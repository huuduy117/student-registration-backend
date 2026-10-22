/**
 * Chat room authorisation.
 *
 * Chat rooms are named after a student class (e.g. "12DHTH11"), not after an
 * id, so a Student may only join the room matching their own class. Staff and
 * teachers are allowed into every room: teachers are not linked to a class
 * cohort in the schema, and staff need to moderate every class channel.
 */

const STAFF_ROLES = new Set([
  "Admin",
  "AcademicAffairs",
  "DepartmentHead",
  "FacultyHead",
]);

const ALL_ROOM_ROLES = new Set(["Teacher"]);

const getSupabase = () => require("../config/db").supabase;

const normaliseRoomId = (roomId) =>
  typeof roomId === "string" ? roomId.trim() : "";

/**
 * @param {{userId?: string, userRole?: string}|null|undefined} user decoded JWT
 * @param {string} roomId
 * @returns {Promise<boolean>}
 */
const canAccessRoom = async (user, roomId) => {
  const room = normaliseRoomId(roomId);
  if (!room || !user || typeof user.userRole !== "string") return false;

  // Staff and teachers may read/post in any class room.
  if (STAFF_ROLES.has(user.userRole) || ALL_ROOM_ROLES.has(user.userRole)) {
    return true;
  }

  if (user.userRole !== "Student" || !user.userId) return false;

  try {
    const { data, error } = await getSupabase()
      .from("students")
      .select("classes(name)")
      .eq("id", user.userId)
      .maybeSingle();

    if (error) throw error;
    return data?.classes?.name === room;
  } catch (error) {
    // Fail closed for chat: a database error must not grant access.
    console.error("[chat] room access check failed:", error?.message || error);
    return false;
  }
};

module.exports = { canAccessRoom, STAFF_ROLES, ALL_ROOM_ROLES };
