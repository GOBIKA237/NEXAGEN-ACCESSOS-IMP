import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = Router();

// Permissions worth flagging when 2+ of the roles being assigned to a user
// all grant them. Ordinary overlap between roles is expected and fine (e.g.
// two roles both granting view_audit_log isn't a problem) — this list is
// for elevated/sensitive grants where stacking them is likely unintentional
// and worth an explicit admin confirmation instead of silently applying.
const CONFLICT_WATCHLIST_PERMISSIONS = ['manage_users'];

router.get('/users', requireAuth, checkPermission('manage_users'), async (req, res) => {
  // Same json_agg + LEFT JOIN pattern as GET /roles/predefined below.
  // docs/api-contract.md and the frontend's userRoleNames() (AdminDashboard.jsx)
  // both expect `roles` as an array of role name strings — not role objects,
  // and not omitted for users with zero roles (COALESCE gives them `[]`
  // instead of NULL from json_agg over an empty LEFT JOIN).
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email,
            COALESCE(
              json_agg(r.name) FILTER (WHERE r.name IS NOT NULL),
              '[]'
            ) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id
     ORDER BY u.id`
  );
  res.json(rows);
});

router.get('/roles', requireAuth, checkPermission('manage_users'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM roles');
  res.json(rows);
});

// The 4 starter roles seeded in docs/schema.sql. Keep this list in sync if
// that seed data ever changes.
const PREDEFINED_ROLE_NAMES = ['admin', 'finance', 'hr', 'employee'];

// GET /roles/predefined — the seeded starter roles with their current
// permission sets attached, for one-click assignment in the admin UI.
// Permissions are read live from role_permissions, not hardcoded, so this
// stays correct if someone edits a predefined role's grants later.
router.get('/roles/predefined', requireAuth, checkPermission('manage_users'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.description,
            COALESCE(
              json_agg(
                json_build_object('id', p.id, 'name', p.name, 'description', p.description)
              ) FILTER (WHERE p.id IS NOT NULL),
              '[]'
            ) AS permissions
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE r.name = ANY($1::text[])
     GROUP BY r.id
     ORDER BY r.id`,
    [PREDEFINED_ROLE_NAMES]
  );

  res.json(rows);
});

// PUT /users/:id/roles — body { roleIds: [1,2] }, replace user's roles in user_roles
router.put('/users/:id/roles', requireAuth, checkPermission('manage_users'), async (req, res) => {
  const { id } = req.params;
  const { roleIds, confirm } = req.body;

  if (!Array.isArray(roleIds)) {
    return res.status(400).json({ error: 'roleIds must be an array' });
  }

  // A single role can't conflict with itself — only check when 2+ distinct
  // roles are being assigned together. Skipped entirely when the caller has
  // already confirmed the conflict once (confirm: true) and wants to apply
  // the roles anyway.
  const distinctRoleIds = [...new Set(roleIds)];
  if (!confirm && distinctRoleIds.length > 1) {
    const { rows: overlapRows } = await pool.query(
      `SELECT p.name
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ANY($1::int[])
         AND p.name = ANY($2::text[])
       GROUP BY p.name
       HAVING COUNT(DISTINCT rp.role_id) > 1`,
      [distinctRoleIds, CONFLICT_WATCHLIST_PERMISSIONS]
    );

    if (overlapRows.length > 0) {
      return res.status(409).json({
        conflict: true,
        message: 'These roles grant overlapping sensitive permissions — confirm before assigning.',
        overlappingPermissions: overlapRows.map((r) => r.name)
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);

    for (const roleId of roleIds) {
      await client.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
        [id, roleId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /users/:id/roles error', err);
    return res.status(500).json({ error: 'Internal error updating user roles' });
  } finally {
    client.release();
  }

  const { rows } = await pool.query(
    `SELECT r.* FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = $1`,
    [id]
  );

  res.json({ id: Number(id), roles: rows });
});

// POST /roles — body { name, description }
router.post('/roles', requireAuth, checkPermission('manage_users'), async (req, res) => {
  const { name, description } = req.body;

  if (typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const { rows } = await pool.query(
      'INSERT INTO roles (name, description) VALUES ($1, $2) RETURNING *',
      [name.trim(), description ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Role name already exists' });
    }
    console.error('POST /roles error', err);
    res.status(500).json({ error: 'Internal error creating role' });
  }
});

// PUT /roles/:id — body { name?, description?, permissionIds? }
router.put('/roles/:id', requireAuth, checkPermission('manage_users'), async (req, res) => {
  const { id } = req.params;
  const { name, description, permissionIds } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE roles
       SET name = COALESCE($1, name),
           description = COALESCE($2, description)
       WHERE id = $3
       RETURNING *`,
      [name ?? null, description ?? null, id]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Role not found' });
    }

    if (Array.isArray(permissionIds)) {
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);

      for (const permissionId of permissionIds) {
        await client.query(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)',
          [id, permissionId]
        );
      }
    }

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /roles/:id error', err);
    res.status(500).json({ error: 'Internal error updating role' });
  } finally {
    client.release();
  }
});

// DELETE /roles/:id
router.delete('/roles/:id', requireAuth, checkPermission('manage_users'), async (req, res) => {
  const { id } = req.params;

  const { rows: assignedRows } = await pool.query(
    'SELECT user_id FROM user_roles WHERE role_id = $1 LIMIT 1',
    [id]
  );

  if (assignedRows.length > 0) {
    return res.status(409).json({
      error: 'Role is still assigned to one or more users and cannot be deleted. Unassign it first.',
    });
  }

  const { rows } = await pool.query('DELETE FROM roles WHERE id = $1 RETURNING id', [id]);

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Role not found' });
  }

  res.status(204).send();
});

// GET /permissions
router.get('/permissions', requireAuth, checkPermission('manage_users'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM permissions');
  res.json(rows);
});

// POST /permissions — body { name, description }
router.post('/permissions', requireAuth, checkPermission('manage_users'), async (req, res) => {
  const { name, description } = req.body;

  if (typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const { rows } = await pool.query(
      'INSERT INTO permissions (name, description) VALUES ($1, $2) RETURNING *',
      [name.trim(), description ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Permission name already exists' });
    }
    console.error('POST /permissions error', err);
    res.status(500).json({ error: 'Internal error creating permission' });
  }
});

export default router;
