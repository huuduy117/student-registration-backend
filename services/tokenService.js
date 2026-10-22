/**
 * JWT revocation list.
 *
 * Access tokens are stateless, so the only way to invalidate one before its
 * `exp` is a server-side list. Tokens now carry a random `jti`; logging out
 * writes that id to `revoked_tokens` (see
 * migrations/20261022_token_revocation.sql) and every authenticated request
 * checks it.
 *
 * The lookup is cached for a short time because the same token is sent on
 * every request. If the table has not been migrated yet, or the database is
 * temporarily unreachable, the check fails open: otherwise a missing
 * migration would log every user out of every endpoint. Revocation therefore
 * only becomes effective after the migration is applied - the README explains
 * this trade-off.
 */

const NEGATIVE_CACHE_TTL_MS = 30_000;
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** jti -> epoch ms until which the token is known to be revoked. */
const revokedUntil = new Map();
/** jti -> { revoked, at } result of the last database lookup. */
const lookupCache = new Map();
let warnedAboutMissingTable = false;

const getSupabase = () => require("../config/db").supabase;

const purgeExpiredCache = (now = Date.now()) => {
  for (const [jti, expiresAt] of revokedUntil) {
    if (expiresAt <= now) revokedUntil.delete(jti);
  }
  for (const [jti, entry] of lookupCache) {
    if (now - entry.at > NEGATIVE_CACHE_TTL_MS) lookupCache.delete(jti);
  }
};

/**
 * @param {string|undefined} jti
 * @returns {Promise<boolean>} true when the token has been revoked
 */
const isTokenRevoked = async (jti) => {
  if (!jti) return false;

  const now = Date.now();
  purgeExpiredCache(now);

  const revokedAt = revokedUntil.get(jti);
  if (revokedAt && revokedAt > now) return true;

  const cached = lookupCache.get(jti);
  if (cached && now - cached.at < NEGATIVE_CACHE_TTL_MS) return cached.revoked;

  try {
    const { data, error } = await getSupabase()
      .from("revoked_tokens")
      .select("jti")
      .eq("jti", jti)
      .maybeSingle();

    if (error) throw error;
    const revoked = Boolean(data);
    lookupCache.set(jti, { revoked, at: now });
    return revoked;
  } catch (error) {
    if (!warnedAboutMissingTable) {
      warnedAboutMissingTable = true;
      console.warn(
        "[token] revocation lookup failed (has migrations/20261022_token_revocation.sql been applied?):",
        error?.message || error,
      );
    }
    // Fail open - see the comment at the top of the file.
    return false;
  }
};

/**
 * Persist a logout. The in-memory entry takes effect immediately even if the
 * database write fails, so the current process stops accepting the token.
 *
 * @param {{jti?: string, userId?: string, exp?: number}} payload decoded JWT
 * @returns {Promise<boolean>} whether the revocation was persisted
 */
const revokeToken = async (payload) => {
  const jti = payload?.jti;
  if (!jti) return false;

  const now = Date.now();
  const expiresAtMs = payload.exp ? payload.exp * 1000 : now + DEFAULT_TOKEN_TTL_MS;
  revokedUntil.set(jti, expiresAtMs);
  lookupCache.set(jti, { revoked: true, at: now });

  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("revoked_tokens").upsert({
      jti,
      user_id: payload.userId ?? null,
      expires_at: new Date(expiresAtMs).toISOString(),
    });
    if (error) throw error;

    // Opportunistic cleanup; logout is rare enough that this is cheap.
    await supabase
      .from("revoked_tokens")
      .delete()
      .lt("expires_at", new Date(now).toISOString());

    return true;
  } catch (error) {
    console.warn("[token] could not persist revocation:", error?.message || error);
    return false;
  }
};

/** Test helper: clear all process-local state. */
const resetTokenCache = () => {
  revokedUntil.clear();
  lookupCache.clear();
  warnedAboutMissingTable = false;
};

module.exports = {
  isTokenRevoked,
  revokeToken,
  resetTokenCache,
  NEGATIVE_CACHE_TTL_MS,
};
