jest.mock("../../config/db", () => ({ supabase: {} }));

jest.mock("../../services/tokenService", () => ({
  revokeToken: jest.fn(),
  isTokenRevoked: jest.fn(),
}));

const { revokeToken } = require("../../services/tokenService");
const userController = require("../../controllers/userController");

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
  jest.spyOn(console, "warn").mockImplementation(() => {});
  revokeToken.mockReset();
  revokeToken.mockResolvedValue(true);
});

describe("logout", () => {
  it("revokes the current token and answers 200", async () => {
    const res = createRes();
    await userController.logout(
      { user: { userId: "u1", userRole: "Student", jti: "j1" } },
      res,
    );

    expect(revokeToken).toHaveBeenCalledWith(
      expect.objectContaining({ jti: "j1" }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ message: "Logged out" });
  });

  it("still logs the client out when persistence fails", async () => {
    revokeToken.mockRejectedValueOnce(new Error("db down"));
    const res = createRes();

    await userController.logout(
      { user: { userId: "u1", userRole: "Student", jti: "j2" } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(console.warn).toHaveBeenCalled();
  });
});
