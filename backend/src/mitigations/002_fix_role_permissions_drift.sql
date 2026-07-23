-- Migration 002: fix role_permissions drift from the canonical
-- view_finance_dashboard / view_hr_dashboard / manage_users / view_audit_log
-- names in docs/schema.sql (lines ~94-131) and the frontend's PERMISSION_KEY
-- constants (Dashboard.jsx FEATURES, Financedashboard.jsx, Hrdashboard.jsx).
--
-- Written "by exclusion" rather than against a hardcoded list of stray
-- names — the task description's manage_finance_expenses /
-- manage_hr_employees are given as examples of the *pattern* ("names
-- like..."), not confirmed as the only/exact stray rows in the dev DB,
-- and this script never got to inspect that DB directly. By exclusion
-- means: whatever the stray permissions are actually called, this removes
-- them, as long as they aren't one of the 4 canonical names.
--
-- What it does:
--   1. Ensures the 4 canonical permissions exist.
--   2. Ensures admin/finance/hr hold exactly the canonical grants
--      docs/schema.sql intends (admin: all 4, finance: view_finance_dashboard,
--      hr: view_hr_dashboard).
--   3. Strips any role_permissions row for admin/finance/hr pointing at a
--      NON-canonical permission — this is what actually removes the drift.
--   4. Deletes permission rows that are now unreferenced by any role and
--      aren't part of the canonical set — i.e. the stray rows themselves.
--
-- Scoped deliberately to admin/finance/hr only, matching the task — this
-- does not touch 'employee' (intentionally zero grants) or 'manager'
-- (gated by role membership, not by role_permissions — see
-- middleware/checkPermission.js's new requireRole()).
--
-- Safe to re-run: every step uses ON CONFLICT DO NOTHING / NOT EXISTS, so a
-- second run just matches zero rows.
--
-- Run with:
--   psql "$DATABASE_URL" -f backend/src/mitigations/002_fix_role_permissions_drift.sql

BEGIN;

-- --------------------------------------------------------------------------
-- 0. Diagnostic only — not executed as part of this migration. Run this
--    SELECT by itself first (e.g. in psql or pgAdmin) if you want to see
--    exactly which rows step 3/4 below are about to remove, before running
--    the rest of this file.
--
-- SELECT r.name AS role, p.name AS permission
-- FROM role_permissions rp
-- JOIN roles r ON r.id = rp.role_id
-- JOIN permissions p ON p.id = rp.permission_id
-- WHERE r.name IN ('admin', 'finance', 'hr')
--   AND p.name NOT IN ('view_finance_dashboard', 'view_hr_dashboard', 'manage_users', 'view_audit_log');
-- --------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- 1. Ensure the canonical permissions exist.
-- --------------------------------------------------------------------------
INSERT INTO permissions (name, description) VALUES
    ('view_finance_dashboard', 'View finance records'),
    ('view_hr_dashboard', 'View HR records'),
    ('manage_users', 'Create/update/delete users and roles'),
    ('view_audit_log', 'View system audit log')
ON CONFLICT (name) DO NOTHING;

-- --------------------------------------------------------------------------
-- 2. Ensure admin/finance/hr hold exactly the canonical grants.
-- --------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin'
  AND p.name IN ('view_finance_dashboard', 'view_hr_dashboard', 'manage_users', 'view_audit_log')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'finance' AND p.name = 'view_finance_dashboard'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'hr' AND p.name = 'view_hr_dashboard'
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------------------
-- 3. Strip any non-canonical grant from admin/finance/hr. This is the step
--    that actually removes the drift, whatever the stray permissions
--    happen to be named.
-- --------------------------------------------------------------------------
DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.name IN ('admin', 'finance', 'hr')
  AND p.name NOT IN ('view_finance_dashboard', 'view_hr_dashboard', 'manage_users', 'view_audit_log');

-- --------------------------------------------------------------------------
-- 4. Clean up the now-unreferenced stray permission rows themselves.
--    NOT EXISTS guards against deleting a non-canonical permission some
--    other role still legitimately holds.
-- --------------------------------------------------------------------------
DELETE FROM permissions p
WHERE p.name NOT IN ('view_finance_dashboard', 'view_hr_dashboard', 'manage_users', 'view_audit_log')
  AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.permission_id = p.id);

COMMIT;
