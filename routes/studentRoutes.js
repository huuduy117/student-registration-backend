const express = require("express");
const router = express.Router();
const { auth, authorize, authorizeSelfOrRoles } = require("../middleware/auth");
const studentController = require("../controllers/studentController");

const STAFF_ROLES = ["Admin", "AcademicAffairs", "DepartmentHead", "FacultyHead"];

// Protected — staff roles can view all students
router.get("/", auth, authorize(...STAFF_ROLES), studentController.getAllStudents);

router.post("/enroll", auth, authorize("Student"), studentController.enrollInSection);

// Protected — student can view own profile, staff can view any
router.get("/:id", auth, authorizeSelfOrRoles("id", ...STAFF_ROLES), studentController.getStudent);

// API lấy tổng quan tín chỉ và học kỳ hiện tại
router.get("/:id/overview", auth, authorizeSelfOrRoles("id", ...STAFF_ROLES), studentController.getStudentOverview);

module.exports = router;
