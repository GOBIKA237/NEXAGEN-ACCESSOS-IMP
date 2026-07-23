-- Migration 004: add audit_logs.target_user_id
--
-- audit_logs.user_id has always meant "the actor" (whoever performed the
-- action). For self-actions (ACCESS_GRANTED, LOGIN, etc.) actor and
-- subject are the same person, so that's fine. But for actions performed
-- ON someone else — an admin/manager approving or rejecting another
-- user's access request, an admin invalidating another user's session —
-- the audit log only ever showed the actor's name, never the affected
-- user's. This adds a nullable target_user_id so both are tracked, and
-- GET /admin/audit-logs can show the target (the person the action was
-- about) instead of the actor where one exists.
--
-- Run with:
--   psql "$DATABASE_URL" -f backend/src/migrations/004_add_audit_log_target_user.sql

BEGIN;

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS target_user_id INTEGER REFERENCES users(id);

COMMIT;
