import { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Banknote, EyeOff, Lock, LockOpen, RefreshCw } from 'lucide-react';
import api from '../api';
import { lbp } from '../context/SettingsContext';
import { Button, Input, Modal, Select, cx, money, useToast } from './ui';

const IN_REASONS = [
  ['petty_cash', 'Petty cash'],
  ['owner_funds', 'Owner’s money'],
  ['customer_payment', 'Customer payment'],
  ['correction', 'Correction'],
  ['other', 'Other'],
];

const OUT_REASONS = [
  ['supplier', 'Paid a supplier'],
  ['expense', 'Expense'],
  ['wages', 'Wages'],
  ['owner_draw', 'Owner took out'],
  ['bank_drop', 'To the bank'],
  ['other', 'Other'],
];

/**
 * Count a drawer note by note.
 *
 * Nobody adds up a till in their head, and a mental total is where an
 * over/short that means nothing comes from. Typing counts and letting the
 * screen multiply is how every till in a shop is actually counted.
 */
function DenominationCounter({ currency, notes, counts, onChange, total }) {
  return (
    <div className="rounded-xl p-3 ring-1 ring-slate-200">
      {/* Named, because side by side the two grids otherwise read as one. */}
      <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
        {currency === 'USD' ? 'Dollars' : 'Pounds'}
      </p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {notes.map((note) => (
          <label key={note} className="flex items-center gap-2 text-sm">
            <span className="tnum w-20 shrink-0 text-right text-slate-500">
              {currency === 'USD' ? `$${note}` : Number(note).toLocaleString('en-US')}
            </span>
            <span className="text-slate-300">×</span>
            <input
              type="number"
              min="0"
              step="1"
              value={counts[note] ?? ''}
              onChange={(e) => onChange({ ...counts, [note]: e.target.value })}
              aria-label={`${currency} ${note} notes`}
              className="h-8 w-full rounded-lg bg-white px-2 text-right text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
            />
          </label>
        ))}
      </div>
      <p className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-sm font-semibold">
        <span className="text-slate-500">Counted</span>
        <span className="tnum text-slate-900">
          {currency === 'USD' ? money(total) : lbp(total)}
        </span>
      </p>
    </div>
  );
}

const sumNotes = (counts) =>
  Object.entries(counts).reduce((sum, [note, n]) => sum + Number(note) * (Number(n) || 0), 0);

/* ------------------------------------------------------------------- open */

function OpenDrawer({ denominations, onClose, onOpened }) {
  const toast = useToast();
  const [usd, setUsd] = useState('');
  const [lbpAmount, setLbpAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/cash/open', {
        openingUsd: Number(usd) || 0,
        openingLbp: Number(lbpAmount) || 0,
        note: note || null,
      });
      toast('Cashbox open');
      onOpened();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open the cashbox');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Open the cashbox" subtitle="What is in the drawer to start with?">
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
          Put in the float — the change you are starting the day with. Leave it empty if the drawer is bare.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Dollars"
            name="openingUsd"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
          />
          <Input
            label="Pounds"
            name="openingLbp"
            type="number"
            min="0"
            step={denominations?.LBP?.[denominations.LBP.length - 1] || 1000}
            placeholder="0"
            value={lbpAmount}
            onChange={(e) => setLbpAmount(e.target.value)}
          />
        </div>

        <Input
          label="Note (optional)"
          name="openingNote"
          placeholder="e.g. carried over from last night"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy}>
            <LockOpen size={16} /> Open cashbox
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ close */

/**
 * Closing is a blind count: the drawer is counted first, and only then is the
 * expected figure shown. Told the answer first, the count stops being a check
 * on anything.
 */
function CloseDrawer({ denominations, onClose, onClosed }) {
  const toast = useToast();
  const [usdNotes, setUsdNotes] = useState({});
  const [lbpNotes, setLbpNotes] = useState({});
  const [carryUsd, setCarryUsd] = useState('');
  const [carryLbp, setCarryLbp] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const countedUsd = sumNotes(usdNotes);
  const countedLbp = sumNotes(lbpNotes);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/cash/close', {
        countedUsd,
        countedLbp,
        carriedUsd: carryUsd === '' ? 0 : Number(carryUsd),
        carriedLbp: carryLbp === '' ? 0 : Number(carryLbp),
        note: note || null,
      });
      setResult(res.data);
      toast('Cashbox closed');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not close the cashbox');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const { session } = result;
    const rows = [
      ['Dollars', session.expected_usd, session.counted_usd, session.over_short_usd, money],
      ['Pounds', session.expected_lbp, session.counted_lbp, session.over_short_lbp, lbp],
    ];

    return (
      <Modal open onClose={onClosed} title="Cashbox closed" subtitle="How the drawer came out">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
            <tr>
              <th className="py-1.5 font-medium" />
              <th className="py-1.5 text-right font-medium">Expected</th>
              <th className="py-1.5 text-right font-medium">Counted</th>
              <th className="py-1.5 text-right font-medium">Difference</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map(([label, expected, counted, diff, format]) => (
              <tr key={label}>
                <td className="py-2 text-slate-600">{label}</td>
                <td className="tnum py-2 text-right text-slate-700">{format(expected)}</td>
                <td className="tnum py-2 text-right text-slate-700">{format(counted)}</td>
                <td
                  className={cx(
                    'tnum py-2 text-right font-semibold',
                    diff === 0 ? 'text-brand-700' : diff < 0 ? 'text-red-600' : 'text-amber-600',
                  )}
                >
                  {diff === 0 ? 'exact' : `${diff > 0 ? '+' : ''}${format(diff)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="mt-4 text-sm text-slate-500">
          {session.over_short_usd === 0 && session.over_short_lbp === 0
            ? 'The drawer counted exactly.'
            : 'The difference is recorded against this session, so the next one starts from what is really there.'}
        </p>

        <Button className="mt-4 w-full" onClick={onClosed}>
          Done
        </Button>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Close the cashbox"
      subtitle="Count what is in the drawer"
      size="lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
          Count the drawer before you see what it should hold — that is the only way the difference tells
          you anything.
        </p>

        <div className="grid grid-cols-2 gap-6">
          <DenominationCounter
            currency="USD"
            notes={denominations?.USD || []}
            counts={usdNotes}
            onChange={setUsdNotes}
            total={countedUsd}
          />
          <DenominationCounter
            currency="LBP"
            notes={denominations?.LBP || []}
            counts={lbpNotes}
            onChange={setLbpNotes}
            total={countedLbp}
          />
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">Leave in the drawer for tomorrow</p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Dollars"
              name="carryUsd"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={carryUsd}
              onChange={(e) => setCarryUsd(e.target.value)}
            />
            <Input
              label="Pounds"
              name="carryLbp"
              type="number"
              min="0"
              step="1000"
              placeholder="0"
              value={carryLbp}
              onChange={(e) => setCarryLbp(e.target.value)}
            />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">The rest is recorded as going to the bank.</p>
        </div>

        <Input
          label="Note (optional)"
          name="closingNote"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy}>
            <Lock size={16} /> Close and check
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------------- movement */

function MoveCash({ direction, onClose, onDone }) {
  const toast = useToast();
  const goingIn = direction === 'in';
  const reasons = goingIn ? IN_REASONS : OUT_REASONS;

  const [reason, setReason] = useState(reasons[0][0]);
  const [usd, setUsd] = useState('');
  const [lbpAmount, setLbpAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/cash/movements', {
        direction,
        amountUsd: Number(usd) || 0,
        amountLbp: Number(lbpAmount) || 0,
        reason,
        note: note || null,
      });
      toast(goingIn ? 'Cash added to the drawer' : 'Cash taken out of the drawer');
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={goingIn ? 'Cash in' : 'Cash out'}
      subtitle={goingIn ? 'Money going into the drawer' : 'Money coming out of the drawer'}
    >
      <form onSubmit={submit} className="space-y-3">
        <Select label="Reason" name="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {reasons.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Dollars"
            name="amountUsd"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
          />
          <Input
            label="Pounds"
            name="amountLbp"
            type="number"
            min="0"
            step="1000"
            placeholder="0"
            value={lbpAmount}
            onChange={(e) => setLbpAmount(e.target.value)}
          />
        </div>

        <Input
          label="What for?"
          name="movementNote"
          placeholder={goingIn ? 'e.g. change from the bank' : 'e.g. milk delivery'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            className="flex-1"
            loading={busy}
            disabled={!Number(usd) && !Number(lbpAmount)}
          >
            {goingIn ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
            {goingIn ? 'Put in' : 'Take out'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ----------------------------------------------------------------- panel */

/**
 * The drawer, where the cashier is already looking.
 *
 * Cash on hand is the panel's whole reason to exist, so it is the biggest thing
 * in it rather than a note beside the status — a figure at eleven pixels in a
 * corner reads as decoration, and gets missed.
 *
 * Shut, the panel is the loudest thing on the screen: a cash sale will be
 * refused until it is open, and the worst moment to learn that is at the
 * counter with a customer waiting.
 */
export default function CashBox({ onChanged }) {
  const [state, setState] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get('/cash/current');
    setState(res.data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      await load();
    } finally {
      setBusy(false);
    }
  };

  const done = () => {
    setDialog(null);
    load();
    onChanged?.();
  };

  if (!state) return null;
  const { session, denominations, expected } = state;

  if (!session) {
    return (
      <>
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-amber-100 p-1.5 text-amber-700">
              <Lock size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-900">Cashbox closed</p>
              <p className="text-[11px] leading-snug text-amber-700">
                {state.required ? 'Cash sales are refused until it is open' : 'Open it to track the drawer'}
              </p>
            </div>
          </div>
          <Button size="sm" className="mt-2.5 w-full" onClick={() => setDialog('open')}>
            <LockOpen size={15} /> Open the cashbox
          </Button>
        </div>

        {dialog === 'open' && (
          <OpenDrawer denominations={denominations} onClose={() => setDialog(null)} onOpened={done} />
        )}
      </>
    );
  }

  return (
    <>
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
            <Banknote size={13} className="text-brand-600" />
            Cash on hand
          </span>
          <button
            onClick={refresh}
            aria-label="Refresh cash on hand"
            title="Refresh"
            className="rounded p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
          >
            <RefreshCw size={13} className={busy ? 'animate-spin' : undefined} />
          </button>
        </div>

        {expected ? (
          <p className="flex items-baseline gap-2">
            <span className="tnum text-2xl leading-none font-semibold text-slate-900">
              {money(expected.usd)}
            </span>
            <span className="tnum text-base leading-none font-medium text-slate-500">
              {lbp(expected.lbp)}
            </span>
          </p>
        ) : (
          /*
           * A cashier counts blind, so the figure is withheld — said plainly,
           * because a blank space where a number should be looks broken.
           */
          <p className="flex items-center gap-1.5 text-sm text-slate-500">
            <EyeOff size={14} /> Counted at close
          </p>
        )}

        <p className="mt-1 text-[11px] text-slate-400">
          Open since {new Date(`${session.opened_at}Z`).toLocaleTimeString([], { timeStyle: 'short' })} ·{' '}
          {session.opened_by_name}
        </p>

        <div className="mt-2.5 flex items-center gap-1.5">
          <Button size="sm" variant="secondary" className="flex-1" onClick={() => setDialog('in')}>
            <ArrowDownLeft size={15} /> Cash in
          </Button>
          <Button size="sm" variant="secondary" className="flex-1" onClick={() => setDialog('out')}>
            <ArrowUpRight size={15} /> Cash out
          </Button>
          {/* Icon-only to fit three controls in a narrow column, so it needs a
              name of its own for anyone not looking at the icon. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDialog('close')}
            aria-label="Close the cashbox"
            title="Close the cashbox"
          >
            <Lock size={15} />
          </Button>
        </div>
      </div>

      {dialog === 'open' && (
        <OpenDrawer denominations={denominations} onClose={() => setDialog(null)} onOpened={done} />
      )}
      {dialog === 'close' && (
        <CloseDrawer denominations={denominations} onClose={() => setDialog(null)} onClosed={done} />
      )}
      {(dialog === 'in' || dialog === 'out') && (
        <MoveCash direction={dialog} onClose={() => setDialog(null)} onDone={done} />
      )}
    </>
  );
}
