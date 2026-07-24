import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/checkPermission.js';

const router = Router();

const ALLOWED_STATUSES = ['todo', 'in_progress', 'done'];

// POST /tasks
// Body: { assignedTo, title, description, dueDate }
// Manager-only. assignedTo must be on this manager's team
// (users.manager_id = req.user.id) — otherwise a manager could assign
// work to (and see status updates from) someone who never reports to
// them, which is the same "no cross-team access" rule
// manager.routes.js enforces for access-request review.
router.post('/', requireAuth, requireRole('manager'), async (req, res) => {
  const { assignedTo, title, description, dueDate } = req.body;

  if (!assignedTo || !title) {
    return res.status(400).json({ error: 'assignedTo and title are required' });
  }

  try {
    const { rows: teamRows } = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND manager_id = $2',
      [assignedTo, req.user.id]
    );

    if (teamRows.length === 0) {
      return res.status(400).json({ error: 'assignedTo must be a member of your team' });
    }

    const { rows } = await pool.query(
      `INSERT INTO tasks (title, description, assigned_to, assigned_by, due_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, description, assigned_to, assigned_by, status, due_date, created_at, updated_at`,
      [title, description ?? null, assignedTo, req.user.id, dueDate ?? null]
    );

    const task = rows[0];

    // Actor is the manager; target is the employee the task is about —
    // same user_id/target_user_id split manager.routes.js uses for
    // MANAGER_APPROVED_REQUEST / MANAGER_REJECTED_REQUEST.
    await pool.query(
      `INSERT INTO audit_logs (user_id, target_user_id, action, resource, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, assignedTo, 'TASK_ASSIGNED', `task:${task.id} — ${task.title}`, req.ip]
    );

    res.status(201).json(task);
  } catch (err) {
    console.error('Error creating task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// GET /tasks
// Manager-only. Every task this manager has assigned (to anyone on
// their team), regardless of status.
router.get('/', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, description, assigned_to, assigned_by, status, due_date, created_at, updated_at
       FROM tasks
       WHERE assigned_by = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// GET /tasks/me
// Any authenticated user. Tasks assigned to them, by anyone.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, description, assigned_to, assigned_by, status, due_date, created_at, updated_at
       FROM tasks
       WHERE assigned_to = $1
       ORDER BY due_date NULLS LAST, created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching my tasks:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// PUT /tasks/:id/status
// Any authenticated user, but only the task's own assignee — not the
// manager who created it, not anyone else — can move its status. Body:
// { status }, one of ALLOWED_STATUSES.
router.put('/:id/status', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}`,
    });
  }

  try {
    const { rows: existingRows } = await pool.query(
      'SELECT id, assigned_to FROM tasks WHERE id = $1',
      [id]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (Number(existingRows[0].assigned_to) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You can't update someone else's task" });
    }

    const { rows } = await pool.query(
      `UPDATE tasks
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, title, description, assigned_to, assigned_by, status, due_date, created_at, updated_at`,
      [status, id]
    );

    // Self-action (the assignee updating their own task) — actor and
    // subject are the same person, so no target_user_id, matching the
    // "self-actions" convention noted in middleware/auth.js's audit
    // comments / migration 004.
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, 'TASK_STATUS_UPDATED', `task:${id} — ${status}`, req.ip]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('Error updating task status:', err);
    res.status(500).json({ error: 'Failed to update task status' });
  }
});

export default router;
