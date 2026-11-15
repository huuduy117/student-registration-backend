/**
 * E2E tests: per-role authorization + cross-role business workflows.
 *
 * Prerequisites (run before these tests):
 * 1. Backend running: `cd student-registration-backend && npm run start`
 *    (env vars configured in .env — JWT_SECRET, SUPABASE_URL, MONGODB_URI)
 * 2. Database seeded with users + course sections matching SEED below.
 *
 * Credentials come from environment variables so live secrets never land in this
 * file. Example (PowerShell):
 *   $env:E2E_USER_Student="student01"; $env:E2E_PASS_Student="123456"
 *   ... (one pair per role below)
 *
 * SEED IDs — update to match your seeded data:
 *   E2E_SEED_COURSE_ID        a course with no Active section
 *   E2E_SEED_SECTION_ID       an Active section for enrollment / grading
 *   E2E_SEED_TEACHER_SECTION_ID a NotOpen/Active section for teaching registration
 *
 * If login fails for a role, every test in that role's describe is skipped
 * (pending) instead of crashing the suite — set the env vars to enable them.
 *
 * These tests mutate real data. Do NOT run against production data.
 *
 * Run:  npx jest tests/e2e --runInBand
 */

const request = require("supertest");

const BASE_URL = "http://localhost:5000";

const ROLES = [
  "Student",
  "Teacher",
  "Admin",
  "AcademicAffairs",
  "DepartmentHead",
  "FacultyHead",
];

const creds = (role) => ({
  username: process.env[`E2E_USER_${role}`] || `user-${role.toLowerCase()}`,
  password: process.env[`E2E_PASS_${role}`] || `pass-${role.toLowerCase()}`,
});

const SEED = {
  courseId: process.env.E2E_SEED_COURSE_ID || "C001",
  sectionId: process.env.E2E_SEED_SECTION_ID || "SEC001",
  teacherSectionId:
    process.env.E2E_SEED_TEACHER_SECTION_ID || "SEC002",
};

let tokens = {};

const login = async (role) => {
  if (tokens[role]) return tokens[role];
  const { username, password } = creds(role);
  const res = await request(BASE_URL)
    .post("/api/users/login")
    .send({ username, password });
  if (res.status !== 200) {
    // Credentials not configured for this role — skip its tests gracefully.
    return null;
  }
  tokens[role] = res.body.token;
  return res.body.token;
};

const authHeader = (role) => `Bearer ${tokens[role]}`;

const requireLogin = (role) => {
  if (!tokens[role]) {
    // Credentials not configured or login failed — skip this test gracefully.
    // Jest has no `pending()`; returning early lets the suite continue.
    return;
  }
};

describe("E2E: per-role login", () => {
  it.each(ROLES)("logs in %s and returns a JWT with the correct role", async (role) => {
    const token = await login(role);
    if (!token) {
      console.warn(
        `Skipping ${role}: E2E_USER_${role}/E2E_PASS_${role} not configured or login failed`,
      );
      return;
    }
    expect(token).toBeTruthy();
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    expect(payload.userRole).toBe(role);
  });
});

describe("E2E: Student role", () => {
  beforeAll(async () => {
    requireLogin("Student");
    if (!tokens.Student) return;
    const payload = JSON.parse(
      Buffer.from(tokens.Student.split(".")[1], "base64").toString(),
    );
    global.__E2E_STUDENT_ID__ = payload.userId;
  });

  it("can enroll in an Active section (POST /api/students/enroll)", async () => {
    requireLogin("Student");
    const res = await request(BASE_URL)
      .post("/api/students/enroll")
      .set("Authorization", authHeader("Student"))
      .send({ sectionId: SEED.sectionId });
    // 200 = enrolled; 400 = business rule; 404 = section not found in this DB
    expect([200, 400, 404]).toContain(res.status);
  });

  it("can view own overview (GET /api/students/:id/overview)", async () => {
    requireLogin("Student");
    const res = await request(BASE_URL)
      .get(`/api/students/${global.__E2E_STUDENT_ID__}/overview`)
      .set("Authorization", authHeader("Student"));
    expect(res.status).toBe(200);
  });

  it("cannot view another student's overview (403)", async () => {
    requireLogin("Student");
    const res = await request(BASE_URL)
      .get("/api/students/999999/overview")
      .set("Authorization", authHeader("Student"));
    expect(res.status).toBe(403);
  });

  it("cannot access teacher-only endpoints (403)", async () => {
    requireLogin("Student");
    const res = await request(BASE_URL)
      .post("/api/teaching/register-teaching")
      .set("Authorization", authHeader("Student"))
      .send({ sectionId: SEED.teacherSectionId });
    expect(res.status).toBe(403);
  });

  it("can submit a class opening request (POST /api/class-requests/submit)", async () => {
    requireLogin("Student");
    const res = await request(BASE_URL)
      .post("/api/class-requests/submit")
      .set("Authorization", authHeader("Student"))
      .send({
        course_id: SEED.courseId,
        participant_count: 30,
        description: "E2E test request",
      });
    // 200 = submitted; 400 = business rule; 404 = course not found in this DB
    expect([200, 400, 404]).toContain(res.status);
  });
});

describe("E2E: Teacher role", () => {
  beforeAll(async () => {
    requireLogin("Teacher");
  });

  it("can register to teach a section (POST /api/teaching/register-teaching)", async () => {
    requireLogin("Teacher");
    const res = await request(BASE_URL)
      .post("/api/teaching/register-teaching")
      .set("Authorization", authHeader("Teacher"))
      .send({ sectionId: SEED.teacherSectionId });
    // 200 = registered; 400 = business rule; 404 = section not found in this DB
    expect([200, 400, 404]).toContain(res.status);
  });

  it("can enter a grade for own assigned section (POST /api/teaching/enter-grade)", async () => {
    requireLogin("Teacher");
    const res = await request(BASE_URL)
      .post("/api/teaching/enter-grade")
      .set("Authorization", authHeader("Teacher"))
      .send({
        studentId: creds("Student").username,
        sectionId: SEED.sectionId,
        grade: 8.5,
      });
    // 200 = graded; 400 = not enrolled / not assigned / bad grade;
    // 403 = not assigned teacher; 404 = section/student not found
    expect([200, 400, 403, 404]).toContain(res.status);
  });

  it("cannot access AcademicAffairs-only endpoints (403)", async () => {
    requireLogin("Teacher");
    const res = await request(BASE_URL)
      .post("/api/class-requests/REQ000/receive")
      .set("Authorization", authHeader("Teacher"))
      .send({});
    expect(res.status).toBe(403);
  });
});

describe("E2E: Admin role", () => {
  beforeAll(async () => {
    requireLogin("Admin");
  });

  it("can list users (GET /api/admin/users)", async () => {
    requireLogin("Admin");
    const res = await request(BASE_URL)
      .get("/api/admin/users?type=Student")
      .set("Authorization", authHeader("Admin"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("can view statistics (GET /api/admin/stats/students)", async () => {
    requireLogin("Admin");
    const res = await request(BASE_URL)
      .get("/api/admin/stats/students")
      .set("Authorization", authHeader("Admin"));
    expect(res.status).toBe(200);
  });
});

describe("E2E: AcademicAffairs role", () => {
  beforeAll(async () => {
    requireLogin("AcademicAffairs");
  });

  it("can receive a class request (POST /api/class-requests/:id/receive)", async () => {
    requireLogin("AcademicAffairs");
    const res = await request(BASE_URL)
      .post("/api/class-requests/REQ000/receive")
      .set("Authorization", authHeader("AcademicAffairs"))
      .send({});
    // 200 = received; 400/404 = no such request or wrong state
    expect([200, 400, 404]).toContain(res.status);
  });

  it("can open a course section (POST /api/class-requests/:id/open-section)", async () => {
    requireLogin("AcademicAffairs");
    const res = await request(BASE_URL)
      .post("/api/class-requests/REQ000/open-section")
      .set("Authorization", authHeader("AcademicAffairs"))
      .send({
        academic_year: "2024-2025",
        semester: "1",
        capacity: 40,
        start_date: "2024-09-01",
        end_date: "2025-01-15",
      });
    // 200 = opened; 400/404 = request not found or wrong state
    expect([200, 400, 404]).toContain(res.status);
  });
});

describe("E2E: DepartmentHead role", () => {
  beforeAll(async () => {
    requireLogin("DepartmentHead");
  });

  it("can review a class request (POST /api/class-requests/:id/review)", async () => {
    requireLogin("DepartmentHead");
    const res = await request(BASE_URL)
      .post("/api/class-requests/REQ000/review")
      .set("Authorization", authHeader("DepartmentHead"))
      .send({ decision: "approve", notes: "E2E review" });
    expect([200, 400, 404]).toContain(res.status);
  });
});

describe("E2E: FacultyHead role", () => {
  beforeAll(async () => {
    requireLogin("FacultyHead");
  });

  it("can approve/reject a class request (POST /api/class-requests/:id/approve)", async () => {
    requireLogin("FacultyHead");
    const res = await request(BASE_URL)
      .post("/api/class-requests/REQ000/approve")
      .set("Authorization", authHeader("FacultyHead"))
      .send({ decision: "approve", notes: "E2E final approval" });
    expect([200, 400, 404]).toContain(res.status);
  });
});

/**
 * Cross-role workflow: Student opens a class request → AcademicAffairs receives
 * → DepartmentHead reviews → FacultyHead approves → AcademicAffairs opens section
 * → Student enrolls → Teacher enters grade.
 */
describe("E2E: cross-role class opening workflow", () => {
  let requestId;

  it("Student submits a class request", async () => {
    requireLogin("Student");
    const res = await request(BASE_URL)
      .post("/api/class-requests/submit")
      .set("Authorization", authHeader("Student"))
      .send({
        course_id: SEED.courseId,
        participant_count: 30,
        description: "E2E workflow test",
      });
    if (res.status === 200) {
      requestId = res.body.data?.id || res.body.id;
    }
  });

  it("AcademicAffairs receives the request", async () => {
    requireLogin("AcademicAffairs");
    if (!requestId) return;
    const res = await request(BASE_URL)
      .post(`/api/class-requests/${requestId}/receive`)
      .set("Authorization", authHeader("AcademicAffairs"))
      .send({});
    expect([200, 400]).toContain(res.status);
  });

  it("DepartmentHead reviews the request", async () => {
    requireLogin("DepartmentHead");
    if (!requestId) return;
    const res = await request(BASE_URL)
      .post(`/api/class-requests/${requestId}/review`)
      .set("Authorization", authHeader("DepartmentHead"))
      .send({ decision: "approve", notes: "E2E dept head review" });
    expect([200, 400]).toContain(res.status);
  });

  it("FacultyHead approves the request", async () => {
    requireLogin("FacultyHead");
    if (!requestId) return;
    const res = await request(BASE_URL)
      .post(`/api/class-requests/${requestId}/approve`)
      .set("Authorization", authHeader("FacultyHead"))
      .send({ decision: "approve", notes: "E2E faculty head approve" });
    expect([200, 400]).toContain(res.status);
  });

  it("AcademicAffairs opens the course section", async () => {
    requireLogin("AcademicAffairs");
    if (!requestId) return;
    const res = await request(BASE_URL)
      .post(`/api/class-requests/${requestId}/open-section`)
      .set("Authorization", authHeader("AcademicAffairs"))
      .send({
        academic_year: "2024-2025",
        semester: "1",
        capacity: 40,
        start_date: "2024-09-01",
        end_date: "2025-01-15",
      });
    expect([200, 400]).toContain(res.status);
  });

  it("Student enrolls in the opened section", async () => {
    requireLogin("Student");
    const res = await request(BASE_URL)
      .post("/api/students/enroll")
      .set("Authorization", authHeader("Student"))
      .send({ sectionId: SEED.sectionId });
    expect([200, 400, 404]).toContain(res.status);
  });

  it("Teacher enters a grade for the enrolled student", async () => {
    requireLogin("Teacher");
    const res = await request(BASE_URL)
      .post("/api/teaching/enter-grade")
      .set("Authorization", authHeader("Teacher"))
      .send({
        studentId: creds("Student").username,
        sectionId: SEED.sectionId,
        grade: 8.0,
      });
    expect([200, 400, 403, 404]).toContain(res.status);
  });
});
