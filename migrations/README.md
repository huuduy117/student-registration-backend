# Database migrations

The API works without these files (it falls back to the old code paths), but
the new guarantees only take effect once they are applied:

| File | Enables |
| --- | --- |
| `20261022_enrollment_atomic.sql` | Unique enrollment indexes + transactional `enroll_student(...)` RPC |
| `20261022_token_revocation.sql` | Server-side logout / JWT revocation |

Apply both in order in the Supabase dashboard (**SQL Editor**) or with the
Supabase CLI (`supabase db push`). The backend uses
`SUPABASE_SERVICE_ROLE_KEY`, which is required for the `security definer` RPC.

## Before applying

The enrollment migration deletes exact duplicate rows before creating unique
indexes. Check what it would remove:

```sql
-- duplicate enrollments
select student_id, section_id, count(*) as n
from public.class_enrollments
group by student_id, section_id
having count(*) > 1;

-- duplicate student_courses per section
select student_id, section_id, count(*) as n
from public.student_courses
where section_id is not null
group by student_id, section_id
having count(*) > 1;

-- duplicate timetable slots
select student_id, section_id, class_date, period_start, period_end, count(*) as n
from public.student_schedules
group by student_id, section_id, class_date, period_start, period_end
having count(*) > 1;
```

The migration keeps the `Active` / graded / most recent row respectively. If
the rows are not duplicates semantically, fix the data first instead of
applying the migration.

## Deploy order

1. Back up the database (Supabase → Database → Backups).
2. Apply `20261022_enrollment_atomic.sql`.
3. Apply `20261022_token_revocation.sql`.
4. Backfill legacy rows (see below).
5. Deploy the backend. On the next request each client gets a new token with a
   `jti`; tokens issued before the deploy have no `jti` and expire normally
   (24h).

## Backfill legacy enrollments

Rows written by the old `/api/class-requests/join` endpoint only exist in
`student_courses`. The script fills in `class_enrollments`, `student_schedules`
and recalculates `course_sections.enrolled_count`. Graded rows (completed
courses) are skipped: they are not current enrollments and must not inflate the
section count. The script **does not** touch
`class_requests.participant_count`, which is the expected headcount from the
request form.

Dry run (default):

```bash
cd student-registration-backend
npm run backfill:enrollment
```

Apply:

```bash
npm run backfill:enrollment -- --apply
```

The script is idempotent: re-running it only adds missing rows and recalculates
counts.

## Rollback

```sql
drop function if exists public.enroll_student(text, text);
drop index if exists public.class_enrollments_student_section_uidx;
drop index if exists public.student_courses_student_section_uidx;
drop index if exists public.student_schedules_student_slot_uidx;
drop table if exists public.revoked_tokens;
```

Dropping the indexes does **not** restore deleted duplicates; restore from the
backup instead if that data was needed.

## Behaviour without the migrations

- Enrollment: the API logs `enroll_student RPC unavailable` and uses the
  compensated-write path. Duplicate protection then relies on the JS checks
  (small race window remains).
- Logout: the token is revoked in the current process, but the revocation is
  not persisted. Other instances/restarts will still accept it until `exp`.
- Chat ACL: does **not** depend on these migrations; it uses the existing
  `students` / `classes` tables.

## Environment variables

Set these on the backend host (Render/Railway/etc.):

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
MONGODB_URI=...
JWT_SECRET=<long random value>   # rotating it invalidates every token
FRONTEND_URL=https://...
FRONTEND_URL_2=https://...       # optional second origin
NODE_ENV=production
```
