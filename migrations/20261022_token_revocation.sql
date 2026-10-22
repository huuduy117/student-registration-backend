-- Revoked JWT ids (logout before expiry).
--
-- Access tokens are valid for 24h. Logout inserts the token's `jti` here and
-- middleware/auth.js rejects any token found in the table. The backend fails
-- open when the table is missing, so applying this migration is what actually
-- enables revocation.

create table if not exists public.revoked_tokens (
  jti text primary key,
  user_id text,
  expires_at timestamptz not null,
  revoked_at timestamptz not null default now()
);

create index if not exists revoked_tokens_expires_at_idx
  on public.revoked_tokens (expires_at);

-- The backend uses the service-role key, which bypasses RLS. Enabling RLS
-- without policies therefore keeps anon/authenticated clients out.
alter table public.revoked_tokens enable row level security;

-- Optional: housekeeping. Supabase supports pg_cron on most plans; if it is
-- enabled, this removes expired rows nightly. The API also opportunistically
-- deletes expired rows on every logout.
--
-- select cron.schedule(
--   'purge-revoked-tokens',
--   '17 3 * * *',
--   $$delete from public.revoked_tokens where expires_at < now()$$
-- );
