// Owned by Frontend Dev 2 (UI built for Frontend Dev 3's request). Admin tabs:
// Users, Roles, Access Requests, Audit Log. Alerts render as a persistent
// banner above the tabs rather than as their own tab.
import { Component, useEffect, useState } from 'react';
import Header from '../components/Header.jsx';
import {
  api,
  getUsers,
  getRoles,
  getAccessRequests,
  getAuditLogs,
  getAlerts,
  approveRequest,
  denyRequest,
} from '../api/client.js';

// --- Roles / permissions / user-role-assignment API calls ----------------
// Not yet in api/client.js (out of scope for this file's owner to add
// there), so they're defined locally using the shared `api` axios
// instance. Shapes per docs/api-contract.md.
async function getPermissions() {
  const { data } = await api.get('/admin/permissions');
  return data;
}

async function createRole(payload) {
  const { data } = await api.post('/admin/roles', payload);
  return data;
}

async function updateRole(id, payload) {
  const { data } = await api.put(`/admin/roles/${id}`, payload);
  return data;
}

async function deleteRole(id) {
  await api.delete(`/admin/roles/${id}`);
}

// `confirm: true` on a retry after a 409 conflict skips the overlap check
// server-side (see PUT /users/:id/roles in rbac.routes.js) and applies the
// roles anyway. Verified working end-to-end as of Backend Dev 2's latest
// changes — a confirmed retry now returns 200 instead of 409 again.
async function updateUserRoles(id, roleIds, { confirm } = {}) {
  const { data } = await api.put(`/admin/users/${id}/roles`, {
    roleIds,
    ...(confirm ? { confirm: true } : {}),
  });
  return data;
}

const TABS = [
  { key: 'users', label: 'Users' },
  { key: 'roles', label: 'Roles' },
  { key: 'requests', label: 'Access Requests' },
  { key: 'audit', label: 'Audit Log' },
  { key: 'alerts', label: 'Alerts' },
];

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// Matches the "impossible travel: CityA → CityB at Xkm/h" reason string
// documented for GET /admin/alerts. Tolerant of "->" as a fallback in case
// the arrow character doesn't round-trip through some client somewhere.
const IMPOSSIBLE_TRAVEL_RE =
  /impossible travel:\s*(.+?)\s*(?:→|->)\s*(.+?)\s+at\s+([\d.,]+)\s*km\/h/i;

function parseImpossibleTravel(reason) {
  if (!reason) return null;
  const match = reason.match(IMPOSSIBLE_TRAVEL_RE);
  if (!match) return null;
  return { from: match[1].trim(), to: match[2].trim(), speedKmh: match[3].trim() };
}

function PlaneIcon({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 16v-2l-8-5V4.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2.5 1.5V22l4-1 4 1v-1.5L13 19v-5.5l8 2.5z" />
    </svg>
  );
}

// expiresAt comes back per-row on GET /admin/access-requests / granted
// roles; null/undefined means the grant doesn't expire.
function formatExpiry(expiresAt) {
  if (!expiresAt) return null;
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (diffMs <= 0) return 'Expired';
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days >= 1) return `in ${days}d`;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours >= 1) return `in ${hours}h`;
  const mins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
  return `in ${mins}m`;
}

function StatusPill({ children, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-100 text-emerald-700',
    red: 'bg-rose-100 text-rose-700',
    amber: 'bg-amber-100 text-amber-700',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function LoadingRow({ colSpan }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-sm text-slate-400">
        Loading…
      </td>
    </tr>
  );
}

function ErrorRow({ colSpan, message }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-sm text-rose-500">
        {message}
      </td>
    </tr>
  );
}

function EmptyRow({ colSpan, message }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-sm text-slate-400">
        {message}
      </td>
    </tr>
  );
}

// --- Tab error boundary ----------------------------------------------------
// Isolates a crash (e.g. an unexpected API shape) to the tab that caused it,
// instead of taking down the whole Admin page. `resetKey` should be the
// active tab key so switching tabs clears a previous error.
class TabErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('Admin tab crashed:', error, info);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="px-4 py-10 text-center text-sm text-rose-500">
          Something went wrong loading this tab.
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Alert banner --------------------------------------------------------

function AlertBanner() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    getAlerts()
      .then((data) => {
        if (!cancelled) setAlerts(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = alerts.filter((a) => !dismissed.has(a.id));

  if (loading || visible.length === 0) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <ul className="divide-y divide-amber-100">
        {visible.map((alert) => {
          const high = alert.riskScore > 50;
          const route = parseImpossibleTravel(alert.reason);
          const isImpossibleTravel = !!route;
          return (
            <li
              key={alert.id}
              className={`flex items-center justify-between gap-4 px-6 py-2.5 text-sm ${
                isImpossibleTravel
                  ? 'border-l-4 border-rose-500 bg-rose-50 pl-5'
                  : high
                  ? 'bg-rose-50'
                  : 'bg-amber-50'
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-semibold ${
                    high ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'
                  }`}
                  aria-hidden="true"
                >
                  !
                </span>
                <div className="min-w-0">
                  <span className={`truncate ${high ? 'text-rose-800' : 'text-amber-800'}`}>
                    {alert.reason}
                  </span>
                  {isImpossibleTravel && (
                    <div className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-rose-700">
                      <PlaneIcon className="h-3 w-3" />
                      <span>
                        {route.from} → {route.to}
                      </span>
                    </div>
                  )}
                </div>
                <StatusPill tone={high ? 'red' : 'amber'}>
                  Risk {alert.riskScore}
                </StatusPill>
                <span className="hidden text-xs text-slate-400 sm:inline">
                  {formatDate(alert.createdAt)}
                </span>
              </div>
              <button
                onClick={() =>
                  setDismissed((prev) => new Set(prev).add(alert.id))
                }
                className="flex-none text-xs font-medium text-slate-500 hover:text-slate-700"
              >
                Dismiss
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- Data hook ------------------------------------------------------------

function useTabData(fetcher, deps = []) {
  const [data, setData] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetcher()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadToken]);

  const refetch = () => setReloadToken((t) => t + 1);

  return [data, status, refetch];
}

// --- Alerts tab -------------------------------------------------------
// Alerts already surface as a dismissible banner (above); this is the
// same GET /admin/alerts data as a browsable list, for anyone who dismissed
// the banner or wants the full history rather than just what's currently
// undismissed. Response shape confirmed against backend/src/routes/
// alerts.routes.js: [{ id, userId, riskScore, reason, createdAt }] —
// matches docs/api-contract.md exactly, no surprises there. (See chat
// writeup for a routing issue found in that same file that means this
// currently 404s regardless of shape.)
function AlertsTab() {
  const [alerts, status] = useTabData(getAlerts);
  const colSpan = 4;

  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <th className="px-4 py-3 text-left font-medium text-slate-500">Risk</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">Reason</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">User</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">When</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 bg-white">
        {status === 'loading' && <LoadingRow colSpan={colSpan} />}
        {status === 'error' && (
          <ErrorRow colSpan={colSpan} message="Couldn't load alerts." />
        )}
        {status === 'ready' && alerts.length === 0 && (
          <EmptyRow colSpan={colSpan} message="No alerts." />
        )}
        {status === 'ready' &&
          alerts.map((alert) => {
            const high = alert.riskScore > 50;
            const route = parseImpossibleTravel(alert.reason);
            const isImpossibleTravel = !!route;
            return (
              <tr
                key={alert.id}
                className={`hover:bg-slate-50 ${isImpossibleTravel ? 'bg-rose-50/40' : ''}`}
              >
                <td
                  className={`px-4 py-3 ${
                    isImpossibleTravel ? 'border-l-4 border-rose-500' : ''
                  }`}
                >
                  <StatusPill tone={high ? 'red' : 'amber'}>
                    {alert.riskScore}
                  </StatusPill>
                </td>
                <td className="px-4 py-3 text-slate-700">
                  {alert.reason}
                  {isImpossibleTravel && (
                    <div className="mt-1 flex items-center gap-1 text-xs font-semibold text-rose-700">
                      <PlaneIcon className="h-3 w-3" />
                      <span>
                        {route.from} → {route.to}
                      </span>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-500">
                  User #{alert.userId}
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {formatDate(alert.createdAt)}
                </td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}

// --- Tabs -------------------------------------------------------------

// Roles come back from GET /admin/users as either an array of name strings
// (per docs/api-contract.md) or, if that field is ever missing, undefined —
// normalize both so a render never throws on `.map`.
function userRoleNames(user) {
  return Array.isArray(user.roles) ? user.roles : [];
}

function UsersTab() {
  const [users, status, refetchUsers] = useTabData(getUsers);
  const [allRoles, rolesStatus] = useTabData(getRoles);
  const [editingUser, setEditingUser] = useState(null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const colSpan = 4;

  const q = query.trim().toLowerCase();
  const filteredUsers = users.filter((user) => {
    const matchesQuery =
      !q ||
      user.name?.toLowerCase().includes(q) ||
      user.email?.toLowerCase().includes(q);
    const matchesRole =
      roleFilter === 'all' || userRoleNames(user).includes(roleFilter);
    return matchesQuery && matchesRole;
  });
  const isFiltered = q.length > 0 || roleFilter !== 'all';

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email…"
          className="w-56 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          disabled={rolesStatus !== 'ready'}
          className="rounded-md border border-slate-300 px-2.5 py-1.5 text-sm disabled:opacity-50"
        >
          <option value="all">All roles</option>
          {allRoles.map((role) => (
            <option key={role.id} value={role.name}>
              {role.name}
            </option>
          ))}
        </select>
      </div>

      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-slate-500">Name</th>
            <th className="px-4 py-3 text-left font-medium text-slate-500">Email</th>
            <th className="px-4 py-3 text-left font-medium text-slate-500">Roles</th>
            <th className="px-4 py-3 text-right font-medium text-slate-500">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {status === 'loading' && <LoadingRow colSpan={colSpan} />}
          {status === 'error' && (
            <ErrorRow colSpan={colSpan} message="Couldn't load users." />
          )}
          {status === 'ready' && users.length === 0 && (
            <EmptyRow colSpan={colSpan} message="No users found." />
          )}
          {status === 'ready' && users.length > 0 && filteredUsers.length === 0 && (
            <EmptyRow
              colSpan={colSpan}
              message={
                isFiltered
                  ? 'No users match your search.'
                  : 'No users found.'
              }
            />
          )}
          {status === 'ready' &&
            filteredUsers.map((user) => (
              <tr key={user.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-800">{user.name}</td>
                <td className="px-4 py-3 text-slate-500">{user.email}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {userRoleNames(user).length === 0 && (
                      <span className="text-slate-400">—</span>
                    )}
                    {userRoleNames(user).map((role) => (
                      <StatusPill key={role} tone="slate">
                        {role}
                      </StatusPill>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setEditingUser(user)}
                    disabled={rolesStatus !== 'ready'}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Manage roles
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      {editingUser && (
        <AssignRolesModal
          user={editingUser}
          allRoles={allRoles}
          onClose={() => setEditingUser(null)}
          onSaved={() => {
            setEditingUser(null);
            refetchUsers();
          }}
        />
      )}
    </>
  );
}

// --- Assign roles modal ----------------------------------------------------

function AssignRolesModal({ user, allRoles, onClose, onSaved }) {
  // GET /admin/users currently doesn't return each user's role ids (see
  // docs/api-contract.md, which says it should) — only name/email come
  // back today, so there's nothing reliable to pre-check here yet. Falling
  // back to matching by name against userRoleNames() in case that lands
  // before the id-based fix does.
  const initialChecked = new Set(
    allRoles
      .filter((role) => userRoleNames(user).includes(role.name))
      .map((role) => role.id)
  );

  const [checkedIds, setCheckedIds] = useState(initialChecked);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null); // { overlappingPermissions } | null

  function toggle(roleId) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  async function submit({ confirm = false } = {}) {
    setSaving(true);
    setError(null);
    try {
      await updateUserRoles(user.id, [...checkedIds], { confirm });
      onSaved();
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.conflict) {
        setConflict(err.response.data);
      } else {
        setError("Couldn't update roles. Try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg">
        {!conflict ? (
          <>
            <h2 className="text-sm font-semibold text-slate-900">
              Roles for {user.name}
            </h2>
            <p className="mt-1 text-xs text-slate-500">{user.email}</p>

            <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
              {allRoles.map((role) => (
                <label
                  key={role.id}
                  className="flex items-start gap-2 rounded-md px-1 py-1 text-sm hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    checked={checkedIds.has(role.id)}
                    onChange={() => toggle(role.id)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-slate-800">{role.name}</span>
                    {role.description && (
                      <span className="block text-xs text-slate-500">
                        {role.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>

            {error && <p className="mt-3 text-xs text-rose-500">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={onClose}
                disabled={saving}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => submit()}
                disabled={saving}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save roles'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-sm font-semibold text-slate-900">
              Overlapping sensitive permissions
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              These roles together grant {user.name} overlapping sensitive
              permissions:
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {(conflict.overlappingPermissions || []).map((perm) => (
                <StatusPill key={perm} tone="amber">
                  {perm}
                </StatusPill>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500">
              Confirm to assign these roles anyway.
            </p>

            {error && <p className="mt-3 text-xs text-rose-500">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConflict(null)}
                disabled={saving}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              >
                Back
              </button>
              <button
                onClick={() => submit({ confirm: true })}
                disabled={saving}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Applying…' : 'Confirm and apply'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RolesTab() {
  const [roles, status, refetchRoles] = useTabData(getRoles);
  const [permissions, permStatus] = useTabData(getPermissions);
  const [editingRole, setEditingRole] = useState(undefined); // undefined = closed, null = "new", object = editing
  const [deletingId, setDeletingId] = useState(null);
  const [rowError, setRowError] = useState({});
  const colSpan = 3;
  const formReady = permStatus === 'ready';

  async function handleDelete(role) {
    if (!window.confirm(`Delete the "${role.name}" role? This can't be undone.`)) {
      return;
    }
    setDeletingId(role.id);
    setRowError((prev) => ({ ...prev, [role.id]: null }));
    try {
      await deleteRole(role.id);
      refetchRoles();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [role.id]: "Couldn't delete this role. Try again.",
      }));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">Roles</h2>
        <button
          onClick={() => setEditingRole(null)}
          disabled={!formReady}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          New role
        </button>
      </div>

      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-slate-500">Role</th>
            <th className="px-4 py-3 text-left font-medium text-slate-500">Description</th>
            <th className="px-4 py-3 text-right font-medium text-slate-500">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {status === 'loading' && <LoadingRow colSpan={colSpan} />}
          {status === 'error' && (
            <ErrorRow colSpan={colSpan} message="Couldn't load roles." />
          )}
          {status === 'ready' && roles.length === 0 && (
            <EmptyRow colSpan={colSpan} message="No roles found." />
          )}
          {status === 'ready' &&
            roles.map((role) => (
              <tr key={role.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-800">{role.name}</td>
                <td className="px-4 py-3 text-slate-500">{role.description}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditingRole(role)}
                        disabled={!formReady}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(role)}
                        disabled={deletingId === role.id}
                        className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {deletingId === role.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                    {rowError[role.id] && (
                      <span className="text-xs text-rose-500">{rowError[role.id]}</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      {editingRole !== undefined && (
        <RoleFormModal
          role={editingRole}
          permissions={permissions}
          onClose={() => setEditingRole(undefined)}
          onSaved={() => {
            setEditingRole(undefined);
            refetchRoles();
          }}
        />
      )}
    </>
  );
}

// --- Role create/edit modal -------------------------------------------

function RoleFormModal({ role, permissions, onClose, onSaved }) {
  const isEdit = !!role;
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  // GET /admin/roles (and the PUT response) don't currently include which
  // permissions a role already has, so there's nothing to pre-check when
  // editing — see chat writeup. Track whether the admin actually touches a
  // checkbox this session so an untouched save doesn't send permissionIds
  // and silently wipe the role's real permissions.
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [permissionsTouched, setPermissionsTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function toggle(permId) {
    setPermissionsTouched(true);
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(permId)) next.delete(permId);
      else next.add(permId);
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = { name: name.trim(), description };
      if (permissionsTouched) payload.permissionIds = [...checkedIds];

      if (isEdit) {
        await updateRole(role.id, payload);
      } else {
        await createRole(payload);
      }
      onSaved();
    } catch (err) {
      setError(
        err.response?.data?.error ?? "Couldn't save this role. Try again."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg"
      >
        <h2 className="text-sm font-semibold text-slate-900">
          {isEdit ? `Edit ${role.name}` : 'New role'}
        </h2>

        <label className="mt-4 block text-xs font-medium text-slate-600">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
          />
        </label>

        <label className="mt-3 block text-xs font-medium text-slate-600">
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
          />
        </label>

        <div className="mt-3">
          <p className="text-xs font-medium text-slate-600">Permissions</p>
          {isEdit && !permissionsTouched && (
            <p className="mt-1 text-xs text-slate-400">
              Current permissions aren't shown here yet — check a box only if
              you want to replace this role's permission set.
            </p>
          )}
          <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
            {permissions.map((perm) => (
              <label
                key={perm.id}
                className="flex items-start gap-2 rounded-md px-1 py-1 text-sm hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={checkedIds.has(perm.id)}
                  onChange={() => toggle(perm.id)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-slate-800">{perm.name}</span>
                  {perm.description && (
                    <span className="block text-xs text-slate-500">
                      {perm.description}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-rose-500">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create role'}
          </button>
        </div>
      </form>
    </div>
  );
}

function AccessRequestsTab() {
  const [requests, status, refetch] = useTabData(getAccessRequests);
  const [pending, setPending] = useState({}); // id -> true while request is in flight
  const [rowError, setRowError] = useState({}); // id -> error message
  const colSpan = 6;

  // TODO: no revoke action exists yet — there's no revokeRequest (or
  // similar) in api/client.js, and no matching route in the backend's
  // access-requests routes (only approve/deny). Wire this up to a real
  // endpoint once one lands (see docs/api-contract.md); for now this just
  // stubs the interaction so the button is in place.
  async function handleRevoke(requestId) {
    console.warn(
      `TODO: revoke access request ${requestId} early — no backend endpoint yet.`
    );
  }

  async function handleDecision(requestId, decision) {
    setPending((prev) => ({ ...prev, [requestId]: true }));
    setRowError((prev) => ({ ...prev, [requestId]: null }));

    try {
      if (decision === 'approved') {
        await approveRequest(requestId);
      } else {
        await denyRequest(requestId);
      }
      // Row disappears once the list re-fetches (backend only returns
      // pending requests), so there's no separate "handled" state to track.
      refetch();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [requestId]: `Couldn't ${decision === 'approved' ? 'approve' : 'deny'} this request. Try again.`,
      }));
    } finally {
      setPending((prev) => ({ ...prev, [requestId]: false }));
    }
  }

  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <th className="px-4 py-3 text-left font-medium text-slate-500">Requester</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">Requested role</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">Requested at</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">Stage</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">Expires</th>
          <th className="px-4 py-3 text-right font-medium text-slate-500">Action</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 bg-white">
        {status === 'loading' && <LoadingRow colSpan={colSpan} />}
        {status === 'error' && (
          <ErrorRow colSpan={colSpan} message="Couldn't load access requests." />
        )}
        {status === 'ready' && requests.length === 0 && (
          <EmptyRow colSpan={colSpan} message="No pending access requests." />
        )}
        {status === 'ready' &&
          requests.map((req) => {
            const isPending = !!pending[req.id];
            const error = rowError[req.id];
            return (
              <tr key={req.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-800">
                  {req.user.name}
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {req.requestedRole.name}
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {formatDate(req.requestedAt)}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      req.status === 'PENDING_MANAGER'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-sky-100 text-sky-700'
                    }`}
                  >
                    {req.status === 'PENDING_MANAGER' ? 'Awaiting manager' : 'Awaiting admin'}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {req.expiresAt ? (
                    <span title={formatDate(req.expiresAt)}>
                      {formatExpiry(req.expiresAt)}
                    </span>
                  ) : (
                    <StatusPill tone="slate">Permanent</StatusPill>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => handleDecision(req.id, 'approved')}
                        disabled={isPending}
                        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isPending ? 'Approving…' : 'Approve'}
                      </button>
                      <button
                        onClick={() => handleDecision(req.id, 'denied')}
                        disabled={isPending}
                        className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isPending ? 'Denying…' : 'Deny'}
                      </button>
                      <button
                        onClick={() => handleRevoke(req.id)}
                        className="rounded-md border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
                      >
                        Revoke early
                      </button>
                    </div>
                    {error && (
                      <span className="text-xs text-rose-500">{error}</span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}

// The backend currently returns audit rows as raw snake_case columns with
// no joined `user` object (user_id only) — that mismatches what the API
// contract promises (`{ user, ipAddress, createdAt }`) and was the actual
// reason this tab looked empty: `log.user.name` threw on every row since
// `log.user` was undefined, so nothing rendered. These helpers accept
// either shape so the tab degrades gracefully instead of blanking out
// while that backend fix lands — see bug report.
function auditUserName(log) {
  return (
    log.user?.name ??
    log.userName ??
    (log.user_id != null ? `User #${log.user_id}` : 'Unknown user')
  );
}

function auditIp(log) {
  return log.ipAddress ?? log.ip_address ?? '—';
}

function auditCreatedAt(log) {
  return log.createdAt ?? log.created_at ?? null;
}

function AuditLogTab() {
  const [logs, status] = useTabData(getAuditLogs);
  const colSpan = 4;

  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <th className="px-4 py-3 text-left font-medium text-slate-500">User</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">Action</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">Resource</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">IP address</th>
          <th className="px-4 py-3 text-left font-medium text-slate-500">When</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 bg-white">
        {status === 'loading' && <LoadingRow colSpan={colSpan} />}
        {status === 'error' && (
          <ErrorRow colSpan={colSpan} message="Couldn't load audit logs." />
        )}
        {status === 'ready' && logs.length === 0 && (
          <EmptyRow colSpan={colSpan} message="No audit log entries yet." />
        )}
        {status === 'ready' &&
          logs.map((log) => {
            const action = log.action.toLowerCase();
            const isNegative = action.includes('denied') || action.includes('rejected');
            return (
              <tr key={log.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-800">
                  {auditUserName(log)}
                </td>
                <td className="px-4 py-3">
                  <StatusPill tone={isNegative ? 'red' : 'green'}>
                    {log.action}
                  </StatusPill>
                </td>
                <td className="px-4 py-3 text-slate-500">{log.resource}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">
                  {auditIp(log)}
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {formatDate(auditCreatedAt(log))}
                </td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}

// --- Page shell -----------------------------------------------------------

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState('users');

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <AlertBanner />

      <header className="border-b border-slate-200 bg-white px-6 pt-6">
        <h1 className="text-xl font-semibold text-slate-900">Admin</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage users, roles, and access across AccessOS.
        </p>

        <nav className="mt-5 flex gap-6 border-b border-transparent">
          {TABS.map((tab) => {
            const isActive = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`relative pb-3 text-sm font-medium transition-colors ${
                  isActive
                    ? 'text-slate-900'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {tab.label}
                {isActive && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-slate-900" />
                )}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="px-6 py-6">
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <TabErrorBoundary resetKey={activeTab}>
              {activeTab === 'users' && <UsersTab />}
              {activeTab === 'roles' && <RolesTab />}
              {activeTab === 'requests' && <AccessRequestsTab />}
              {activeTab === 'audit' && <AuditLogTab />}
              {activeTab === 'alerts' && <AlertsTab />}
            </TabErrorBoundary>
          </div>
        </div>
      </main>
    </div>
  );
}
