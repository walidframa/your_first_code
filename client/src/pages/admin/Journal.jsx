import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { when, isoDay } from '../../lib/when';
import {
  Button, Card, EmptyState, Input, LoadError, Modal, ModalActions, Select, Skeleton, cx, money, useToast,
} from '../../components/ui';

/**
 * Journal entries: the shop's own hand on the books.
 *
 * The one thing this screen has to do well is make the balance visible **while
 * somebody is typing**, not after they press save. An entry that does not
 * balance is refused by the server whatever this screen does — that rule lives
 * in one place and is not repeated here — but being told at the end that the
 * columns are out by twelve, with no clue which line is wrong, is how a person
 * comes to hate double entry.
 *
 * So the two totals and the difference sit under the lines and move as the
 * figures do. Save is offered only when they agree.
 */
const BLANK = () => ({
  key: `l${Math.random().toString(36).slice(2)}`,
  accountId: '', debit: '', credit: '', costCentreId: '', areaId: '',
});

export default function Journal() {
  const [entries, setEntries] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [centres, setCentres] = useState([]);
  const [areas, setAreas] = useState([]);
  const [failed, setFailed] = useState(null);
  const [writing, setWriting] = useState(false);
  const [looking, setLooking] = useState(null);

  const load = useCallback(async () => {
    try {
      const [list, chart, centre, area] = await Promise.all([
        api.get('/ledger/entries'),
        api.get('/ledger/accounts', { params: { activeOnly: 'true' } }),
        api.get('/ledger/cost-centres', { params: { activeOnly: 'true' } }),
        api.get('/ledger/areas', { params: { activeOnly: 'true' } }),
      ]);
      setEntries(list.data.entries);
      setAccounts(chart.data.accounts.filter((a) => !a.is_group));
      setCentres(centre.data.items);
      setAreas(area.data.items);
      setFailed(null);
    } catch (err) {
      setFailed(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (failed) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Journal" />
        <Card className="m-4">
          <LoadError error={failed} what="the journal" onRetry={load} />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Journal"
        subtitle="Entries written by hand, and everything they moved"
        actions={
          <Button onClick={() => setWriting(true)}>
            <Plus size={16} /> New entry
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <Card className="max-w-4xl overflow-hidden">
          {!entries ? (
            <div className="p-5"><Skeleton className="h-48 w-full" /></div>
          ) : entries.length === 0 ? (
            <EmptyState
              title="Nothing written yet"
              hint="A journal entry is how the books record something the till cannot — the owner putting money in, a bill that arrived, a correction."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="w-28 px-3 py-2 font-medium">Number</th>
                  <th className="w-28 px-2 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">What it was</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setLooking(e.id)}
                    className="cursor-pointer border-t border-slate-100 transition hover:bg-slate-50"
                  >
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{e.entry_number}</td>
                    <td className="px-2 py-2 text-slate-600">{e.entry_date}</td>
                    <td className="px-2 py-2 text-slate-800">
                      {e.memo || <span className="text-slate-400">—</span>}
                      {e.reverses_id && (
                        <span className="ms-1.5 text-[11px] text-amber-700">reversal</span>
                      )}
                    </td>
                    <td className="tnum px-2 py-2 text-right text-slate-800">{money(e.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {writing && (
        <EntryDialog
          accounts={accounts}
          centres={centres}
          areas={areas}
          onClose={() => setWriting(false)}
          onSaved={() => { setWriting(false); load(); }}
        />
      )}
      {looking && <EntryView id={looking} onClose={() => setLooking(null)} onChanged={load} />}
    </div>
  );
}

function EntryDialog({ accounts, centres, areas, onClose, onSaved }) {
  const toast = useToast();
  const [entryDate, setEntryDate] = useState(isoDay());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([BLANK(), BLANK()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const totals = useMemo(() => {
    const debit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const credit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    return { debit, credit, gap: Math.round((debit - credit) * 100) / 100 };
  }, [lines]);

  const ready =
    totals.gap === 0 &&
    totals.debit > 0 &&
    lines.filter((l) => l.accountId && (Number(l.debit) || Number(l.credit))).length >= 2;

  const setLine = (key, patch) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post('/ledger/entries', {
        entryDate,
        memo: memo.trim() || null,
        lines: lines
          .filter((l) => l.accountId && (Number(l.debit) || Number(l.credit)))
          .map((l) => ({
            accountId: Number(l.accountId),
            debit: Number(l.debit) || 0,
            credit: Number(l.credit) || 0,
            costCentreId: l.costCentreId ? Number(l.costCentreId) : null,
            areaId: l.areaId ? Number(l.areaId) : null,
          })),
      });
      toast('Entry posted');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not post it');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New journal entry" subtitle="Both columns have to agree" size="xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Input label="Date" name="entryDate" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} required />
          <Input label="What it was" name="memo" value={memo} onChange={(e) => setMemo(e.target.value)} className="col-span-2"
                 placeholder="e.g. Owner put money into the drawer" />
        </div>

        <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="w-32 px-2 py-2 text-right font-medium">Debit</th>
                <th className="w-32 px-2 py-2 text-right font-medium">Credit</th>
                {/* Only when the shop keeps them. A pair of empty columns on
                    every entry is a pair of questions nobody asked. */}
                {centres.length > 0 && <th className="w-40 px-2 py-2 font-medium">Cost centre</th>}
                {areas.length > 0 && <th className="w-40 px-2 py-2 font-medium">Area</th>}
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {lines.map((l) => (
                <tr key={l.key} className="border-t border-slate-100">
                  <td className="px-2 py-1.5">
                    <select
                      value={l.accountId}
                      onChange={(e) => setLine(l.key, { accountId: e.target.value })}
                      aria-label="Account"
                      className="h-9 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                    >
                      <option value="">Choose an account…</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                      ))}
                    </select>
                  </td>
                  {/* One side per line: typing in one column empties the other,
                      because a line carrying both is two lines pretending to be
                      one — and the server refuses it anyway. */}
                  <td className="px-2 py-1.5">
                    <input
                      type="number" min="0" step="0.01" placeholder="0.00"
                      value={l.debit}
                      onChange={(e) => setLine(l.key, { debit: e.target.value, credit: '' })}
                      aria-label="Debit"
                      className="tnum h-9 w-full rounded-lg bg-white px-2 text-right text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number" min="0" step="0.01" placeholder="0.00"
                      value={l.credit}
                      onChange={(e) => setLine(l.key, { credit: e.target.value, debit: '' })}
                      aria-label="Credit"
                      className="tnum h-9 w-full rounded-lg bg-white px-2 text-right text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                    />
                  </td>
                  {centres.length > 0 && (
                    <td className="px-2 py-1.5">
                      <select
                        value={l.costCentreId}
                        onChange={(e) => setLine(l.key, { costCentreId: e.target.value })}
                        aria-label="Cost centre"
                        className="h-9 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                      >
                        <option value="">—</option>
                        {centres.map((c) => (
                          <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                        ))}
                      </select>
                    </td>
                  )}
                  {areas.length > 0 && (
                    <td className="px-2 py-1.5">
                      <select
                        value={l.areaId}
                        onChange={(e) => setLine(l.key, { areaId: e.target.value })}
                        aria-label="Area"
                        className="h-9 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                      >
                        <option value="">—</option>
                        {areas.map((a) => (
                          <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                        ))}
                      </select>
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-right">
                    {lines.length > 2 && (
                      <button
                        type="button"
                        onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                        aria-label="Remove this line"
                        className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {/*
              * The running total, and how far out it is.
              *
              * Under the lines and updating as they are typed, because being
              * told at the end that the columns are out by twelve — with no
              * clue which line is wrong — is how somebody comes to hate double
              * entry.
              */}
            <tfoot className="border-t border-slate-200 bg-slate-50">
              <tr>
                <td className="px-3 py-2 text-xs font-medium text-slate-500">Totals</td>
                <td className="tnum px-2 py-2 text-right font-medium text-slate-800">{money(totals.debit)}</td>
                <td className="tnum px-2 py-2 text-right font-medium text-slate-800">{money(totals.credit)}</td>
                <td colSpan={1 + (centres.length > 0 ? 1 : 0) + (areas.length > 0 ? 1 : 0)} />
              </tr>
              {totals.gap !== 0 && (
                <tr>
                  <td
                    colSpan={4 + (centres.length > 0 ? 1 : 0) + (areas.length > 0 ? 1 : 0)}
                    className="px-3 pb-2 text-right text-xs font-medium text-amber-700"
                  >
                    Out by {money(Math.abs(totals.gap))} — {totals.gap > 0 ? 'credits' : 'debits'} are short
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>

        <button
          type="button"
          onClick={() => setLines((prev) => [...prev, BLANK()])}
          className="flex items-center gap-1 text-sm font-medium text-brand-700 transition hover:text-brand-800"
        >
          <Plus size={14} /> Another line
        </button>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          <Button
            type="submit" className="flex-1" loading={saving} disabled={!ready}
            title={ready ? undefined : 'The two columns have to agree first'}
          >
            Post entry
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function EntryView({ id, onClose, onChanged }) {
  const toast = useToast();
  const [entry, setEntry] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get(`/ledger/entries/${id}`).then((res) => setEntry(res.data.entry)).catch(() => setEntry(null));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function reverse() {
    setBusy(true);
    try {
      await api.post(`/ledger/entries/${id}/reverse`, {});
      toast('Reversed — both entries stay on the record');
      onChanged();
      onClose();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not reverse it', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={entry?.entry_number || 'Entry'} subtitle={entry?.memo || ''} size="lg">
      {!entry ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Debit</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {entry.lines.map((l) => (
                  <tr key={l.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs text-slate-400">{l.account_code}</span>{' '}
                      <span className="text-slate-800">{l.account_name}</span>
                      {(l.cost_centre_name || l.area_name) && (
                        <span className="block text-[11px] text-slate-400">
                          {[l.cost_centre_name, l.area_name].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </td>
                    <td className="tnum px-2 py-2 text-right">{l.debit_usd ? money(l.debit_usd) : ''}</td>
                    <td className="tnum px-2 py-2 text-right">{l.credit_usd ? money(l.credit_usd) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-500">
            Written by {entry.user_name || 'somebody'} · {when(entry.created_at)}
            {entry.reverses_number && ` · reverses ${entry.reverses_number}`}
          </p>

          {entry.reversed_by ? (
            <p className={cx('rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200')}>
              Already reversed by {entry.reversed_by.entry_number}. Both are still on the record —
              between them they come to nothing.
            </p>
          ) : (
            !entry.reverses_id && (
              <Button variant="secondary" onClick={reverse} loading={busy}>
                <RotateCcw size={15} /> Reverse this entry
              </Button>
            )
          )}
        </div>
      )}
    </Modal>
  );
}
