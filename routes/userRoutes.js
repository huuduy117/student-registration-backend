// backend/routes/userRoutes.js
const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const { auth } = require("../middleware/auth");

router.post("/login", userController.login);

// Revokes the current JWT (see services/tokenService.js). Mounted under
// /api/users; app.js exempts /logout from the strict login rate limiter.
router.post("/logout", auth, userController.logout);

module.exports = router;
