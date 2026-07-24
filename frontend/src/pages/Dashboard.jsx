import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { requestAccess, getAvailableRoles, getMe, getMyAccessRequests } from '../api/client.js';
import Header from '../components/Header.jsx';

// Static registry of dashboard features. Add new cards here as the product
// grows — each just needs the permission string that unlocks it.
// `path` is optional: only set it once a real page exists for the card.
// Cards without a path keep the old inert "Open →" button rather than
// linking somewhere that 404s.
//
// `role` is new: the single named role (see schema.sql's role_permissions
// seed) that currently grants this card's permission — 'finance' is the
// only role granting view_finance_dashboard, 'admin' is the only role
// granting manage_users, etc. It's used purely to look up that role's
// expiry for the countdown badge below; it's a frontend-only mapping, not
// something read from the API. If a permission ever ends up grantable by
// more than one role, this 1:1 lookup stops being accurate and the expiry
// would need to come from the backend per-permission instead of per-role.
//
// EXPIRY DATA ASSUMPTION: this reads `user.roleExpirations`, a shape that
// doesn't exist on GET /auth/me yet (today it only returns
// { id, name, email } — see the note in refreshSession() below). Assumed
// shape once it's added: `{ [roleName]: expiresAtISOString }`, present
// only for roles with a non-null user_roles.expires_at (see migration 006)
// — permanent roles simply have no entry. Everything below degrades
// gracefully if it's absent: `user.roleExpirations?.[...]` is undefined,
// useCountdown treats that as "no expiry", cards behave exactly as they
// do today. Flag to Backend Dev 1 if a different shape is planned.
const FEATURES = [
  {
    key: 'view_finance_dashboard',
    title: 'Finance Dashboard',
    description: 'View budgets, expenses, and financial reports.',
    accent: 'bg-emerald-500',
    path: '/dashboard/finance',
    role: 'finance',
  },
  {
    key: 'view_hr_dashboard',
    title: 'HR Dashboard',
    description: 'Employee records, leave requests, and payroll.',
    accent: 'bg-sky-500',
    path: '/dashboard/hr',
    role: 'hr',
  },
  {
    key: 'manage_users',
    title: 'User Management',
    description: 'Create, edit, and manage user roles.',
    accent: 'bg-violet-500',
    role: 'admin',
  },
  {
    key: 'view_audit_log',
    title: 'Audit Log',
    description: 'Review permission checks and admin actions.',
    accent: 'bg-amber-500',
    role: 'admin',
  },
];

// Human-readable label for a permission key, for use in the "new access"
// toast. Falls back to the raw key for permissions that aren't tied to a
// dashboard card (e.g. anything admin-only).
function permissionLabel(key) {
  return FEATURES.find((f) => f.key === key)?.title ?? key;
}

// Human-readable label + pill color for each access_requests.status value.
// Falls back to the raw value for anything unrecognized so a future status
// doesn't render as a blank cell.
const STATUS_LABELS = {
  PENDING_MANAGER: { label: 'Pending manager review', tone: 'amber' },
  PENDING_ADMIN: { label: 'Pending admin review', tone: 'amber' },
  APPROVED: { label: 'Approved', tone: 'green' },
  REJECTED: { label: 'Rejected', tone: 'red' },
  REVOKED: { label: 'Revoked', tone: 'slate' },
};

function statusInfo(status) {
  return STATUS_LABELS[status] ?? { label: status, tone: 'slate' };
}

const STATUS_PILL_TONES = {
  slate: 'bg-slate-100 text-slate-700',
  green: 'bg-emerald-100 text-emerald-700',
  red: 'bg-rose-100 text-rose-700',
  amber: 'bg-amber-100 text-amber-700',
};

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// Renders a manager/admin decision cell: the decision itself plus its
// comment (if any), or "Awaiting review" while that stage hasn't happened
// yet.
function DecisionCell({ decision }) {
  if (!decision) {
    return <span className="text-xs italic text-slate-400">Awaiting review</span>;
  }

  // adminDecision.decision can be APPROVED | REJECTED | REVOKED (see
  // accessRequestsMe.routes.js); managerDecision.decision is only ever
  // APPROVED | REJECTED. Handle all three explicitly rather than
  // defaulting anything non-APPROVED to "Rejected", which mislabeled a
  // revoke as a rejection.
  const DECISION_STYLES = {
    APPROVED: { tone: 'green', label: 'Approved' },
    REJECTED: { tone: 'red', label: 'Rejected' },
    REVOKED: { tone: 'slate', label: 'Revoked' },
  };
  const { tone, label } = DECISION_STYLES[decision.decision] ?? {
    tone: 'slate',
    label: decision.decision,
  };

  return (
    <div>
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL_TONES[tone]}`}
      >
        {label}
      </span>
      {decision.comment && (
        <p className="mt-1 text-xs text-slate-500">{decision.comment}</p>
      )}
    </div>
  );
}

// Ticks every 30s (not every second — this is a badge, not a stopwatch;
// matches the "refresh every 30s" spec and avoids re-rendering every card
// every second for no visible benefit at minute-level display precision).
// `expiresAt` absent/null means a permanent grant — the interval never
// starts and every call returns the same inert "not active" result.
const COUNTDOWN_TICK_MS = 30000;
const COUNTDOWN_RED_THRESHOLD_MS = 5 * 60 * 1000; // under 5 minutes
const COUNTDOWN_AMBER_THRESHOLD_MS = 60 * 60 * 1000; // under 1 hour

function formatCountdown(msRemaining) {
  const totalMinutes = Math.floor(msRemaining / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `expires in ${hours}h ${minutes}m`;
  if (minutes > 0) return `expires in ${minutes}m`;
  return 'expires in <1m';
}

function useCountdown(expiresAt) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return undefined; // permanent — nothing to tick
    const interval = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(interval);
  }, [expiresAt]);

  if (!expiresAt) {
    return { active: false, expired: false, label: null, tone: 'slate' };
  }

  const msRemaining = new Date(expiresAt).getTime() - now;

  if (msRemaining <= 0) {
    return { active: true, expired: true, label: null, tone: 'red' };
  }

  const tone =
    msRemaining < COUNTDOWN_RED_THRESHOLD_MS
      ? 'red'
      : msRemaining < COUNTDOWN_AMBER_THRESHOLD_MS
      ? 'amber'
      : 'slate';

  return { active: true, expired: false, label: formatCountdown(msRemaining), tone };
}

const COUNTDOWN_BADGE_TONES = {
  slate: 'bg-slate-100 text-slate-600',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-rose-100 text-rose-700',
};

function FeatureCard({ title, description, accent, enabled, path, expiresAt }) {
  const countdown = useCountdown(expiresAt);
  // A card can be permission-enabled but locally past its computed expiry
  // for up to 30s before the next tick / the next session refresh confirms
  // it server-side — treat that window as already expired rather than
  // showing a live "Open →" on a grant that's actually timed out.
  const effectivelyEnabled = enabled && !countdown.expired;

  return (
    <div
      className={`relative rounded-xl border p-5 shadow-sm transition ${
        effectivelyEnabled
          ? 'border-slate-200 bg-white hover:shadow-md hover:-translate-y-0.5'
          : 'border-slate-100 bg-slate-50 opacity-60'
      }`}
    >
      {effectivelyEnabled && countdown.active && (
        <span
          className={`absolute right-4 top-4 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${COUNTDOWN_BADGE_TONES[countdown.tone]}`}
        >
          ⏱ {countdown.label}
        </span>
      )}

      <div className={`h-1.5 w-10 rounded-full ${accent} mb-4`} />
      <h3 className="font-semibold text-slate-800">{title}</h3>
      <p className="mt-1 text-sm text-slate-500">{description}</p>

      <div className="mt-4">
        {countdown.expired ? (
          <span className="text-xs font-medium text-rose-500">
            Access expired — request again
          </span>
        ) : effectivelyEnabled && path ? (
          <Link
            to={path}
            className="text-sm font-medium text-slate-700 hover:text-slate-900"
          >
            Open →
          </Link>
        ) : effectivelyEnabled ? (
          <button
            type="button"
            className="text-sm font-medium text-slate-700 hover:text-slate-900"
          >
            Open →
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400">
            🔒 Restricted
          </span>
        )}
      </div>
    </div>
  );
}

function Toast({ type, message, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const isError = type === 'error';

  return (
    <div
      role="status"
      className={`fixed bottom-6 right-6 z-[60] flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium shadow-lg ${
        isError
          ? 'border-red-200 bg-red-50 text-red-700'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700'
      }`}
    >
      <span>{isError ? '⚠️' : '✅'}</span>
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-2 text-current opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <div className="mx-auto max-w-5xl animate-pulse p-6 md:p-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-full bg-slate-200" />
            <div className="space-y-2">
              <div className="h-4 w-40 rounded bg-slate-200" />
              <div className="h-3 w-24 rounded bg-slate-200" />
            </div>
          </div>
          <div className="h-9 w-36 rounded-lg bg-slate-200" />
        </div>

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-32 rounded-xl border border-slate-100 bg-white p-5">
              <div className="mb-4 h-1.5 w-10 rounded-full bg-slate-200" />
              <div className="mb-2 h-4 w-2/3 rounded bg-slate-200" />
              <div className="h-3 w-full rounded bg-slate-200" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// <select> values are always strings, so 'permanent' is a sentinel rather
// than using '' (which would be ambiguous with "not yet chosen") or null
// (which can't be a JSX select value). Converted to a real durationHours
// number|null right before it's sent — see handleSubmit below.
const DURATION_OPTIONS = [
  { value: '4', label: '4 hours' },
  { value: '24', label: '24 hours' },
  { value: '168', label: '7 days' },
  { value: 'permanent', label: 'Permanent' },
];

function RequestAccessModal({ roles, rolesStatus, onClose, onSubmit, submitting }) {
  const [selectedRoleId, setSelectedRoleId] = useState('');
  // Defaults to 'permanent' so a request submitted without anyone touching
  // this field behaves exactly like it did before this control existed.
  const [duration, setDuration] = useState('permanent');

  // roles load asynchronously after the modal opens, so default the
  // selection once they arrive instead of only on mount.
  useEffect(() => {
    if (rolesStatus === 'ready' && roles.length > 0 && !selectedRoleId) {
      setSelectedRoleId(roles[0].id);
    }
  }, [rolesStatus, roles, selectedRoleId]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const role = roles.find((r) => String(r.id) === String(selectedRoleId));
    const durationHours = duration === 'permanent' ? null : Number(duration);
    onSubmit(role, durationHours);
  };

  const canSubmit = rolesStatus === 'ready' && roles.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">Request Access</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {rolesStatus === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
                aria-hidden="true"
              />
              Loading roles…
            </div>
          )}

          {rolesStatus === 'error' && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              Could not load the list of roles. Please try again.
            </p>
          )}

          {rolesStatus === 'ready' && roles.length === 0 && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
              No roles are available to request right now.
            </p>
          )}

          {rolesStatus === 'ready' && roles.length > 0 && (
            <div>
              <label htmlFor="role" className="block text-sm font-medium text-slate-700">
                Role
              </label>
              <select
                id="role"
                value={selectedRoleId}
                onChange={(e) => setSelectedRoleId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} — {role.description}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label htmlFor="duration" className="block text-sm font-medium text-slate-700">
              Duration
            </label>
            <select
              id="duration"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              {DURATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !canSubmit}
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Submitting…' : 'Submit Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [checkedStorage, setCheckedStorage] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null); // { type: 'success' | 'error', message }
  const [roles, setRoles] = useState([]);
  const [rolesStatus, setRolesStatus] = useState('idle'); // idle | loading | ready | error
  const [refreshing, setRefreshing] = useState(false);
  const [myRequests, setMyRequests] = useState([]);
  const [myRequestsStatus, setMyRequestsStatus] = useState('idle'); // idle | loading | ready | error

  // Pulls the latest roles/permissions from the server and writes them
  // back into sessionStorage + state. Called on mount and from the manual
  // "Refresh access" button — this is what makes an admin's approval show
  // up without the user having to log out and back in.
  async function refreshSession() {
    setRefreshing(true);
    try {
      const fresh = await getMe();
      setUser((prev) => {
        const merged = { ...prev, ...fresh };
        sessionStorage.setItem('user', JSON.stringify(merged));

        // Surface anything newly granted since the last refresh (e.g. an
        // admin just approved a pending request) so it doesn't go
        // unnoticed until the user happens to reload.
        //
        // NOTE: GET /auth/me currently only returns { id, name, email } —
        // it doesn't include permissions (unlike POST /auth/login, which
        // does build that array). Until that's added, merged.permissions
        // never actually changes, so this block is a safe no-op today —
        // it activates automatically the moment the endpoint returns
        // permissions. Flagged to backend; not something fixable from here.
        const prevPermissions = Array.isArray(prev?.permissions) ? prev.permissions : [];
        const newPermissions = Array.isArray(merged.permissions) ? merged.permissions : [];
        const newlyGranted = newPermissions.filter((p) => !prevPermissions.includes(p));

        if (newlyGranted.length > 0) {
          const label =
            newlyGranted.length === 1
              ? permissionLabel(newlyGranted[0])
              : `${newlyGranted.length} new features`;
          setToast({
            type: 'success',
            message: `You now have access to ${label}.`,
          });
        }

        return merged;
      });
    } catch (err) {
      // Non-fatal — keep showing whatever we already have from
      // sessionStorage rather than blocking the page.
      console.error('Failed to refresh session:', err);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const raw = sessionStorage.getItem('user');

    if (!raw) {
      window.location.href = '/';
      return;
    }

    try {
      const parsedUser = JSON.parse(raw);
      setUser(parsedUser);
    } catch (err) {
      // Malformed JSON in sessionStorage — treat same as "not logged in"
      console.error('Failed to parse user from sessionStorage:', err);
      sessionStorage.removeItem('user');
      window.location.href = '/';
      return;
    }

    setCheckedStorage(true);
    // Fire-and-forget refresh right after showing the cached session, so
    // the page paints immediately but corrects itself if roles changed
    // since last login.
    refreshSession();
  }, []);

  // Loads the current user's own access requests for the "My requests"
  // section. Separate effect (rather than folded into the session-check
  // effect above) so a failure here never blocks the rest of the page
  // from rendering.
  useEffect(() => {
    if (!checkedStorage) return;

    let cancelled = false;
    setMyRequestsStatus('loading');

    getMyAccessRequests()
      .then((data) => {
        if (cancelled) return;
        setMyRequests(data);
        setMyRequestsStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load my access requests:', err);
        setMyRequestsStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [checkedStorage]);

  const openRequestModal = async () => {
    setModalOpen(true);
    setRolesStatus('loading');
    try {
      const data = await getAvailableRoles();
      setRoles(data);
      setRolesStatus('ready');
    } catch (err) {
      console.error('Failed to load roles:', err);
      setRolesStatus('error');
    }
  };

  const handleRequestSubmit = async (role, durationHours) => {
    if (!role) return;

    setSubmitting(true);

    try {
      await requestAccess(role.id, durationHours);
      setModalOpen(false);
      setToast({
        type: 'success',
        message: `Access request for "${role.name}" submitted — an admin will review it.`,
      });
    } catch (err) {
      console.error('Failed to submit access request:', err);
      const message =
        err.response?.data?.error ||
        'Could not submit your request. Please try again.';
      setToast({ type: 'error', message });
    } finally {
      setSubmitting(false);
    }
  };

  // Avoid a flash of empty content until we've checked sessionStorage —
  // show a skeleton instead of nothing while that resolves.
  if (!checkedStorage || !user) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <div className="mx-auto max-w-5xl p-6 md:p-10">
        {/* Page toolbar — identity + logout now live in the shared
            <Header /> above; this keeps only what's specific to this page
            (a greeting, plus the two action buttons Header doesn't have).
            Roles are still shown in full below in "My roles & permissions",
            so dropping the duplicate role pills that used to be up here
            isn't a loss of information. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-xl font-semibold text-slate-800">
            Welcome, {user.name}
          </h1>

          <div className="flex items-center gap-2 self-start sm:self-auto">
            <button
              type="button"
              onClick={refreshSession}
              disabled={refreshing}
              title="Pull the latest roles/permissions if an admin just approved a request"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refreshing ? 'Refreshing…' : 'Refresh access'}
            </button>
            <button
              type="button"
              onClick={openRequestModal}
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-900"
            >
              Request Access
            </button>
          </div>
        </div>

        {/* Feature grid */}
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature) => (
            <FeatureCard
              key={feature.key}
              title={feature.title}
              description={feature.description}
              accent={feature.accent}
              enabled={user.permissions.includes(feature.key)}
              path={feature.path}
              expiresAt={user.roleExpirations?.[feature.role]}
            />
          ))}
        </div>

        {/* Roles & permissions — read straight from sessionStorage, no API call */}
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold text-slate-800">My roles & permissions</h2>

          <div className="mt-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Roles
            </h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {user.roles.length > 0 ? (
                user.roles.map((role) => (
                  <span
                    key={role}
                    className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium capitalize text-slate-700"
                  >
                    {role}
                  </span>
                ))
              ) : (
                <span className="text-xs font-medium italic text-slate-400">
                  No roles assigned yet
                </span>
              )}
            </div>
          </div>

          <div className="mt-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Permissions
            </h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {user.permissions.length > 0 ? (
                user.permissions.map((permission) => (
                  <span
                    key={permission}
                    className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600"
                  >
                    {permission}
                  </span>
                ))
              ) : (
                <span className="text-xs font-medium italic text-slate-400">
                  No permissions granted yet
                </span>
              )}
            </div>
          </div>
        </div>

        {/* My requests — wired up against GET /access-requests/me. Backend
            Dev 1 hasn't shipped that endpoint yet (see client.js), so this
            currently renders the documented-shape mock data; the table
            itself doesn't need to change once the real endpoint lands. */}
        <div className="mt-8 rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between p-5 pb-0">
            <h2 className="font-semibold text-slate-800">My requests</h2>
          </div>

          <div className="mt-4 overflow-x-auto">
            {myRequestsStatus === 'loading' && (
              <p className="px-5 pb-5 text-sm text-slate-400">Loading your requests…</p>
            )}

            {myRequestsStatus === 'error' && (
              <p className="px-5 pb-5 text-sm text-rose-500">
                Couldn't load your access requests. Please try again later.
              </p>
            )}

            {myRequestsStatus === 'ready' && myRequests.length === 0 && (
              <p className="px-5 pb-5 text-sm text-slate-400">
                You haven't requested any access yet.
              </p>
            )}

            {myRequestsStatus === 'ready' && myRequests.length > 0 && (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-5 py-3 text-left font-medium text-slate-500">Resource</th>
                    <th className="px-5 py-3 text-left font-medium text-slate-500">Requested access</th>
                    <th className="px-5 py-3 text-left font-medium text-slate-500">Requested</th>
                    <th className="px-5 py-3 text-left font-medium text-slate-500">Status</th>
                    <th className="px-5 py-3 text-left font-medium text-slate-500">Manager decision</th>
                    <th className="px-5 py-3 text-left font-medium text-slate-500">Admin decision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {myRequests.map((req) => {
                    const { label, tone } = statusInfo(req.status);
                    return (
                      <tr key={req.id}>
                        <td className="px-5 py-3 font-medium text-slate-800">{req.resource}</td>
                        <td className="px-5 py-3 capitalize text-slate-600">{req.requestedAccess}</td>
                        <td className="px-5 py-3 text-slate-500">{formatDate(req.requestedAt)}</td>
                        <td className="px-5 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_PILL_TONES[tone]}`}
                          >
                            {label}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <DecisionCell decision={req.managerDecision} />
                        </td>
                        <td className="px-5 py-3">
                          <DecisionCell decision={req.adminDecision} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {modalOpen && (
        <RequestAccessModal
          roles={roles}
          rolesStatus={rolesStatus}
          onClose={() => setModalOpen(false)}
          onSubmit={handleRequestSubmit}
          submitting={submitting}
        />
      )}

      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
