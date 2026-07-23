// Owned by Frontend Dev 3. Gated on 'view_hr_dashboard', same as before —
// that gating logic is untouched below, only the allowed-body content is
// new. Structure (useTabData hook, StatusPill, table loading/empty/error
// rows) mirrors AdminDashboard.jsx's Users tab so this looks consistent
// with the rest of the app rather than a one-off design.
//
// NOTE ON FILENAME: this replaces a file that was on disk as
// `pages/Hrdashboard` (no extension, wrong case) while App.jsx imports
// `./pages/HRDashboard.jsx` — that mismatch would have failed to resolve
// at build time regardless of what the component did. Delete the old
// `Hrdashboard` file once this one's in place.
//
// Backend: hr.routes.js (GET/POST /api/hr/employees, PUT
// /api/hr/employees/:id, PUT /api/hr/employees/:id/status) is still being
// built by Backend Dev 3. Everything here is written against the shape
// described in the task and will work unchanged once those routes exist —
// see api/client.js for the exact request/response shapes assumed.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { getEmployees, createEmployee, setEmployeeStatus } from '../api/client.js';

const PERMISSION_KEY = 'view_hr_dashboard';

// --- Small shared helpers (same look as AdminDashboard.jsx) ---------------

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
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

function useAsync(fetcher, deps = []) {
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

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// --- Onboarding form --------------------------------------------------------

function OnboardEmployeeModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [department, setDepartment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !department.trim()) {
      setError('Name, email, and department are all required.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await createEmployee({ name: name.trim(), email: email.trim(), department: department.trim() });
      onCreated();
      onClose();
    } catch (err) {
      setError(
        err.response?.data?.message || "Couldn't create this employee. Check the details and try again."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Onboard employee" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-600">Full name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
            placeholder="Jane Doe"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
            placeholder="jane.doe@nexagen.com"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600">Department</label>
          <input
            type="text"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
            placeholder="Engineering"
          />
        </div>

        {error && <p className="text-xs text-rose-500">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? 'Onboarding…' : 'Onboard employee'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// --- Employee directory ------------------------------------------------

function EmployeeDirectory() {
  const [employees, status, refetch] = useAsync(getEmployees);
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showOnboardModal, setShowOnboardModal] = useState(false);
  const [pending, setPending] = useState({}); // id -> true while status change in flight
  const [rowError, setRowError] = useState({});
  const colSpan = 6;

  const departments = useMemo(() => {
    const set = new Set(employees.map((e) => e.department).filter(Boolean));
    return Array.from(set).sort();
  }, [employees]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      const matchesSearch =
        !q || e.name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q);
      const matchesDept = departmentFilter === 'all' || e.department === departmentFilter;
      const matchesStatus = statusFilter === 'all' || e.status === statusFilter;
      return matchesSearch && matchesDept && matchesStatus;
    });
  }, [employees, search, departmentFilter, statusFilter]);

  async function handleToggleStatus(employee) {
    const nextStatus = employee.status === 'active' ? 'inactive' : 'active';
    setPending((prev) => ({ ...prev, [employee.id]: true }));
    setRowError((prev) => ({ ...prev, [employee.id]: null }));

    try {
      await setEmployeeStatus(employee.id, nextStatus);
      refetch();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [employee.id]: `Couldn't ${nextStatus === 'active' ? 'activate' : 'deactivate'} this employee.`,
      }));
    } finally {
      setPending((prev) => ({ ...prev, [employee.id]: false }));
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email…"
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none sm:max-w-xs"
          />
          <select
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="all">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <button
          onClick={() => setShowOnboardModal(true)}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
        >
          + Onboard employee
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Name</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Email</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Department</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Roles</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Status</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Joined</th>
              <th className="px-4 py-3 text-right font-medium text-slate-500">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {status === 'loading' && <LoadingRow colSpan={colSpan + 1} />}
            {status === 'error' && (
              <ErrorRow colSpan={colSpan + 1} message="Couldn't load the employee directory." />
            )}
            {status === 'ready' && employees.length === 0 && (
              <EmptyRow colSpan={colSpan + 1} message="No employees yet — onboard the first one above." />
            )}
            {status === 'ready' && employees.length > 0 && filtered.length === 0 && (
              <EmptyRow colSpan={colSpan + 1} message="No employees match your search/filters." />
            )}
            {status === 'ready' &&
              filtered.map((emp) => {
                const isPending = !!pending[emp.id];
                const error = rowError[emp.id];
                const isActive = emp.status === 'active';
                return (
                  <tr key={emp.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-800">{emp.name}</td>
                    <td className="px-4 py-3 text-slate-500">{emp.email}</td>
                    <td className="px-4 py-3 text-slate-500">{emp.department || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {(emp.roles ?? []).length > 0 ? (
                          emp.roles.map((role) => (
                            <StatusPill key={role} tone="slate">
                              {role}
                            </StatusPill>
                          ))
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill tone={isActive ? 'green' : 'red'}>
                        {isActive ? 'Active' : 'Inactive'}
                      </StatusPill>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{formatDate(emp.joinedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-col items-end gap-1">
                        <button
                          onClick={() => handleToggleStatus(emp)}
                          disabled={isPending}
                          className={`rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 ${
                            isActive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'
                          }`}
                        >
                          {isPending ? 'Saving…' : isActive ? 'Deactivate' : 'Activate'}
                        </button>
                        {error && <span className="text-xs text-rose-500">{error}</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {showOnboardModal && (
        <OnboardEmployeeModal onClose={() => setShowOnboardModal(false)} onCreated={refetch} />
      )}
    </div>
  );
}

// --- Page shell -------------------------------------------------------------

export default function HRDashboard() {
  const raw = sessionStorage.getItem('user');
  const user = raw ? JSON.parse(raw) : null;

  if (!user) {
    window.location.href = '/';
    return null;
  }

  const allowed = !!user.permissions?.includes(PERMISSION_KEY);

  if (!allowed) {
    return (
      <div className="min-h-screen bg-slate-50 p-6 md:p-10">
        <div className="mx-auto max-w-3xl rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-sm font-medium text-slate-400">🔒 Restricted</p>
          <h1 className="mt-2 text-xl font-semibold text-slate-800">
            You don't have access to the HR Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Ask an admin to grant "{PERMISSION_KEY}", or use Request Access from the dashboard.
          </p>
          <Link
            to="/dashboard"
            className="mt-4 inline-block text-sm font-medium text-slate-700 hover:text-slate-900"
          >
            ← Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <div className="mx-auto max-w-6xl p-6 md:p-10">
        <Link to="/dashboard" className="text-sm font-medium text-slate-500 hover:text-slate-700">
          ← Back to Dashboard
        </Link>

        <div className="mt-4 flex items-center gap-3">
          <div className="h-8 w-1.5 rounded-full bg-sky-500" />
          <h1 className="text-2xl font-semibold text-slate-800">HR Dashboard</h1>
        </div>
        <p className="mt-1 text-sm text-slate-500">Employee directory and onboarding.</p>

        <div className="mt-8">
          <EmployeeDirectory />
        </div>
      </div>
    </div>
  );
}
