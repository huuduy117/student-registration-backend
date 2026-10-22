const { buildCorsConfig } = require("../../utils/corsConfig");

describe("CORS allowlist", () => {
  const prod = buildCorsConfig({
    env: {
      FRONTEND_URL: "https://app.example.com/",
      FRONTEND_URL_2: "https://admin.example.com",
    },
    nodeEnv: "production",
  });

  it("normalises configured origins", () => {
    expect(prod.configuredOrigins).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
      "https://student-registration-frontend-delta.vercel.app",
    ]);
  });

  it("allows exact configured origins (with or without trailing slash)", () => {
    expect(prod.isAllowedOrigin("https://app.example.com")).toBe(true);
    expect(prod.isAllowedOrigin("https://app.example.com/")).toBe(true);
    expect(prod.isAllowedOrigin("https://admin.example.com")).toBe(true);
    expect(
      prod.isAllowedOrigin("https://student-registration-frontend-delta.vercel.app"),
    ).toBe(true);
  });

  it("rejects look-alike origins that `startsWith` used to accept", () => {
    expect(prod.isAllowedOrigin("https://app.example.com.evil.com")).toBe(false);
    expect(prod.isAllowedOrigin("https://app.example.com@evil.com")).toBe(false);
    expect(prod.isAllowedOrigin("http://app.example.com")).toBe(false);
  });

  it("rejects localhost in production", () => {
    expect(prod.isAllowedOrigin("http://localhost:5173")).toBe(false);
    expect(prod.isAllowedOrigin("http://127.0.0.1:5173")).toBe(false);
  });

  it("rejects missing origins in the predicate", () => {
    expect(prod.isAllowedOrigin(undefined)).toBe(false);
    expect(prod.isAllowedOrigin("")).toBe(false);
  });

  it("accepts any localhost port only outside production", () => {
    const dev = buildCorsConfig({
      env: { FRONTEND_URL: "http://localhost:5173" },
      nodeEnv: "development",
    });

    expect(dev.isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(dev.isAllowedOrigin("http://localhost:4173")).toBe(true);
    expect(dev.isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(dev.isAllowedOrigin("https://localhost:5173")).toBe(false);
    expect(dev.isAllowedOrigin("http://localhost:5173.evil.com")).toBe(false);
  });

  it("calls back with false instead of throwing for denied origins", () => {
    const decide = (origin) => {
      let result;
      prod.options.origin(origin, (error, allowed) => {
        expect(error).toBeNull();
        result = allowed;
      });
      return result;
    };

    expect(decide(undefined)).toBe(true); // curl / server-to-server
    expect(decide("https://app.example.com")).toBe(true);
    expect(decide("https://evil.example")).toBe(false);
  });

  it("uses the same rules for preflight", () => {
    expect(prod.options.optionsSuccessStatus).toBe(204);
    expect(prod.options.credentials).toBe(true);
    expect(prod.options.allowedHeaders).toEqual(["Content-Type", "Authorization"]);
    expect(prod.options.methods).toEqual(
      expect.arrayContaining(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
    );
  });
});
