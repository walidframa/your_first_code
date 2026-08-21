import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  ChevronDown,
  EyeOff,
  FileText,
  Lock,
  LockOpen,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import api from '../api';
import CashReport from './CashReport';
import { lbp, useSettings } from '../context/SettingsContext';
import { combinedUsd } from '../lib/change.js';
import { countDifference } from '../lib/cashCount.js';
import { Button, Input, Modal, ModalActions, Select, cx, money, useToast } from './ui';
import { useT } from '../context/LanguageContext';

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
        {currency === 'USD' ? 'Dollars' : 'LBP'}
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
              className="h-8 w-full rounded-lg bg-white px-2 text-right text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
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

/* Cents, not floating-point dust: $20.10 counted against $20.10 must read as
   matching rather than as three ten-thousandths over. */
const round2 = (n) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------- open */

function OpenDrawer({ denominations, accountId, onClose, onOpened }) {
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
        accountId,
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
            label="Lebanese pounds (LBP)"
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

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy}>
            <LockOpen size={16} /> Open cashbox
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ close */

/**
 * Closing a till.
 *
 * The drawer can be counted note by note or the total typed straight in —
 * plenty of shopkeepers counted it on the counter before opening the app, and
 * making them enter it again a denomination at a time is how a count gets
 * rushed. Either way it is the same figure, and counting notes fills the total
 * in.
 *
 * For a cashier it is a **blind** count: told what the drawer should hold, the
 * count stops being a check on anything and becomes a number to copy. Whoever
 * is trusted with the till's history already sees that figure on the panel
 * behind this dialog, so for them the difference is shown as they type — which
 * is the question they opened the dialog to answer.
 */
function CloseDrawer({ denominations, accountId, expected, onClose, onClosed, onReport }) {
  const t = useT();
  const toast = useToast();
  const { rate } = useSettings();
  const [usdNotes, setUsdNotes] = useState({});
  const [lbpNotes, setLbpNotes] = useState({});
  /*
   * What is actually in the drawer, as one figure per currency.
   *
   * Counting note by note fills these in, but plenty of shopkeepers already
   * know their total — they counted it on the counter before opening the app —
   * and making them re-enter it note by note is how a count gets rushed.
   */
  const [totalUsd, setTotalUsd] = useState('');
  const [totalLbp, setTotalLbp] = useState('');
  const [carryUsd, setCarryUsd] = useState('');
  const [carryLbp, setCarryLbp] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const countedUsd = Number(totalUsd) || 0;
  const countedLbp = Number(totalLbp) || 0;

  /* Counting notes writes the total; the total stays editable on its own. */
  function countUsdNotes(next) {
    setUsdNotes(next);
    setTotalUsd(String(sumNotes(next)));
  }
  function countLbpNotes(next) {
    setLbpNotes(next);
    setTotalLbp(String(sumNotes(next)));
  }

  /*
   * The difference, live — but only for somebody who is already allowed to see
   * what the till should hold. A cashier counts blind, because a figure shown
   * before the count is a figure that gets copied rather than counted.
   */
  /*
   * The per-currency figures are what get recorded, because a drawer is right
   * or wrong in each independently. The combined one is what a shopkeeper means
   * by "am I short" — see lib/cashCount.js, where that arithmetic is tested.
   */
  const difference = countDifference({
    expected,
    counted: { usd: countedUsd, lbp: countedLbp },
    rate,
  });

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/cash/close', {
        accountId,
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
    const closingRate = session.exchange_rate || rate;
    const combinedDiff = round2(
      combinedUsd(session.over_short_usd, session.over_short_lbp, closingRate),
    );
    const rows = [
      ['Dollars', session.expected_usd, session.counted_usd, session.over_short_usd, money],
      ['Lebanese pounds', session.expected_lbp, session.counted_lbp, session.over_short_lbp, lbp],
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

            {/*
              * The two together, at the rate this sitting was opened at rather
              * than today's — a close read back next month should say what it
              * said on the night.
              */}
            {closingRate > 0 && (
              <tr className="border-t-2 border-slate-200">
                <td className="py-2 font-medium text-slate-700">Altogether</td>
                <td className="tnum py-2 text-right text-slate-700">
                  {money(combinedUsd(session.expected_usd, session.expected_lbp, closingRate))}
                </td>
                <td className="tnum py-2 text-right text-slate-700">
                  {money(combinedUsd(session.counted_usd, session.counted_lbp, closingRate))}
                </td>
                <td
                  className={cx(
                    'tnum py-2 text-right font-semibold',
                    combinedDiff === 0
                      ? 'text-brand-700'
                      : combinedDiff < 0
                        ? 'text-red-600'
                        : 'text-amber-600',
                  )}
                >
                  {combinedDiff === 0 ? 'exact' : `${combinedDiff > 0 ? '+' : ''}${money(combinedDiff)}`}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <p className="mt-4 text-sm text-slate-500">
          {session.over_short_usd === 0 && session.over_short_lbp === 0
            ? 'The drawer counted exactly.'
            : 'The difference is recorded against this session, so the next one starts from what is really there.'}
        </p>

        {/*
          * The report is offered here rather than only in the back office,
          * because this is the moment somebody wants it: the drawer has just
          * been counted, and whoever counted it is the person who signs off the
          * page and files it.
          */}
        <ModalActions>
          <Button variant="secondary" className="flex-1" onClick={() => onReport(session.id)}>
            <FileText size={16} /> Cashbox report
          </Button>
          <Button className="flex-1" onClick={onClosed}>
            Done
          </Button>
        </ModalActions>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('Close the cashbox')}
      subtitle="Count what is in the drawer"
      size="lg"
    >
      <form onSubmit={submit} className="space-y-4">
        {!expected && (
          <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
            Count the drawer before you see what it should hold — that is the only way the difference
            tells you anything.
          </p>
        )}

        <div className="grid grid-cols-2 gap-6">
          <DenominationCounter
            currency="USD"
            notes={denominations?.USD || []}
            counts={usdNotes}
            onChange={countUsdNotes}
            total={sumNotes(usdNotes)}
          />
          <DenominationCounter
            currency="LBP"
            notes={denominations?.LBP || []}
            counts={lbpNotes}
            onChange={countLbpNotes}
            total={sumNotes(lbpNotes)}
          />
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">
            What is actually in the drawer
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Dollars"
              name="countedUsd"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={totalUsd}
              onChange={(e) => setTotalUsd(e.target.value)}
              hint="Counted above, or type it straight in"
            />
            <Input
              label="Lebanese pounds (LBP)"
              name="countedLbp"
              type="number"
              min="0"
              step="1000"
              placeholder="0"
              value={totalLbp}
              onChange={(e) => setTotalLbp(e.target.value)}
              hint="Counted above, or type it straight in"
            />
          </div>

          {/* Whether the drawer agrees with the app, before it is committed. */}
          {difference && (
            <div className="mt-3 rounded-xl bg-slate-50 p-3">
              <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
                Against the app
              </p>
              <dl className="space-y-1.5 text-sm">
                {[
                  ['Dollars', expected.usd, countedUsd, difference.usd, money],
                  ['Lebanese pounds', expected.lbp, countedLbp, difference.lbp, lbp],
                ].map(([text, should, have, diff, format]) => (
                  <div key={text} className="flex items-baseline justify-between gap-3">
                    <dt className="text-slate-500">
                      {text}
                      <span className="ml-2 text-xs text-slate-400">
                        app says {format(should)}, you counted {format(have)}
                      </span>
                    </dt>
                    <dd
                      className={cx(
                        'tnum shrink-0 font-semibold',
                        diff === 0 ? 'text-brand-700' : diff < 0 ? 'text-red-600' : 'text-amber-600',
                      )}
                    >
                      {diff === 0
                        ? 'matches'
                        : `${diff > 0 ? '+' : ''}${format(diff)} ${diff > 0 ? 'over' : 'short'}`}
                    </dd>
                  </div>
                ))}

                {/* One number for "am I short", the pounds converted at today's
                    rate. It is the reading, not the record: what gets stored is
                    still each currency on its own. */}
                {difference.combined !== null && (
                  <div className="flex items-baseline justify-between gap-3 border-t border-slate-200 pt-1.5">
                    <dt className="font-medium text-slate-700">
                      Altogether
                      <span className="ml-2 text-xs font-normal text-slate-400">
                        app says {money(difference.expectedCombined)}, you counted{' '}
                        {money(difference.countedCombined)}
                      </span>
                    </dt>
                    <dd
                      className={cx(
                        'tnum shrink-0 font-semibold',
                        difference.combined === 0
                          ? 'text-brand-700'
                          : difference.combined < 0
                            ? 'text-red-600'
                            : 'text-amber-600',
                      )}
                    >
                      {difference.combined === 0
                        ? 'matches'
                        : `${difference.combined > 0 ? '+' : ''}${money(difference.combined)} ${
                            difference.combined > 0 ? 'over' : 'short'
                          }`}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}
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
              label="Lebanese pounds (LBP)"
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

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy}>
            <Lock size={16} /> Close and check
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------------- movement */

function MoveCash({ direction, accountId, onClose, onDone }) {
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
      const res = await api.post('/cash/movements', {
        accountId,
        direction,
        amountUsd: Number(usd) || 0,
        amountLbp: Number(lbpAmount) || 0,
        reason,
        note: note || null,
      });
      /*
       * Taking out more than is there is allowed, and said out loud. Given
       * longer than an ordinary toast because it is the kind of thing somebody
       * has to go and look into, not an acknowledgement to glance at.
       */
      if (res.data.warning) toast(res.data.warning, 'warning', 9000);
      else toast(goingIn ? 'Cash added to the drawer' : 'Cash taken out of the drawer');
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
            label="Lebanese pounds (LBP)"
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

        <ModalActions>
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
        </ModalActions>
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
/**
 * One till's drawer.
 *
 * `accountId` says which — the register's, the transfer desk's, the safe's.
 * Omitted, it is the shop's default till, which is what every screen used
 * before there was more than one.
 */
export default function CashBox({
  onChanged,
  refreshOn = 0,
  accountId = null,
  showProfit = false,
  /*
   * Laid out for the top bar rather than for a column.
   *
   * The drawer and the day's profit are a *status*: glanced at, rarely acted
   * on. Sitting at the head of the cart they were charging the thing used every
   * minute for the space of the thing read twice a day — so on the register
   * they now live in the header, where the rest of the shop's state already is,
   * and the fold-out hangs below them as a menu instead of pushing the cart
   * down the screen.
   *
   * The same component either way, deliberately. Two copies of a drawer figure
   * is two chances for one of them to be stale.
   */
  compact = false,
}) {
  const t = useT();
  const [state, setState] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  // Which sitting's report is on screen — set from the close dialog, and from
  // the panel itself while the drawer is still open.
  const [reportFor, setReportFor] = useState(null);
  /*
   * Folded away by default.
   *
   * The drawer and the day's profit are worth a glance, not a quarter of the
   * column — and the column's real job is the cart. Folded, the figures are
   * still on screen; it is the buttons under them, which are used a few times a
   * day, that stop crowding out the thing used every minute.
   *
   * Remembered only in the column. A panel that pushes the cart down is a
   * preference somebody expressed; a popover hanging out of the header is a
   * menu, and a menu that reopens itself on every page load is a menu covering
   * the register — which is precisely what it did, silently swallowing clicks
   * on the search box until a test noticed.
   */
  const [detailOpen, setDetailOpen] = useState(
    () => !compact && globalThis.localStorage?.getItem('pos_money_open') === '1',
  );

  const toggleDetail = () =>
    setDetailOpen((wasOpen) => {
      if (!compact) globalThis.localStorage?.setItem('pos_money_open', wasOpen ? '0' : '1');
      return !wasOpen;
    });

  /*
   * And it closes the way every other menu closes: click elsewhere, or Escape.
   * In the column there is nothing to dismiss — the panel is part of the page.
   */
  const holder = useRef(null);
  useEffect(() => {
    if (!compact || !detailOpen) return undefined;
    const away = (e) => {
      if (holder.current && !holder.current.contains(e.target)) setDetailOpen(false);
    };
    const key = (e) => {
      if (e.key === 'Escape') setDetailOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [compact, detailOpen]);

  const load = useCallback(async () => {
    const res = await api.get('/cash/current', { params: accountId ? { accountId } : undefined });
    setState(res.data);
  }, [accountId]);

  // `refreshOn` changes when a sale completes, which is the moment the figure
  // on screen stops being true; `load` changes when the till does.
  useEffect(() => {
    load();
  }, [load, refreshOn]);

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
  const { session, denominations, expected, profit, short } = state;

  if (!session) {
    if (compact) {
      return (
        <>
          {/*
            * A shut drawer is not a mild status: it refuses every cash sale, and
            * a cashier who finds that out at the payment sheet has already kept
            * somebody waiting. So the chip says what is wrong and what it costs,
            * and is itself the way to fix it — one press, not a press to reveal
            * a press.
            */}
          <button
            onClick={() => setDialog('open')}
            className="flex h-10 min-w-0 items-center gap-1.5 rounded-xl bg-amber-50 px-2.5 text-sm font-semibold text-amber-900 ring-1 ring-amber-200 transition hover:bg-amber-100"
          >
            <Lock size={15} className="shrink-0" />
            {/* Gives way rather than drawing over the rest of the bar: on a
                phone this chip and the name beside it wanted the same space,
                and a fixed-width chip simply took it. */}
            <span className="truncate">{t('Cashbox closed')}</span>
            {state.required && (
              <span className="hidden font-normal text-amber-700 sm:inline">
                · {t('Cash sales are refused until it is open')}
              </span>
            )}
          </button>

          {dialog === 'open' && (
            <OpenDrawer
              denominations={denominations}
              accountId={accountId}
              onClose={() => setDialog(null)}
              onOpened={done}
            />
          )}
          {reportFor && <CashReport sessionId={reportFor} onClose={() => setReportFor(null)} />}
        </>
      );
    }

    return (
      <>
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-amber-100 p-1.5 text-amber-700">
              <Lock size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-900">{t('Cashbox closed')}</p>
              <p className="text-[11px] leading-snug text-amber-700">
                {state.required ? t('Cash sales are refused until it is open') : 'Open it to track the drawer'}
              </p>
            </div>
          </div>
          <Button size="sm" className="mt-2.5 w-full" onClick={() => setDialog('open')}>
            <LockOpen size={15} /> {t('Open the cashbox')}
          </Button>
        </div>

        {dialog === 'open' && (
          <OpenDrawer
            denominations={denominations}
            accountId={accountId}
            onClose={() => setDialog(null)}
            onOpened={done}
          />
        )}
        {/*
          * Also here, not only on the open panel: closing the drawer is exactly
          * when the report is asked for, and by then this is the branch that
          * renders.
          */}
        {reportFor && <CashReport sessionId={reportFor} onClose={() => setReportFor(null)} />}
      </>
    );
  }

  return (
    <>
      {/*
        * Profit above the drawer, because the two answer different questions and
        * the wrong one gets read for the other all day: cash on hand is what is
        * in the till, which includes the float, the customer payments and the
        * money that is not the shop's to keep. This is what the shop made.
        *
        * Only rendered where the till is the shop's trade — the register — and
        * only when the server sent it, which it does for whoever may see profit
        * at all. A cashier gets nothing here, not a hidden or blanked-out box.
        */}
      <div
        ref={holder}
        /*
         * `min-w-0`, not `shrink-0`. This wrapper is the flex item the header
         * actually lays out, and while it refused to shrink the handle inside
         * it kept its full width no matter what the button was told — which is
         * how a $824.00 ended up printed across the log-out button on a phone
         * with the bigger-text setting on.
         */
        className={cx(compact ? 'relative flex min-w-0' : 'border-b border-slate-200 bg-slate-50')}
      >
        {/*
          * The whole strip is the handle. One row, both figures, and the
          * chevron — a cashier glancing at the drawer gets what they came for
          * without the panel taking the cart's room to give it to them.
          */}
        <button
          onClick={toggleDetail}
          aria-expanded={detailOpen}
          aria-label={detailOpen ? t('Hide the drawer detail') : t('Show the drawer detail')}
          className={cx(
            'flex items-center gap-2 text-left transition hover:bg-slate-100',
            compact
              ? 'h-10 min-w-0 rounded-xl px-2.5 ring-1 ring-slate-200'
              : 'w-full px-4 py-2',
          )}
        >
          {short && compact ? (
            /*
              * In the header the paragraph below does not fit, and a drawer that
              * has gone short is the one thing on this strip that must not wait
              * to be noticed. The figure already turns red; this makes it a
              * warning rather than a colour somebody has to interpret.
              */
            <AlertTriangle size={14} className="text-red-500" />
          ) : (
            <Banknote size={14} className={short ? 'text-red-500' : 'text-brand-600'} />
          )}
          {expected ? (
            <>
              <span
                className={cx(
                  'tnum leading-none font-semibold',
                  short ? 'text-red-600' : 'text-slate-900',
                  // In the header the figure gives way rather than growing past
                  // the end of the bar — which is what it did on a phone with
                  // the bigger-text setting on, straight over the way out.
                  compact ? 'min-w-0 truncate text-sm' : 'text-base',
                )}
              >
                {money(expected.usd)}
              </span>
              {/* The pounds go first when the bar runs out of room: on a phone
                  the dollars are the figure being glanced at, and losing the
                  logout button to keep both is a poor trade. */}
              <span
                className={cx(
                  'tnum text-xs leading-none',
                  short ? 'text-red-500' : 'text-slate-500',
                  compact && 'hidden sm:inline',
                )}
              >
                {lbp(expected.lbp)}
              </span>
            </>
          ) : (
            /*
             * A cashier counts blind, so the figure is withheld — said plainly,
             * because a blank space where a number should be looks broken.
             */
            <span
              className={cx(
                'flex items-center gap-1.5 text-sm text-slate-500',
                compact && 'min-w-0 truncate',
              )}
            >
              <EyeOff size={13} className="shrink-0" />{' '}
              <span className="truncate">{t('Counted at close')}</span>
            </span>
          )}

          {/*
            * Said in words, not only in red.
            *
            * A drawer below zero means the money and the books have drifted
            * apart, and the sooner somebody looks the better the chance of
            * remembering why — so it stays on screen until it is fixed or the
            * sitting is closed. The full sentence does not fit in a header and
            * is in the menu below; two words do, and two words are enough to
            * make somebody open it.
            */}
          {short && compact && (
            <span className="ms-1 shrink-0 text-sm font-semibold text-red-600">
              {t('Drawer short')}
            </span>
          )}

          {showProfit && profit && (
            <span
              className={cx(
                'flex items-baseline gap-1',
                // On a phone the bar holds the drawer or the profit, not both,
                // and the drawer is the one a cashier is looking at. The profit
                // is a press away, in the panel this handle opens.
                compact ? 'ms-1 hidden sm:flex' : 'ml-auto',
              )}
            >
              <TrendingUp size={12} className="text-brand-600" />
              <span className="tnum text-sm font-semibold text-brand-700">
                {money(profit.netProfit)}
              </span>
              <span className={cx('text-[11px] text-brand-700/60', compact && 'hidden sm:inline')}>
                {t('profit')}
              </span>
            </span>
          )}

          <ChevronDown
            size={15}
            className={cx(
              'shrink-0 text-slate-400 transition-transform',
              showProfit && profit ? '' : compact ? '' : 'ml-auto',
              detailOpen && 'rotate-180',
            )}
          />
        </button>

        {/*
          * A drawer below zero means the money and the books have drifted
          * apart, and the sooner somebody looks the better the chance of
          * remembering why. It stays put until it is fixed or the sitting is
          * closed — the toast at the moment it happened is long gone by then,
          * and folding the panel away must not fold this away with it.
          *
          * Shown to a cashier too, who cannot see the figure: they are told the
          * drawer is short, not how short, which is still enough to act on.
          */}
        <div
          className={cx(
            compact &&
              detailOpen &&
              'absolute end-0 top-full z-30 mt-1 w-80 rounded-xl bg-white py-2 shadow-lg ring-1 ring-slate-200',
            // Folded away, there is nothing to hang below the handle.
            compact && !detailOpen && 'hidden',
          )}
        >
        {short && (
          <p className="mx-4 mb-2 flex items-start gap-1.5 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] leading-snug text-red-700">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            <span>
              More has gone out than came in. Something earlier is missing — a sale rung up
              elsewhere, or a float never entered.
            </span>
          </p>
        )}

        {detailOpen && (
          <div className="px-4 pb-3">
            {showProfit && profit && (
              <p className="tnum mb-2 flex items-center justify-between text-[11px] text-brand-700/70">
                <span>
                  {money(profit.revenue)} sold · {money(profit.grossProfit)} gross ·{' '}
                  {money(profit.expenses)} spent
                  {/*
                    * Where it came from, whenever it did not all come from
                    * here. This panel sits on the register and is read as the
                    * register's own takings — it is not, it is the shop's whole
                    * trade over the hours the till was open. Somebody who had
                    * rung up nothing, refunded everything, and was still shown
                    * a profit had no way to see that the figure was an
                    * invoice's.
                    */}
                  {profit.fromInvoices > 0 && (
                    <span className="block text-brand-700/60">
                      {money(profit.fromInvoices)} of it on invoices, not at this counter
                    </span>
                  )}
                  {profit.refundedOrders > 0 && (
                    <span className="block text-brand-700/60">
                      {profit.refundedOrders} sale{profit.refundedOrders === 1 ? '' : 's'} refunded, and
                      already off these figures
                    </span>
                  )}
                </span>
                <button
                  onClick={() => setReportFor(session.id)}
                  title="Cashbox report"
                  aria-label="Cashbox report"
                  className="rounded p-1 text-brand-700/70 transition hover:bg-brand-100 hover:text-brand-800"
                >
                  <FileText size={13} />
                </button>
              </p>
            )}

            <p className="flex items-center justify-between text-[11px] text-slate-400">
              <span>
                Open since{' '}
                {new Date(`${session.opened_at}Z`).toLocaleTimeString([], { timeStyle: 'short' })} ·{' '}
                {session.opened_by_name}
              </span>
              <button
                onClick={refresh}
                aria-label={t('Refresh cash on hand')}
                title="Refresh"
                className="rounded p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
              >
                <RefreshCw size={13} className={busy ? 'animate-spin' : undefined} />
              </button>
            </p>

            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" variant="secondary" className="flex-1" onClick={() => setDialog('in')}>
                <ArrowDownLeft size={15} /> {t('Cash in')}
              </Button>
              <Button size="sm" variant="secondary" className="flex-1" onClick={() => setDialog('out')}>
                <ArrowUpRight size={15} /> {t('Cash out')}
              </Button>
              {/* Icon-only to fit three controls in a narrow column, so it needs
                  a name of its own for anyone not looking at the icon. */}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDialog('close')}
                aria-label={t('Close the cashbox')}
                title="Close the cashbox"
              >
                <Lock size={15} />
              </Button>
            </div>
          </div>
        )}
        </div>
      </div>

      {dialog === 'open' && (
        <OpenDrawer
            denominations={denominations}
            accountId={accountId}
            onClose={() => setDialog(null)}
            onOpened={done}
          />
      )}
      {dialog === 'close' && (
        <CloseDrawer
          denominations={denominations}
          accountId={accountId}
          expected={state?.expected ?? null}
          onClose={() => setDialog(null)}
          onClosed={done}
          onReport={(id) => {
            // Finish the close first: the panel behind has to catch up, and two
            // dialogs stacked on each other is one too many to read.
            done();
            setReportFor(id);
          }}
        />
      )}
      {(dialog === 'in' || dialog === 'out') && (
        <MoveCash direction={dialog} accountId={accountId} onClose={() => setDialog(null)} onDone={done} />
      )}
      {reportFor && <CashReport sessionId={reportFor} onClose={() => setReportFor(null)} />}
    </>
  );
}
