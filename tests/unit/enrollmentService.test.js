const { createFakeSupabase } = require("../helpers/fakeSupabase");

const SEC1 = {
  id: "SEC1",
  course_id: "CRS1",
  status: "Active",
  capacity: 40,
  enrolled_count: 5,
  courses: { prerequisite: null },
};

let fake;

const loadService = () => {
  jest.resetModules();
  jest.doMock("../../config/db", () => ({ supabase: fake.supabase }));
  return require("../../services/enrollmentService");
};

const seed = () => {
  fake.reset();
  fake.state.students = [{ id: "ST1", status: "Enrolled" }];
  fake.state.course_sections = [{ ...SEC1, courses: { prerequisite: null } }];
  fake.state.class_enrollments = Array.from({ length: 5 }, (_, i) => ({
    student_id: `OTHER_${i}`,
    section_id: "SEC1",
    status: "Active",
  }));
  fake.state.student_courses = [];
  fake.state.teacher_schedules = [
    {
      section_id: "SEC1",
      class_date: "2026-10-19",
      period_start: 1,
      period_end: 3,
      room: "A1",
      session_type: "Lecture",
    },
    {
      section_id: "SEC1",
      class_date: "2026-10-21",
      period_start: 7,
      period_end: 9,
      room: "A1",
      session_type: "Lecture",
    },
  ];
  fake.state.student_schedules = [];
  fake.state.class_requests = [{ id: "REQ1", section_id: "SEC1", participant_count: 1 }];
};

const expectCode = async (promise, code) => {
  await expect(promise).rejects.toMatchObject({ name: "EnrollmentError", code });
};

beforeEach(() => {
  fake = createFakeSupabase();
  seed();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("schedulesConflict", () => {
  it("compares periods numerically, not lexicographically", () => {
    const { schedulesConflict } = loadService();

    // Before the fix, "3" > "10" made these look like they overlapped.
    expect(
      schedulesConflict(
        { class_date: "2026-10-19", period_start: 1, period_end: 3 },
        { class_date: "2026-10-19", period_start: 10, period_end: 12 },
      ),
    ).toBe(false);

    expect(
      schedulesConflict(
        { class_date: "2026-10-19", period_start: 9, period_end: 10 },
        { class_date: "2026-10-19", period_start: 10, period_end: 11 },
      ),
    ).toBe(true);
  });

  it("ignores different dates and unknown periods", () => {
    const { schedulesConflict } = loadService();

    expect(
      schedulesConflict(
        { class_date: "2026-10-20", period_start: 1, period_end: 3 },
        { class_date: "2026-10-19", period_start: 1, period_end: 3 },
      ),
    ).toBe(false);

    expect(schedulesConflict({}, { class_date: "2026-10-19" })).toBe(false);
    expect(
      schedulesConflict(
        { class_date: "2026-10-19", period_start: "07:30", period_end: "09:00" },
        { class_date: "2026-10-19", period_start: "08:00", period_end: "10:00" },
      ),
    ).toBe(false);
  });
});

describe("enrollStudent", () => {
  it("uses the explicit course_sections -> courses relationship", async () => {
    const { enrollStudent } = loadService();

    await enrollStudent({ studentId: "ST1", sectionId: "SEC1" });

    const sectionSelect = fake.selectLog.find(
      (entry) => entry.table === "course_sections",
    );
    // `courses(prerequisite)` made PostgREST fail in production (500 even for
    // a missing section); every other query in the codebase uses this hint.
    expect(sectionSelect.columns).toContain(
      "courses!course_sections_course_id_fkey(prerequisite)",
    );
  });

  it("writes all four tables without touching the expected headcount", async () => {
    const { enrollStudent } = loadService();

    const result = await enrollStudent({ studentId: "ST1", sectionId: "SEC1" });

    expect(result).toEqual({ sectionId: "SEC1", courseId: "CRS1", enrolledCount: 6 });

    expect(fake.state.student_courses).toHaveLength(1);
    expect(fake.state.student_courses[0]).toMatchObject({
      student_id: "ST1",
      course_id: "CRS1",
      section_id: "SEC1",
    });

    expect(fake.state.class_enrollments).toHaveLength(6);
    expect(fake.state.class_enrollments.at(-1).status).toBe("Active");
    expect(fake.state.course_sections[0].enrolled_count).toBe(6);

    expect(fake.state.student_schedules).toHaveLength(2);
    expect(
      fake.state.student_schedules.map((slot) => [
        slot.student_id,
        slot.section_id,
        slot.class_date,
        slot.period_start,
        slot.period_end,
      ]),
    ).toEqual([
      ["ST1", "SEC1", "2026-10-19", 1, 3],
      ["ST1", "SEC1", "2026-10-21", 7, 9],
    ]);

    // participant_count is the *expected* headcount from the request form.
    // Actual enrollment lives in course_sections.enrolled_count.
    expect(fake.state.class_requests[0].participant_count).toBe(1);
  });

  it("rejects a duplicate enrollment in the same section", async () => {
    fake.state.class_enrollments.push({
      student_id: "ST1",
      section_id: "SEC1",
      status: "Active",
    });
    const { enrollStudent } = loadService();

    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "DUPLICATE_ENROLLMENT",
    );
    expect(fake.state.student_courses).toHaveLength(0);
  });

  it("rejects a course that was already passed", async () => {
    fake.state.student_courses.push({
      student_id: "ST1",
      course_id: "CRS1",
      section_id: "OLD",
      grade: 8,
    });
    const { enrollStudent } = loadService();

    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "DUPLICATE_ENROLLMENT",
    );
  });

  it("allows retaking a course that was failed", async () => {
    fake.state.student_courses.push({
      student_id: "ST1",
      course_id: "CRS1",
      section_id: "OLD",
      grade: 3,
    });
    const { enrollStudent } = loadService();

    await enrollStudent({ studentId: "ST1", sectionId: "SEC1" });
    expect(fake.state.student_courses).toHaveLength(2);
  });

  it("rejects a section that is not Active", async () => {
    fake.state.course_sections[0].status = "NotOpen";
    const { enrollStudent } = loadService();

    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "SECTION_NOT_ACTIVE",
    );
  });

  it("rejects a full section", async () => {
    fake.state.course_sections[0].capacity = 6;
    fake.state.course_sections[0].enrolled_count = 6;
    const { enrollStudent } = loadService();

    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "SECTION_FULL",
    );
  });

  it("treats a null capacity as unlimited", async () => {
    fake.state.course_sections[0].capacity = null;
    const { enrollStudent } = loadService();

    await expect(enrollStudent({ studentId: "ST1", sectionId: "SEC1" })).resolves.toBeTruthy();
  });

  it("rejects a missing section", async () => {
    const { enrollStudent } = loadService();

    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "MISSING" }),
      "SECTION_NOT_FOUND",
    );
    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: null }),
      "MISSING_SECTION",
    );
  });

  it("rejects students who are not Enrolled or do not exist", async () => {
    const { enrollStudent } = loadService();

    fake.state.students = [{ id: "ST1", status: "Suspended" }];
    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "STUDENT_NOT_ENROLLED",
    );

    fake.state.students = [];
    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "STUDENT_NOT_FOUND",
    );
  });

  it("enforces prerequisites, but accepts a passed one", async () => {
    fake.state.course_sections[0].courses.prerequisite = "PRE1";
    const { enrollStudent } = loadService();

    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "PREREQUISITE_NOT_MET",
    );

    fake.state.student_courses.push({
      student_id: "ST1",
      course_id: "PRE1",
      section_id: "S0",
      grade: 7,
    });
    await expect(enrollStudent({ studentId: "ST1", sectionId: "SEC1" })).resolves.toBeTruthy();
  });

  it("detects a timetable conflict before writing anything", async () => {
    fake.state.student_schedules.push({
      student_id: "ST1",
      section_id: "OTHER",
      class_date: "2026-10-19",
      period_start: 2,
      period_end: 4,
    });
    const { enrollStudent } = loadService();

    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "SCHEDULE_CONFLICT",
    );

    expect(fake.state.student_courses).toHaveLength(0);
    expect(fake.state.class_enrollments).toHaveLength(5);
    expect(fake.state.course_sections[0].enrolled_count).toBe(5);
  });

  it("rolls back student_courses when class_enrollments insert fails", async () => {
    fake.failInsert.class_enrollments = true;
    const { enrollStudent } = loadService();

    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "ENROLLMENT_FAILED",
    );

    expect(fake.state.student_courses).toHaveLength(0);
    expect(fake.state.class_enrollments).toHaveLength(5);
    expect(fake.state.course_sections[0].enrolled_count).toBe(5);
  });

  it("restores enrolled_count when the schedule insert fails", async () => {
    fake.failInsert.student_schedules = true;
    const { enrollStudent } = loadService();

    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "ENROLLMENT_FAILED",
    );

    expect(fake.state.student_courses).toHaveLength(0);
    expect(fake.state.class_enrollments).toHaveLength(5);
    expect(fake.state.course_sections[0].enrolled_count).toBe(5);
  });
});

describe("transactional enroll_student RPC", () => {
  it("uses the RPC result and skips the REST writes", async () => {
    const calls = [];
    fake.setRpc(async (fn, args) => {
      calls.push([fn, args]);
      return {
        data: { sectionId: "SEC1", courseId: "CRS1", enrolledCount: 7 },
        error: null,
      };
    });

    const { enrollStudent } = loadService();
    const result = await enrollStudent({ studentId: "ST1", sectionId: "SEC1" });

    expect(calls).toEqual([
      ["enroll_student", { p_student_id: "ST1", p_section_id: "SEC1" }],
    ]);
    expect(result).toEqual({ sectionId: "SEC1", courseId: "CRS1", enrolledCount: 7 });

    // The RPC owns every write; the fallback must not run as well.
    expect(fake.state.student_courses).toHaveLength(0);
    expect(fake.state.class_enrollments).toHaveLength(5);
  });

  it("maps business errors raised by the RPC", async () => {
    fake.setRpc(async () => ({
      data: null,
      error: { code: "P0001", message: "SECTION_FULL" },
    }));

    const { enrollStudent } = loadService();

    await expectCode(
      enrollStudent({ studentId: "ST1", sectionId: "SEC1" }),
      "SECTION_FULL",
    );
    expect(fake.state.student_courses).toHaveLength(0);
  });

  it("falls back to compensated writes when the function is missing", async () => {
    // The fake default is PGRST202 (function not found in schema cache).
    const { enrollStudent } = loadService();
    const result = await enrollStudent({ studentId: "ST1", sectionId: "SEC1" });

    expect(result).toEqual({ sectionId: "SEC1", courseId: "CRS1", enrolledCount: 6 });
    expect(fake.state.student_courses).toHaveLength(1);
  });
});
