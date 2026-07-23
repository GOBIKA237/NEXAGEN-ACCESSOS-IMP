// Smoke test for GET /api/access-requests/me (routes/accessRequestsMe.routes.js).
//
// Same real-Postgres integration pattern as tests/auth.test.js: hits the
// actual `pool` via DATABASE_URL, so run against a disposable/dev DB.
// Requires migration 001_add_department_hierarchy_and_request_workflow.sql
// to already be applied (manager_id, manager_decision_at, manager_comment,
// admin_comment on access_requests) — see backend/src/migrations/.
//
// IMPORTANT CAVEAT: there is currently no API endpoint anywhere in the
// codebase that performs a *manager* decision on an access request, and
// the existing admin endpoint (PUT /api/admin/access-requests/:id in
// Request.routes.js, owned by Backend Dev 2) still only accepts the old
// 'approved' | 'denied' vocabulary, writes it to `status` verbatim (so it
// would store lowercase 'approved'/'denied', not the new
// APPROVED/REJECTED/PENDING_MANAGER/... vocabulary), and never touches
// manager_id/manager_comment/admin_comment. This matches the warning
// already left in the migration file itself. So this test drives the
// requester-facing parts through the real HTTP API (register, login,
// POST /api/access-requests) but simulates the manager and admin decision
// steps with direct SQL, standing in for the not-yet-built/not-yet-updated
// review endpoints. Once Dev 2 adds a manager-decision route and updates
// the admin route for the new workflow, the two `pool.query(UPDATE ...)`
// blocks below should be replaced with real requests against those routes.
//
// Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

import authRoutes from '../src/routes/auth.routes.js';
import requestRoutes from '../src/routes/Request.routes.js';
import accessRequestsMeRoutes from '../src/routes/accessRequestsMe.routes.js';
import { pool } from '../src/config/db.js';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api', requestRoutes);
app.use('/api/access-requests', accessRequestsMeRoutes);

const MANAGER_EMAIL = 'smoke-manager@example.com';
const REQUESTER_EMAIL = 'smoke-requester@example.com';
const PASSWORD = 'correct-horse-battery';

let managerId;
let requesterId;
let requesterToken;
let financeRoleId;

async function cleanup() {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE email IN ($1, $2)',
    [MANAGER_EMAIL, REQUESTER_EMAIL]
  );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;

  // Child-table-first teardown — no ON DELETE CASCADE from access_requests/
  // login_events/audit_logs to users in docs/schema.sql.
  await pool.query('DELETE FROM access_requests WHERE user_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM login_events WHERE user_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM audit_logs WHERE user_id = ANY($1)', [ids]);
  await pool.query('UPDATE users SET manager_id = NULL WHERE id = ANY($1)', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
}

before(async () => {
  await cleanup();

  const managerRes = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Smoke Manager', email: MANAGER_EMAIL, password: PASSWORD });
  assert.equal(managerRes.status, 201, `manager register failed: ${JSON.stringify(managerRes.body)}`);
  managerId = managerRes.body.id;

  const requesterRes = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Smoke Requester', email: REQUESTER_EMAIL, password: PASSWORD });
  assert.equal(requesterRes.status, 201, `requester register failed: ${JSON.stringify(requesterRes.body)}`);
  requesterId = requesterRes.body.id;

  await pool.query('UPDATE users SET manager_id = $1 WHERE id = $2', [managerId, requesterId]);

  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: REQUESTER_EMAIL, password: PASSWORD });
  assert.equal(loginRes.status, 200, `requester login failed: ${JSON.stringify(loginRes.body)}`);
  requesterToken = loginRes.body.token;

  const { rows: roleRows } = await pool.query("SELECT id FROM roles WHERE name = 'finance'");
  assert.ok(roleRows[0], "seed role 'finance' not found — run docs/schema.sql seed data first");
  financeRoleId = roleRows[0].id;
});

after(async () => {
  await cleanup();
  await pool.end();
});

test('full workflow: submit -> manager approves -> admin approves -> GET /me shape', async () => {
  const createRes = await request(app)
    .post('/api/access-requests')
    .set('Authorization', `Bearer ${requesterToken}`)
    .send({ requestedRoleId: financeRoleId });
  assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
  const requestId = createRes.body.id;

  // POST /access-requests (Request.routes.js) still hardcodes status =
  // 'pending' on insert (pre-dates this migration) — normalize to the new
  // vocabulary's starting state so the rest of this test exercises the
  // workflow docs/schema.sql actually describes.
  await pool.query(
    "UPDATE access_requests SET status = 'PENDING_MANAGER' WHERE id = $1",
    [requestId]
  );

  // --- Simulated manager decision (no real endpoint exists yet) ---
  await pool.query(
    `UPDATE access_requests
     SET status = 'PENDING_ADMIN', manager_id = $1,
         manager_decision_at = NOW(), manager_comment = 'Looks reasonable, approved.'
     WHERE id = $2`,
    [managerId, requestId]
  );

  // --- Simulated admin decision (existing endpoint uses old vocab) ---
  await pool.query(
    `UPDATE access_requests
     SET status = 'APPROVED', reviewed_by = $1, reviewed_at = NOW(),
         admin_comment = 'Confirmed with finance lead.'
     WHERE id = $2`,
    [managerId, requestId]
  );

  const meRes = await request(app)
    .get('/api/access-requests/me')
    .set('Authorization', `Bearer ${requesterToken}`);

  assert.equal(meRes.status, 200, JSON.stringify(meRes.body));
  assert.equal(meRes.body.length, 1);

  const [entry] = meRes.body;
  assert.equal(entry.id, requestId);
  assert.equal(entry.requestedAccess, 'finance');
  assert.equal(typeof entry.resource, 'string');
  assert.ok(entry.requestedAt);
  assert.equal(entry.status, 'APPROVED');

  assert.deepEqual(Object.keys(entry).sort(), [
    'adminDecision',
    'id',
    'managerDecision',
    'requestedAccess',
    'requestedAt',
    'resource',
    'status',
  ]);

  assert.equal(entry.managerDecision.decision, 'APPROVED');
  assert.equal(entry.managerDecision.comment, 'Looks reasonable, approved.');
  assert.ok(entry.managerDecision.decidedAt);

  assert.equal(entry.adminDecision.decision, 'APPROVED');
  assert.equal(entry.adminDecision.comment, 'Confirmed with finance lead.');
  assert.ok(entry.adminDecision.decidedAt);
});

test('manager-rejected request: adminDecision stays null, managerDecision.decision is REJECTED', async () => {
  const createRes = await request(app)
    .post('/api/access-requests')
    .set('Authorization', `Bearer ${requesterToken}`)
    .send({ requestedRoleId: financeRoleId });
  assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
  const requestId = createRes.body.id;

  await pool.query(
    `UPDATE access_requests
     SET status = 'REJECTED', manager_id = $1,
         manager_decision_at = NOW(), manager_comment = 'Not needed for this role.'
     WHERE id = $2`,
    [managerId, requestId]
  );

  const meRes = await request(app)
    .get('/api/access-requests/me')
    .set('Authorization', `Bearer ${requesterToken}`);

  assert.equal(meRes.status, 200, JSON.stringify(meRes.body));

  const entry = meRes.body.find((r) => r.id === requestId);
  assert.ok(entry, 'expected the manager-rejected request in the response');

  assert.equal(entry.status, 'REJECTED');
  assert.equal(entry.managerDecision.decision, 'REJECTED');
  assert.equal(entry.managerDecision.comment, 'Not needed for this role.');
  assert.equal(entry.adminDecision, null);
});

test('GET /access-requests/me requires auth', async () => {
  const res = await request(app).get('/api/access-requests/me');
  assert.equal(res.status, 401);
});
