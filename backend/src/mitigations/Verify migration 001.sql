-- Run this against your local/dev DB to check whether migration 001
-- (backend/src/migrations/001_add_department_hierarchy_and_request_workflow.sql)
-- has actually been applied yet.
--
--   psql "$DATABASE_URL" -f verify_migration_001.sql

-- 1. Column check — expect 4 rows back (manager_id, manager_decision_at,
--    manager_comment, admin_comment). If you get fewer, the migration
--    hasn't run (or only partially ran).
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'access_requests'
  AND column_name IN ('manager_id', 'manager_decision_at', 'manager_comment', 'admin_comment')
ORDER BY column_name;

-- 2. Status default check — expect 'PENDING_MANAGER'::character varying.
--    If it still shows 'pending', the ALTER COLUMN ... SET DEFAULT hasn't run.
SELECT column_default
FROM information_schema.columns
WHERE table_name = 'access_requests' AND column_name = 'status';

-- 3. Any rows still stuck in the old vocabulary (pending/approved/denied)?
--    Should return 0 rows after the migration's backfill UPDATEs.
SELECT id, status FROM access_requests
WHERE status IN ('pending', 'approved', 'denied');

-- 4. 'manager' role present? (inserted by the migration, ON CONFLICT DO NOTHING)
SELECT id, name FROM roles WHERE name = 'manager';