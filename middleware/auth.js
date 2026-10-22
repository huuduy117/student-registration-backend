const jwt = require("jsonwebtoken");

const JWT_ALGORITHM = "HS256";

/**
 * Read the signing secret once per call. Throwing here is intentional: a
 * missing secret used to make `jwt.sign`/`jwt.verify` fail at request time with
 * confusing errors, and (worse) any hard-coded fallback would be a skeleton key.
 */
const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.trim() === "") {
    throw new Error("JWT_SECRET is not configured");
  }
  return secret;
};

const unauthorized = (message) => {
  const error = new Error(message);
  error.status = 401;
  return error;
};

/** Verify a raw JWT and guarantee the payload has the fields we rely on. */
const verifyToken = (token) => {
  if (!token) throw unauthorized("No authentication token provided");

  // Pin the algorithm: prevents `alg: none` / algorithm-confusion attacks.
  const decoded = jwt.verify(token, getJwtSecret(), {
    algorithms: [JWT_ALGORITHM],
  });

  if (
    !decoded ||
    typeof decoded !== "object" ||
    typeof decoded.userId !== "string" ||
    typeof decoded.userRole !== "string"
  ) {
    throw unauthorized("Invalid token payload");
  }

  return decoded;
};

const auth = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "No authentication token provided" });
  }

  let user;
  try {
    user = verifyToken(token);
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  // Tokens issued before revocation support have no `jti` and cannot be
  // revoked; they simply expire as before.
  if (user.jti) {
    try {
      const { isTokenRevoked } = require("../services/tokenService");
      if (await isTokenRevoked(user.jti)) {
        return res.status(401).json({ message: "Token has been revoked" });
      }
    } catch (error) {
      // tokenService fails open on purpose; this only guards an unexpected
      // programming error so a broken check cannot take the API down.
      console.error("[auth] revocation check failed:", error?.message || error);
    }
  }

  req.user = user;
  return next();
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (!roles.includes(req.user.userRole)) {
      return res.status(403).json({
        message: "You do not have permission to access this feature",
        userRole: req.user.userRole,
        requiredRoles: roles,
      });
    }
    next();
  };
};

/**
 * Allow staff roles through, plus the owner of the resource identified by
 * `req.params[paramName]`. Used for endpoints such as /students/:id or
 * /schedule/:studentId, where any authenticated user could previously read
 * another person's data.
 */
const authorizeSelfOrRoles = (paramName, ...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (roles.includes(req.user.userRole)) return next();

    const requestedId = req.params?.[paramName];
    if (requestedId && requestedId === req.user.userId) return next();

    return res.status(403).json({
      message: "You do not have permission to access this resource",
      requiredRoles: roles,
    });
  };
};

module.exports = {
  auth,
  authorize,
  authorizeSelfOrRoles,
  getJwtSecret,
  verifyToken,
  JWT_ALGORITHM,
};
