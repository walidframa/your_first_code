import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Banknote, CreditCard, Delete, Layers, Wallet } from 'lucide-react';
import { Button, Modal, cx, money } from './ui';
import { useT } from '../context/LanguageContext';
import { useSettings, lbp } from '../context/SettingsContext';
import { splitStatus, suggestSplit } from '../lib/change';
import SplitPayment from './SplitPayment';

const QUICK_USD = [5, 10, 20, 50, 100];
const QUICK_LBP = [100000, 200000, 500000, 1000000, 5000000];

/** The keypad targets that belong to the change, not to the tender. */
const CHANGE_FIELDS = ['CHANGE_USD', 'CHANGE_LBP'];

/**
 * Payment step. The customer may hand over USD, LBP, or both; the cashier
 * chooses how to give change back — all dollars, all pounds, or split between
 * the two — and the sheet shows the exact amounts to hand over.
 */
export default function PaymentSheet({
  open,
  total,
  customer,
  onClose,
  onConfirm,
  onCustomer,
  submitting,
}) {
  const t = useT();
  const { rate, step, toLbp } = useSettings();

  const [method, setMethod] = useState(null);
  const [usdEntry, setUsdEntry] = useState('');
  const [lbpEntry, setLbpEntry] = useState('');
  const [changeUsdEntry, setChangeUsdEntry] = useState('');
  const [changeLbpEntry, setChangeLbpEntry] = useState('');
  /*
   * A field is "touched" once the cashier types a figure into it. Until then it
   * is the till's suggestion, free to follow whatever the other field says.
   */
  const [touched, setTouched] = useState({ CHANGE_USD: false, CHANGE_LBP: false });
  // Which field the keypad is typing into: a tender currency, or — in split
  // mode — one of the two piles being handed back.
  const [active, setActive] = useState('USD');

  useEffect(() => {
    if (open) {
      setMethod(null);
      setUsdEntry('');
      setLbpEntry('');
      setChangeUsdEntry('');
      setChangeLbpEntry('');
      setTouched({ CHANGE_USD: false, CHANGE_LBP: false });
      setActive('USD');
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
  const suggestion = suggestSplit({
    changeDue: changeUsd,
    usd: changeUsdEntry,
    lbp: changeLbpEntry,
    usdTouched: touched.CHANGE_USD,
    lbpTouched: touched.CHANGE_LBP,
    rate,
    step,
  });
  const split = splitStatus({
    changeDue: changeUsd,
    usd: suggestion.usd,
    lbp: suggestion.lbp,
    rate,
    step,
  });
  const { usd: splitUsd, lbp: splitLbp, total: splitTotal, left: splitLeft } = split;

  /*
   * Handing back a little more than is owed is just rounding to the notes in
   * the drawer. Handing back a lot more is a slipped digit, and the server
   * refuses it — so the button says why rather than letting it fail on submit.
   */
  const overGiving = split.over;

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
    if (CHANGE_FIELDS.includes(active)) setTouched((t) => ({ ...t, [active]: true }));
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

  /**
   * The counter's own keyboard.
   *
   * The keypad on screen is there for a touch monitor, and it was the only way
   * in — a shop on a desktop with a numeric keypad under its hand had to point
   * at the screen for every digit, which is slower than the thing it replaced.
   *
   * Bound to the document rather than to an input, because the amounts are not
   * inputs: they are two fields the keypad fills, and which one is being typed
   * into is a choice the cashier has already made. Tab moves between them, so
   * "fifty dollars and two hundred thousand" is one uninterrupted run at the
   * keys.
   *
   * Only while the cash sheet is up, and never over a modifier — Ctrl+R has to
   * keep reloading the page.
   */
  useEffect(() => {
    if (!open || method !== 'cash') return undefined;

    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
        return;
      }
      if (e.key === '.' || e.key === ',') {
        e.preventDefault();
        press('.');
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        press('back');
        return;
      }
      if (e.key === 'Tab') {
        // Round the two amounts rather than out of the dialog, which is where
        // the browser would otherwise send it.
        e.preventDefault();
        setActive((now) => (now === 'USD' ? 'LBP' : 'USD'));
        return;
      }
      if (e.key === 'Enter' && covered && !overGiving && !submitting) {
        e.preventDefault();
        confirm();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // `press` and `confirm` close over the entry state, so this is rebound as
    // it changes — cheap, and the alternative is a listener typing into a
    // stale field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, method, active, usdEntry, lbpEntry, covered, overGiving, submitting]);

  /**
   * Give the whole change in one currency.
   *
   * Naming every dollar of a $27.87 change is five keystrokes for the commonest
   * case there is, so it gets a button. Pounds need no figure at all — an
   * untouched pair already suggests the lot in pounds — so "all pounds" is the
   * same as starting over.
   */
  function allInDollars() {
    setChangeUsdEntry(String(Math.round(changeUsd * 100) / 100));
    setTouched({ CHANGE_USD: true, CHANGE_LBP: false });
    setActive('CHANGE_USD');
  }

  function allInPounds() {
    setChangeUsdEntry('');
    setChangeLbpEntry('');
    setTouched({ CHANGE_USD: false, CHANGE_LBP: false });
    setActive('CHANGE_LBP');
  }

  /**
   * Hand a field back to the till.
   *
   * Clearing what was typed makes the field untouched again, so it goes back to
   * following the other one. Better than writing a computed number into it: the
   * field stays live as the other side changes.
   */
  function restoreSuggestion(field) {
    setTouched((t) => ({ ...t, [field]: false }));
    SETTERS[field]('');
  }

  function confirm() {
    const payments = [];
    if (paidUsd > 0) payments.push({ currency: 'USD', amount: paidUsd });
    if (paidLbp > 0) payments.push({ currency: 'LBP', amount: paidLbp });
    onConfirm({
      paymentMethod: 'cash',
      payments,
      /*
       * Always the two figures, never a mode. Whether this was dollars, pounds
       * or a mix is a question the recorded pair answers on its own, and the
       * server storing exactly what was handed over beats it recomputing a
       * conversion the cashier had already rounded to real notes.
       */
      changeCurrency: 'SPLIT',
      changeUsd: splitUsd,
      changeLbp: splitLbp,
    });
  }

  /* Shortcut amounts follow whichever field the keypad is pointed at. */
  const quickAmounts = wholeNumbersOnly ? QUICK_LBP : QUICK_USD;

  /** What the confirm button says about the change it is about to hand over. */
  const changeLabel =
    splitUsd > 0 && splitLbp > 0
      ? `${money(splitUsd)} + ${lbp(splitLbp)}`
      : splitLbp > 0
        ? lbp(splitLbp)
        : money(splitUsd);

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
          {t('Confirm')} {money(total)}
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
      title={
        method === null
          ? t('Take payment')
          : method === 'cash'
            ? t('Cash payment')
            : method === 'split'
              ? t('Split payment')
              : t('Card payment')
      }
      subtitle={`${money(total)} · ${lbp(totalLbp)}`}
      size={method === 'cash' || method === 'split' ? 'lg' : 'sm'}
      footer={footer}
    >
      {method === 'split' && (
        <SplitPayment
          total={total}
          customer={customer}
          submitting={submitting}
          onConfirm={onConfirm}
          onCustomer={onCustomer}
          onBack={() => setMethod(null)}
        />
      )}

      {method === null && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMethod('card')}
              className="flex flex-col items-center gap-2 rounded-xl bg-white px-4 py-8 ring-1 ring-slate-300 transition hover:bg-slate-50 hover:ring-brand-400"
            >
              <CreditCard size={26} className="text-slate-700" />
              <span className="font-medium text-slate-800">{t('Card')}</span>
            </button>
            <button
              onClick={() => setMethod('cash')}
              className="flex flex-col items-center gap-2 rounded-xl bg-white px-4 py-8 ring-1 ring-slate-300 transition hover:bg-slate-50 hover:ring-brand-400"
            >
              <Banknote size={26} className="text-slate-700" />
              <span className="font-medium text-slate-800">{t('Cash')}</span>
            </button>
          </div>

          {/*
            * More than one thing.
            *
            * Some dollars, the rest on Whish, and ten on the account until
            * Friday is one ordinary transaction — and the only one of these
            * three buttons that can express a customer who is short.
            */}
          <button
            onClick={() => setMethod('split')}
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-4 text-slate-800 ring-1 ring-slate-300 transition hover:bg-slate-50 hover:ring-brand-400"
          >
            <Layers size={20} />
            <span className="font-medium">{t('Split it — cash, card or on account')}</span>
          </button>

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
              {customer
                ? t("Put on {name}'s account", { name: customer.name })
                : t('On account — pick a customer first')}
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

          {/* Discoverable rather than a secret: a shop on a desktop should not
              have to find out by accident that the keys work. */}
          <p className="no-print -mt-2 text-center text-[11px] text-slate-400">
            Type on the keyboard too — Tab swaps currency, Enter confirms
          </p>

          <div
            className={cx(
              'rounded-xl px-4 py-3 text-center',
              covered ? 'bg-brand-50' : 'bg-amber-50',
            )}
          >
            {covered ? (
              <>
                <p className="text-xs tracking-wide text-slate-500 uppercase">Change to give</p>
                <p className="mt-0.5 text-3xl font-semibold text-slate-900">{money(changeUsd)}</p>
                <p className="mt-0.5 text-xs text-slate-500">{lbp(toLbp(changeUsd))}</p>
              </>
            ) : (
              <>
                <p className="text-xs tracking-wide text-amber-800 uppercase">Still due</p>
                <p className="mt-0.5 text-3xl font-semibold text-amber-900">{money(remaining)}</p>
                <p className="mt-0.5 text-xs text-amber-700">{lbp(toLbp(remaining))}</p>
              </>
            )}
          </div>

          {covered && changeUsd > 0.0001 && (
            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <p className="text-sm text-slate-600">Change I&apos;m giving</p>
                {/*
                 * All in one currency is a shortcut, not a mode. Both figures
                 * stay on screen either way, so there is nothing to switch back
                 * from when the drawer turns out to be short of one of them.
                 */}
                <span className="flex gap-1">
                  <button
                    onClick={allInDollars}
                    className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-200"
                  >
                    All dollars
                  </button>
                  <button
                    onClick={allInPounds}
                    className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-200"
                  >
                    All LBP
                  </button>
                </span>
              </div>

              <div className="space-y-2">
                  {/*
                   * Whichever pile the cashier has not typed into follows the
                   * one they have, so saying "here is $25" is enough and the
                   * pounds appear beside it.
                   */}
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { field: 'CHANGE_USD', label: 'Dollars back', display: money(splitUsd) },
                      { field: 'CHANGE_LBP', label: 'LBP back', display: lbp(splitLbp) },
                    ].map((f) => {
                      const isSuggested =
                        suggestion.suggested === (f.field === 'CHANGE_USD' ? 'usd' : 'lbp');
                      return (
                        <div key={f.field} className="space-y-1">
                          <button
                            onClick={() => setActive(f.field)}
                            className={cx(
                              'w-full rounded-xl px-3 py-3 text-left ring-1 transition',
                              active === f.field
                                ? 'bg-white ring-2 ring-brand-500'
                                : 'bg-slate-50 ring-slate-200',
                            )}
                          >
                            <span className="flex items-baseline justify-between gap-1">
                              <span className="text-xs text-slate-500">{f.label}</span>
                              {isSuggested && (
                                <span className="text-[10px] tracking-wide text-brand-600 uppercase">
                                  suggested
                                </span>
                              )}
                            </span>
                            <span
                              className={cx(
                                'mt-0.5 block text-xl font-semibold',
                                isSuggested ? 'text-brand-700' : 'text-slate-900',
                              )}
                            >
                              {f.display}
                            </span>
                          </button>
                          {/*
                           * Only reachable once both figures are the cashier's
                           * own — it hands the field back to the till rather
                           * than writing a number they would then have to trust.
                           */}
                          {suggestion.suggested === null && splitLeft !== 0 && (
                            <button
                              onClick={() => restoreSuggestion(f.field)}
                              className="w-full rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-200"
                            >
                              let the till fill this
                            </button>
                          )}
                        </div>
                      );
                    })}
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
            </div>
          )}

          {quickAmounts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {quickAmounts.map((amount) => (
                <button
                  key={amount}
                  onClick={() => {
                    if (CHANGE_FIELDS.includes(active)) setTouched((t) => ({ ...t, [active]: true }));
                    setEntry(String(amount));
                  }}
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
