// backend/controllers/userController.js
const { supabase } = require("../config/db");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { findUserByUsername } = require("../models/userModel");
const { getJwtSecret, JWT_ALGORITHM } = require("../middleware/auth");
const { revokeToken } = require("../services/tokenService");

const BCRYPT_ROUNDS = 10;

/**
 * Legacy rows store passwords in plaintext. On the first successful login they
 * are upgraded to a bcrypt hash, so the plaintext fallback stops being a
 * permanent weakness. Failures here must never block a valid login.
 */
const upgradePasswordHash = async (userId, password) => {
  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { error } = await supabase.from("users").update({ password: hash }).eq("id", userId);
    if (error) throw error;
  } catch (error) {
    console.warn("[login] could not upgrade password hash:", error?.message || error);
  }
};

const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "Please provide username and password" });
  }

  try {
    const user = await findUserByUsername(username);

    if (!user) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    const isBcryptHash = typeof user.password === "string" && user.password.startsWith("$2");
    const isPasswordValid = isBcryptHash
      ? await bcrypt.compare(password, user.password)
      : user.password === password;

    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    if (!isBcryptHash) {
      await upgradePasswordHash(user.id, password);
    }

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        userRole: user.role,
        // Needed so logout can revoke this exact token before its expiry.
        jti: crypto.randomUUID(),
      },
      getJwtSecret(),
      { algorithm: JWT_ALGORITHM, expiresIn: "24h" }
    );

    return res.status(200).json({
      message: "Login successful",
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        userRole: user.role,
      },
      token,
    });
  } catch (error) {
    // Never send the internal error object to the client.
    console.error("Login error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

/**
 * Revoke the caller's token. Always answers 200: the client is logging out
 * regardless, and leaking whether the revocation row was persisted is not
 * useful. If the DB is unavailable, the in-process denylist still applies.
 */
const logout = async (req, res) => {
  try {
    await revokeToken(req.user);
  } catch (error) {
    console.warn("[logout] revocation failed:", error?.message || error);
  }
  return res.status(200).json({ message: "Logged out" });
};

module.exports = { login, logout };
