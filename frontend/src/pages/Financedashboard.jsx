// Owned by Frontend Dev 3. Gated on 'view_finance_dashboard', same as
// before — that gating logic is untouched below, only the allowed-body
// content is new. Structure (useAsync hook, StatusPill, table
// loading/empty/error rows) mirrors AdminDashboard.jsx's tabs so this
// looks consistent with the rest of the app.
//
// NOTE ON FILENAME: this replaces a file that was on disk as
// `pages/Financedashboard` (no extension, wrong case) while App.jsx
// imports `./pages/FinanceDashboard.jsx` — that mismatch would have
// failed to resolve at build time regardless of what the component did.
// Delete the old `Financedashboard` file once this one's in place.
//
// Backend: finance.routes.js (GET /api/finance/budgets, GET/POST
// /api/finance/expenses, PUT /api/finance/expenses/:id, GET
// /api/finance/reports) is still being built by Backend Dev 3. Everything
// here is written against the shape described in the task; no numbers
// below are hardcoded — every figure comes from one of those four calls.
// See api/client.js for the exact request/response shapes assumed.
import { useMemo, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import {
  getBudgets,
  getExpenses,
  createExpense,
  setExpenseStatus,
  getFinanceReports,
} from '../api/client.js';

const PERMISSION_KEY = 'view_finance_dashboard';

// --- Small shared helpers (same look as AdminDashboard.jsx) ---------------

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function formatCurrency(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
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
  const [data, setData] = useState(null);
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
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SectionCard({ title, subtitle, children, action }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// --- Budget overview ---------------------------------------------------

function budgetDerived(b) {
  const allocated = Number(b.allocated) || 0;
  const spent = Number(b.spent) || 0;
  const remaining = b.remaining != null ? Number(b.remaining) : allocated - spent;
  const utilization =
    b.utilizationPercent != null
      ? Number(b.utilizationPercent)
      : allocated > 0
      ? (spent / allocated) * 100
      : 0;
  return { allocated, spent, remaining, utilization };
}

function BudgetOverview() {
  const [budgets, status] = useAsync(getBudgets);
  const colSpan = 5;

  return (
    <SectionCard title="Budget overview" subtitle="Allocated vs. spent, by category">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Category</th>
              <th className="px-4 py-3 text-right font-medium text-slate-500">Allocated</th>
              <th className="px-4 py-3 text-right font-medium text-slate-500">Spent</th>
              <th className="px-4 py-3 text-right font-medium text-slate-500">Remaining</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Utilization</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {status === 'loading' && <LoadingRow colSpan={colSpan} />}
            {status === 'error' && (
              <ErrorRow colSpan={colSpan} message="Couldn't load budgets." />
            )}
            {status === 'ready' && (budgets ?? []).length === 0 && (
              <EmptyRow colSpan={colSpan} message="No budgets set up yet." />
            )}
            {status === 'ready' &&
              (budgets ?? []).map((b) => {
                const { allocated, spent, remaining, utilization } = budgetDerived(b);
                const over = utilization > 100;
                return (
                  <tr key={b.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-800">{b.category}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{formatCurrency(allocated)}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{formatCurrency(spent)}</td>
                    <td className={`px-4 py-3 text-right ${remaining < 0 ? 'text-rose-600' : 'text-slate-600'}`}>
                      {formatCurrency(remaining)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full ${over ? 'bg-rose-500' : 'bg-emerald-500'}`}
                            style={{ width: `${Math.min(utilization, 100)}%` }}
                          />
                        </div>
                        <span className={`text-xs ${over ? 'text-rose-600' : 'text-slate-500'}`}>
                          {utilization.toFixed(0)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// --- Submit expense form -----------------------------------------------

function SubmitExpenseModal({ categories, onClose, onCreated }) {
  const [category, setCategory] = useState(categories[0] ?? '');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    const parsedAmount = Number(amount);
    if (!category.trim() || !description.trim() || !amount || parsedAmount <= 0) {
      setError('Category, description, and a positive amount are all required.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await createExpense({
        category: category.trim(),
        description: description.trim(),
        amount: parsedAmount,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(
        err.response?.data?.message || "Couldn't submit this expense. Check the details and try again."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Submit expense" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-600">Category</label>
          {categories.length > 0 ? (
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Travel"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
            />
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Client dinner, team offsite, etc."
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600">Amount (USD)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="150.00"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
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
            {saving ? 'Submitting…' : 'Submit expense'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// --- Expense list ---------------------------------------------------------

function ExpenseList({ budgetCategories }) {
  const [expenses, status, refetch] = useAsync(getExpenses);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [pending, setPending] = useState({});
  const [rowError, setRowError] = useState({});
  const colSpan = 6;

  async function handleDecision(expenseId, decision) {
    setPending((prev) => ({ ...prev, [expenseId]: true }));
    setRowError((prev) => ({ ...prev, [expenseId]: null }));

    try {
      await setExpenseStatus(expenseId, decision);
      refetch();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [expenseId]: `Couldn't ${decision === 'approved' ? 'approve' : 'reject'} this expense.`,
      }));
    } finally {
      setPending((prev) => ({ ...prev, [expenseId]: false }));
    }
  }

  return (
    <SectionCard
      title="Expenses"
      subtitle="Submitted expenses awaiting or past review"
      action={
        <button
          onClick={() => setShowSubmitModal(true)}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
        >
          + Submit expense
        </button>
      }
    >
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Category</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Description</th>
              <th className="px-4 py-3 text-right font-medium text-slate-500">Amount</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Submitted by</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Status</th>
              <th className="px-4 py-3 text-right font-medium text-slate-500">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {status === 'loading' && <LoadingRow colSpan={colSpan} />}
            {status === 'error' && (
              <ErrorRow colSpan={colSpan} message="Couldn't load expenses." />
            )}
            {status === 'ready' && (expenses ?? []).length === 0 && (
              <EmptyRow colSpan={colSpan} message="No expenses submitted yet." />
            )}
            {status === 'ready' &&
              (expenses ?? []).map((exp) => {
                const isPending = !!pending[exp.id];
                const error = rowError[exp.id];
                const isDecided = exp.status !== 'pending';
                return (
                  <tr key={exp.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-800">{exp.category}</td>
                    <td className="px-4 py-3 text-slate-500">{exp.description}</td>
                    <td className="px-4 py-3 text-right text-slate-600">
                      {formatCurrency(Number(exp.amount))}
                    </td>
                    <td className="px-4 py-3 text-slate-500">{exp.submittedBy?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      <StatusPill
                        tone={
                          exp.status === 'approved' ? 'green' : exp.status === 'rejected' ? 'red' : 'amber'
                        }
                      >
                        {exp.status}
                      </StatusPill>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isDecided ? (
                        <span className="text-xs text-slate-400">{formatDate(exp.reviewedAt)}</span>
                      ) : (
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => handleDecision(exp.id, 'approved')}
                              disabled={isPending}
                              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                            >
                              {isPending ? '…' : 'Approve'}
                            </button>
                            <button
                              onClick={() => handleDecision(exp.id, 'rejected')}
                              disabled={isPending}
                              className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                            >
                              {isPending ? '…' : 'Reject'}
                            </button>
                          </div>
                          {error && <span className="text-xs text-rose-500">{error}</span>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {showSubmitModal && (
        <SubmitExpenseModal
          categories={budgetCategories}
          onClose={() => setShowSubmitModal(false)}
          onCreated={refetch}
        />
      )}
    </SectionCard>
  );
}

// --- Reports ----------------------------------------------------------

function StatBlock({ label, value }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-800">{value}</p>
    </div>
  );
}

function Reports() {
  const [reports, status] = useAsync(getFinanceReports);

  if (status === 'loading') {
    return (
      <SectionCard title="Reports">
        <p className="px-4 py-8 text-center text-sm text-slate-400">Loading…</p>
      </SectionCard>
    );
  }

  if (status === 'error') {
    return (
      <SectionCard title="Reports">
        <p className="px-4 py-8 text-center text-sm text-rose-500">Couldn't load reports.</p>
      </SectionCard>
    );
  }

  const budgetSummary = reports?.budgetSummary;
  const expenseSummary = reports?.expenseSummary;
  const monthlySummary = reports?.monthlySummary ?? [];
  const maxMonthly = Math.max(1, ...monthlySummary.map((m) => Number(m.totalSpent) || 0));

  return (
    <div className="space-y-4">
      {budgetSummary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatBlock label="Total allocated" value={formatCurrency(Number(budgetSummary.totalAllocated))} />
          <StatBlock label="Total spent" value={formatCurrency(Number(budgetSummary.totalSpent))} />
          <StatBlock label="Total remaining" value={formatCurrency(Number(budgetSummary.totalRemaining))} />
          <StatBlock
            label="Utilization"
            value={`${Number(budgetSummary.utilizationPercent ?? 0).toFixed(0)}%`}
          />
        </div>
      )}

      {expenseSummary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatBlock label="Pending expenses" value={expenseSummary.totalPending ?? 0} />
          <StatBlock label="Approved expenses" value={expenseSummary.totalApproved ?? 0} />
          <StatBlock label="Rejected expenses" value={expenseSummary.totalRejected ?? 0} />
          <StatBlock
            label="Approved amount"
            value={formatCurrency(Number(expenseSummary.totalAmountApproved))}
          />
        </div>
      )}

      <SectionCard title="Monthly summary" subtitle="Total spend by month">
        {monthlySummary.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-400">No monthly data yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {monthlySummary.map((m) => (
              <li key={m.month} className="flex items-center gap-4 px-4 py-3">
                <span className="w-24 flex-none text-sm text-slate-600">{m.month}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full bg-sky-500"
                    style={{ width: `${((Number(m.totalSpent) || 0) / maxMonthly) * 100}%` }}
                  />
                </div>
                <span className="w-24 flex-none text-right text-sm text-slate-600">
                  {formatCurrency(Number(m.totalSpent))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

// --- Page shell -------------------------------------------------------------

function FinanceDashboardBody() {
  // Budgets are fetched here too (separately from BudgetOverview's own
  // fetch) purely to get the list of known categories for the expense
  // submission form's dropdown — a little duplicate-fetching for a much
  // simpler prop story than lifting BudgetOverview's whole state up.
  const [budgets] = useAsync(getBudgets);
  const categories = useMemo(
    () => Array.from(new Set((budgets ?? []).map((b) => b.category).filter(Boolean))),
    [budgets]
  );

  return (
    <div className="space-y-6">
      <BudgetOverview />
      <ExpenseList budgetCategories={categories} />
      <Reports />
    </div>
  );
}

export default function FinanceDashboard() {
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
            You don't have access to the Finance Dashboard
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
          <div className="h-8 w-1.5 rounded-full bg-emerald-500" />
          <h1 className="text-2xl font-semibold text-slate-800">Finance Dashboard</h1>
        </div>
        <p className="mt-1 text-sm text-slate-500">Budgets, expenses, and financial reports.</p>

        <div className="mt-8">
          <FinanceDashboardBody />
        </div>
      </div>
    </div>
  );
}
