-- Migration 005: add geolocation columns to login_events
--
-- Adds geo_lat / geo_lon / geo_city so rulesEngine.js's
-- checkImpossibleTravel() can compare consecutive logins for a user via a
-- haversine distance / time-delta speed calculation.
--
-- These are populated best-effort by auth.routes.js *after* the login_events
-- row already exists, via a call to ip-api.com. That lookup runs in a
-- try/catch with a short timeout and never blocks or fails the login itself
-- — so all three columns are nullable, and stay NULL for any row where the
-- lookup failed, timed out, or hit a private/reserved IP range (localhost,
-- 10.x.x.x, etc., which covers most of the demo/dev data in docs/schema.sql).
-- checkImpossibleTravel() and explainRiskSignals() both treat NULL geo data
-- as "nothing to compare" and skip the signal rather than erroring.
--
-- Run with:
--   psql "$DATABASE_URL" -f backend/src/migrations/005_add_login_geolocation.sql

BEGIN;

ALTER TABLE login_events
  ADD COLUMN IF NOT EXISTS geo_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS geo_lon NUMERIC,
  ADD COLUMN IF NOT EXISTS geo_city VARCHAR(100);

COMMIT;
