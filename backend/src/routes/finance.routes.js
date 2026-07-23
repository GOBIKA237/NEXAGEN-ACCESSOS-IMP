import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { checkPermission } from '../middleware/checkPermission.js';

// Owned by Backend Dev 3. Mounted at /api/finance in index.js, so paths
// here stay '/budgets', '/expenses...' (not '/finance/budgets' etc.) — see
// alerts.routes.js's comment for the double-prefix bug this is avoiding.

const router = Router();

// PERMISSION NOTE: gated on the canonical 'view_finance_dashboard' (the one
// docs/schema.sql seeds, finance/admin actually hold, and
// Financedashboard.jsx's own PERMISSION_KEY checks client-side), not
// 'manage_finance_expenses'. See the matching note at the top of
// hr.routes.js and mitigations/003_add_hr_finance_tables.sql for the full
// reasoning — short version: manage_finance_expenses isn't a real granted
// permission anywhere in the DB, and mitigations/002 actively strips
// anything outside the 4 canonical names, so gating on it would 403 every
// role including admin.
const FINANCE_PERMISSION = 'view_finance_dashboard';

function shapeBudget(row) {
  const allocated = Number(row.allocated);
  const spent = Number(row.spent);
  const remaining = allocated - spent;
  const utilizationPercent = allocated > 0 ? (spent / allocated) * 100 : 0;
  return {
    id: row.id,
    category: row.category,
    allocated,
    spent,
    remaining,
    utilizationPercent,
  };
}

function shapeExpense(row) {
  return {
    id: row.id,
    category: row.category,
    description: row.description,
    amount: Number(row.amount),
    status: row.status,
    submittedBy: { name: row.submitted_by_name ?? null },
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
  };
}

// GET /budgets
router.get('/budgets', requireAuth, checkPermission(FINANCE_PERMISSION), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, category, allocated, spent FROM budgets ORDER BY category`
    );
    res.json(rows.map(shapeBudget));
  } catch (err) {
    console.error('Error fetching budgets:', err);
    res.status(500).json({ error: 'Failed to fetch budgets' });
  }
});

// GET /expenses
router.get('/expenses', requireAuth, checkPermission(FINANCE_PERMISSION), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.category, e.description, e.amount, e.status,
              e.submitted_at, e.reviewed_at, u.name AS submitted_by_name
       FROM expenses e
       LEFT JOIN users u ON u.id = e.submitted_by
       ORDER BY e.submitted_at DESC`
    );
    res.json(rows.map(shapeExpense));
  } catch (err) {
    console.error('Error fetching expenses:', err);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// POST /expenses — body { category, description, amount }
router.post('/expenses', requireAuth, checkPermission(FINANCE_PERMISSION), async (req, res) => {
  const { category, description, amount } = req.body;
  const parsedAmount = Number(amount);

  if (
    typeof category !== 'string' || category.trim().length === 0 ||
    typeof description !== 'string' || description.trim().length === 0 ||
    !Number.isFinite(parsedAmount) || parsedAmount <= 0
  ) {
    return res.status(400).json({
      error: 'category, description, and a positive amount are all required',
    });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO expenses (category, description, amount, status, submitted_by)
       VALUES ($1, $2, $3, 'pending', $4)
       RETURNING id, category, description, amount, status, submitted_at, reviewed_at`,
      [category.trim(), description.trim(), parsedAmount, req.user.id]
    );

    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, 'EXPENSE_SUBMITTED', `expense:${rows[0].id}`, req.ip]
    );

    // req.user comes straight from the JWT payload (id, email, iat, exp —
    // see middleware/auth.js), no name field, so look it up rather than
    // assume it's there.
    const { rows: nameRows } = await pool.query('SELECT name FROM users WHERE id = $1', [
      req.user.id,
    ]);

    res.status(201).json(
      shapeExpense({ ...rows[0], submitted_by_name: nameRows[0]?.name ?? null })
    );
  } catch (err) {
    console.error('Error creating expense:', err);
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

// PUT /expenses/:id — body { status: 'approved' | 'rejected' }
router.put('/expenses/:id', requireAuth, checkPermission(FINANCE_PERMISSION), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query(
      'SELECT id, category, amount, status FROM expenses WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (existingRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Expense not found' });
    }

    const existing = existingRows[0];

    if (existing.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This expense has already been decided' });
    }

    const { rows } = await client.query(
      `UPDATE expenses
       SET status = $1, reviewed_at = NOW()
       WHERE id = $2
       RETURNING id, category, description, amount, status, submitted_by, submitted_at, reviewed_at`,
      [status, id]
    );

    // Approving an expense counts it against its category's budget. If no
    // budget row exists for the category yet, this matches zero rows and
    // is a no-op rather than an error — the expense itself still goes
    // through.
    if (status === 'approved') {
      await client.query(
        `UPDATE budgets SET spent = spent + $1 WHERE category = $2`,
        [existing.amount, existing.category]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, action, resource, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [
        req.user.id,
        status === 'approved' ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
        `expense:${id}`,
        req.ip,
      ]
    );

    await client.query('COMMIT');

    const { rows: nameRows } = await pool.query('SELECT name FROM users WHERE id = $1', [
      rows[0].submitted_by,
    ]);

    res.json(shapeExpense({ ...rows[0], submitted_by_name: nameRows[0]?.name ?? null }));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error reviewing expense:', err);
    res.status(500).json({ error: 'Failed to review expense' });
  } finally {
    client.release();
  }
});

// GET /reports
router.get('/reports', requireAuth, checkPermission(FINANCE_PERMISSION), async (req, res) => {
  try {
    const { rows: budgetRows } = await pool.query(
      `SELECT COALESCE(SUM(allocated), 0) AS total_allocated,
              COALESCE(SUM(spent), 0) AS total_spent
       FROM budgets`
    );
    const totalAllocated = Number(budgetRows[0].total_allocated);
    const totalSpent = Number(budgetRows[0].total_spent);
    const totalRemaining = totalAllocated - totalSpent;
    const utilizationPercent = totalAllocated > 0 ? (totalSpent / totalAllocated) * 100 : 0;

    const { rows: expenseRows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS total_pending,
         COUNT(*) FILTER (WHERE status = 'approved') AS total_approved,
         COUNT(*) FILTER (WHERE status = 'rejected') AS total_rejected,
         COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) AS total_amount_approved
       FROM expenses`
    );
    const e = expenseRows[0];

    const { rows: monthlyRows } = await pool.query(
      `SELECT to_char(date_trunc('month', reviewed_at), 'Mon YYYY') AS month,
              SUM(amount) AS total_spent
       FROM expenses
       WHERE status = 'approved' AND reviewed_at IS NOT NULL
       GROUP BY date_trunc('month', reviewed_at)
       ORDER BY date_trunc('month', reviewed_at)`
    );

    res.json({
      budgetSummary: {
        totalAllocated,
        totalSpent,
        totalRemaining,
        utilizationPercent,
      },
      expenseSummary: {
        totalPending: Number(e.total_pending),
        totalApproved: Number(e.total_approved),
        totalRejected: Number(e.total_rejected),
        totalAmountApproved: Number(e.total_amount_approved),
      },
      monthlySummary: monthlyRows.map((row) => ({
        month: row.month,
        totalSpent: Number(row.total_spent),
      })),
    });
  } catch (err) {
    console.error('Error building finance reports:', err);
    res.status(500).json({ error: 'Failed to build finance reports' });
  }
});

export default router;
