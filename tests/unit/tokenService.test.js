const { createFakeSupabase } = require("../helpers/fakeSupabase");

let fake;

const loadService = () => {
  jest.resetModules();
  jest.doMock("../../config/db", () => ({ supabase: fake.supabase }));
  return require("../../services/tokenService");
};

beforeEach(() => {
  fake = createFakeSupabase();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("isTokenRevoked", () => {
  it("ignores tokens without a jti", async () => {
    const { isTokenRevoked } = loadService();
    await expect(isTokenRevoked(undefined)).resolves.toBe(false);
    await expect(isTokenRevoked(null)).resolves.toBe(false);
  });

  it("returns true when the jti is in the denylist", async () => {
    fake.state.revoked_tokens = [
      { jti: "j1", user_id: "u1", expires_at: "2099-01-01T00:00:00.000Z" },
    ];
    const { isTokenRevoked } = loadService();

    await expect(isTokenRevoked("j1")).resolves.toBe(true);
    await expect(isTokenRevoked("j2")).resolves.toBe(false);
  });

  it("caches a negative lookup for repeated requests with the same token", async () => {
    const { isTokenRevoked } = loadService();
    const fromSpy = jest.spyOn(fake.supabase, "from");

    await expect(isTokenRevoked("j3")).resolves.toBe(false);
    await expect(isTokenRevoked("j3")).resolves.toBe(false);

    expect(fromSpy).toHaveBeenCalledTimes(1);
  });

  it("fails open when the table is missing", async () => {
    const { isTokenRevoked } = loadService();
    fake.supabase.from = () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: null,
            error: { code: "42P01", message: "relation does not exist" },
          }),
        }),
      }),
    });

    await expect(isTokenRevoked("j4")).resolves.toBe(false);
  });
});

describe("revokeToken", () => {
  it("persists the jti and blocks it immediately", async () => {
    const { isTokenRevoked, revokeToken } = loadService();
    const exp = Math.floor(Date.now() / 1000) + 3600;

    const persisted = await revokeToken({
      jti: "j5",
      userId: "u1",
      exp,
    });

    expect(persisted).toBe(true);
    expect(fake.state.revoked_tokens).toHaveLength(1);
    expect(fake.state.revoked_tokens[0]).toMatchObject({
      jti: "j5",
      user_id: "u1",
    });

    await expect(isTokenRevoked("j5")).resolves.toBe(true);
  });

  it("still revokes in-process when the write fails", async () => {
    const { isTokenRevoked, revokeToken } = loadService();
    fake.failInsert.revoked_tokens = true;

    const persisted = await revokeToken({ jti: "j6", userId: "u1" });

    expect(persisted).toBe(false);
    await expect(isTokenRevoked("j6")).resolves.toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });

  it("returns false when the token has no jti", async () => {
    const { revokeToken } = loadService();
    await expect(revokeToken({ userId: "u1" })).resolves.toBe(false);
  });
});
