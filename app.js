require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const http = require("http");
const { connectMongoDB } = require("./config/db");

// ─── Routes ───────────────────────────────────────────────────────────────────
const userRoutes = require("./routes/userRoutes");
const studentRoutes = require("./routes/studentRoutes");
const teacherRoutes = require("./routes/teacherRoutes");
const adminUserRoutes = require("./routes/adminUserRoutes");
const classRequestRoutes = require("./routes/classRequestRoutes");
const scheduleRoutes = require("./routes/scheduleRoutes");
const newsfeedRoutes = require("./routes/newsfeedRoutes");
const passwordResetRoutes = require("./routes/passwordResetRoutes");
const teacherScheduleRoutes = require("./routes/teacher_scheduleRoutes");
const teachingRegistrationRoutes = require("./routes/teachingRegistrationRoutes");

// ─── WebSocket ─────────────────────────────────────────────────────────────────
const WebSocketController = require("./controllers/websocket/WebSocketController");

const app = express();
const server = http.createServer(app);

// ─── Security Middleware ───────────────────────────────────────────────────────

// Security headers
app.use(helmet());

// CORS — allow only frontend origin
const allowedOrigins = [
  process.env.FRONTEND_URL || "http://localhost:5173",
  process.env.FRONTEND_URL_2,
].filter(Boolean);
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later." },
});
app.use(globalLimiter);

// Auth endpoints rate limiter (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts, please try again later." },
});

app.use(express.json({ limit: "10kb" }));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/users", authLimiter, userRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/teachers", teacherRoutes);
app.use("/api/admin", adminUserRoutes);
app.use("/api/class-requests", classRequestRoutes);
app.use("/api/schedule", scheduleRoutes);
app.use("/api/newsfeed", newsfeedRoutes);
app.use("/api/password-reset", authLimiter, passwordResetRoutes);
app.use("/api/teacher-schedule", teacherScheduleRoutes);
app.use("/api/teaching", teachingRegistrationRoutes);

// ─── Start Server ─────────────────────────────────────────────────────────────
async function startServer() {
  try {
    const mongoDB = await connectMongoDB();

    // Initialize WebSocket controller
    const wsController = new WebSocketController(mongoDB);
    const chatRouter = await wsController.initialize();
    app.use("/api/chat", chatRouter);

    // Handle WebSocket upgrade requests
    server.on("upgrade", (request, socket, head) => {
      wsController.handleUpgrade(request, socket, head);
    });

    const port = process.env.PORT || 5000;
    server.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();