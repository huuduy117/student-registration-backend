/**
 * Single source of truth for "student joins a course section".
 *
 * Both POST /api/students/enroll (canonical) and POST /api/class-requests/join
 * (deprecated alias) delegate here.
 *
 * Writes touch four tables: student_courses, class_enrollments,
 * course_sections.enrolled_count and student_schedules. Supabase's REST API
 * has no multi-statement transaction, so the preferred path is the
 * `enroll_student` Postgres function (migrations/20261022_enrollment_atomic.sql)
 * which performs every check and write atomically. If that function has not
 * been deployed yet, the code falls back to the previous compensated-write
 * implementation so a backend deploy is never blocked on a migration.
 */

const { supabase } = require("../config/db");

const ACTIVE = "Active";
const ENROLL_RPC = "enroll_student";

class EnrollmentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "EnrollmentError";
    this.code = code;
    this.status = status;
  }
}

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
};

/** Two sessions conflict when they are on the same date and their periods overlap. */
const schedulesConflict = (a, b) => {
  if (!a?.class_date || !b?.class_date) return false;
  if (String(a.class_date) !== String(b.class_date)) return false;

  const aStart = toNumber(a.period_start);
  const aEnd = toNumber(a.period_end);
  const bStart = toNumber(b.period_start);
  const bEnd = toNumber(b.period_end);

  // Unknown periods cannot be compared safely; skip instead of false-positive.
  if ([aStart, aEnd, bStart, bEnd].some(Number.isNaN)) return false;

  return aStart <= bEnd && bStart <= aEnd;
};

const isActiveOrPassed = (row) =>
  row.grade === null || row.grade === undefined || Number(row.grade) >= 5;

const describeError = (error) => ({
  code: error?.code ?? null,
  message: error?.message ?? String(error),
  details: error?.details ?? null,
  hint: error?.hint ?? null,
});

/**
 * Turn an unexpected Supabase/PostgREST failure into a generic 500 without
 * losing the original error. The controller logs `cause`/`stage`, which is
 * what makes production failures diagnosable without leaking SQL details to
 * clients.
 */
const lookupFailure = (stage, error) => {
  console.error(`[enrollment] lookup failed (${stage})`, describeError(error));
  const wrapped = new EnrollmentError(
    "ENROLLMENT_FAILED",
    "Enrollment failed, please retry",
    500,
  );
  wrapped.cause = error;
  wrapped.stage = stage;
  return wrapped;
};

const writeFailure = (stage, error) => {
  // 23505 = unique_violation. The pre-checks should catch this, but a
  // concurrent request can still lose the race.
  if (error?.code === "23505") {
    console.warn(`[enrollment] duplicate write detected (${stage})`, describeError(error));
    return new EnrollmentError(
      "DUPLICATE_ENROLLMENT",
      "Already enrolled or passed this course",
      409,
    );
  }

  console.error(`[enrollment] write failed (${stage})`, describeError(error));
  const wrapped = new EnrollmentError(
    "ENROLLMENT_FAILED",
    "Enrollment failed, please retry",
    500,
  );
  wrapped.cause = error;
  wrapped.stage = stage;
  return wrapped;
};

const RPC_ERRORS = {
  SECTION_NOT_FOUND: { status: 404, message: "Section not found" },
  STUDENT_NOT_FOUND: { status: 404, message: "Student not found" },
  SECTION_NOT_ACTIVE: { status: 400, message: "Section is not Active" },
  SECTION_FULL: { status: 400, message: "Section is full" },
  STUDENT_NOT_ENROLLED: { status: 400, message: "Student is not enrolled" },
  DUPLICATE_ENROLLMENT: {
    status: 400,
    message: "Already enrolled or passed this course",
  },
  PREREQUISITE_NOT_MET: { status: 400, message: "Prerequisite not met" },
  SCHEDULE_CONFLICT: { status: 400, message: "Schedule conflict detected" },
};

let warnedRpcUnavailable = false;

const normaliseRpcResult = (data, sectionId) => {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return { sectionId, courseId: null, enrolledCount: null };
  }
  return {
    sectionId: row.sectionId ?? row.section_id ?? sectionId,
    courseId: row.courseId ?? row.course_id ?? null,
    enrolledCount:
      row.enrolledCount ?? row.enrolled_count ?? null,
  };
};

/**
 * Try the transactional RPC first.
 *
 * @returns {Promise<{handled: boolean, result?: object}>}
 *   `handled: false` means "function not available/schema mismatch, use the
 *   compensated-write fallback".
 */
const tryEnrollWithRpc = async (studentId, sectionId) => {
  if (typeof supabase.rpc !== "function") return { handled: false };

  let response;
  try {
    response = await supabase.rpc(ENROLL_RPC, {
      p_student_id: studentId,
      p_section_id: sectionId,
    });
  } catch (error) {
    // Network-level failure: the fallback will surface the real error.
    if (!warnedRpcUnavailable) {
      warnedRpcUnavailable = true;
      console.warn(
        `[enrollment] ${ENROLL_RPC} RPC failed, using compensated writes:`,
        error?.message || error,
      );
    }
    return { handled: false };
  }

  const { data, error } = response || {};

  if (!response || typeof response !== "object") {
    if (!warnedRpcUnavailable) {
      warnedRpcUnavailable = true;
      console.warn(
        `[enrollment] ${ENROLL_RPC} returned no response, using compensated writes`,
      );
    }
    return { handled: false };
  }

  if (!error) {
    return { handled: true, result: normaliseRpcResult(data, sectionId) };
  }

  const haystack = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ");
  const businessCode = Object.keys(RPC_ERRORS).find((code) =>
    haystack.includes(code),
  );

  if (businessCode) {
    const meta = RPC_ERRORS[businessCode];
    throw new EnrollmentError(businessCode, meta.message, meta.status);
  }

  // PGRST202 = function not found in the schema cache; 42883 = undefined
  // function. Any other error (e.g. a column mismatch in an older schema) is
  // also recoverable by the fallback, because the failed RPC rolled back.
  if (!warnedRpcUnavailable) {
    warnedRpcUnavailable = true;
    console.warn(
      `[enrollment] ${ENROLL_RPC} RPC unavailable, using compensated writes:`,
      error.message || error,
    );
  }
  return { handled: false };
};

/**
 * Previous implementation, kept as a safety net until the migration has been
 * applied in every environment. Writes are rolled back manually on failure.
 */
const enrollWithCompensatedWrites = async ({ studentId, sectionId }) => {
  // ── 1. Section must exist, be open and have a free seat ──────────────────
  // Use the explicit relationship name everywhere: PostgREST cannot infer
  // `courses(...)` reliably (it failed in production with a 500 even for a
  // missing section), while `courses!course_sections_course_id_fkey` is the
  // spelling used by every other query in this codebase.
  const { data: section, error: sectionError } = await supabase
    .from("course_sections")
    .select("*, courses!course_sections_course_id_fkey(prerequisite)")
    .eq("id", sectionId)
    .maybeSingle();

  if (sectionError) throw lookupFailure("course_sections", sectionError);
  if (!section) throw new EnrollmentError("SECTION_NOT_FOUND", "Section not found", 404);
  if (section.status !== ACTIVE) {
    throw new EnrollmentError("SECTION_NOT_ACTIVE", "Section is not Active");
  }

  const capacity = toNumber(section.capacity);
  const hasCapacityLimit = !Number.isNaN(capacity) && capacity > 0;
  if (hasCapacityLimit && (toNumber(section.enrolled_count) || 0) >= capacity) {
    throw new EnrollmentError("SECTION_FULL", "Section is full");
  }

  // ── 2. Student must be enrolled ──────────────────────────────────────────
  const { data: student, error: studentError } = await supabase
    .from("students")
    .select("status")
    .eq("id", studentId)
    .maybeSingle();

  if (studentError) throw lookupFailure("students", studentError);
  if (!student) throw new EnrollmentError("STUDENT_NOT_FOUND", "Student not found", 404);
  if (student.status !== "Enrolled") {
    throw new EnrollmentError("STUDENT_NOT_ENROLLED", "Student is not enrolled");
  }

  // ── 3. Not already in this section ───────────────────────────────────────
  const { data: existingSection, error: existingSectionError } = await supabase
    .from("class_enrollments")
    .select("status")
    .eq("student_id", studentId)
    .eq("section_id", sectionId)
    .maybeSingle();

  if (existingSectionError) {
    throw lookupFailure("class_enrollments", existingSectionError);
  }
  if (existingSection) {
    throw new EnrollmentError("DUPLICATE_ENROLLMENT", "Already enrolled in this section");
  }

  // ── 4. Not already taking (or having passed) the course ──────────────────
  const { data: existingCourse, error: existingCourseError } = await supabase
    .from("student_courses")
    .select("grade")
    .eq("student_id", studentId)
    .eq("course_id", section.course_id);

  if (existingCourseError) {
    throw lookupFailure("student_courses", existingCourseError);
  }
  if ((existingCourse || []).some(isActiveOrPassed)) {
    throw new EnrollmentError("DUPLICATE_ENROLLMENT", "Already enrolled or passed this course");
  }

  // ── 5. Prerequisite must be passed ───────────────────────────────────────
  const prerequisite = section.courses?.prerequisite;
  if (prerequisite) {
    const { data: prerequisiteRows, error: prerequisiteError } = await supabase
      .from("student_courses")
      .select("grade")
      .eq("student_id", studentId)
      .eq("course_id", prerequisite);

    if (prerequisiteError) {
      throw lookupFailure("student_courses.prerequisite", prerequisiteError);
    }

    const passed = (prerequisiteRows || []).some(
      (row) => row.grade !== null && Number(row.grade) >= 5,
    );
    if (!passed) throw new EnrollmentError("PREREQUISITE_NOT_MET", "Prerequisite not met");
  }

  // ── 6. No overlap with the student's existing timetable ──────────────────
  const { data: teacherSchedules, error: teacherSchedulesError } = await supabase
    .from("teacher_schedules")
    .select("class_date, period_start, period_end, room, session_type")
    .eq("section_id", sectionId);

  if (teacherSchedulesError) {
    throw lookupFailure("teacher_schedules", teacherSchedulesError);
  }

  if (teacherSchedules && teacherSchedules.length > 0) {
    const { data: studentSchedules, error: studentSchedulesError } = await supabase
      .from("student_schedules")
      .select("class_date, period_start, period_end")
      .eq("student_id", studentId);

    if (studentSchedulesError) {
      throw lookupFailure("student_schedules", studentSchedulesError);
    }

    const hasConflict = (studentSchedules || []).some((existing) =>
      teacherSchedules.some((incoming) => schedulesConflict(incoming, existing)),
    );

    if (hasConflict) {
      throw new EnrollmentError("SCHEDULE_CONFLICT", "Schedule conflict detected");
    }
  }

  // ── 7. Writes (compensated on failure) ───────────────────────────────────
  const rollbacks = [];
  const registeredAt = new Date().toISOString().split("T")[0];

  try {
    const { error: courseError } = await supabase.from("student_courses").insert({
      student_id: studentId,
      course_id: section.course_id,
      section_id: sectionId,
      registered_at: registeredAt,
    });
    if (courseError) throw courseError;
    rollbacks.push(() =>
      supabase
        .from("student_courses")
        .delete()
        .eq("student_id", studentId)
        .eq("section_id", sectionId),
    );

    const { error: enrollmentError } = await supabase.from("class_enrollments").insert({
      student_id: studentId,
      section_id: sectionId,
      status: ACTIVE,
      enrolled_at: registeredAt,
    });
    if (enrollmentError) throw enrollmentError;
    rollbacks.push(() =>
      supabase
        .from("class_enrollments")
        .delete()
        .eq("student_id", studentId)
        .eq("section_id", sectionId),
    );

    // Re-count after the write: reduces (does not eliminate) the race window
    // between the capacity check and the insert.
    const { count: activeCount, error: countError } = await supabase
      .from("class_enrollments")
      .select("*", { count: "exact", head: true })
      .eq("section_id", sectionId)
      .eq("status", ACTIVE);
    if (countError) throw countError;

    if (hasCapacityLimit && (activeCount || 0) > capacity) {
      throw new EnrollmentError("SECTION_FULL", "Section is full");
    }

    const previousCount = toNumber(section.enrolled_count);
    const { error: updateError } = await supabase
      .from("course_sections")
      .update({ enrolled_count: activeCount || 0 })
      .eq("id", sectionId);
    if (updateError) throw updateError;
    rollbacks.push(() =>
      supabase
        .from("course_sections")
        .update({ enrolled_count: Number.isNaN(previousCount) ? 0 : previousCount })
        .eq("id", sectionId),
    );

    if (teacherSchedules && teacherSchedules.length > 0) {
      const rows = teacherSchedules.map((slot) => ({
        id: `SS_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        student_id: studentId,
        section_id: sectionId,
        class_date: slot.class_date,
        period_start: slot.period_start,
        period_end: slot.period_end,
        room: slot.room,
        session_type: slot.session_type,
      }));

      const { error: scheduleError } = await supabase.from("student_schedules").insert(rows);
      if (scheduleError) throw scheduleError;
      rollbacks.push(() =>
        supabase
          .from("student_schedules")
          .delete()
          .eq("student_id", studentId)
          .eq("section_id", sectionId),
      );
    }

    return {
      sectionId,
      courseId: section.course_id,
      enrolledCount: activeCount || 0,
    };
  } catch (error) {
    await Promise.all(
      rollbacks.reverse().map((rollback) =>
        Promise.resolve(rollback()).catch((rollbackError) =>
          console.error("[enrollment] rollback failed:", rollbackError?.message || rollbackError),
        ),
      ),
    );

    if (error instanceof EnrollmentError) throw error;
    throw writeFailure("writes", error);
  }
};

/**
 * Enroll a student in a section, enforcing every business rule first.
 * Throws `EnrollmentError` for expected failures.
 *
 * Note: `class_requests.participant_count` is the student's *expected*
 * headcount from the request form, so it is deliberately not overwritten here.
 * The actual number is `course_sections.enrolled_count` and the participants
 * endpoint.
 */
const enrollStudent = async ({ studentId, sectionId }) => {
  if (!studentId) throw new EnrollmentError("MISSING_STUDENT", "Missing student id");
  if (!sectionId) throw new EnrollmentError("MISSING_SECTION", "Missing section id");

  const rpc = await tryEnrollWithRpc(studentId, sectionId);
  if (rpc.handled) return rpc.result;

  return enrollWithCompensatedWrites({ studentId, sectionId });
};

module.exports = {
  EnrollmentError,
  enrollStudent,
  schedulesConflict,
};
