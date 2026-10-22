const jwt = require("jsonwebtoken");
const express = require("express");
const request = require("supertest");
const cors = require("cors");

const { buildCorsConfig } = require("../../utils/corsConfig");

jest.mock("../../controllers/studentController", () => ({
  getAllStudents: (req, res) => res.json({ ok: true, route: "students.list" }),
  enrollInSection: (req, res) => res.json({ ok: true, route: "students.enroll" }),
  getStudent: (req, res) => res.json({ ok: true, id: req.params.id }),
  getStudentOverview: (req, res) =>
    res.json({ ok: true, overview: req.params.id }),
}));

jest.mock("../../controllers/scheduleController", () => ({
  getStudentSchedule: (req, res) => res.json({ ok: true, id: req.params.studentId }),
  getScheduleByWeek: (req, res) => res.json({ ok: true, id: req.params.studentId }),
  getAvailableWeeks: (req, res) => res.json({ ok: true, id: req.params.studentId }),
}));

jest.mock("../../controllers/teacher_scheduleController", () => ({
  getTeacherSchedule: (req, res) => res.json({ ok: true, id: req.params.teacherId }),
  getScheduleByWeek: (req, res) => res.json({ ok: true, id: req.params.teacherId }),
  getAvailableWeeks: (req, res) => res.json({ ok: true, id: req.params.teacherId }),
}));

jest.mock("../../controllers/teacherController", () => ({
  getAvailableClassSections: (req, res) => res.json({ ok: true, route: "available" }),
  getApprovedClassSections: (req, res) => res.json({ ok: true, route: "approved" }),
  createNewClassSections: (req, res) => res.json({ ok: true, route: "create" }),
  registerTeaching: (req, res) => res.json({ ok: true, route: "register" }),
  getAvailableTimeSlots: (req, res) => res.json({ ok: true, route: "slots" }),
}));

jest.mock("../../controllers/userController", () => ({
  login: (req, res) => res.json({ ok: true, route: "users.login" }),
  logout: (req, res) => res.json({ ok: true, route: "users.logout" }),
}));

const studentRoutes = require("../../routes/studentRoutes");
const scheduleRoutes = require("../../routes/scheduleRoutes");
const teacherScheduleRoutes = require("../../routes/teacher_scheduleRoutes");
const teachingRegistrationRoutes = require("../../routes/teachingRegistrationRoutes");
const userRoutes = require("../../routes/userRoutes");

const tokenFor = (userRole, userId = "u1") =>
  jwt.sign({ userId, username: `${userRole}-${userId}`, userRole }, "test-secret", {
    algorithm: "HS256",
    expiresIn: "1h",
  });

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const app = express();
app.use(express.json());
app.use("/api/students", studentRoutes);
app.use("/api/schedule", scheduleRoutes);
app.use("/api/teacher-schedule", teacherScheduleRoutes);
app.use("/api/teaching", teachingRegistrationRoutes);
app.use("/api/users", userRoutes);

describe("student routes", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/students/u1");
    expect(res.status).toBe(401);
  });

  it("lets a student read their own profile", async () => {
    const res = await request(app)
      .get("/api/students/u1")
      .set(auth(tokenFor("Student", "u1")));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("u1");
  });

  it("blocks a student from reading another student (IDOR)", async () => {
    const res = await request(app)
      .get("/api/students/u2")
      .set(auth(tokenFor("Student", "u1")));
    expect(res.status).toBe(403);
  });

  it("blocks the overview of another student", async () => {
    const res = await request(app)
      .get("/api/students/u2/overview")
      .set(auth(tokenFor("Student", "u1")));
    expect(res.status).toBe(403);
  });

  it("allows staff to read any student", async () => {
    for (const role of ["Admin", "AcademicAffairs", "DepartmentHead", "FacultyHead"]) {
      const res = await request(app)
        .get("/api/students/u2")
        .set(auth(tokenFor(role, "staff")));
      expect(res.status).toBe(200);
    }
  });

  it("restricts the student list to staff", async () => {
    const denied = await request(app)
      .get("/api/students")
      .set(auth(tokenFor("Student", "u1")));
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get("/api/students")
      .set(auth(tokenFor("Admin", "admin")));
    expect(allowed.status).toBe(200);
  });

  it("restricts enrollment to students", async () => {
    const teacher = await request(app)
      .post("/api/students/enroll")
      .set(auth(tokenFor("Teacher", "t1")))
      .send({ sectionId: "SEC1" });
    expect(teacher.status).toBe(403);

    const student = await request(app)
      .post("/api/students/enroll")
      .set(auth(tokenFor("Student", "s1")))
      .send({ sectionId: "SEC1" });
    expect(student.status).toBe(200);
  });
});

describe("schedule routes", () => {
  it("lets a student read their own schedule only", async () => {
    const own = await request(app)
      .get("/api/schedule/u1/week")
      .set(auth(tokenFor("Student", "u1")));
    expect(own.status).toBe(200);

    const other = await request(app)
      .get("/api/schedule/u2/week")
      .set(auth(tokenFor("Student", "u1")));
    expect(other.status).toBe(403);
  });

  it("lets staff read any student schedule", async () => {
    const res = await request(app)
      .get("/api/schedule/u9")
      .set(auth(tokenFor("AcademicAffairs", "staff")));
    expect(res.status).toBe(200);
  });
});

describe("teacher schedule routes", () => {
  it("lets a teacher read their own schedule only", async () => {
    const own = await request(app)
      .get("/api/teacher-schedule/t1")
      .set(auth(tokenFor("Teacher", "t1")));
    expect(own.status).toBe(200);

    const other = await request(app)
      .get("/api/teacher-schedule/t2")
      .set(auth(tokenFor("Teacher", "t1")));
    expect(other.status).toBe(403);
  });

  it("lets staff read any teacher schedule", async () => {
    const res = await request(app)
      .get("/api/teacher-schedule/t9")
      .set(auth(tokenFor("Admin", "admin")));
    expect(res.status).toBe(200);
  });
});

describe("teaching registration routes", () => {
  it("blocks students from every workflow endpoint", async () => {
    const token = auth(tokenFor("Student", "s1"));

    const getApproved = await request(app)
      .get("/api/teaching/class-sections/approved")
      .set(token);
    expect(getApproved.status).toBe(403);

    const register = await request(app)
      .post("/api/teaching/register-teaching")
      .set(token)
      .send({ sectionId: "SEC1" });
    expect(register.status).toBe(403);

    const createNew = await request(app)
      .post("/api/teaching/class-sections/create-new")
      .set(token)
      .send({});
    expect(createNew.status).toBe(403);

    const slots = await request(app)
      .get("/api/teaching/class-sections/SEC1/time-slots")
      .set(token);
    expect(slots.status).toBe(403);
  });

  it("lets teachers register to teach", async () => {
    const res = await request(app)
      .post("/api/teaching/register-teaching")
      .set(auth(tokenFor("Teacher", "t1")))
      .send({ sectionId: "SEC1" });
    expect(res.status).toBe(200);
  });

  it("restricts section creation to the academic office", async () => {
    const teacher = await request(app)
      .post("/api/teaching/class-sections/create-new")
      .set(auth(tokenFor("Teacher", "t1")))
      .send({});
    expect(teacher.status).toBe(403);

    const academic = await request(app)
      .post("/api/teaching/class-sections/create-new")
      .set(auth(tokenFor("AcademicAffairs", "a1")))
      .send({});
    expect(academic.status).toBe(200);
  });
});

describe("user routes", () => {
  it("protects logout with the auth middleware", async () => {
    const denied = await request(app).post("/api/users/logout");
    expect(denied.status).toBe(401);

    const allowed = await request(app)
      .post("/api/users/logout")
      .set(auth(tokenFor("Student", "u1")));
    expect(allowed.status).toBe(200);
    expect(allowed.body.route).toBe("users.logout");
  });
});

describe("CORS integration", () => {
  const corsApp = express();
  corsApp.use(
    cors(
      buildCorsConfig({
        env: { FRONTEND_URL: "https://app.example.com" },
        nodeEnv: "production",
      }).options,
    ),
  );
  corsApp.get("/ping", (req, res) => res.json({ ok: true }));

  it("adds the CORS header for an allowed origin", async () => {
    const res = await request(corsApp)
      .get("/ping")
      .set("Origin", "https://app.example.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("omits the CORS header for a look-alike origin", async () => {
    const res = await request(corsApp)
      .get("/ping")
      .set("Origin", "https://app.example.com.evil.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflight with the same allowlist", async () => {
    const allowed = await request(corsApp)
      .options("/ping")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "GET");
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.com");

    const denied = await request(corsApp)
      .options("/ping")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
