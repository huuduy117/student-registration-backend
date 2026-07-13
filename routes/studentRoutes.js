const express = require("express");
const router = express.Router();
const studentController = require("../controllers/studentController");
const { auth, authorize } = require("../middleware/auth");

// Protected — staff roles can view all students
router.get("/", auth, authorize("Admin", "AcademicAffairs", "DepartmentHead", "FacultyHead"), studentController.getAllStudents);

router.post("/enroll", auth, authorize("Student"), studentController.enrollInSection);

// Protected — student can view own profile, staff can view any
router.get("/:id", auth, studentController.getStudent);

// API lấy tổng quan tín chỉ và học kỳ hiện tại
router.get("/:id/overview", auth, studentController.getStudentOverview);

module.exports = router;
