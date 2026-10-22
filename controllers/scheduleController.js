const { supabase } = require("../config/db");
const {
  buildWeeklySchedule,
  getWeekEnd,
  getWeekNumber,
  getWeekStart,
  mapScheduleItem,
  toDateOnlyString,
} = require("../utils/scheduleUtils");

// Keep the nested select in one place so the student and weekly queries can
// never drift apart.
const SCHEDULE_SELECT = `
  id, class_date, period_start, period_end, room, session_type,
  course_sections(id, courses!course_sections_course_id_fkey(id, name), teacher_assignments(teacher_id, teachers(id, full_name)))
`;

// ─── Get Student Schedule ─────────────────────────────────────────────────────

exports.getStudentSchedule = async (req, res) => {
  const { studentId } = req.params;
  const { startDate, endDate } = req.query;

  if (!studentId) {
    return res.status(400).json({ message: "Missing student ID" });
  }

  try {
    let query = supabase
      .from("student_schedules")
      .select(SCHEDULE_SELECT)
      .eq("student_id", studentId);

    if (startDate && endDate) {
      query = query.gte("class_date", startDate).lte("class_date", endDate);
    }

    const { data, error } = await query.order("class_date").order("period_start");
    if (error) throw error;

    res.json((data || []).map(mapScheduleItem));
  } catch (err) {
    console.error("Error fetching student schedule:", err);
    res.status(500).json({ message: "Error fetching schedule" });
  }
};

// ─── Get Schedule By Week ─────────────────────────────────────────────────────

exports.getScheduleByWeek = async (req, res) => {
  const { studentId } = req.params;
  const { weekStart } = req.query;

  if (!studentId || !weekStart) {
    return res.status(400).json({ message: "Missing student ID or week start date" });
  }

  const start = getWeekStart(weekStart);
  const end = getWeekEnd(weekStart);
  if (!start || !end) {
    return res.status(400).json({ message: "Invalid week start date" });
  }

  const formattedStart = toDateOnlyString(start);
  const formattedEnd = toDateOnlyString(end);

  try {
    const { data, error } = await supabase
      .from("student_schedules")
      .select(SCHEDULE_SELECT)
      .eq("student_id", studentId)
      .gte("class_date", formattedStart)
      .lte("class_date", formattedEnd)
      .order("class_date")
      .order("period_start");

    if (error) throw error;

    res.json({
      weekStart: formattedStart,
      weekEnd: formattedEnd,
      schedule: buildWeeklySchedule((data || []).map(mapScheduleItem)),
    });
  } catch (err) {
    console.error("Error fetching weekly schedule:", err);
    res.status(500).json({ message: "Error fetching weekly schedule" });
  }
};

// ─── Get Available Weeks ──────────────────────────────────────────────────────

exports.getAvailableWeeks = async (req, res) => {
  const { studentId } = req.params;

  if (!studentId) {
    return res.status(400).json({ message: "Missing student ID" });
  }

  try {
    const { data, error } = await supabase
      .from("student_schedules")
      .select("class_date")
      .eq("student_id", studentId);

    if (error) throw error;

    const weeksMap = new Map();
    (data || []).forEach((item) => {
      const start = getWeekStart(item.class_date);
      if (!start) return;

      const startStr = toDateOnlyString(start);
      if (weeksMap.has(startStr)) return;

      weeksMap.set(startStr, {
        weekNumber: getWeekNumber(start),
        weekStart: startStr,
        weekEnd: toDateOnlyString(getWeekEnd(item.class_date)),
        _ts: start.getTime(),
      });
    });

    const results = [...weeksMap.values()]
      .sort((a, b) => a._ts - b._ts)
      .map(({ _ts, ...week }) => week);

    res.json(results);
  } catch (err) {
    console.error("Error fetching available weeks:", err);
    res.status(500).json({ message: "Error fetching available weeks" });
  }
};
