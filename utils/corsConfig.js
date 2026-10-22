/**
 * CORS configuration kept in one place so it can be unit-tested and so the
 * preflight handler always uses the same rules as normal requests.
 */

const normalizeOrigin = (value) => (value || "").trim().replace(/\/+$/, "");

// Fallback for the known production frontend. `FRONTEND_URL` (and
// `FRONTEND_URL_2`) should still be set on the host; this default keeps CORS
// working when the env var is missing, which is what produced the
// "Redirect is not allowed for a preflight request" failure in production.
const DEFAULT_DEPLOYED_ORIGINS = [
  "https://student-registration-frontend-delta.vercel.app",
];

const buildCorsConfig = ({
  env = process.env,
  nodeEnv = process.env.NODE_ENV,
} = {}) => {
  const configuredOrigins = [
    env.FRONTEND_URL,
    env.FRONTEND_URL_2,
    ...DEFAULT_DEPLOYED_ORIGINS,
  ]
    .filter(Boolean)
    .map(normalizeOrigin);

  const isProduction = nodeEnv === "production";

  // In development any localhost port is accepted (Vite may pick another one).
  const isLocalDevOrigin = (origin) =>
    !isProduction && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

  const isAllowedOrigin = (origin) => {
    if (!origin) return false;
    const normalized = normalizeOrigin(origin);
    return configuredOrigins.includes(normalized) || isLocalDevOrigin(normalized);
  };

  const options = {
    origin: (origin, callback) => {
      // No Origin header = server-to-server / curl / health checks. CORS does
      // not apply to them; browsers always send the header.
      if (!origin) return callback(null, true);

      // `false` omits the CORS headers so the browser blocks the response.
      // Do not throw: a 500 would be noisy and would not add any security.
      return callback(null, isAllowedOrigin(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  };

  return { configuredOrigins, isAllowedOrigin, options };
};

module.exports = { buildCorsConfig, DEFAULT_DEPLOYED_ORIGINS };
