import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = Router();

// GET /roles — any authenticated user, not admin-only. Returns just the
// safe fields (id/name/description) so the Request Access dropdown on the
// user dashboard can populate. Deliberately separate from the admin-only
// GET /admin/roles in rbac.routes.js, which stays locked to manage_users.
router.get('/roles', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, description FROM roles ORDER BY name'
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching roles:', err);
    res.status(500).json({ error: 'Failed to fetch roles' });
  }
});

// POST /access-requests
// Any logged-in user. Body: { requestedRoleId, durationHours? }
//
// durationHours is optional — e.g. 4 / 24 / 168 (one week). Omit it (or
// pass null) for a permanent request, unchanged from before. It's only
// the *ask* at this point: nothing is time-boxed yet, and it has no
// effect until an admin approves the request (see the PUT
// /admin/access-requests/:id handler below, which is what actually
// stamps access_requests.expires_at / user_roles.expires_at from it).
router.post('/access-requests', requireAuth, async (req, res) => {
  const { requestedRoleId, durationHours } = req.body;

  if (!requestedRoleId) {
    return res.status(400).json({ error: 'requestedRoleId is required' });
  }

  let normalizedDurationHours = null;
  if (durationHours !== undefined && durationHours !== null) {
    const parsed = Number(durationHours);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return res
        .status(400)
        .json({ error: 'durationHours must be a positive integer number of hours, or omitted for permanent access' });
    }
    normalizedDurationHours = parsed;
  }

  try {
    // manager_id is a snapshot of the requester's manager at request time
    // (docs/schema.sql), not a live lookup on review — if the requester's
    // manager changes later, this request stays with whoever it was
    // assigned to when submitted.
    const { rows: userRows } = await pool.query(
      'SELECT manager_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const managerId = userRows[0]?.manager_id ?? null;

    const result = await pool.query(
      `INSERT INTO access_requests (user_id, requested_role_id, status, manager_id, duration_hours)
       VALUES ($1, $2, 'PENDING_MANAGER', $3, $4)
       RETURNING id, user_id, requested_role_id, status, requested_at, manager_id, duration_hours, expires_at`,
      [req.user.id, requestedRoleId, managerId, normalizedDurationHours]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating access request:', err);
    return res.status(500).json({ error: 'Failed to create access request' });
  }
});

// GET /admin/access-requests?status=PENDING
// requireAuth + checkPermission('manage_users')
//
// `status` is matched against the real enum stored in access_requests.status:
// PENDING_MANAGER | PENDING_ADMIN | APPROVED | REJECTED | REVOKED (see
// docs/schema.sql).
//
// ADMIN VISIBILITY: there is currently no UI/route for assigning a manager
// to a user, so every request lands with manager_id = NULL and would sit at
// PENDING_MANAGER forever if Admin only ever looked at PENDING_ADMIN — that
// was the bug reported (submitted requests never showed up for Admin).
// Admin needs to be able to see and decide on a request regardless of
// whether it's picked up a manager decision yet, so `status=PENDING` is an
// alias covering BOTH not-yet-finalized stages (PENDING_MANAGER and
// PENDING_ADMIN). Any other value passed is matched exactly (e.g. for a
// future "history" view over APPROVED/REJECTED/REVOKED). No `status` at all
// still returns everything, same as before.
// client.js's getAccessRequests() calls this with ?status=PENDING.
const ADMIN_QUEUE_ALIAS = { PENDING: ['PENDING_MANAGER', 'PENDING_ADMIN'] };

router.get(
  '/admin/access-requests',
  requireAuth,
  checkPermission('manage_users'),
  async (req, res) => {
    const { status } = req.query;

    try {
      const params = [];
      let where = '';
      if (status && ADMIN_QUEUE_ALIAS[status]) {
        params.push(ADMIN_QUEUE_ALIAS[status]);
        where = `WHERE ar.status = ANY($${params.length}::text[])`;
      } else if (status) {
        params.push(status);
        where = `WHERE ar.status = $${params.length}`;
      }

      const result = await pool.query(
        `SELECT
           ar.id,
           ar.status,
           ar.requested_at,
           ar.reviewed_at,
           ar.duration_hours,
           ar.expires_at,
           u.id   AS user_id,
           u.email AS user_email,
           u.name  AS user_name,
           r.id   AS requested_role_id,
           r.name AS requested_role_name,
           rb.id  AS reviewed_by_id,
           rb.email AS reviewed_by_email
         FROM access_requests ar
         JOIN users u ON u.id = ar.user_id
         JOIN roles r ON r.id = ar.requested_role_id
         LEFT JOIN users rb ON rb.id = ar.reviewed_by
         ${where}
         ORDER BY ar.requested_at DESC`,
        params
      );

      // Shape rows to match docs/api-contract.md:
      // [{ id, user: {...}, requestedRole: {...}, requestedAt }]
      // The frontend (AdminDashboard.jsx) reads req.user.name and
      // req.requestedRole.name, so the flat/snake_case row shape from
      // the query above must be nested here before sending it out.
      const shaped = result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        requestedAt: row.requested_at,
        reviewedAt: row.reviewed_at,
        durationHours: row.duration_hours,
        expiresAt: row.expires_at,
        user: {
          id: row.user_id,
          email: row.user_email,
          name: row.user_name,
        },
        requestedRole: {
          id: row.requested_role_id,
          name: row.requested_role_name,
        },
        reviewedBy: row.reviewed_by_id
          ? { id: row.reviewed_by_id, email: row.reviewed_by_email }
          : null,
      }));

      return res.json(shaped);
    } catch (err) {
      console.error('Error fetching access requests:', err);
      return res.status(500).json({ error: 'Failed to fetch access requests' });
    }
  }
);

// PUT /admin/access-requests/:id
// Body: { status: 'approved' | 'denied' }
// requireAuth + checkPermission('manage_users')
//
// Admin can decide a request from EITHER PENDING_MANAGER or PENDING_ADMIN —
// not just PENDING_ADMIN. There's currently no way to assign a manager to a
// user, so every request would otherwise sit at PENDING_MANAGER forever
// with nobody able to act on it. This makes Admin the always-available
// final authority: if a manager gets assigned later and reviews first, the
// request naturally arrives here already at PENDING_ADMIN (unchanged
// behavior); if not, Admin can still act on it directly from
// PENDING_MANAGER (an implicit skip-level override). Either starting status
// still requires it to be a non-terminal request — APPROVED/REJECTED/
// REVOKED can't be re-decided. The stored result is written back in the
// same uppercase enum as every other stage
// (PENDING_MANAGER/PENDING_ADMIN/APPROVED/REJECTED/REVOKED) rather than
// the raw lowercase request-body value, so it stays consistent with what
// accessRequestsMe.routes.js and Dashboard.jsx's STATUS_LABELS expect.
const ADMIN_DECISION_STATUS = {
  approved: 'APPROVED',
  denied: 'REJECTED',
};

router.put(
  '/admin/access-requests/:id',
  requireAuth,
  checkPermission('manage_users'),
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const newStatus = ADMIN_DECISION_STATUS[status];
    if (!newStatus) {
      return res.status(400).json({ error: "status must be 'approved' or 'denied'" });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // expires_at is only ever set here, on APPROVED, and only when the
      // original request carried a duration_hours (set at creation time in
      // POST /access-requests). Denials/permanent requests leave it NULL —
      // computing it inline in the UPDATE (rather than reading
      // duration_hours back and doing a second write) keeps the "was this
      // approved with a duration" decision and the timestamp write atomic.
      const updateResult = await client.query(
        `UPDATE access_requests
         SET status = $1,
             reviewed_by = $2,
             reviewed_at = NOW(),
             expires_at = CASE
               WHEN $1 = 'APPROVED' AND duration_hours IS NOT NULL
                 THEN NOW() + (duration_hours || ' hours')::interval
               ELSE expires_at
             END
         WHERE id = $3 AND status IN ('PENDING_MANAGER', 'PENDING_ADMIN')
         RETURNING id, user_id, requested_role_id, status, duration_hours, expires_at`,
        [newStatus, req.user.id, id]
      );

      if (updateResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: 'Access request not found or already reviewed',
        });
      }

      const request = updateResult.rows[0];

      if (newStatus === 'APPROVED') {
        // Same expires_at as just stamped on the access_requests row above,
        // copied onto the grant itself — user_roles.expires_at is what
        // checkPermission.js actually enforces against, so the request
        // record and the live grant always agree on when it lapses.
        await client.query(
          `INSERT INTO user_roles (user_id, role_id, expires_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, role_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
          [request.user_id, request.requested_role_id, request.expires_at]
        );
      }

      // Pull the requester's name + the role they asked for so the audit
      // log shows a human-readable "who/what" instead of just the raw
      // access_request id (which meant nothing without cross-referencing
      // the access_requests table by hand).
      const { rows: contextRows } = await client.query(
        `SELECT u.name AS user_name, r.name AS role_name
         FROM users u, roles r
         WHERE u.id = $1 AND r.id = $2`,
        [request.user_id, request.requested_role_id]
      );
      const requesterName = contextRows[0]?.user_name ?? `user:${request.user_id}`;
      const roleName = contextRows[0]?.role_name ?? `role:${request.requested_role_id}`;

      // CLAUDE.md: "Every permission check and admin action gets written to
      // audit_logs" — this route was missing it (manager.routes.js's
      // equivalent decision already logs its own).
      //
      // user_id stays the actor (the admin who made the call);
      // target_user_id is the requester the decision was actually about.
      // GET /admin/audit-logs below shows target_user_id as the row's
      // "user" when present, so the log reads as "who it happened to"
      // rather than "who clicked the button."
      await client.query(
        `INSERT INTO audit_logs (user_id, target_user_id, action, resource, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.user.id,
          request.user_id,
          newStatus === 'APPROVED' ? 'ADMIN_APPROVED_REQUEST' : 'ADMIN_REJECTED_REQUEST',
          `access_request:${id} — ${requesterName} (${roleName})`,
          req.ip,
        ]
      );

      await client.query('COMMIT');
      return res.json(request);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error reviewing access request:', err);
      return res.status(500).json({ error: 'Failed to review access request' });
    } finally {
      client.release();
    }
  }
);

// POST /admin/access-requests/:id/revoke
// requireAuth + checkPermission('manage_users')
//
// Ends an already-APPROVED grant early — e.g. someone's temporary access
// hasn't hit its expires_at yet but should be cut off now, or a permanent
// grant needs pulling before the next review cycle. Only acts on a request
// currently APPROVED; anything else (still pending, already rejected,
// already revoked) is a 409 rather than silently no-op'ing.
//
// user_roles.expires_at is what checkPermission.js actually enforces
// (`ur.expires_at IS NULL OR ur.expires_at > NOW()`), evaluated at
// check-time on every request — so stamping it to NOW() here is enough to
// stop the grant working on the very next permission check. No cron job,
// no separate "revoked" flag on user_roles to keep in sync.
router.post(
  '/admin/access-requests/:id/revoke',
  requireAuth,
  checkPermission('manage_users'),
  async (req, res) => {
    const { id } = req.params;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const updateResult = await client.query(
        `UPDATE access_requests
         SET status = 'REVOKED'
         WHERE id = $1 AND status = 'APPROVED'
         RETURNING id, user_id, requested_role_id, status`,
        [id]
      );

      if (updateResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Only an approved request can be revoked.',
        });
      }

      const request = updateResult.rows[0];

      // Expire the live grant immediately. This targets the specific
      // (user_id, role_id) pair from the request rather than deleting —
      // deleting would also erase the row's own history (when it was
      // granted, whether it already had a temporary expires_at from
      // duration_hours). If the row's somehow already gone (role
      // reassigned/removed since approval), this just affects 0 rows —
      // access_requests.status = REVOKED is still the authoritative record.
      await client.query(
        `UPDATE user_roles
         SET expires_at = NOW()
         WHERE user_id = $1 AND role_id = $2`,
        [request.user_id, request.requested_role_id]
      );

      // Same "who/what" lookup as the approve/reject route above, so the
      // audit log reads as a name + role rather than raw ids.
      const { rows: contextRows } = await client.query(
        `SELECT u.name AS user_name, r.name AS role_name
         FROM users u, roles r
         WHERE u.id = $1 AND r.id = $2`,
        [request.user_id, request.requested_role_id]
      );
      const requesterName = contextRows[0]?.user_name ?? `user:${request.user_id}`;
      const roleName = contextRows[0]?.role_name ?? `role:${request.requested_role_id}`;

      // Same actor/target pattern as the rest of this file: user_id is the
      // admin who revoked it, target_user_id is whose access it was.
      await client.query(
        `INSERT INTO audit_logs (user_id, target_user_id, action, resource, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.user.id,
          request.user_id,
          'ADMIN_REVOKED_ACCESS',
          `access_request:${id} — ${requesterName} (${roleName})`,
          req.ip,
        ]
      );

      await client.query('COMMIT');
      return res.json(request);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error revoking access request:', err);
      return res.status(500).json({ error: 'Failed to revoke access request' });
    } finally {
      client.release();
    }
  }
);

// GET /admin/audit-logs?limit=50&userId=
// requireAuth + checkPermission('view_audit_log')
router.get(
  '/admin/audit-logs',
  requireAuth,
  checkPermission('view_audit_log'),
  async (req, res) => {
    const { userId } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    try {
      const params = [];
      let where = '';
      if (userId) {
        params.push(userId);
        where = `WHERE al.user_id = $${params.length}`;
      }
      params.push(limit, offset);

      const result = await pool.query(
        `SELECT al.id, al.action, al.resource, al.ip_address, al.device_info, al.created_at,
                actor.id AS actor_id, actor.name AS actor_name, actor.email AS actor_email,
                target.id AS target_id, target.name AS target_name, target.email AS target_email
         FROM audit_logs al
         LEFT JOIN users actor  ON actor.id  = al.user_id
         LEFT JOIN users target ON target.id = al.target_user_id
         ${where}
         ORDER BY al.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      // "user" is whoever the row is ABOUT: the target when this action was
      // performed on someone else (approvals/rejections/session actions),
      // falling back to the actor for self-actions (ACCESS_GRANTED, etc.)
      // where there's no separate target. performedBy always stays the
      // actor, so who-did-it is never lost even though the UI only shows
      // one name column today — see AdminDashboard.jsx's auditUserName().
      const shaped = result.rows.map((row) => ({
        id: row.id,
        user: row.target_id
          ? { id: row.target_id, name: row.target_name, email: row.target_email }
          : row.actor_id
          ? { id: row.actor_id, name: row.actor_name, email: row.actor_email }
          : null,
        performedBy: row.actor_id
          ? { id: row.actor_id, name: row.actor_name, email: row.actor_email }
          : null,
        action: row.action,
        resource: row.resource,
        ipAddress: row.ip_address,
        deviceInfo: row.device_info,
        createdAt: row.created_at,
      }));

      return res.json(shaped);
    } catch (err) {
      console.error('Error fetching audit logs:', err);
      return res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
  }
);

export default router;
