const StudentModel = require("../models/studentModel");
const { sendSuccess, sendError } = require("../utils/response");
const { EnrollmentError, enrollStudent } = require("../services/enrollmentService");

exports.getAllStudents = async (req, res) => {
  try {
    const results = await StudentModel.getAllStudents();
    return sendSuccess(res, "get_all_students", results);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "INTERNAL_ERROR", "Query error");
  }
};

exports.getStudent = async (req, res) => {
  const studentId = req.params.id;
  try {
    const student = await StudentModel.getStudentById(studentId);
    if (!student) return sendError(res, 404, "NOT_FOUND", "Student not found");
    
    return sendSuccess(res, "get_student", {
      id: student.id,
      fullName: student.full_name,
      email: student.email,
      phone: student.phone,
      address: student.address,
      birthDate: student.birth_date,
      gender: student.gender,
      enrollmentDate: student.enrollment_date,
      status: student.status,
      majorId: student.major_id,
      majorName: student.majors?.name,
      className: student.classes?.name,
    });
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "INTERNAL_ERROR", "Query error");
  }
};

exports.getStudentOverview = async (req, res) => {
  const studentId = req.params.id;
  try {
    const overview = await StudentModel.getStudentOverview(studentId);
    return sendSuccess(res, "get_student_overview", overview);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "INTERNAL_ERROR", "Query error");
  }
};

// ─── WORKFLOW 3: STUDENT COURSE ENROLLMENT ─────────────────────────────────

exports.enrollInSection = async (req, res) => {
  const { sectionId } = req.body;
  const studentId = req.user.userId;

  try {
    const result = await enrollStudent({ studentId, sectionId });
    return sendSuccess(res, "enroll_in_section", result, [
      "student_courses",
      "class_enrollments",
      "course_sections",
      "student_schedules",
    ]);
  } catch (error) {
    if (error instanceof EnrollmentError) {
      return sendError(res, error.status, error.code, error.message);
    }
    console.error("Error enrolling in section:", error);
    return sendError(res, 500, "INTERNAL_ERROR", "Error enrolling in section");
  }
};
