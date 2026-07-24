-- Migration 008: task management
--
-- Adds a `tasks` table so a manager can assign work items to people on
-- their team and those people can track/update status themselves.
--
--   assigned_to  -- the employee the task is for (must be on the
--                    assigning manager's team — enforced in
--                    task.routes.js, not here, since "team" is just
--                    users.manager_id and doesn't need its own constraint)
--   assigned_by  -- the manager who created the task
--   status       -- 'todo' | 'in_progress' | 'done', validated in
--                    task.routes.js (not a CHECK constraint, to stay
--                    consistent with access_requests.status / roles
--                    elsewhere in this schema, which are also
--                    app-validated VARCHARs rather than enums/CHECKs)
--
-- Run with:
--   psql "$DATABASE_URL" -f backend/src/migrations/008_add_tasks.sql

BEGIN;

CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    assigned_to INTEGER NOT NULL REFERENCES users(id),
    assigned_by INTEGER NOT NULL REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'todo', -- todo | in_progress | done
    due_date DATE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_by ON tasks(assigned_by);

COMMIT;
