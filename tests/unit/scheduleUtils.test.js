const {
  buildWeeklySchedule,
  getDayIndex,
  getWeekEnd,
  getWeekNumber,
  getWeekStart,
  mapScheduleItem,
  toDateOnlyString,
} = require("../../utils/scheduleUtils");

describe("mapScheduleItem", () => {
  const row = {
    id: "SS_1",
    class_date: "2026-10-19",
    period_start: 1,
    period_end: 3,
    room: "A101",
    session_type: "Lecture",
    course_sections: {
      id: "SEC_1",
      enrolled_count: 42,
      courses: { id: "CRS_1", name: "Lập trình web" },
      teacher_assignments: [
        { teacher_id: "T1", teachers: { id: "T1", full_name: "Nguyễn Văn A" } },
      ],
    },
  };

  it("maps a fully populated row (canonical + legacy aliases)", () => {
    const mapped = mapScheduleItem(row);

    expect(mapped).toMatchObject({
      scheduleId: "SS_1",
      classDate: "2026-10-19",
      periodStart: 1,
      periodEnd: 3,
      room: "A101",
      courseId: "CRS_1",
      courseName: "Lập trình web",
      sectionId: "SEC_1",
      teacherId: "T1",
      teacherName: "Nguyễn Văn A",
      enrolledCount: 42,
    });

    expect(mapped).toMatchObject({
      tenMH: "Lập trình web",
      maLopHP: "SEC_1",
      maMH: "CRS_1",
      tietBD: "1",
      tietKT: "3",
      phongHoc: "A101",
      tenGiangVien: "Nguyễn Văn A",
      siSoHienTai: 42,
    });
  });

  it("does not create undefined/NaN values for sparse rows", () => {
    const sparse = mapScheduleItem({ id: "SS_2", class_date: "2026-10-20" });

    expect(sparse.courseName).toBeNull();
    expect(sparse.teacherName).toBeNull();
    expect(sparse.tietBD).toBe("");
    expect(sparse.tietKT).toBe("");
    expect(sparse.phongHoc).toBe("");
  });
});

describe("week math", () => {
  it("is timezone independent", () => {
    expect(toDateOnlyString(getWeekStart("2026-10-22"))).toBe("2026-10-19"); // Thu -> Mon
    expect(toDateOnlyString(getWeekStart("2026-10-19"))).toBe("2026-10-19"); // Mon -> Mon
    expect(toDateOnlyString(getWeekStart("2026-10-25"))).toBe("2026-10-19"); // Sun -> Mon
    expect(toDateOnlyString(getWeekEnd("2026-10-22"))).toBe("2026-10-25");
  });

  it("computes the ISO-ish week number used by the UI", () => {
    expect(getWeekNumber(getWeekStart("2026-10-22"))).toBe(202643);
  });

  it("maps dates to day indexes", () => {
    expect(getDayIndex("2026-10-25")).toBe(0); // Sunday
    expect(getDayIndex("2026-10-26")).toBe(1); // Monday
    expect(getDayIndex(null)).toBeNull();
  });
});

describe("buildWeeklySchedule", () => {
  it("groups items into the seven day buckets", () => {
    const week = buildWeeklySchedule([
      { classDate: "2026-10-19", scheduleId: "SS_1" },
      { classDate: "2026-10-25", scheduleId: "SS_SUN" },
    ]);

    expect(week.monday).toHaveLength(1);
    expect(week.monday[0].scheduleId).toBe("SS_1");
    expect(week.sunday).toHaveLength(1);
    expect(Object.keys(week)).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ]);
  });

  it("returns empty buckets for invalid input", () => {
    expect(buildWeeklySchedule(null)).toEqual({
      monday: [],
      tuesday: [],
      wednesday: [],
      thursday: [],
      friday: [],
      saturday: [],
      sunday: [],
    });
  });
});
