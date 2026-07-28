import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Banknote, CreditCard, Delete, Wallet } from 'lucide-react';
import { Button, Modal, cx, money } from './ui';
import { useSettings, lbp } from '../context/SettingsContext';

const QUICK_USD = [5, 10, 20, 50, 100];
const QUICK_LBP = [100000, 200000, 500000, 1000000, 5000000];

/**
 * Payment step. The customer may hand over USD, LBP, or both; the cashier
 * chooses how to give change back — all dollars, all pounds, or split between
 * the two — and the sheet shows the exact amounts to hand over.
 */
export default function PaymentSheet({ open, total, customer, onClose, onConfirm, submitting }) {
  const { rate, toLbp } = useSettings();

  const [method, setMethod] = useState(null);
  const [usdEntry, setUsdEntry] = useState('');
  const [lbpEntry, setLbpEntry] = useState('');
  const [changeEntry, setChangeEntry] = useState('');
  // Which field the keypad is typing into: a tender currency, or — in split
  // mode — the dollars being handed back.
  const [active, setActive] = useState('USD');
  const [changeCurrency, setChangeCurrency] = useState('LBP');

  useEffect(() => {
    if (open) {
      setMethod(null);
      setUsdEntry('');
      setLbpEntry('');
      setChangeEntry('');
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
    if (!covered && active === 'CHANGE') setActive('USD');
  }, [covered, active]);

  /*
   * Split change: the cashier types only the dollars they are handing over and
   * the rest converts to pounds. Typing both halves would mean two numbers that
   * have to agree, and they would not for long.
   *
   * The dollar part is capped at the change due, so an overrun becomes "all in
   * dollars" rather than a negative pile of pounds. The pounds are rounded to a
   * note the till can actually give, which is why the two parts may not add
   * back to the exact figure — that small difference really did cross the
   * counter, and it shows up honestly at close.
   */
  const splitUsd = Math.min(Math.max(0, Number(changeEntry || 0)), changeUsd);
  const splitLbp = toLbp(Math.max(0, changeUsd - splitUsd));

  const totalLbp = useMemo(() => toLbp(total), [toLbp, total]);

  const setEntry =
    active === 'USD' ? setUsdEntry : active === 'LBP' ? setLbpEntry : setChangeEntry;

  function press(key) {
    setEntry((prev) => {
      if (key === 'clear') return '';
      if (key === 'back') return prev.slice(0, -1);
      if (key === '.') {
        if (active === 'LBP') return prev; // pounds have no subunit in practice
        return prev.includes('.') ? prev : (prev || '0') + '.';
      }
      if (active !== 'LBP' && prev.includes('.') && prev.split('.')[1].length >= 2) return prev;
      return prev === '0' ? key : prev + key;
    });
  }

  /** Switch how change is given, pointing the keypad at the field that matters. */
  function pickChangeCurrency(mode) {
    setChangeCurrency(mode);
    if (mode === 'SPLIT') setActive('CHANGE');
    else if (active === 'CHANGE') setActive('USD');
  }

  function confirm() {
    const payments = [];
    if (paidUsd > 0) payments.push({ currency: 'USD', amount: paidUsd });
    if (paidLbp > 0) payments.push({ currency: 'LBP', amount: paidLbp });
    onConfirm({
      paymentMethod: 'cash',
      payments,
      changeCurrency,
      changeUsd: changeCurrency === 'SPLIT' ? splitUsd : undefined,
    });
  }

  /*
   * Shortcut amounts follow the keypad. Handing back change is capped by what
   * is owed, so a $50 button next to $4 of change is only a way to fat-finger.
   */
  const quickAmounts =
    active === 'LBP'
      ? QUICK_LBP
      : active === 'CHANGE'
        ? QUICK_USD.filter((a) => a <= changeUsd)
        : QUICK_USD;

  /** What the confirm button says about the change it is about to hand over. */
  const changeLabel =
    changeCurrency === 'SPLIT'
      ? `${money(splitUsd)} + ${lbp(splitLbp)}`
      : changeCurrency === 'LBP'
        ? lbp(toLbp(changeUsd))
        : money(changeUsd);

  return (
    <Modal
      open={open}
      onClose={submitting ? undefined : onClose}
      title={method === null ? 'Take payment' : method === 'cash' ? 'Cash payment' : 'Card payment'}
      subtitle={`${money(total)} · ${lbp(totalLbp)}`}
      size={method === 'cash' ? 'lg' : 'sm'}
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
                    <p className="mt-0.5 flex items-baseline justify-center gap-2 text-3xl font-semibold text-slate-900">
                      <span>{money(splitUsd)}</span>
                      <span className="text-xl font-normal text-slate-400">+</span>
                      <span>{lbp(splitLbp)}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">together ≈ {money(changeUsd)}</p>
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
                <button
                  onClick={() => setActive('CHANGE')}
                  className={cx(
                    'mt-2 flex w-full items-baseline justify-between rounded-xl px-3 py-3 text-left ring-1 transition',
                    active === 'CHANGE' ? 'bg-white ring-2 ring-brand-500' : 'bg-slate-50 ring-slate-200',
                  )}
                >
                  <span>
                    <span className="block text-xs text-slate-500">Dollars to hand back</span>
                    <span className="mt-0.5 block text-xs text-slate-400">
                      the rest goes back as {lbp(splitLbp)}
                    </span>
                  </span>
                  <span
                    className={cx(
                      'text-xl font-semibold',
                      changeEntry ? 'text-slate-900' : 'text-slate-300',
                    )}
                  >
                    {money(splitUsd)}
                  </span>
                </button>
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
                  {active === 'LBP' ? `${(amount / 1000).toLocaleString()}k` : money(amount)}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'].map((key) => (
              <button
                key={key}
                onClick={() => press(key)}
                disabled={key === '.' && active === 'LBP'}
                aria-label={key === 'back' ? 'Backspace' : key}
                className="flex h-13 items-center justify-center rounded-xl bg-white py-3 text-lg font-medium text-slate-800 ring-1 ring-slate-200 transition hover:bg-slate-50 active:bg-slate-100 disabled:opacity-30"
              >
                {key === 'back' ? <Delete size={18} /> : key}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" size="lg" onClick={() => setMethod(null)} disabled={submitting}>
              <ArrowLeft size={16} /> Back
            </Button>
            <Button
              size="lg"
              className="flex-1"
              disabled={!covered}
              loading={submitting}
              onClick={confirm}
            >
              {covered ? `Confirm · change ${changeLabel}` : `${money(remaining)} still due`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
