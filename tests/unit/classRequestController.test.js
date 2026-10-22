const { createFakeSupabase } = require("../helpers/fakeSupabase");

let fake;

const loadController = () => {
  jest.resetModules();
  jest.doMock("../../config/db", () => ({ supabase: fake.supabase }));
  return require("../../controllers/classRequestController");
};

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

beforeEach(() => {
  fake = createFakeSupabase();
});

describe("getAvailableCourses", () => {
  it("returns only courses without an Active section", async () => {
    fake.state.courses = [
      { id: "C1", name: "Cơ sở dữ liệu", credits: 3 },
      { id: "C2", name: "Lập trình web", credits: 4 },
      { id: "C3", name: "Mạng máy tính", credits: 3 },
    ];
    fake.state.course_sections = [
      { id: "S1", course_id: "C1", status: "Active" },
      { id: "S2", course_id: "C3", status: "Active" },
      { id: "S3", course_id: "C3", status: "Closed" },
    ];

    const controller = loadController();
    const res = createRes();
    await controller.getAvailableCourses({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe("get_available_courses");
    expect(res.body.data).toEqual([
      { id: "C2", name: "Lập trình web", credits: 4 },
    ]);
  });

  it("returns every course when no section is Active", async () => {
    fake.state.courses = [
      { id: "C1", name: "A", credits: 3 },
      { id: "C2", name: "B", credits: 4 },
    ];
    fake.state.course_sections = [{ id: "S1", course_id: "C1", status: "Closed" }];

    const controller = loadController();
    const res = createRes();
    await controller.getAvailableCourses({}, res);

    expect(res.body.data).toHaveLength(2);
  });
});

describe("submitClassRequest validation", () => {
  const submit = async (body) => {
    const controller = loadController();
    const res = createRes();
    await controller.submitClassRequest(
      { body, user: { userId: "ST1" } },
      res,
    );
    return res;
  };

  it("rejects a missing course_id and participant_count", async () => {
    const res = await submit({});

    expect(res.statusCode).toBe(400);
    expect(res.body.error_code).toBe("INVALID_INPUT");
    expect(res.body.context.errors).toEqual([
      { field: "course_id", expected: "existing course id", actual: null },
      { field: "participant_count", expected: ">= 1", actual: null },
    ]);
  });

  it("rejects participant_count below 1", async () => {
    const res = await submit({ course_id: "C1", participant_count: 0 });

    expect(res.statusCode).toBe(400);
    expect(res.body.context.errors).toEqual([
      { field: "participant_count", expected: ">= 1", actual: 0 },
    ]);
  });

  it("rejects a student who is not Enrolled", async () => {
    fake.state.students = [{ id: "ST1", status: "Suspended" }];

    const res = await submit({ course_id: "C1", participant_count: 1 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error_code).toBe("STUDENT_NOT_ENROLLED");
  });

  it("rejects a duplicate active/passed enrollment", async () => {
    fake.state.students = [{ id: "ST1", status: "Enrolled" }];
    fake.state.courses = [{ id: "C1", prerequisite: null }];
    fake.state.student_courses = [
      { student_id: "ST1", course_id: "C1", grade: 8 },
    ];

    const res = await submit({ course_id: "C1", participant_count: 1 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error_code).toBe("DUPLICATE_ENROLLMENT");
  });

  it("creates the request and returns the persisted row", async () => {
    fake.state.students = [{ id: "ST1", status: "Enrolled" }];
    fake.state.courses = [{ id: "C1", prerequisite: null }];
    fake.state.student_courses = [];
    fake.state.class_requests = [];

    const res = await submit({
      course_id: "C1",
      participant_count: 12,
      description: "  cần mở lớp  ",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      student_id: "ST1",
      course_id: "C1",
      participant_count: 12,
      overall_status: "Submitted",
    });
    expect(fake.state.class_requests).toHaveLength(1);
  });
});
