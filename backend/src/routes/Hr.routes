import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { checkPermission } from '../middleware/checkPermission.js';

// Owned by Backend Dev 3. Mounted at /api/hr in index.js, so paths here
// stay '/employees...' (not '/hr/employees...') — see alerts.routes.js's
// comment for the double-prefix bug this is avoiding.

const router = Router();

// PERMISSION NOTE: gated on the canonical 'view_hr_dashboard' (the one
// docs/schema.sql seeds, hr/admin actually hold, and Hrdashboard.jsx's own
// PERMISSION_KEY checks client-side), not 'manage_hr_employees'. That name
// only shows up as an illustrative example in
// mitigations/002_fix_role_permissions_drift.sql's comments — 002 treats
// anything outside the 4 canonical permission names as drift and deletes
// it. Gating on manage_hr_employees would mean 002 (or any re-run of it)
// strips the grant from every role, including admin, and this entire
// dashboard 403s for everyone. Flagging this back per the task instructions
// rather than matching the task description literally — see
// mitigations/003_add_hr_finance_tables.sql for the fuller writeup. Happy
// to switch to a real manage_hr_employees permission instead if the team
// wants a write/read split, as long as 002 is updated to stop treating it
// as drift.
const HR_PERMISSION = 'view_hr_dashboard';

function shapeEmployee(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    department: row.department,
    roles: row.roles ?? [],
    status: row.status,
    joinedAt: row.joined_at,
  };
}

// GET /employees
router.get('/employees', requireAuth, checkPermission(HR_PERMISSION), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, department, roles, status, joined_at
       FROM employees
       ORDER BY name`
    );
    res.json(rows.map(shapeEmployee));
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// POST /employees — body { name, email, department }
router.post('/employees', requireAuth, checkPermission(HR_PERMISSION), async (req, res) => {
  const { name, email, department } = req.body;

  if (
    typeof name !== 'string' || name.trim().length === 0 ||
    typeof email !== 'string' || email.trim().length === 0 ||
    typeof department !== 'string' || department.trim().length === 0
  ) {
    return res.status(400).json({ error: 'name, email, and department are all required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO employees (name, email, department)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, department, roles, status, joined_at`,
      [name.trim(), email.trim(), department.trim()]
    );

    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, 'EMPLOYEE_ONBOARDED', `employee:${rows[0].id}`, req.ip]
    );

    res.status(201).json(shapeEmployee(rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An employee with this email already exists' });
    }
    console.error('Error creating employee:', err);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

// PUT /employees/:id/status — body { status: 'active' | 'inactive' }
router.put(
  '/employees/:id/status',
  requireAuth,
  checkPermission(HR_PERMISSION),
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active' or 'inactive'" });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE employees
         SET status = $1
         WHERE id = $2
         RETURNING id, name, email, department, roles, status, joined_at`,
        [status, id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Employee not found' });
      }

      await pool.query(
        `INSERT INTO audit_logs (user_id, action, resource, ip_address)
         VALUES ($1, $2, $3, $4)`,
        [
          req.user.id,
          status === 'active' ? 'EMPLOYEE_ACTIVATED' : 'EMPLOYEE_DEACTIVATED',
          `employee:${id}`,
          req.ip,
        ]
      );

      res.json(shapeEmployee(rows[0]));
    } catch (err) {
      console.error('Error updating employee status:', err);
      res.status(500).json({ error: 'Failed to update employee status' });
    }
  }
);

export default router;
