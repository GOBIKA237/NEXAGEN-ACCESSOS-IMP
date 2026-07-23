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
// Any logged-in user. Body: { requestedRoleId }
router.post('/access-requests', requireAuth, async (req, res) => {
  const { requestedRoleId } = req.body;

  if (!requestedRoleId) {
    return res.status(400).json({ error: 'requestedRoleId is required' });
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
      `INSERT INTO access_requests (user_id, requested_role_id, status, manager_id)
       VALUES ($1, $2, 'PENDING_MANAGER', $3)
       RETURNING id, user_id, requested_role_id, status, requested_at, manager_id`,
      [req.user.id, requestedRoleId, managerId]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating access request:', err);
    return res.status(500).json({ error: 'Failed to create access request' });
  }
});

// GET /admin/access-requests?status=pending
// requireAuth + checkPermission('manage_users')
router.get(
  '/admin/access-requests',
  requireAuth,
  checkPermission('manage_users'),
  async (req, res) => {
    const { status } = req.query;

    try {
      const params = [];
      let where = '';
      if (status) {
        params.push(status);
        where = `WHERE ar.status = $${params.length}`;
      }

      const result = await pool.query(
        `SELECT
           ar.id,
           ar.status,
           ar.requested_at,
           ar.reviewed_at,
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
router.put(
  '/admin/access-requests/:id',
  requireAuth,
  checkPermission('manage_users'),
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['approved', 'denied'].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved' or 'denied'" });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const updateResult = await client.query(
        `UPDATE access_requests
         SET status = $1, reviewed_by = $2, reviewed_at = NOW()
         WHERE id = $3 AND status = 'pending'
         RETURNING id, user_id, requested_role_id, status`,
        [status, req.user.id, id]
      );

      if (updateResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: 'Access request not found or already reviewed',
        });
      }

      const request = updateResult.rows[0];

      if (status === 'approved') {
        await client.query(
          `INSERT INTO user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, role_id) DO NOTHING`,
          [request.user_id, request.requested_role_id]
        );
      }

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
        where = `WHERE user_id = $${params.length}`;
      }
      params.push(limit, offset);

      const result = await pool.query(
        `SELECT id, user_id, action, resource, ip_address, device_info, created_at
         FROM audit_logs
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      return res.json(result.rows);
    } catch (err) {
      console.error('Error fetching audit logs:', err);
      return res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
  }
);

export default router;
