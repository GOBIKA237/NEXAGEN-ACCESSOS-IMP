-- AccessOS shared schema — lock this on Day 1. Any change needs a team ping.

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    last_login_at TIMESTAMP,
    last_login_ip VARCHAR(45),
    -- JWTs are stateless and otherwise unrevocable, so admin-forced logout
    -- (e.g. responding to a high-risk alert) works by stamping this and
    -- having requireAuth reject any token issued before it. NULL = no
    -- forced invalidation in effect. Enforced in middleware/auth.js
    -- (requireAuth compares this against the token's `iat` on every request).
    tokens_invalid_before TIMESTAMP,
    -- Added by migration 001_add_department_hierarchy_and_request_workflow.sql
    department VARCHAR(50),
    status VARCHAR(20) DEFAULT 'active', -- 'active' | 'inactive' (account status, unrelated to access_requests.status)
    manager_id INTEGER REFERENCES users(id)
);

CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT
);

CREATE TABLE permissions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,   -- e.g. 'view_finance_dashboard'
    description TEXT
);

CREATE TABLE role_permissions (
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE access_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    requested_role_id INTEGER REFERENCES roles(id),
    -- Multi-stage workflow (was: pending | approved | denied). Added by
    -- migration 001_add_department_hierarchy_and_request_workflow.sql:
    -- PENDING_MANAGER | PENDING_ADMIN | APPROVED | REJECTED | REVOKED
    status VARCHAR(20) DEFAULT 'PENDING_MANAGER',
    requested_at TIMESTAMP DEFAULT NOW(),
    -- Admin decision (existing columns, now the *second*-stage decision).
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TIMESTAMP,
    -- Added by migration 001_add_department_hierarchy_and_request_workflow.sql
    manager_id INTEGER REFERENCES users(id), -- snapshot of the requester's manager at request time
    manager_decision_at TIMESTAMP,
    manager_comment TEXT,
    admin_comment TEXT
);

CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,     -- e.g. 'ACCESS_GRANTED', 'ROLE_UPDATED'
    resource VARCHAR(100),            -- e.g. 'finance_dashboard'
    ip_address VARCHAR(45),
    device_info TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE login_events (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    success BOOLEAN NOT NULL,
    ip_address VARCHAR(45),
    device_fingerprint VARCHAR(255),
    risk_score INTEGER DEFAULT 0,     -- written by the rules engine
    created_at TIMESTAMP DEFAULT NOW()
);

-- Added by backend/src/mitigations/003_add_hr_finance_tables.sql (Backend
-- Dev 3, hr.routes.js / finance.routes.js). See that file for the full
-- rationale, in particular why these routes gate on the existing
-- view_hr_dashboard / view_finance_dashboard permissions rather than new
-- manage_* ones.
CREATE TABLE employees (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    department VARCHAR(50),
    roles TEXT[] NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active' | 'inactive'
    joined_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE budgets (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) UNIQUE NOT NULL,
    allocated NUMERIC(12,2) NOT NULL DEFAULT 0,
    spent NUMERIC(12,2) NOT NULL DEFAULT 0 -- maintained by finance.routes.js on expense approval
);

CREATE TABLE expenses (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    amount NUMERIC(12,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
    submitted_by INTEGER REFERENCES users(id),
    submitted_at TIMESTAMP DEFAULT NOW(),
    reviewed_at TIMESTAMP
);

-- Seed a few starter roles/permissions so everyone has the same base data
INSERT INTO roles (name, description) VALUES
    ('admin', 'Full system access'),
    ('finance', 'Finance team access'),
    ('hr', 'HR team access'),
    ('employee', 'Base employee access'),
    ('manager', 'Reviews direct reports'' access requests (first-stage approval)');

INSERT INTO permissions (name, description) VALUES
    ('view_finance_dashboard', 'View finance records'),
    ('view_hr_dashboard', 'View HR records'),
    ('manage_users', 'Create/update/delete users and roles'),
    ('view_audit_log', 'View system audit log');

-- ============================================================================
-- DEMO SEED DATA — added by Member 6 (DB / Testing / DevOps)
-- Run this on a fresh database, right after the statements above. Safe to
-- re-run: it clears its own demo rows (matched by email) before re-inserting,
-- so running this script twice in a row won't error or duplicate anything.
-- ============================================================================

-- --------------------------------------------------------------------------
-- Grant permissions to the starter roles.
--
-- IMPORTANT: this block was MISSING before today. role_permissions had zero
-- rows, which means checkPermission() rejected every single user, including
-- accounts with the 'admin' role — there was nothing for it to match
-- against. This was the #1 blocker found in smoke testing; without it,
-- login "works" but every /admin/* route 403s no matter who you are.
-- --------------------------------------------------------------------------

-- admin gets every permission that currently exists
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'finance' AND p.name = 'view_finance_dashboard'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'hr' AND p.name = 'view_hr_dashboard'
ON CONFLICT DO NOTHING;

-- 'employee' intentionally gets nothing — this is what makes the locked
-- "Restricted" feature cards on the user dashboard demo-able.

-- --------------------------------------------------------------------------
-- Demo users. All five share the password:  Demo@1234
--
-- Hashed here with pgcrypto's crypt()/gen_salt('bf') instead of a hardcoded
-- string, because it needs to be a real bcrypt hash the backend's
-- bcrypt.compare() can verify at login — Postgres' bcrypt variant ($2a$) and
-- Node's `bcrypt` package ($2b$) are cross-compatible, this is a standard,
-- safe pattern.
-- --------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Clean up any previous run. Done as an explicit child-table-first teardown
-- (rather than relying on ON DELETE CASCADE) because login_events and
-- audit_logs reference users(id) WITHOUT a cascade rule in this schema —
-- a plain "DELETE FROM users ..." would fail on the second run once those
-- rows exist.
DO $$
DECLARE
  demo_emails TEXT[] := ARRAY[
    'admin@nexagen.com',
    'priya.finance@nexagen.com',
    'rahul.hr@nexagen.com',
    'employee.demo@nexagen.com',
    'ananya.pending@nexagen.com'
  ];
BEGIN
  DELETE FROM login_events    WHERE user_id IN (SELECT id FROM users WHERE email = ANY(demo_emails));
  DELETE FROM audit_logs      WHERE user_id IN (SELECT id FROM users WHERE email = ANY(demo_emails));
  DELETE FROM access_requests WHERE user_id IN (SELECT id FROM users WHERE email = ANY(demo_emails));
  DELETE FROM users WHERE email = ANY(demo_emails);
END $$;

INSERT INTO users (name, email, password_hash, created_at, last_login_at, last_login_ip) VALUES
    ('Admin Demo',     'admin@nexagen.com',          crypt('Demo@1234', gen_salt('bf')), NOW() - INTERVAL '30 days', NOW() - INTERVAL '1 day',   '10.0.0.2'),
    ('Priya Finance',  'priya.finance@nexagen.com',  crypt('Demo@1234', gen_salt('bf')), NOW() - INTERVAL '25 days', NOW() - INTERVAL '2 days',  '10.0.0.4'),
    ('Rahul HR',       'rahul.hr@nexagen.com',       crypt('Demo@1234', gen_salt('bf')), NOW() - INTERVAL '20 days', NOW() - INTERVAL '3 days',  '10.0.0.5'),
    ('Employee Demo',  'employee.demo@nexagen.com',  crypt('Demo@1234', gen_salt('bf')), NOW() - INTERVAL '15 days', NOW() - INTERVAL '5 hours', '203.0.113.42'),
    ('Ananya Pending', 'ananya.pending@nexagen.com', crypt('Demo@1234', gen_salt('bf')), NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day',   '10.0.0.9');

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r
WHERE (u.email, r.name) IN (
    ('admin@nexagen.com', 'admin'),
    ('priya.finance@nexagen.com', 'finance'),
    ('rahul.hr@nexagen.com', 'hr'),
    ('employee.demo@nexagen.com', 'employee'),
    ('ananya.pending@nexagen.com', 'employee')
)
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------------------
-- Login history for "Employee Demo" — this is the anomaly-alert setup.
--
-- Row 1: a normal login two weeks ago, mid-morning, familiar device/IP,
--        low risk score.
-- Row 2: a login this week from an unrecognized device at 2am, high risk
--        score — this is the row the alerts feature should surface once
--        GET /admin/alerts + the rules engine exist (see bug report — not
--        built yet as of today). Seeded directly so the demo doesn't
--        depend on that landing in time; if it does land, this is exactly
--        the data it needs to produce a real alert.
-- --------------------------------------------------------------------------
INSERT INTO login_events (user_id, success, ip_address, device_fingerprint, risk_score, created_at)
SELECT id, true, '198.51.100.10', 'known-laptop-chrome-mac', 5, (NOW() - INTERVAL '15 days') + INTERVAL '10 hours'
FROM users WHERE email = 'employee.demo@nexagen.com';

INSERT INTO login_events (user_id, success, ip_address, device_fingerprint, risk_score, created_at)
SELECT id, true, '203.0.113.42', 'unknown-device-android', 82, NOW() - INTERVAL '5 hours'
FROM users WHERE email = 'employee.demo@nexagen.com';

-- --------------------------------------------------------------------------
-- One pending access request — for the approve/deny demo step.
-- Ananya (employee) has requested the finance role.
-- --------------------------------------------------------------------------
INSERT INTO access_requests (user_id, requested_role_id, status, requested_at)
SELECT u.id, r.id, 'PENDING_MANAGER', NOW() - INTERVAL '2 days'
FROM users u, roles r
WHERE u.email = 'ananya.pending@nexagen.com' AND r.name = 'finance';

-- --------------------------------------------------------------------------
-- A couple of audit log rows so the Audit Log tab isn't empty on first load.
-- --------------------------------------------------------------------------
INSERT INTO audit_logs (user_id, action, resource, ip_address, created_at)
SELECT id, 'ACCESS_GRANTED', 'view_finance_dashboard', '10.0.0.4', NOW() - INTERVAL '2 days'
FROM users WHERE email = 'priya.finance@nexagen.com';

INSERT INTO audit_logs (user_id, action, resource, ip_address, created_at)
SELECT id, 'ACCESS_DENIED', 'manage_users', '10.0.0.5', NOW() - INTERVAL '1 days'
FROM users WHERE email = 'rahul.hr@nexagen.com';

-- --------------------------------------------------------------------------
-- Starter budget categories so the Finance dashboard's expense-submission
-- dropdown isn't empty on first load. Matched by category name, safe to
-- re-run. See backend/src/mitigations/003_add_hr_finance_tables.sql.
-- --------------------------------------------------------------------------
INSERT INTO budgets (category, allocated, spent) VALUES
    ('Travel', 20000, 6400),
    ('Equipment', 15000, 9800),
    ('Marketing', 25000, 11200),
    ('Operations', 30000, 18750)
ON CONFLICT (category) DO NOTHING;
