import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { explainRiskSignals } from '../utils/rulesEngine.js';

// Owned by Lead, alongside rulesEngine.js.
const router = Router();

// A login only counts as an "alert" once at least one real signal fired.
// The three signals are worth 50 / 30 / 20, so 50 is the lowest score that
// guarantees something meaningful tripped (either the failed-attempts burst
// on its own, or the two weaker signals — unrecognized device + off-hours —
// together). Anything below that is either noise or unreachable given the
// current weights. Tunable via ?minScore= if that turns out too strict/loose
// for the demo data.
const DEFAULT_MIN_SCORE = 50;

// GET /admin/alerts?minScore=&page=&limit=
// requireAuth + checkPermission('manage_users'), same as every other admin route.
// Mounted at /api/admin in index.js, so this stays '/alerts' (not
// '/admin/alerts') to match how rbac.routes.js defines its own paths —
// the old '/admin/alerts' here doubled up to /api/admin/admin/alerts and
// 404'd every time.
router.get(
  '/alerts',
  requireAuth,
  checkPermission('manage_users'),
  async (req, res) => {
    const minScore = req.query.minScore !== undefined
      ? parseInt(req.query.minScore, 10)
      : DEFAULT_MIN_SCORE;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    if (Number.isNaN(minScore)) {
      return res.status(400).json({ error: 'minScore must be a number' });
    }

    try {
      // login_events grows on every login attempt, so this is scored,
      // filtered, ordered, and paginated in the DB rather than pulling
      // everything back and slicing in JS.
      const { rows } = await pool.query(
        `SELECT id, user_id, device_fingerprint, risk_score, created_at
         FROM login_events
         WHERE risk_score >= $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [minScore, limit, offset]
      );

      // Reasons aren't stored anywhere — scoreLogin() only ever wrote the
      // number — so they're recomputed per row from the event's own data.
      const alerts = await Promise.all(
        rows.map(async (row) => {
          const reasons = await explainRiskSignals({
            id: row.id,
            userId: row.user_id,
            deviceFingerprint: row.device_fingerprint,
            createdAt: row.created_at,
          });

          return {
            id: row.id,
            userId: row.user_id,
            riskScore: row.risk_score,
            reason: reasons.length > 0 ? reasons.join('; ') : 'elevated risk score',
            createdAt: row.created_at,
          };
        })
      );

      return res.json(alerts);
    } catch (err) {
      console.error('Error fetching alerts:', err);
      return res.status(500).json({ error: 'Failed to fetch alerts' });
    }
  }
);

// POST /admin/alerts/:id/invalidate-session
// requireAuth + checkPermission('manage_users'), same as GET /admin/alerts.
//
// :id is the login_events row (the alert), not a user id — keeps the admin
// UI able to act directly from a row in the alerts table without a second
// lookup. Forces every token that user currently holds to stop working by
// stamping users.tokens_invalid_before; requireAuth checks that on every
// request going forward. There's no server-side session/token store to
// delete from since auth is stateless JWTs, so "invalidate" here means
// "reject going forward," not "delete a stored token."
router.post(
  '/admin/alerts/:id/invalidate-session',
  requireAuth,
  checkPermission('manage_users'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const { rows: alertRows } = await pool.query(
        `SELECT id, user_id FROM login_events WHERE id = $1`,
        [id]
      );

      if (alertRows.length === 0) {
        return res.status(404).json({ error: 'Alert not found' });
      }

      const targetUserId = alertRows[0].user_id;

      const { rows: updatedUser } = await pool.query(
        `UPDATE users SET tokens_invalid_before = NOW()
         WHERE id = $1
         RETURNING id, name, email, tokens_invalid_before`,
        [targetUserId]
      );

      // Same pattern checkPermission uses: record the admin action so it
      // shows up in the audit log / feeds the rules engine.
      //
      // user_id is the actor (the admin who invalidated the session);
      // target_user_id is the user whose session it was — see
      // Request.routes.js's GET /admin/audit-logs, which shows
      // target_user_id as the row's "user".
      await pool.query(
        `INSERT INTO audit_logs (user_id, target_user_id, action, resource, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user.id, targetUserId, 'SESSION_INVALIDATED', `user:${targetUserId}`, req.ip]
      );

      return res.json({
        message: 'Session invalidated. The user will need to log in again.',
        user: updatedUser[0],
      });
    } catch (err) {
      console.error('Error invalidating session:', err);
      return res.status(500).json({ error: 'Failed to invalidate session' });
    }
  }
);

export default router;
