const { createFakeSupabase } = require("../helpers/fakeSupabase");

let fake;

const loadService = () => {
  jest.resetModules();
  jest.doMock("../../config/db", () => ({ supabase: fake.supabase }));
  return require("../../services/roomAccessService");
};

beforeEach(() => {
  fake = createFakeSupabase();
  fake.state.students = [
    { id: "ST1", classes: { name: "12DHTH11" } },
    { id: "ST2", classes: { name: "12DHTH12" } },
    { id: "ST3", classes: null },
  ];
});

describe("canAccessRoom", () => {
  it("requires a user and a room", async () => {
    const { canAccessRoom } = loadService();

    await expect(canAccessRoom(null, "12DHTH11")).resolves.toBe(false);
    await expect(canAccessRoom({ userId: "ST1", userRole: "Student" }, "")).resolves.toBe(false);
    await expect(canAccessRoom({ userRole: "Student" }, "12DHTH11")).resolves.toBe(false);
  });

  it("lets staff into every room", async () => {
    const { canAccessRoom } = loadService();

    for (const role of [
      "Admin",
      "AcademicAffairs",
      "DepartmentHead",
      "FacultyHead",
    ]) {
      await expect(
        canAccessRoom({ userId: "staff", userRole: role }, "12DHTH99"),
      ).resolves.toBe(true);
    }
  });

  it("lets teachers into every room", async () => {
    const { canAccessRoom } = loadService();
    await expect(
      canAccessRoom({ userId: "T1", userRole: "Teacher" }, "12DHTH99"),
    ).resolves.toBe(true);
  });

  it("lets a student into their own class room only", async () => {
    const { canAccessRoom } = loadService();

    await expect(
      canAccessRoom({ userId: "ST1", userRole: "Student" }, "12DHTH11"),
    ).resolves.toBe(true);

    await expect(
      canAccessRoom({ userId: "ST1", userRole: "Student" }, "12DHTH12"),
    ).resolves.toBe(false);
  });

  it("denies students without a class or without a student row", async () => {
    const { canAccessRoom } = loadService();

    await expect(
      canAccessRoom({ userId: "ST3", userRole: "Student" }, "12DHTH11"),
    ).resolves.toBe(false);

    await expect(
      canAccessRoom({ userId: "MISSING", userRole: "Student" }, "12DHTH11"),
    ).resolves.toBe(false);
  });

  it("denies unknown roles", async () => {
    const { canAccessRoom } = loadService();
    await expect(
      canAccessRoom({ userId: "x", userRole: "Guest" }, "12DHTH11"),
    ).resolves.toBe(false);
  });

  it("fails closed when the lookup throws", async () => {
    const { canAccessRoom } = loadService();
    jest.spyOn(console, "error").mockImplementation(() => {});
    fake.supabase.from = () => {
      throw new Error("database down");
    };

    await expect(
      canAccessRoom({ userId: "ST1", userRole: "Student" }, "12DHTH11"),
    ).resolves.toBe(false);
  });
});
