const { supabase } = require("../config/db");
const {
  buildWeeklySchedule,
  getWeekEnd,
  getWeekNumber,
  getWeekStart,
  mapScheduleItem,
  toDateOnlyString,
} = require("../utils/scheduleUtils");

const SCHEDULE_SELECT = `
  id, class_date, period_start, period_end, room, session_type,
  course_sections(id, enrolled_count, courses!course_sections_course_id_fkey(id, name))
`;

// ─── Get Teacher Schedule ─────────────────────────────────────────────────────

exports.getTeacherSchedule = async (req, res) => {
  const { teacherId } = req.params;
  const { startDate, endDate } = req.query;

  if (!teacherId) {
    return res.status(400).json({ message: "Missing teacher ID" });
  }

  try {
    let query = supabase
      .from("teacher_schedules")
      .select(SCHEDULE_SELECT)
      .eq("teacher_id", teacherId);

    if (startDate && endDate) {
      query = query.gte("class_date", startDate).lte("class_date", endDate);
    }

    const { data, error } = await query.order("class_date").order("period_start");
    if (error) throw error;

    res.json((data || []).map(mapScheduleItem));
  } catch (err) {
    console.error("Error fetching teacher schedule:", err?.message || err);
    res.status(500).json({
      message: "Error fetching schedule",
      detail: err?.message || String(err),
      hint: err?.hint,
    });
  }
};

// ─── Get Schedule By Week ─────────────────────────────────────────────────────

exports.getScheduleByWeek = async (req, res) => {
  const { teacherId } = req.params;
  const { weekStart } = req.query;

  if (!teacherId || !weekStart) {
    return res.status(400).json({ message: "Missing teacher ID or week start date" });
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
      .from("teacher_schedules")
      .select(SCHEDULE_SELECT)
      .eq("teacher_id", teacherId)
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
    console.error("Error fetching weekly schedule:", err?.message || err);
    res.status(500).json({
      message: "Error fetching weekly schedule",
      detail: err?.message || String(err),
      hint: err?.hint,
    });
  }
};

// ─── Get Available Weeks ──────────────────────────────────────────────────────

exports.getAvailableWeeks = async (req, res) => {
  const { teacherId } = req.params;

  if (!teacherId) {
    return res.status(400).json({ message: "Missing teacher ID" });
  }

  try {
    const { data, error } = await supabase
      .from("teacher_schedules")
      .select("class_date")
      .eq("teacher_id", teacherId);

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
