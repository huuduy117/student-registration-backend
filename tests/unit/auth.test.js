jest.mock("../../services/tokenService", () => ({
  isTokenRevoked: jest.fn(),
  revokeToken: jest.fn(),
}));

const jwt = require("jsonwebtoken");
const { isTokenRevoked } = require("../../services/tokenService");

const {
  auth,
  authorize,
  authorizeSelfOrRoles,
  verifyToken,
  getJwtSecret,
  JWT_ALGORITHM,
} = require("../../middleware/auth");

const SECRET = "test-secret";
const STAFF = ["Admin", "AcademicAffairs", "DepartmentHead", "FacultyHead"];

const sign = (payload, options = {}) =>
  jwt.sign(payload, SECRET, { algorithm: "HS256", expiresIn: "1h", ...options });

const makeRes = () => ({
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const run = (middleware, req) => {
  const res = makeRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
};

const runAsync = async (middleware, req) => {
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
};

beforeEach(() => {
  isTokenRevoked.mockReset();
  isTokenRevoked.mockResolvedValue(false);
});

describe("JWT configuration", () => {
  it("pins the HS256 algorithm", () => {
    expect(JWT_ALGORITHM).toBe("HS256");
  });

  it("fails fast when JWT_SECRET is missing", () => {
    const original = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET is not configured/);
    process.env.JWT_SECRET = original;
  });
});

describe("verifyToken", () => {
  it("returns the decoded payload", () => {
    const token = sign({ userId: "u1", username: "sv1", userRole: "Student" });
    expect(verifyToken(token)).toMatchObject({
      userId: "u1",
      username: "sv1",
      userRole: "Student",
    });
  });

  it("rejects a missing token", () => {
    expect(() => verifyToken(null)).toThrow(/No authentication token provided/);
    expect(() => verifyToken("")).toThrow(/No authentication token provided/);
  });

  it("rejects a token signed with another secret", () => {
    const token = jwt.sign({ userId: "u1", userRole: "Student" }, "other-secret", {
      algorithm: "HS256",
    });
    expect(() => verifyToken(token)).toThrow();
  });

  it("rejects an expired token", () => {
    const token = sign({ userId: "u1", userRole: "Student" }, { expiresIn: -10 });
    expect(() => verifyToken(token)).toThrow(/jwt expired/);
  });

  it("rejects an unsigned 'alg: none' token", () => {
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const forged = `${encode({ alg: "none", typ: "JWT" })}.${encode({
      userId: "u1",
      userRole: "Admin",
    })}.`;

    expect(() => verifyToken(forged)).toThrow();
  });

  it("rejects payloads without userId or userRole", () => {
    expect(() => verifyToken(sign({ userRole: "Student" }))).toThrow(
      /Invalid token payload/,
    );
    expect(() => verifyToken(sign({ userId: "u1" }))).toThrow(
      /Invalid token payload/,
    );
    expect(() => verifyToken(sign({ userId: 123, userRole: "Student" }))).toThrow(
      /Invalid token payload/,
    );
  });
});

describe("auth middleware", () => {
  it("rejects a request without an Authorization header", async () => {
    const { res, nextCalled } = await runAsync(auth, { headers: {} });
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it("rejects a non-Bearer scheme", async () => {
    const { res } = await runAsync(auth, { headers: { authorization: "Basic abc" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid token with a generic message", async () => {
    const { res } = await runAsync(auth, {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe("Invalid or expired token");
  });

  it("attaches req.user for a valid token", async () => {
    const token = sign({ userId: "u1", username: "sv1", userRole: "Student" });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const { nextCalled } = await runAsync(auth, req);
    expect(nextCalled).toBe(true);
    expect(req.user).toMatchObject({ userId: "u1", userRole: "Student" });
    // Legacy tokens have no jti and skip the lookup entirely.
    expect(isTokenRevoked).not.toHaveBeenCalled();
  });

  it("checks the jti of new tokens", async () => {
    const token = sign({
      userId: "u1",
      username: "sv1",
      userRole: "Student",
      jti: "token-1",
    });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const { nextCalled } = await runAsync(auth, req);

    expect(nextCalled).toBe(true);
    expect(isTokenRevoked).toHaveBeenCalledWith("token-1");
  });

  it("rejects a revoked token", async () => {
    isTokenRevoked.mockResolvedValueOnce(true);
    const token = sign({
      userId: "u1",
      username: "sv1",
      userRole: "Student",
      jti: "token-2",
    });
    const { res, nextCalled } = await runAsync(auth, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe("Token has been revoked");
    expect(nextCalled).toBe(false);
  });
});

describe("authorize", () => {
  it("allows a matching role", () => {
    const { nextCalled } = run(authorize("Student"), {
      user: { userRole: "Student" },
    });
    expect(nextCalled).toBe(true);
  });

  it("rejects a different role with 403", () => {
    const { res } = run(authorize("Teacher"), { user: { userRole: "Student" } });
    expect(res.statusCode).toBe(403);
    expect(res.body.requiredRoles).toEqual(["Teacher"]);
  });

  it("returns 401 when auth did not run", () => {
    const { res } = run(authorize("Student"), {});
    expect(res.statusCode).toBe(401);
  });
});

describe("authorizeSelfOrRoles", () => {
  const guard = authorizeSelfOrRoles("id", ...STAFF);

  it("allows the owner", () => {
    const { nextCalled } = run(guard, {
      user: { userId: "u1", userRole: "Student" },
      params: { id: "u1" },
    });
    expect(nextCalled).toBe(true);
  });

  it("allows staff members", () => {
    STAFF.forEach((role) => {
      const { nextCalled } = run(guard, {
        user: { userId: "staff-1", userRole: role },
        params: { id: "u2" },
      });
      expect(nextCalled).toBe(true);
    });
  });

  it("blocks another student (IDOR)", () => {
    const { res } = run(guard, {
      user: { userId: "u1", userRole: "Student" },
      params: { id: "u2" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("blocks when the parameter is missing", () => {
    const { res } = run(guard, {
      user: { userId: "u1", userRole: "Student" },
      params: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 without req.user", () => {
    const { res } = run(guard, { params: { id: "u1" } });
    expect(res.statusCode).toBe(401);
  });
});
