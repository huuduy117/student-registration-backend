#!/usr/bin/env node
/**
 * Backfill rows that the old `/api/class-requests/join` endpoint never wrote.
 *
 * Before the shared enrollment service existed, the UI's join flow only
 * inserted into `student_courses`. As a result those students had:
 *   - no `class_enrollments` row (grade entry failed),
 *   - no `student_schedules` rows (empty timetable),
 *   - a stale `course_sections.enrolled_count`.
 *
 * Usage:
 *   npm run backfill:enrollment            # dry run, prints what would change
 *   npm run backfill:enrollment -- --apply # write the changes
 *
 * The script is idempotent and deliberately does not touch
 * `class_requests.participant_count`: that column is the expected headcount
 * from the request form, not the actual number of enrollments.
 */

require("dotenv").config();

const crypto = require("crypto");
const { supabase } = require("../config/db");

const APPLY = process.argv.includes("--apply");
const PAGE_SIZE = 500;
const BATCH_SIZE = 200;

const MODE = APPLY ? "APPLY" : "DRY-RUN";

const log = (...args) => console.log(`[backfill:${MODE}]`, ...args);
const warn = (...args) => console.warn(`[backfill:${MODE}]`, ...args);

const pairKey = (studentId, sectionId) =>
  `${String(studentId)}\u0000${String(sectionId)}`;

const slotKey = (studentId, date, start, end) =>
  `${String(studentId)}\u0000${String(date)}\u0000${String(start)}\u0000${String(end)}`;

const asDate = (value) => {
  if (typeof value === "string" && value.length >= 10) return value.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
};

const selectAll = async (table, columns, filter) => {
  const rows = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(table).select(columns);
    if (filter) query = filter(query);
    query = query.range(from, from + PAGE_SIZE - 1);

    const { data, error } = await query;
    if (error) throw error;

    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return rows;
};

const insertInBatches = async (table, rows, { ignoreDuplicates = false } = {}) => {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).insert(chunk);

    if (error) {
      if (ignoreDuplicates && error.code === "23505") {
        // A whole batch failed because at least one row already exists.
        // Retry individually so the other rows are not lost.
        warn(`${table}: batch contained duplicates, retrying row by row`);
        for (const row of chunk) {
          const { error: rowError } = await supabase.from(table).insert(row);
          if (rowError && rowError.code !== "23505") throw rowError;
        }
        continue;
      }
      throw error;
    }
  }
};

const newScheduleId = () =>
  `SS_${crypto.randomUUID().replace(/-/g, "")}`;

const fetchSections = async () => {
  const rows = await selectAll(
    "student_courses",
    "student_id, section_id, course_id, registered_at, grade",
    (query) => query.not("section_id", "is", null),
  );

  // One row per (student, section); the first registered_at wins. Graded
  // rows belong to completed courses, so they are not current enrollments and
  // must not inflate course_sections.enrolled_count.
  const byPair = new Map();
  for (const row of rows) {
    if (!row.student_id || !row.section_id) continue;
    if (row.grade !== null && row.grade !== undefined) continue;
    const key = pairKey(row.student_id, row.section_id);
    if (!byPair.has(key)) {
      byPair.set(key, {
        studentId: row.student_id,
        sectionId: row.section_id,
        registeredAt: row.registered_at,
      });
    }
  }

  return { courseRows: rows.length, pairs: [...byPair.values()] };
};

const backfillEnrollments = async (pairs) => {
  const existing = await selectAll(
    "class_enrollments",
    "student_id, section_id",
  );
  const existingKeys = new Set(
    existing.map((row) => pairKey(row.student_id, row.section_id)),
  );

  const missing = pairs.filter(
    (pair) => !existingKeys.has(pairKey(pair.studentId, pair.sectionId)),
  );

  log(
    `class_enrollments: ${pairs.length} section pairs, ${existing.length} rows, ${missing.length} missing`,
  );

  if (!APPLY || missing.length === 0) return missing;

  await insertInBatches(
    "class_enrollments",
    missing.map((pair) => ({
      student_id: pair.studentId,
      section_id: pair.sectionId,
      status: "Active",
      enrolled_at: asDate(pair.registeredAt),
    })),
    { ignoreDuplicates: true },
  );

  return missing;
};

const backfillSchedules = async (pairs) => {
  const pairsBySection = new Map();
  for (const pair of pairs) {
    if (!pairsBySection.has(pair.sectionId)) {
      pairsBySection.set(pair.sectionId, []);
    }
    pairsBySection.get(pair.sectionId).push(pair);
  }

  let inserted = 0;

  for (const [sectionId, sectionPairs] of pairsBySection) {
    const slots = await selectAll(
      "teacher_schedules",
      "class_date, period_start, period_end, room, session_type",
      (query) => query.eq("section_id", sectionId),
    );

    if (slots.length === 0) continue;

    const existing = await selectAll(
      "student_schedules",
      "student_id, class_date, period_start, period_end",
      (query) => query.eq("section_id", sectionId),
    );

    const existingKeys = new Set(
      existing.map((row) =>
        slotKey(row.student_id, row.class_date, row.period_start, row.period_end),
      ),
    );

    const rows = [];
    for (const pair of sectionPairs) {
      for (const slot of slots) {
        const key = slotKey(
          pair.studentId,
          slot.class_date,
          slot.period_start,
          slot.period_end,
        );
        if (existingKeys.has(key)) continue;

        existingKeys.add(key);
        rows.push({
          id: newScheduleId(),
          student_id: pair.studentId,
          section_id: sectionId,
          class_date: slot.class_date,
          period_start: slot.period_start,
          period_end: slot.period_end,
          room: slot.room,
          session_type: slot.session_type,
        });
      }
    }

    if (rows.length > 0) {
      log(`student_schedules: ${sectionId} -> ${rows.length} missing slots`);
      inserted += rows.length;
      if (APPLY) {
        await insertInBatches("student_schedules", rows, {
          ignoreDuplicates: true,
        });
      }
    }
  }

  if (inserted === 0) log("student_schedules: nothing to backfill");
  return inserted;
};

const recalculateCounts = async (pairs) => {
  const sections = [...new Set(pairs.map((pair) => pair.sectionId))];
  let changed = 0;

  for (const sectionId of sections) {
    const { count, error: countError } = await supabase
      .from("class_enrollments")
      .select("*", { count: "exact", head: true })
      .eq("section_id", sectionId)
      .eq("status", "Active");

    if (countError) throw countError;

    const { data: section, error: sectionError } = await supabase
      .from("course_sections")
      .select("id, enrolled_count")
      .eq("id", sectionId)
      .maybeSingle();

    if (sectionError) throw sectionError;
    if (!section) {
      warn(`course_sections: ${sectionId} no longer exists, skipping count`);
      continue;
    }

    const actual = count || 0;
    const stored = Number(section.enrolled_count) || 0;
    if (actual === stored) continue;

    changed += 1;
    log(`course_sections: ${sectionId} enrolled_count ${stored} -> ${actual}`);
    if (APPLY) {
      const { error: updateError } = await supabase
        .from("course_sections")
        .update({ enrolled_count: actual })
        .eq("id", sectionId);
      if (updateError) throw updateError;
    }
  }

  if (changed === 0) log("course_sections: all enrolled_count values are correct");
  return changed;
};

const main = async () => {
  log(
    APPLY
      ? "writing changes (re-run without --apply for a dry run)"
      : "no writes; pass --apply to persist",
  );

  const { courseRows, pairs } = await fetchSections();
  log(`student_courses: ${courseRows} rows with a section, ${pairs.length} unique pairs`);

  if (pairs.length === 0) {
    log("nothing to do");
    return;
  }

  await backfillEnrollments(pairs);
  await backfillSchedules(pairs);
  await recalculateCounts(pairs);

  log(APPLY ? "done" : "dry run complete; re-run with -- --apply");
};

main().catch((error) => {
  console.error("[backfill] failed:", error?.message || error);
  process.exitCode = 1;
});
