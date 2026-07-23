-- Migration 003: employees / budgets / expenses tables for hr.routes.js and
-- finance.routes.js (Backend Dev 3).
--
-- Additive only — no existing table/column is touched. Mirrors the same
-- CREATE TABLE statements now committed in docs/schema.sql, so a fresh
-- `psql -f schema.sql` install and an existing DB that runs this migration
-- end up identical.
--
-- IMPORTANT — permission gating: hr.routes.js / finance.routes.js gate on
-- the CANONICAL permissions view_hr_dashboard / view_finance_dashboard
-- (the ones docs/schema.sql seeds and 002_fix_role_permissions_drift.sql
-- protects), NOT on manage_hr_employees / manage_finance_expenses. Those
-- two names appear only as illustrative examples in 002's comment header —
-- 002 treats anything outside the 4 canonical permission names as drift
-- and deletes it (see its step 3/4). Gating these new routes on
-- manage_hr_employees / manage_finance_expenses would mean 002 (or any
-- future run of it) strips the grant from every role, including admin,
-- and the HR/Finance dashboards 403 for everyone. See the note at the top
-- of hr.routes.js and finance.routes.js, and the PR description, for the
-- full explanation. No new permission rows are created by this migration.
--
-- Safe to re-run: every statement uses IF NOT EXISTS / ON CONFLICT DO
-- NOTHING, so a second run just matches zero rows.
--
-- Run with:
--   psql "$DATABASE_URL" -f backend/src/mitigations/003_add_hr_finance_tables.sql

BEGIN;

-- --------------------------------------------------------------------------
-- employees — HR's own roster, deliberately separate from `users` (system
-- login accounts). Onboarding an employee here does not create a `users`
-- row / login — that's a distinct step Backend Dev 1's auth flow would own
-- if/when the two get linked.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    department VARCHAR(50),
    roles TEXT[] NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active' | 'inactive'
    joined_at TIMESTAMP DEFAULT NOW()
);

-- --------------------------------------------------------------------------
-- budgets — one row per spending category. `spent` is maintained by
-- finance.routes.js: it's incremented when an expense in that category is
-- approved (PUT /finance/expenses/:id), not edited directly.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budgets (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) UNIQUE NOT NULL,
    allocated NUMERIC(12,2) NOT NULL DEFAULT 0,
    spent NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- --------------------------------------------------------------------------
-- expenses — submitted by any authenticated user with view_finance_dashboard
-- access, decided (approved/rejected) by the same gate. `submitted_by`
-- references `users`, not `employees` — expense submission rides on the
-- logged-in session (req.user.id), which only exists for `users` rows.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    amount NUMERIC(12,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
    submitted_by INTEGER REFERENCES users(id),
    submitted_at TIMESTAMP DEFAULT NOW(),
    reviewed_at TIMESTAMP
);

-- --------------------------------------------------------------------------
-- Demo seed — a few starter budget categories so the expense-submission
-- dropdown (Financedashboard.jsx reads its category list from GET
-- /finance/budgets) isn't empty on first load. Matched by category name,
-- safe to re-run.
-- --------------------------------------------------------------------------
INSERT INTO budgets (category, allocated, spent) VALUES
    ('Travel', 20000, 6400),
    ('Equipment', 15000, 9800),
    ('Marketing', 25000, 11200),
    ('Operations', 30000, 18750)
ON CONFLICT (category) DO NOTHING;

COMMIT;
