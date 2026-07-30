import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Banknote, CreditCard, Delete, Wallet } from 'lucide-react';
import { Button, Modal, cx, money } from './ui';
import { useSettings, lbp } from '../context/SettingsContext';
import { splitStatus } from '../lib/change';

const QUICK_USD = [5, 10, 20, 50, 100];
const QUICK_LBP = [100000, 200000, 500000, 1000000, 5000000];

/** The keypad targets that belong to the change, not to the tender. */
const CHANGE_FIELDS = ['CHANGE_USD', 'CHANGE_LBP'];

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Payment step. The customer may hand over USD, LBP, or both; the cashier
 * chooses how to give change back — all dollars, all pounds, or split between
 * the two — and the sheet shows the exact amounts to hand over.
 */
export default function PaymentSheet({ open, total, customer, onClose, onConfirm, submitting }) {
  const { rate, step, toLbp } = useSettings();

  const [method, setMethod] = useState(null);
  const [usdEntry, setUsdEntry] = useState('');
  const [lbpEntry, setLbpEntry] = useState('');
  const [changeUsdEntry, setChangeUsdEntry] = useState('');
  const [changeLbpEntry, setChangeLbpEntry] = useState('');
  // Which field the keypad is typing into: a tender currency, or — in split
  // mode — one of the two piles being handed back.
  const [active, setActive] = useState('USD');
  const [changeCurrency, setChangeCurrency] = useState('LBP');

  useEffect(() => {
    if (open) {
      setMethod(null);
      setUsdEntry('');
      setLbpEntry('');
      setChangeUsdEntry('');
      setChangeLbpEntry('');
      setActive('USD');
      setChangeCurrency('LBP');
    }
  }, [open]);

  const paidUsd = Number(usdEntry || 0);
  const paidLbp = Number(lbpEntry || 0);
  const tenderedUsd = paidUsd + (rate ? paidLbp / rate : 0);
  const remaining = total - tenderedUsd;
  const covered = remaining <= 0.0001;
  const changeUsd = Math.max(0, tenderedUsd - total);

  /*
   * Backspacing the tender until the sale is short hides the change section, and
   * with it the field the keypad was aimed at. Send the keypad back to the
   * dollars so the next digit lands somewhere the cashier can see.
   */
  useEffect(() => {
    if (!covered && CHANGE_FIELDS.includes(active)) setActive('USD');
  }, [covered, active]);

  /*
   * Split change: the cashier names both piles, because which notes are in the
   * drawer is something only they can see — 2,500,000 LL may be four notes
   * where the exact remainder is seven. What is handed back is simply the two
   * added together, and the sheet says whether that comes to what is owed.
   */
  const split = splitStatus({
    changeDue: changeUsd,
    usd: changeUsdEntry,
    lbp: changeLbpEntry,
    rate,
    step,
  });
  const { usd: splitUsd, lbp: splitLbp, total: splitTotal, left: splitLeft } = split;

  /*
   * Handing back a little more than is owed is just rounding to the notes in
   * the drawer. Handing back a lot more is a slipped digit, and the server
   * refuses it — so the button says why rather than letting it fail on submit.
   */
  const overGiving = changeCurrency === 'SPLIT' && split.over;

  const totalLbp = useMemo(() => toLbp(total), [toLbp, total]);

  const SETTERS = {
    USD: setUsdEntry,
    LBP: setLbpEntry,
    CHANGE_USD: setChangeUsdEntry,
    CHANGE_LBP: setChangeLbpEntry,
  };
  const setEntry = SETTERS[active];
  // Pounds have no subunit in practice, in the drawer or in the change.
  const wholeNumbersOnly = active === 'LBP' || active === 'CHANGE_LBP';

  function press(key) {
    setEntry((prev) => {
      if (key === 'clear') return '';
      if (key === 'back') return prev.slice(0, -1);
      if (key === '.') {
        if (wholeNumbersOnly) return prev;
        return prev.includes('.') ? prev : (prev || '0') + '.';
      }
      if (!wholeNumbersOnly && prev.includes('.') && prev.split('.')[1].length >= 2) return prev;
      return prev === '0' ? key : prev + key;
    });
  }

  /** Switch how change is given, pointing the keypad at the field that matters. */
  function pickChangeCurrency(mode) {
    setChangeCurrency(mode);
    if (mode === 'SPLIT') setActive('CHANGE_USD');
    else if (CHANGE_FIELDS.includes(active)) setActive('USD');
  }

  /**
   * Put whatever is still owed into the other pile.
   *
   * The usual split is "some dollars, rest in pounds", and making the cashier
   * work out the rest by hand would be handing them arithmetic the app already
   * knows. It fills a field they can still overwrite — the app suggests, it
   * does not decide.
   */
  function fillRest(field) {
    const short = Math.max(0, changeUsd - splitTotal);
    if (field === 'CHANGE_LBP') setChangeLbpEntry(String(toLbp(short + (rate ? splitLbp / rate : 0))));
    else setChangeUsdEntry(String(round2(splitUsd + short)));
  }

  function confirm() {
    const payments = [];
    if (paidUsd > 0) payments.push({ currency: 'USD', amount: paidUsd });
    if (paidLbp > 0) payments.push({ currency: 'LBP', amount: paidLbp });
    onConfirm({
      paymentMethod: 'cash',
      payments,
      changeCurrency,
      // Both halves are the cashier's; the server records exactly these.
      changeUsd: changeCurrency === 'SPLIT' ? splitUsd : undefined,
      changeLbp: changeCurrency === 'SPLIT' ? splitLbp : undefined,
    });
  }

  /* Shortcut amounts follow whichever field the keypad is pointed at. */
  const quickAmounts = wholeNumbersOnly ? QUICK_LBP : QUICK_USD;

  /** What the confirm button says about the change it is about to hand over. */
  const changeLabel =
    changeCurrency === 'SPLIT'
      ? `${money(splitUsd)} + ${lbp(splitLbp)}`
      : changeCurrency === 'LBP'
        ? lbp(toLbp(changeUsd))
        : money(changeUsd);

  /*
   * The actions live in the modal's pinned footer rather than at the end of the
   * body. A cash sheet with both change fields open runs past a short screen,
   * and a Confirm button you have to scroll to find is one a busy cashier will
   * miss with a queue waiting.
   */
  const footer =
    method === 'card' ? (
      <div className="flex gap-2">
        <Button variant="secondary" size="lg" onClick={() => setMethod(null)} disabled={submitting}>
          <ArrowLeft size={16} /> Back
        </Button>
        <Button
          size="lg"
          className="flex-1"
          loading={submitting}
          onClick={() => onConfirm({ paymentMethod: 'card' })}
        >
          Confirm {money(total)}
        </Button>
      </div>
    ) : method === 'cash' ? (
      <div className="flex gap-2">
        <Button variant="secondary" size="lg" onClick={() => setMethod(null)} disabled={submitting}>
          <ArrowLeft size={16} /> Back
        </Button>
        <Button
          size="lg"
          className="flex-1"
          disabled={!covered || overGiving}
          loading={submitting}
          onClick={confirm}
        >
          {!covered
            ? `${money(remaining)} still due`
            : overGiving
              ? `${money(-splitLeft)} more than the change`
              : `Confirm · change ${changeLabel}`}
        </Button>
      </div>
    ) : null;

  return (
    <Modal
      open={open}
      onClose={submitting ? undefined : onClose}
      title={method === null ? 'Take payment' : method === 'cash' ? 'Cash payment' : 'Card payment'}
      subtitle={`${money(total)} · ${lbp(totalLbp)}`}
      size={method === 'cash' ? 'lg' : 'sm'}
      footer={footer}
    >
      {method === null && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMethod('card')}
              className="flex flex-col items-center gap-2 rounded-xl bg-white px-4 py-8 ring-1 ring-slate-300 transition hover:bg-slate-50 hover:ring-brand-400"
            >
              <CreditCard size={26} className="text-slate-700" />
              <span className="font-medium text-slate-800">Card</span>
            </button>
            <button
              onClick={() => setMethod('cash')}
              className="flex flex-col items-center gap-2 rounded-xl bg-white px-4 py-8 ring-1 ring-slate-300 transition hover:bg-slate-50 hover:ring-brand-400"
            >
              <Banknote size={26} className="text-slate-700" />
              <span className="font-medium text-slate-800">Cash</span>
            </button>
          </div>

          {/* Credit is only offered once a customer is attached to the sale. */}
          <button
            onClick={() => customer && onConfirm({ paymentMethod: 'account' })}
            disabled={!customer || submitting}
            className={cx(
              'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-4 ring-1 transition',
              customer
                ? 'bg-white text-slate-800 ring-slate-300 hover:bg-slate-50 hover:ring-brand-400'
                : 'cursor-not-allowed bg-slate-50 text-slate-400 ring-slate-200',
            )}
          >
            <Wallet size={20} />
            <span className="font-medium">
              {customer ? `Put on ${customer.name}'s account` : 'On account — pick a customer first'}
            </span>
          </button>
        </div>
      )}

      {method === 'card' && (
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 px-4 py-6 text-center">
            <p className="text-sm text-slate-500">Charge to card</p>
            <p className="mt-1 text-3xl font-semibold text-slate-900">{money(total)}</p>
            <p className="mt-0.5 text-sm text-slate-500">{lbp(totalLbp)}</p>
          </div>
          <p className="text-center text-xs text-slate-500">
            This records the sale. No card is actually charged — connect a payment provider to take real
            payments.
          </p>
        </div>
      )}

      {method === 'cash' && (
        <div className="space-y-4">
          {/* What has been handed over, per currency */}
          <div className="grid grid-cols-2 gap-2">
            {[
              { key: 'USD', label: 'US dollars', value: usdEntry, display: money(paidUsd) },
              { key: 'LBP', label: 'Lebanese pounds', value: lbpEntry, display: lbp(paidLbp) },
            ].map((c) => (
              <button
                key={c.key}
                onClick={() => setActive(c.key)}
                className={cx(
                  'rounded-xl px-3 py-3 text-left transition ring-1',
                  active === c.key ? 'bg-white ring-brand-500 ring-2' : 'bg-slate-50 ring-slate-200',
                )}
              >
                <span className="block text-xs text-slate-500">{c.label}</span>
                <span
                  className={cx(
                    'mt-0.5 block text-xl font-semibold',
                    c.value ? 'text-slate-900' : 'text-slate-300',
                  )}
                >
                  {c.value ? c.display : c.key === 'USD' ? '$0.00' : '0 LL'}
                </span>
              </button>
            ))}
          </div>

          <div
            className={cx(
              'rounded-xl px-4 py-3 text-center',
              covered ? 'bg-brand-50' : 'bg-amber-50',
            )}
          >
            {covered ? (
              <>
                <p className="text-xs tracking-wide text-slate-500 uppercase">Change to give</p>
                {changeCurrency === 'SPLIT' ? (
                  <>
                    <p className="mt-0.5 text-3xl font-semibold text-slate-900">{money(changeUsd)}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{lbp(toLbp(changeUsd))}</p>
                  </>
                ) : (
                  <>
                    <p className="mt-0.5 text-3xl font-semibold text-slate-900">
                      {changeCurrency === 'LBP' ? lbp(toLbp(changeUsd)) : money(changeUsd)}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {changeCurrency === 'LBP'
                        ? `≈ ${money(changeUsd)}`
                        : `≈ ${lbp(toLbp(changeUsd))}`}
                    </p>
                  </>
                )}
              </>
            ) : (
              <>
                <p className="text-xs tracking-wide text-amber-800 uppercase">Still due</p>
                <p className="mt-0.5 text-3xl font-semibold text-amber-900">{money(remaining)}</p>
                <p className="mt-0.5 text-xs text-amber-700">{lbp(toLbp(remaining))}</p>
              </>
            )}
          </div>

          {covered && (
            <div>
              <p className="mb-1.5 text-sm text-slate-600">Give change in</p>
              <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium">
                {[
                  ['LBP', 'Pounds'],
                  ['USD', 'Dollars'],
                  ['SPLIT', 'Both'],
                ].map(([c, label]) => (
                  <button
                    key={c}
                    onClick={() => pickChangeCurrency(c)}
                    className={cx(
                      'flex-1 rounded-md px-3 py-1.5 transition',
                      changeCurrency === c ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {changeCurrency === 'SPLIT' && (
                <div className="mt-2 space-y-2">
                  {/* Both piles are typed. The total is simply the two added up. */}
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      {
                        field: 'CHANGE_USD',
                        label: 'Dollars back',
                        entry: changeUsdEntry,
                        display: money(splitUsd),
                        zero: '$0.00',
                      },
                      {
                        field: 'CHANGE_LBP',
                        label: 'Pounds back',
                        entry: changeLbpEntry,
                        display: lbp(splitLbp),
                        zero: '0 LL',
                      },
                    ].map((f) => (
                      <div key={f.field} className="space-y-1">
                        <button
                          onClick={() => setActive(f.field)}
                          className={cx(
                            'w-full rounded-xl px-3 py-3 text-left ring-1 transition',
                            active === f.field ? 'bg-white ring-2 ring-brand-500' : 'bg-slate-50 ring-slate-200',
                          )}
                        >
                          <span className="block text-xs text-slate-500">{f.label}</span>
                          <span
                            className={cx(
                              'mt-0.5 block text-xl font-semibold',
                              f.entry ? 'text-slate-900' : 'text-slate-300',
                            )}
                          >
                            {f.entry ? f.display : f.zero}
                          </span>
                        </button>
                        {splitLeft > 0.005 && (
                          <button
                            onClick={() => fillRest(f.field)}
                            className="w-full rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-200"
                          >
                            + rest ({f.field === 'CHANGE_LBP' ? lbp(toLbp(splitLeft)) : money(splitLeft)})
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {/*
                   * Say plainly whether the two piles come to what is owed. A
                   * cashier rounding to the notes they have will land a little
                   * either side, and being told so beats being silently corrected.
                   */}
                  <p
                    className={cx(
                      'rounded-lg px-3 py-2 text-center text-sm',
                      splitLeft === 0
                        ? 'bg-brand-50 text-brand-800'
                        : splitLeft > 0
                          ? 'bg-amber-50 text-amber-800'
                          : 'bg-red-50 text-red-700',
                    )}
                  >
                    {splitLeft === 0
                      ? `${money(splitTotal)} — that is the change exactly`
                      : splitLeft > 0
                        ? `${money(splitTotal)} of ${money(changeUsd)} — ${money(splitLeft)} short`
                        : `${money(splitTotal)} of ${money(changeUsd)} — ${money(-splitLeft)} over`}
                  </p>
                </div>
              )}
            </div>
          )}

          {quickAmounts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {quickAmounts.map((amount) => (
                <button
                  key={amount}
                  onClick={() => setEntry(String(amount))}
                  className="flex-1 rounded-lg bg-slate-100 px-2 py-2 text-sm font-medium whitespace-nowrap text-slate-700 transition hover:bg-slate-200"
                >
                  {wholeNumbersOnly ? `${(amount / 1000).toLocaleString()}k` : money(amount)}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'].map((key) => (
              <button
                key={key}
                onClick={() => press(key)}
                disabled={key === '.' && wholeNumbersOnly}
                aria-label={key === 'back' ? 'Backspace' : key}
                className="flex h-13 items-center justify-center rounded-xl bg-white py-3 text-lg font-medium text-slate-800 ring-1 ring-slate-200 transition hover:bg-slate-50 active:bg-slate-100 disabled:opacity-30"
              >
                {key === 'back' ? <Delete size={18} /> : key}
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
