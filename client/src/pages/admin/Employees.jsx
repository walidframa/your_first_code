import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck, FileText, IdCard, Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import { Link } from 'react-router';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import AccountStatement from '../../components/AccountStatement';
import { useConfirm } from '../../components/ConfirmProvider';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ModalActions,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';

const monthName = (period) => {
  const [year, month] = String(period || '').split('-');
  if (!year || !month) return period;
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

/**
 * What somebody's balance says, in the words an owner uses.
 *
 * The ledger keeps one signed number and it means opposite things either side
 * of zero. Every screen that had to remember which way round it went got it
 * wrong at least once, so it is said here and nowhere else.
 */
function Standing({ employee }) {
  if (employee.owedToThem > 0.005) {
    return <Badge tone="warning">owed {money(employee.owedToThem)}</Badge>;
  }
  if (employee.owedToShop > 0.005) {
    return <Badge tone="danger">owes {money(employee.owedToShop)}</Badge>;
  }
  return <Badge tone="neutral">settled</Badge>;
}

function EmployeeForm({ employee, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(employee);
  const [form, setForm] = useState({
    name: employee?.name || '',
    phone: employee?.phone || '',
    jobTitle: employee?.job_title || '',
    monthlySalary: employee?.monthly_salary ?? '',
    startedOn: employee?.started_on || '',
    note: employee?.note || '',
    openingBalance: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        jobTitle: form.jobTitle.trim() || null,
        monthlySalary: Number(form.monthlySalary) || 0,
        startedOn: form.startedOn || null,
        note: form.note.trim() || null,
      };
      if (!editing && Number(form.openingBalance)) {
        body.openingBalance = Number(form.openingBalance);
      }

      const res = editing
        ? await api.put(`/employees/${employee.id}`, body)
        : await api.post('/employees', body);
      toast(editing ? `${res.data.employee.name} saved` : `${res.data.employee.name} added`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={saving ? undefined : onClose}
      title={editing ? `Edit ${employee.name}` : 'Add an employee'}
      subtitle="They get an account of their own, so they can buy on it"
    >
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Input label="Name" value={form.name} onChange={set('name')} required autoFocus />
        <Input label="Phone" value={form.phone} onChange={set('phone')} />
        <Input label="Job" value={form.jobTitle} onChange={set('jobTitle')} placeholder="e.g. Technician" />
        <Input
          label="Monthly salary"
          type="number"
          step="0.01"
          min="0"
          value={form.monthlySalary}
          onChange={set('monthlySalary')}
          hint="What one month puts on their account"
        />
        <Input label="Started" type="date" value={form.startedOn} onChange={set('startedOn')} />
        {!editing && (
          <Input
            label="Opening balance"
            type="number"
            step="0.01"
            value={form.openingBalance}
            onChange={set('openingBalance')}
            hint="Minus if the shop already owes them"
          />
        )}
        <Input label="Note" value={form.note} onChange={set('note')} className="col-span-2" />

        {error && (
          <p className="col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <ModalActions className="col-span-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            {editing ? 'Save' : 'Add them'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/**
 * Handing somebody money, and the one question worth asking about it.
 *
 * Not "is this a wage or an advance?" — the app cannot know and does not need
 * to. Money leaves the till and lands on their account; whether that clears
 * what was owed or puts them in debt until the end of the month is answered by
 * the balance afterwards.
 */
function PayModal({ employee, onClose, onSaved }) {
  const toast = useToast();
  const [amount, setAmount] = useState(
    employee.owedToThem > 0 ? String(employee.owedToThem) : '',
  );
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post(`/employees/${employee.id}/payments`, {
        amountUsd: Number(amount) || 0,
        note: note.trim() || null,
      });
      toast(`${res.data.voucher.voucher_number} — ${money(Number(amount))} to ${employee.name}`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not pay that out');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={saving ? undefined : onClose} title={`Pay ${employee.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {employee.owedToThem > 0.005
            ? `${money(employee.owedToThem)} is owed to them.`
            : employee.owedToShop > 0.005
              ? `They already owe ${money(employee.owedToShop)} — paying more adds to it.`
              : 'Their account is settled. Anything paid now is an advance.'}
        </p>

        <Input
          label="Amount"
          type="number"
          step="0.01"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          autoFocus
          hint="Out of the till, with a numbered voucher"
        />
        <Input label="What for" value={note} onChange={(e) => setNote(e.target.value)} />

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving} disabled={!(Number(amount) > 0)}>
            Pay it
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** One person: what they are owed, the months already run, and what they bought. */
function EmployeeModal({ id, onClose, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [detail, setDetail] = useState(null);
  const [period, setPeriod] = useState('');
  const [statement, setStatement] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get(`/employees/${id}`);
    setDetail(res.data);
  }, [id]);

  useEffect(() => {
    load();
    setPeriod(new Date().toISOString().slice(0, 7));
  }, [load]);

  async function runMonth() {
    try {
      await api.post(`/employees/${id}/salary`, { period });
      toast(`${monthName(period)} put on the account`);
      await load();
      onChanged();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not run that month', 'error');
    }
  }

  async function undoMonth(row) {
    const ok = await confirm({
      title: `Take back ${monthName(row.period)}?`,
      body: `${money(row.amount_usd)} comes off ${detail.employee.name}'s account, and the wage stops counting against the shop's profit.`,
      confirmLabel: 'Take it back',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/employees/${id}/salary/${row.period}`);
      await load();
      onChanged();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not undo that', 'error');
    }
  }

  if (!detail) {
    return (
      <Modal open onClose={onClose} title="Employee" size="lg">
        <Skeleton className="h-64" />
      </Modal>
    );
  }

  const { employee, salaries, entries, dealings } = detail;

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={employee.name}
        subtitle={[employee.job_title, employee.branch_name].filter(Boolean).join(' · ')}
        size="xl"
      >
        <div className="grid grid-cols-2 gap-5">
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <p className="text-xs tracking-wide text-slate-500 uppercase">Where they stand</p>
                  <p
                    className={cx(
                      'tnum text-2xl font-semibold',
                      employee.owedToThem > 0.005
                        ? 'text-amber-700'
                        : employee.owedToShop > 0.005
                          ? 'text-red-600'
                          : 'text-slate-700',
                    )}
                  >
                    {money(Math.abs(employee.balance))}
                  </p>
                  <p className="text-sm text-slate-500">
                    {employee.owedToThem > 0.005
                      ? 'the shop owes them'
                      : employee.owedToShop > 0.005
                        ? 'they owe the shop'
                        : 'settled'}
                  </p>
                </div>
                <div className="text-right text-sm text-slate-500">
                  <p className="tnum">{money(employee.monthly_salary)} a month</p>
                  {employee.started_on && <p className="text-xs">since {employee.started_on}</p>}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setStatement(true)}>
                  <FileText size={14} /> Statement
                </Button>
                {/*
                  * Straight through to the account itself. An employee's
                  * account is an ordinary customer account, and everything a
                  * customer's screen can do to it — the credit limit, a manual
                  * charge — belongs there rather than copied onto this screen.
                  */}
                <Link
                  to={`/admin/customers?id=${employee.customer_id}`}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50"
                >
                  <Wallet size={14} /> Their account
                </Link>
              </div>
            </Card>

            <Card className="p-4">
              <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
                Months run
              </p>
              <div className="mb-3 flex gap-2">
                <Input
                  label="Month"
                  type="month"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                />
                <div className="flex items-end">
                  <Button size="sm" onClick={runMonth} disabled={!period}>
                    <CalendarCheck size={14} /> Run it
                  </Button>
                </div>
              </div>

              {salaries.length === 0 ? (
                <p className="text-sm text-slate-400">No month has been run yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {salaries.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="text-slate-700">{monthName(s.period)}</span>
                      <span className="flex items-center gap-2">
                        <span className="tnum text-slate-600">{money(s.amount_usd)}</span>
                        <button
                          onClick={() => undoMonth(s)}
                          aria-label={`Take back ${monthName(s.period)}`}
                          className="rounded p-0.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-4">
            <Card className="p-4">
              <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
                Everything on the account
              </p>
              {entries.length === 0 ? (
                <p className="text-sm text-slate-400">Nothing yet.</p>
              ) : (
                <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto text-sm">
                  {entries.map((e) => (
                    <li key={e.id} className="flex justify-between gap-3 py-1.5">
                      <span className="min-w-0">
                        <span className="block truncate text-slate-700">
                          {e.note || e.kind}
                        </span>
                        <span className="text-xs text-slate-400">
                          {String(e.created_at).slice(0, 16).replace('T', ' ')}
                        </span>
                      </span>
                      <span
                        className={cx(
                          'tnum shrink-0',
                          e.amount_usd > 0 ? 'text-red-600' : 'text-brand-700',
                        )}
                      >
                        {e.amount_usd > 0 ? '+' : '−'}
                        {money(Math.abs(e.amount_usd))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-4">
              <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
                What they bought
              </p>
              {dealings.length === 0 ? (
                <p className="text-sm text-slate-400">Nothing off the shelf yet.</p>
              ) : (
                <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto text-sm">
                  {dealings.map((d) => (
                    <li key={`${d.kind}-${d.id}`} className="flex justify-between gap-3 py-1.5">
                      <span className="font-mono text-xs text-slate-600">{d.reference}</span>
                      <span className="tnum text-slate-700">{money(d.total)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </Modal>

      {statement && (
        <AccountStatement
          partyType="customer"
          partyId={employee.customer_id}
          path={`/employees/${employee.id}`}
          name={employee.name}
          onClose={() => setStatement(false)}
        />
      )}
    </>
  );
}

export default function Employees() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [paying, setPaying] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [period, setPeriod] = useState('');

  const load = useCallback(async () => {
    const res = await api.get('/employees');
    setData(res.data);
    setPeriod((now) => now || res.data.period);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runPayroll() {
    const ok = await confirm({
      title: `Run ${monthName(period)} for everybody?`,
      body: 'Each salary goes onto that person’s account and counts as a wage against the shop’s profit. Anybody already run for this month is skipped.',
      confirmLabel: 'Run the month',
      tone: 'primary',
    });
    if (!ok) return;
    try {
      const res = await api.post('/employees/payroll', { period });
      toast(
        res.data.paid > 0
          ? `${res.data.paid} put on account — ${money(res.data.accrued)}`
          : 'Everybody had already been run for that month',
      );
      await load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not run the month', 'error');
    }
  }

  async function archive(employee) {
    const ok = await confirm({
      title: `Remove ${employee.name}?`,
      body: 'They come off the list, and their account stays so the ledger still reads.',
      confirmLabel: 'Remove them',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/employees/${employee.id}`);
      await load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not remove them', 'error');
    }
  }

  const employees = data?.employees || [];
  const summary = data?.summary;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Employees"
        subtitle={
          summary
            ? `${summary.people} on the payroll · ${money(summary.monthly)} a month · ${money(summary.owedToStaff)} owed to staff`
            : 'Loading…'
        }
        actions={
          <Button onClick={() => setForm({})}>
            <Plus size={16} /> Add an employee
          </Button>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <Input
            label="Run the month"
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            hint="Every salary onto its own account, once"
          />
          <Button onClick={runPayroll} disabled={!period || employees.length === 0}>
            <CalendarCheck size={16} /> Run it for everybody
          </Button>
          {summary && summary.owedToShop > 0.005 && (
            <p className="ml-auto text-sm text-slate-500">
              <span className="tnum font-medium text-slate-700">{money(summary.owedToShop)}</span> in
              advances and purchases not yet worked off
            </p>
          )}
        </Card>

        {!data ? (
          <Skeleton className="h-64" />
        ) : employees.length === 0 ? (
          <EmptyState
            icon={IdCard}
            title="Nobody on the payroll yet"
            description="Add somebody and they get an account of their own — wages, advances and whatever they buy all land on the one balance."
          />
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Job</th>
                  <th className="px-3 py-2 text-right font-medium">Salary</th>
                  <th className="px-3 py-2 font-medium">Standing</th>
                  <th className="px-5 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {employees.map((e) => (
                  <tr key={e.id} className="transition hover:bg-slate-50">
                    <td
                      onClick={() => setOpenId(e.id)}
                      className="cursor-pointer px-5 py-2.5 font-medium text-slate-800"
                    >
                      {e.name}
                      {e.phone && <span className="block text-xs text-slate-400">{e.phone}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{e.job_title || '—'}</td>
                    <td className="tnum px-3 py-2.5 text-right text-slate-700">
                      {money(e.monthly_salary)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Standing employee={e} />
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="secondary" onClick={() => setPaying(e)}>
                          Pay
                        </Button>
                        <button
                          onClick={() => setForm(e)}
                          aria-label={`Edit ${e.name}`}
                          className="rounded p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => archive(e)}
                          aria-label={`Remove ${e.name}`}
                          className="rounded p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {form && (
        <EmployeeForm
          employee={form.id ? form : null}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            load();
          }}
        />
      )}

      {paying && (
        <PayModal
          employee={paying}
          onClose={() => setPaying(null)}
          onSaved={() => {
            setPaying(null);
            load();
          }}
        />
      )}

      {openId && (
        <EmployeeModal id={openId} onClose={() => setOpenId(null)} onChanged={load} />
      )}
    </div>
  );
}
