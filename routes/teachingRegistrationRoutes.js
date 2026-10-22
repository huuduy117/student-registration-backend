const express = require("express");
const router = express.Router();
const { auth, authorize } = require("../middleware/auth");
const teacherController = require("../controllers/teacherController");

// Reading class sections is for teachers (and staff who oversee them).
const READ_ROLES = ["Teacher", "AcademicAffairs", "Admin"];

// Get available class sections (for teacher teaching registration)
router.get("/class-sections/available", auth, authorize(...READ_ROLES), teacherController.getAvailableClassSections);

// Get approved class sections
router.get("/class-sections/approved", auth, authorize(...READ_ROLES), teacherController.getApprovedClassSections);

// Create new class sections for approved requests — academic office only
router.post("/class-sections/create-new", auth, authorize("AcademicAffairs", "Admin"), teacherController.createNewClassSections);

// Register to teach a class — never reachable by students
router.post("/register-teaching", auth, authorize("Teacher"), teacherController.registerTeaching);

// Get available time slots for a class section
router.get("/class-sections/:sectionId/time-slots", auth, authorize(...READ_ROLES), teacherController.getAvailableTimeSlots);

module.exports = router;
