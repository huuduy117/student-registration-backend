const express = require("express");
const router = express.Router();
const { auth, authorizeSelfOrRoles } = require("../middleware/auth");
const teacherScheduleController = require("../controllers/teacher_scheduleController");

const STAFF_ROLES = ["Admin", "AcademicAffairs", "DepartmentHead", "FacultyHead"];

// Get teacher schedule — teacher can read own schedule, staff can read any
router.get("/:teacherId", auth, authorizeSelfOrRoles("teacherId", ...STAFF_ROLES), teacherScheduleController.getTeacherSchedule);

// Get schedule by week
router.get("/:teacherId/week", auth, authorizeSelfOrRoles("teacherId", ...STAFF_ROLES), teacherScheduleController.getScheduleByWeek);

// Get available weeks
router.get("/:teacherId/available-weeks", auth, authorizeSelfOrRoles("teacherId", ...STAFF_ROLES), teacherScheduleController.getAvailableWeeks);

module.exports = router;
