const express = require("express");
const router = express.Router();
const { auth, authorizeSelfOrRoles } = require("../middleware/auth");
const scheduleController = require("../controllers/scheduleController");

const STAFF_ROLES = ["Admin", "AcademicAffairs", "DepartmentHead", "FacultyHead"];

// Get student schedule — student can read own schedule, staff can read any
router.get("/:studentId", auth, authorizeSelfOrRoles("studentId", ...STAFF_ROLES), scheduleController.getStudentSchedule);

// Get schedule by week
router.get("/:studentId/week", auth, authorizeSelfOrRoles("studentId", ...STAFF_ROLES), scheduleController.getScheduleByWeek);

// Get available weeks
router.get("/:studentId/available-weeks", auth, authorizeSelfOrRoles("studentId", ...STAFF_ROLES), scheduleController.getAvailableWeeks);

module.exports = router;
