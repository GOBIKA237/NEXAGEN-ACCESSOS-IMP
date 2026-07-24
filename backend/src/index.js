import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/auth.routes.js';
import rbacRoutes from './routes/rbac.routes.js';
import requestRoutes from './routes/Request.routes.js';
import alertsRoutes from './routes/alerts.routes.js';
import accessRequestsMeRoutes from './routes/accessRequestsMe.routes.js';
import managerRoutes from './routes/manager.routes.js';
import leaveRoutes from './routes/leave.routes.js';
import taskRoutes from './routes/task.routes.js';
import hrRoutes from './routes/hr.routes.js';
import financeRoutes from './routes/finance.routes.js';

dotenv.config();

const app = express();

// Restrict CORS to our actual frontend origin instead of allowing any origin.
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  })
);
app.use(express.json());

// 5 attempts per minute per IP on the login endpoint, to slow down credential
// stuffing / brute-force attempts. This counts every request (successful or
// failed) toward the limit — good enough for this basic protection.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 5,
  standardHeaders: true, // return RateLimit-* headers
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in a minute.' },
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/admin', rbacRoutes);
app.use('/api/admin', alertsRoutes);

// Access requests and audit log routes
app.use('/api', requestRoutes);

// GET /api/access-requests/me — the logged-in user's own access requests.
// Deliberately its own router/mount (see routes/accessRequestsMe.routes.js)
// rather than folded into requestRoutes above, which is owned by Backend Dev 2.
app.use('/api/access-requests', accessRequestsMeRoutes);

// Leave requests — POST /api/leave-requests, GET /api/leave-requests/me.
// Mounted at /api (routes/leave.routes.js uses relative, unprefixed paths)
// so the final paths stay /api/leave-requests... rather than nesting under
// another prefix. The manager-side GET/PUT /api/manager/leave-requests...
// live in manager.routes.js and ride along with the existing
// /api/manager mount below.
app.use('/api', leaveRoutes);

// Manager dashboard — GET /api/manager/team, GET /api/manager/access-requests,
// PUT /api/manager/access-requests/:id. See routes/manager.routes.js.
app.use('/api/manager', managerRoutes);

// Task management — POST /api/tasks, GET /api/tasks, GET /api/tasks/me,
// PUT /api/tasks/:id/status. See routes/task.routes.js.
app.use('/api/tasks', taskRoutes);

// HR / Finance dashboards — Backend Dev 3. GET/POST /api/hr/employees,
// PUT /api/hr/employees/:id/status (hr.routes.js); GET /api/finance/budgets,
// GET/POST /api/finance/expenses, PUT /api/finance/expenses/:id, GET
// /api/finance/reports (finance.routes.js). Paths inside those two files
// are relative ('/employees', '/budgets', ...) — same double-prefix bug
// alerts.routes.js hit and fixed applies here if that ever changes.
app.use('/api/hr', hrRoutes);
app.use('/api/finance', financeRoutes);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`AccessOS backend running on port ${PORT}`);
});
