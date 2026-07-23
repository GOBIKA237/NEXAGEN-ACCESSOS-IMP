import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/checkPermission.js';

const router = Router();

// Every route here scopes to req.user.id (the JWT subject) as "the
// manager" — never from a param or body, so there's no way to view or act
// on another manager's team/requests by guessing an id.

// GET /manager/team
// Response: [{ id, name, email, department, status }]
router.get('/team', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, department, status
       FROM users
       WHERE manager_id = $1
       ORDER BY name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching team:', err);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// GET /manager/access-requests
// Response: [{ id, user: {...}, requestedRole: {...}, status, requestedAt,
//              managerComment }]
// Returns every request assigned to this manager at ALL stages, not just
// PENDING_MANAGER — Managerdashboard.jsx renders this same array twice:
// AccessRequestsReview filters status === 'PENDING_MANAGER', and
// ApprovalHistory filters status !== 'PENDING_MANAGER' from it.
router.get('/access-requests', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         ar.id,
         ar.status,
         ar.requested_at,
         ar.manager_comment,
         u.id    AS user_id,
         u.email AS user_email,
         u.name  AS user_name,
         r.id    AS requested_role_id,
         r.name  AS requested_role_name
       FROM access_requests ar
       JOIN users u ON u.id = ar.user_id
       JOIN roles r ON r.id = ar.requested_role_id
       WHERE ar.manager_id = $1
       ORDER BY ar.requested_at DESC`,
      [req.user.id]
    );

    const shaped = rows.map((row) => ({
      id: row.id,
      user: { id: row.user_id, name: row.user_name, email: row.user_email },
      requestedRole: { id: row.requested_role_id, name: row.requested_role_name },
      status: row.status,
      requestedAt: row.requested_at,
      managerComment: row.manager_comment,
    }));

    res.json(shaped);
  } catch (err) {
    console.error('Error fetching manager access requests:', err);
    res.status(500).json({ error: 'Failed to fetch access requests' });
  }
});

// PUT /manager/access-requests/:id
// Body: { decision: 'approved' | 'rejected', comment }
// approved -> PENDING_ADMIN (goes on to admin for final sign-off)
// rejected -> REJECTED (terminal — matches accessRequestsMe.routes.js's
// documented invariant that a manager rejection never reaches admin)
router.put('/access-requests/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { id } = req.params;
  const { decision, comment } = req.body;

  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }

  try {
    const { rows: existingRows } = await pool.query(
      'SELECT id, manager_id, status FROM access_requests WHERE id = $1',
      [id]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Access request not found' });
    }

    const existing = existingRows[0];

    // This manager must be the one the request was assigned to at creation
    // time (access_requests.manager_id — a snapshot, see Request.routes.js),
    // not just anyone currently holding the 'manager' role.
    if (Number(existing.manager_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "This request isn't assigned to you" });
    }

    if (existing.status !== 'PENDING_MANAGER') {
      return res.status(409).json({ error: 'This request has already been decided' });
    }

    const newStatus = decision === 'approved' ? 'PENDING_ADMIN' : 'REJECTED';

    const { rows } = await pool.query(
      `UPDATE access_requests
       SET status = $1, manager_decision_at = NOW(), manager_comment = $2
       WHERE id = $3
       RETURNING id, status, manager_decision_at, manager_comment`,
      [newStatus, comment ?? null, id]
    );

    // CLAUDE.md: "Every permission check and admin action gets written to
    // audit_logs" — this is a manager decision, same convention.
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [
        req.user.id,
        decision === 'approved' ? 'MANAGER_APPROVED_REQUEST' : 'MANAGER_REJECTED_REQUEST',
        `access_request:${id}`,
        req.ip,
      ]
    );

    res.json({
      id: rows[0].id,
      status: rows[0].status,
      managerDecisionAt: rows[0].manager_decision_at,
      managerComment: rows[0].manager_comment,
    });
  } catch (err) {
    console.error('Error reviewing access request:', err);
    res.status(500).json({ error: 'Failed to review access request' });
  }
});

export default router;
