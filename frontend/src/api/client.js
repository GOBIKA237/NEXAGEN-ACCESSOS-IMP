import axios from 'axios';
import * as mock from './mockData.js';

// Set to false to use the real backend
export const USE_MOCK = false;

export const api = axios.create({
  baseURL: 'http://localhost:5000/api',
});

// Automatically attach JWT token to authenticated requests
api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('token');

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

// Clears the local session. Exported so the logout button and the 401
// interceptor below share one definition instead of duplicating it.
export function logout() {
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('user');
}

// If any authenticated request comes back 401, the token is missing/expired
// — clear the session and bounce to login. Skip this for the login endpoint
// itself: a 401 there just means "wrong password" and is already handled
// as a normal form error by Login.jsx, not a dead session.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url || '';
    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/register');

    if (status === 401 && !isAuthEndpoint) {
      logout();
      if (window.location.pathname !== '/') {
        window.location.href = '/';
      }
    }

    return Promise.reject(error);
  }
);

// =========================
// AUTHENTICATION
// =========================

export async function login(email, password) {
  if (USE_MOCK) {
    return mock.mockLoginResponse;
  }

  const { data } = await api.post('/auth/login', {
    email,
    password,
  });

  return data;
}

export async function register(name, email, password) {
  const { data } = await api.post('/auth/register', {
    name,
    email,
    password,
  });

  return data;
}

// Backs Dashboard.jsx's refreshSession() — GET /auth/me re-reads current
// roles/permissions from the DB so an admin's approval shows up without a
// re-login. See auth.routes.js for the route.
export async function getMe() {
  const { data } = await api.get('/auth/me');
  return data;
}

// =========================
// ADMIN - USERS
// =========================

export async function getUsers() {
  if (USE_MOCK) {
    return mock.mockUsers;
  }

  const { data } = await api.get('/admin/users');
  return data;
}

// =========================
// ADMIN - ROLES
// =========================

export async function getRoles() {
  if (USE_MOCK) {
    return mock.mockRoles;
  }

  const { data } = await api.get('/admin/roles');
  return data;
}

// Roles list for the Request Access dropdown — any logged-in user, not
// admin-only. Hits GET /roles (Request.routes.js), which is deliberately
// separate from the admin-only GET /admin/roles above so employees without
// manage_users can still see what roles exist to request.
export async function getAvailableRoles() {
  if (USE_MOCK) {
    return mock.mockRoles;
  }

  const { data } = await api.get('/roles');
  return data;
}

// =========================
// ACCESS REQUESTS
// =========================

// Admin's pending queue. access_requests.status is a case-sensitive enum
// (PENDING_MANAGER | PENDING_ADMIN | APPROVED | REJECTED | REVOKED — see
// docs/schema.sql). `status=PENDING` is a backend alias covering BOTH
// non-terminal stages (PENDING_MANAGER and PENDING_ADMIN) — see
// Request.routes.js. Admin can act on a request at either stage: there's
// currently no way to assign a manager to a user, so most requests would
// otherwise never leave PENDING_MANAGER and would never show up here.
export async function getAccessRequests() {
  if (USE_MOCK) {
    return mock.mockAccessRequests;
  }

  const { data } = await api.get('/admin/access-requests?status=PENDING');

  return data;
}

// =========================
// REQUEST ACCESS (user-facing)
// =========================

// durationHours: 4 | 24 | 168 | null (null = permanent). Optional — Request
// routes.js already treats undefined/null identically, both mean
// permanent, so it's safe to always send the key rather than conditionally
// including it.
export async function requestAccess(roleId, durationHours = null) {
  if (USE_MOCK) {
    return {
      id: Date.now(),
      status: 'pending',
      durationHours,
    };
  }

  const { data } = await api.post('/access-requests', {
    requestedRoleId: roleId,
    durationHours,
  });

  return data;
}

// =========================
// MY ACCESS REQUESTS (Frontend Dev 1)
// =========================
// Backend: GET /api/access-requests/me — Backend Dev 1's task, not built
// yet as of this writing. Dashboard.jsx's "My requests" section (see
// statusInfo/DecisionCell there) already expects an array shaped exactly
// like this, so Backend Dev 1 should match it on landing rather than the
// other way around:
//   {
//     id,
//     resource,          // e.g. role description, "Finance team access"
//     requestedAccess,   // e.g. role name, "finance"
//     requestedAt,       // ISO timestamp
//     status,            // 'PENDING_MANAGER' | 'PENDING_ADMIN' | 'APPROVED'
//                         // | 'REJECTED' | 'REVOKED'
//     managerDecision,   // null, or { decision: 'APPROVED'|'REJECTED', comment }
//     adminDecision,     // null, or { decision: 'APPROVED'|'REJECTED', comment }
//   }

export async function getMyAccessRequests() {
  if (USE_MOCK) {
    return mock.mockMyAccessRequests ?? [];
  }

  const { data } = await api.get('/access-requests/me');
  return data;
}

// =========================
// AUDIT LOGS
// =========================

export async function getAuditLogs() {
  if (USE_MOCK) {
    return mock.mockAuditLogs;
  }

  const { data } = await api.get('/admin/audit-logs');
  return data;
}

// =========================
// ALERTS
// =========================

export async function getAlerts() {
  if (USE_MOCK) {
    return mock.mockAlerts;
  }

  const { data } = await api.get('/admin/alerts');
  return data;
}

// =========================
// APPROVE ACCESS REQUEST
// =========================

export async function approveRequest(id) {
  if (USE_MOCK) {
    return {
      id,
      status: 'approved',
    };
  }

  const { data } = await api.put(
    `/admin/access-requests/${id}`,
    {
      status: 'approved',
    }
  );

  return data;
}

// =========================
// DENY ACCESS REQUEST
// =========================

export async function denyRequest(id) {
  if (USE_MOCK) {
    return {
      id,
      status: 'denied',
    };
  }

  const { data } = await api.put(
    `/admin/access-requests/${id}`,
    {
      status: 'denied',
    }
  );

  return data;
}

// =========================
// HR DASHBOARD (Frontend Dev 3)
// =========================
// Backend: hr.routes.js — GET/POST /api/hr/employees, PUT
// /api/hr/employees/:id, PUT /api/hr/employees/:id/status. Not built yet
// as of this writing; these follow the same USE_MOCK pattern as the rest
// of the file so they work against mock data now and the real routes the
// moment they exist, with no call-site changes.
//
// Assumed shapes (swap to match hr.routes.js exactly once it lands):
//   Employee: { id, name, email, department, roles: [string], status:
//     'active'|'inactive', joinedAt: ISO string }
//   POST body: { name, email, department }
//   PUT .../status body: { status: 'active'|'inactive' }

export async function getEmployees() {
  if (USE_MOCK) {
    return mock.mockEmployees;
  }

  const { data } = await api.get('/hr/employees');
  return data;
}

export async function createEmployee({ name, email, department }) {
  if (USE_MOCK) {
    return {
      id: Date.now(),
      name,
      email,
      department,
      roles: [],
      status: 'active',
      joinedAt: new Date().toISOString(),
    };
  }

  const { data } = await api.post('/hr/employees', { name, email, department });
  return data;
}

export async function setEmployeeStatus(id, status) {
  if (USE_MOCK) {
    return { id, status };
  }

  const { data } = await api.put(`/hr/employees/${id}/status`, { status });
  return data;
}

// =========================
// FINANCE DASHBOARD (Frontend Dev 3)
// =========================
// Backend: finance.routes.js — GET /api/finance/budgets, GET/POST
// /api/finance/expenses, PUT /api/finance/expenses/:id, GET
// /api/finance/reports. Not built yet as of this writing; same USE_MOCK
// pattern as above.
//
// Assumed shapes (swap to match finance.routes.js exactly once it lands):
//   Budget: { id, category, allocated, spent, remaining?, utilizationPercent? }
//     (remaining/utilizationPercent are computed client-side if the
//     backend doesn't send them — see FinanceDashboard.jsx)
//   Expense: { id, category, description, amount, status:
//     'pending'|'approved'|'rejected', submittedBy: { name }, submittedAt,
//     reviewedAt? }
//   POST body: { category, description, amount }
//   PUT .../:id body: { status: 'approved'|'rejected' }
//   Reports: { budgetSummary: { totalAllocated, totalSpent,
//     totalRemaining, utilizationPercent }, expenseSummary: { totalPending,
//     totalApproved, totalRejected, totalAmountApproved }, monthlySummary:
//     [{ month, totalSpent }] }

export async function getBudgets() {
  if (USE_MOCK) {
    return mock.mockBudgets;
  }

  const { data } = await api.get('/finance/budgets');
  return data;
}

export async function getExpenses() {
  if (USE_MOCK) {
    return mock.mockExpenses;
  }

  const { data } = await api.get('/finance/expenses');
  return data;
}

export async function createExpense({ category, description, amount }) {
  if (USE_MOCK) {
    return {
      id: Date.now(),
      category,
      description,
      amount,
      status: 'pending',
      submittedBy: { name: 'You' },
      submittedAt: new Date().toISOString(),
    };
  }

  const { data } = await api.post('/finance/expenses', { category, description, amount });
  return data;
}

export async function setExpenseStatus(id, status) {
  if (USE_MOCK) {
    return { id, status };
  }

  const { data } = await api.put(`/finance/expenses/${id}`, { status });
  return data;
}

export async function getFinanceReports() {
  if (USE_MOCK) {
    return mock.mockFinanceReports;
  }

  const { data } = await api.get('/finance/reports');
  return data;
}

// =========================
// MANAGER DASHBOARD (Frontend Dev 2)
// =========================
// Backend: manager.routes.js — GET /api/manager/team, GET
// /api/manager/access-requests, PUT /api/manager/access-requests/:id. Not
// built yet as of this writing; same USE_MOCK pattern as the rest of this
// file so this works against mock data now and the real routes the moment
// they exist, with no call-site changes.
//
// Assumed shapes (swap to match manager.routes.js exactly once it lands):
//   Team member: { id, name, email, department, status }
//   Access request (manager view): { id, user: {id, name, email},
//     requestedRole: {id, name}, status: 'PENDING_MANAGER'|'PENDING_ADMIN'|
//     'APPROVED'|'REJECTED', requestedAt, managerComment }
//   PUT body: { decision: 'approved'|'rejected', comment }

export async function getMyTeam() {
  if (USE_MOCK) {
    return mock.mockTeam ?? [];
  }

  const { data } = await api.get('/manager/team');
  return data;
}

export async function getManagerAccessRequests() {
  if (USE_MOCK) {
    return mock.mockManagerRequests ?? [];
  }

  const { data } = await api.get('/manager/access-requests');
  return data;
}

export async function reviewManagerRequest(id, decision, comment) {
  if (USE_MOCK) {
    return { id, status: decision === 'approved' ? 'PENDING_ADMIN' : 'REJECTED' };
  }

  const { data } = await api.put(`/manager/access-requests/${id}`, {
    decision,
    comment,
  });
  return data;
}
