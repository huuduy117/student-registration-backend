-- Atomic enrollment + data-integrity constraints.
--
-- Apply this file once in the Supabase SQL editor (or with `supabase db push`)
-- before relying on transactional enrollment. The backend detects a missing
-- function and falls back to compensated writes, so deploying the API first
-- is safe.
--
-- Important: the dedupe statements below remove exact duplicate rows before
-- creating the unique indexes. Review the SELECTs first if the database
-- contains data you cannot recreate.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Remove duplicates that would block the unique indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- One active enrollment per student/section. Keep the Active row (if any),
-- then the most recent one.
delete from public.class_enrollments
where ctid in (
  select ctid
  from (
    select
      ctid,
      row_number() over (
        partition by student_id, section_id
        order by (status::text = 'Active') desc, enrolled_at desc nulls last
      ) as rn
    from public.class_enrollments
  ) ranked
  where rn > 1
);

-- One student_courses row per student/section. Keep a graded row if present.
delete from public.student_courses
where section_id is not null
  and ctid in (
    select ctid
    from (
      select
        ctid,
        row_number() over (
          partition by student_id, section_id
          order by (grade is not null) desc, registered_at desc nulls last
        ) as rn
      from public.student_courses
      where section_id is not null
    ) ranked
    where rn > 1
  );

-- One timetable row per student and exact slot.
delete from public.student_schedules
where ctid in (
  select ctid
  from (
    select
      ctid,
      row_number() over (
        partition by student_id, section_id, class_date, period_start, period_end
        order by id
      ) as rn
    from public.student_schedules
  ) ranked
  where rn > 1
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Idempotency guards
-- ─────────────────────────────────────────────────────────────────────────────

create unique index if not exists class_enrollments_student_section_uidx
  on public.class_enrollments (student_id, section_id);

create unique index if not exists student_courses_student_section_uidx
  on public.student_courses (student_id, section_id)
  where section_id is not null;

create unique index if not exists student_schedules_student_slot_uidx
  on public.student_schedules (student_id, section_id, class_date, period_start, period_end);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Transactional enrollment
-- ─────────────────────────────────────────────────────────────────────────────
--
-- IDs are compared as text because this project mixes text ids (SEC_...) with
-- database-generated ids. Inserts use dynamic SQL with %L literals so the
-- same function works whether student_id/course_id are text or uuid columns.

create or replace function public.enroll_student(
  p_student_id text,
  p_section_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_section public.course_sections%rowtype;
  v_student_status text;
  v_course_id text;
  v_prerequisite text;
  v_conflict boolean;
  v_enrolled_count integer;
begin
  if p_student_id is null or btrim(p_student_id) = ''
     or p_section_id is null or btrim(p_section_id) = '' then
    raise exception 'MISSING_INPUT' using errcode = 'P0001';
  end if;

  -- Lock the section: concurrent enrollments for the same section serialise
  -- here, so the capacity check below is race-free.
  select * into v_section
  from public.course_sections
  where id::text = p_section_id
  for update;

  if not found then
    raise exception 'SECTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_section.status::text is distinct from 'Active' then
    raise exception 'SECTION_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  if coalesce(v_section.capacity, 0) > 0
     and coalesce(v_section.enrolled_count, 0) >= v_section.capacity then
    raise exception 'SECTION_FULL' using errcode = 'P0001';
  end if;

  v_course_id := v_section.course_id::text;

  select s.status::text into v_student_status
  from public.students s
  where s.id::text = p_student_id;

  if not found then
    raise exception 'STUDENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_student_status is distinct from 'Enrolled' then
    raise exception 'STUDENT_NOT_ENROLLED' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.class_enrollments ce
    where ce.student_id::text = p_student_id
      and ce.section_id::text = p_section_id
  ) then
    raise exception 'DUPLICATE_ENROLLMENT' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.student_courses sc
    where sc.student_id::text = p_student_id
      and sc.course_id::text = v_course_id
      and (sc.grade is null or sc.grade::numeric >= 5)
  ) then
    raise exception 'DUPLICATE_ENROLLMENT' using errcode = 'P0001';
  end if;

  select c.prerequisite::text into v_prerequisite
  from public.courses c
  where c.id::text = v_course_id;

  if v_prerequisite is not null and btrim(v_prerequisite) <> '' then
    if not exists (
      select 1
      from public.student_courses sc
      where sc.student_id::text = p_student_id
        and sc.course_id::text = v_prerequisite
        and sc.grade is not null
        and sc.grade::numeric >= 5
    ) then
      raise exception 'PREREQUISITE_NOT_MET' using errcode = 'P0001';
    end if;
  end if;

  select exists (
    select 1
    from public.teacher_schedules ts
    join public.student_schedules ss
      on ss.student_id::text = p_student_id
     and ss.class_date = ts.class_date
    where ts.section_id::text = p_section_id
      and ss.period_start is not null
      and ss.period_end is not null
      and ts.period_start is not null
      and ts.period_end is not null
      -- Match schedulesConflict(): only numeric periods are comparable.
      and ss.period_start::text ~ '^[0-9]+$'
      and ss.period_end::text ~ '^[0-9]+$'
      and ts.period_start::text ~ '^[0-9]+$'
      and ts.period_end::text ~ '^[0-9]+$'
      and ss.period_start <= ts.period_end
      and ts.period_start <= ss.period_end
  ) into v_conflict;

  if v_conflict then
    raise exception 'SCHEDULE_CONFLICT' using errcode = 'P0001';
  end if;

  -- Writes. %L lets Postgres coerce the quoted literal to the column type,
  -- whether the column is text or uuid.
  execute format(
    'insert into public.student_courses
       (student_id, course_id, section_id, registered_at)
     values (%L, %L, %L, current_date)',
    p_student_id, v_course_id, p_section_id
  );

  execute format(
    'insert into public.class_enrollments
       (student_id, section_id, status, enrolled_at)
     values (%L, %L, %L, current_date)',
    p_student_id, p_section_id, 'Active'
  );

  -- Copy every timetable slot of the section, skipping slots the student
  -- already has (legacy data / retries).
  execute format($sql$
    insert into public.student_schedules
      (id, student_id, section_id, class_date, period_start, period_end, room, session_type)
    select
      'SS_' || replace(gen_random_uuid()::text, '-', ''),
      %L, %L, ts.class_date, ts.period_start, ts.period_end, ts.room, ts.session_type
    from public.teacher_schedules ts
    where ts.section_id::text = %L
      and not exists (
        select 1
        from public.student_schedules ss
        where ss.student_id::text = %L
          and ss.section_id::text = %L
          and ss.class_date = ts.class_date
          and coalesce(ss.period_start, -1) = coalesce(ts.period_start, -1)
          and coalesce(ss.period_end, -1) = coalesce(ts.period_end, -1)
      )
  $sql$, p_student_id, p_section_id, p_section_id, p_student_id, p_section_id);

  update public.course_sections
  set enrolled_count = (
    select count(*)
    from public.class_enrollments ce
    where ce.section_id::text = p_section_id
      and ce.status::text = 'Active'
  )
  where id::text = p_section_id
  returning enrolled_count into v_enrolled_count;

  return jsonb_build_object(
    'sectionId', p_section_id,
    'courseId', v_course_id,
    'enrolledCount', coalesce(v_enrolled_count, 0)
  );
end;
$$;

-- Only the backend's service-role key needs to call this SECURITY DEFINER
-- function; do not leave it executable by anon/authenticated.
revoke all on function public.enroll_student(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.enroll_student(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.enroll_student(text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.enroll_student(text, text) to service_role;
  end if;
end;
$$;
