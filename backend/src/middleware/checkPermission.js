import { pool } from '../config/db.js';

// Owned by Backend Dev 2.
// Usage: router.get('/admin/users', requireAuth, checkPermission('manage_users'), handler)
export function checkPermission(featureName) {
  return async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    try {
      const { rows } = await pool.query(
        `SELECT 1
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND p.name = $2
         LIMIT 1`,
        [userId, featureName]
      );

      const allowed = rows.length > 0;

      // Every check gets logged, allowed or not — this feeds the audit log
      // and, on repeated denials, the anomaly rules engine.
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, resource, ip_address)
         VALUES ($1, $2, $3, $4)`,
        [userId, allowed ? 'ACCESS_GRANTED' : 'ACCESS_DENIED', featureName, req.ip]
      );

      if (!allowed) return res.status(403).json({ error: 'Permission denied' });
      next();
    } catch (err) {
      console.error('checkPermission error', err);
      res.status(500).json({ error: 'Internal error checking permissions' });
    }
  };
}

// Role-membership gate, for routes that aren't keyed to a permission in
// role_permissions at all (e.g. 'manager' — there's nothing in the
// existing feature-permission model for it to unlock; the manager
// dashboard is gated purely on holding the role). Same shape and same
// audit-log pattern as checkPermission() above, deliberately — this isn't
// a replacement for it, just the role-based sibling for routes where a
// permission doesn't apply.
// Usage: router.get('/manager/team', requireAuth, requireRole('manager'), handler)
export function requireRole(roleName) {
  return async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    try {
      const { rows } = await pool.query(
        `SELECT 1
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1 AND r.name = $2
         LIMIT 1`,
        [userId, roleName]
      );

      const allowed = rows.length > 0;

      await pool.query(
        `INSERT INTO audit_logs (user_id, action, resource, ip_address)
         VALUES ($1, $2, $3, $4)`,
        [userId, allowed ? 'ACCESS_GRANTED' : 'ACCESS_DENIED', `role:${roleName}`, req.ip]
      );

      if (!allowed) return res.status(403).json({ error: 'Permission denied' });
      next();
    } catch (err) {
      console.error('requireRole error', err);
      res.status(500).json({ error: 'Internal error checking role' });
    }
  };
}
