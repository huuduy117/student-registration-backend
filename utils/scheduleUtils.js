/**
 * Shared helpers for the student & teacher schedule endpoints.
 *
 * Both endpoints must expose the exact same item shape. They used to keep
 * separate mappers, which drifted apart and left the student schedule without
 * the fields the frontend rendered (see Schedule.jsx).
 *
 * All day-of-week / week math is done in UTC on purpose: class_date values are
 * plain `YYYY-MM-DD` strings, and `new Date("2026-10-19").getDay()` depends on
 * the server timezone (UTC+7 would still be fine, UTC-5 would shift the day).
 */

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse `YYYY-MM-DD` (or an ISO timestamp) into a UTC-midnight Date. */
const parseDateOnly = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  const datePart = String(value).split("T")[0];
  const match = DATE_ONLY_RE.exec(datePart);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** Format a Date as `YYYY-MM-DD` (UTC). */
const toDateOnlyString = (date) => (date ? date.toISOString().split("T")[0] : null);

/** 0 = Sunday ... 6 = Saturday, timezone independent. */
const getDayIndex = (value) => {
  const date = parseDateOnly(value);
  return date ? date.getUTCDay() : null;
};

/** Monday of the week containing `value`. */
const getWeekStart = (value) => {
  const date = parseDateOnly(value);
  if (!date) return null;
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date;
};

/** Sunday of the week containing `value`. */
const getWeekEnd = (value) => {
  const start = getWeekStart(value);
  if (!start) return null;
  start.setUTCDate(start.getUTCDate() + 6);
  return start;
};

/** e.g. 202642 for week 42 of 2026 (kept identical to the previous behaviour). */
const getWeekNumber = (date) => {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
  return parseInt(`${target.getUTCFullYear()}${String(weekNo).padStart(2, "0")}`, 10);
};

const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Group mapped items into the week buckets returned by `/:id/week`. */
const buildWeeklySchedule = (items) => {
  const weekly = {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
  };

  (items || []).forEach((item) => {
    const dayIndex = getDayIndex(item.classDate);
    if (dayIndex === null) return;
    weekly[DAY_KEYS[dayIndex]].push(item);
  });

  return weekly;
};

/**
 * Map a raw `student_schedules` / `teacher_schedules` row (with nested
 * `course_sections`, `courses`, `teacher_assignments.teachers`) to the API shape.
 *
 * `camelCase` keys are the canonical contract. The Vietnamese aliases below are
 * deprecated but kept so older clients keep rendering instead of going blank.
 */
const mapScheduleItem = (item) => {
  const section = item.course_sections || {};
  const course = section.courses || {};

  const assignments = Array.isArray(section.teacher_assignments) ? section.teacher_assignments : [];
  const assignment = assignments[0] || null;
  const teacher = assignment?.teachers || null;

  const periodStart = item.period_start ?? null;
  const periodEnd = item.period_end ?? null;
  const courseName = course.name || "";
  const sectionId = section.id || "";

  return {
    // ── canonical contract ──────────────────────────────────────────────────
    scheduleId: item.id,
    classDate: item.class_date,
    periodStart,
    periodEnd,
    room: item.room ?? null,
    sessionType: item.session_type ?? null,
    courseId: course.id ?? null,
    courseName: course.name ?? null,
    sectionId: section.id ?? null,
    teacherId: teacher?.id ?? assignment?.teacher_id ?? null,
    teacherName: teacher?.full_name ?? null,
    enrolledCount: section.enrolled_count ?? null,

    // ── deprecated aliases (kept for backward compatibility) ────────────────
    tenMH: courseName,
    maLopHP: sectionId,
    maMH: course.id || "",
    tietBD: periodStart === null ? "" : String(periodStart),
    tietKT: periodEnd === null ? "" : String(periodEnd),
    phongHoc: item.room || "",
    tenGiangVien: teacher?.full_name || "",
    siSoHienTai: section.enrolled_count ?? 0,
  };
};

module.exports = {
  DAY_KEYS,
  buildWeeklySchedule,
  getDayIndex,
  getWeekEnd,
  getWeekNumber,
  getWeekStart,
  mapScheduleItem,
  parseDateOnly,
  toDateOnlyString,
};
