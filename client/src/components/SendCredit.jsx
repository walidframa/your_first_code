import { useEffect, useState } from 'react';
import { ArrowDownLeft, Send, TriangleAlert } from 'lucide-react';
import api from '../api';
import { Button, Input, Modal, ModalActions, Select, cx, money, useToast } from './ui';
import { lbp, useSettings } from '../context/SettingsContext';

/**
 * Calling credit — the "$" — going out to a customer, and coming back in.
 *
 * Both halves live here because they are the same balance seen from two sides,
 * and in this shop they are two ends of one trade: a 30-day validity card is
 * sold with $7.50 on it, most of that comes back onto the shop's own line, and
 * it is then resold by the dollar at the counter price.
 *
 * Two things the arithmetic has to get right, neither of them obvious:
 *
 * The carrier takes 3, 2 or 1 per message, so $10 is four sends and **every
 * message costs 0.15 off the balance** — $10.60 leaves for $10 delivered.
 *
 * And that credit did not cost a dollar a dollar. Taken back off a card the
 * shop already bought and already sold, it cost nothing extra, so the margin is
 * against what it really cost rather than against face value.
 */
export default function SendCredit({ onClose, onPicked }) {
  const toast = useToast();
  const { rate } = useSettings();

  // Out to a customer, or back in off a validity card.
  const [mode, setMode] = useState('send');
  const [carriers, setCarriers] = useState([]);
  const [walletId, setWalletId] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [amount, setAmount] = useState('');
  const [charged, setCharged] = useState('');
  const [cameBackCost, setCameBackCost] = useState('0');
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadCarriers = () =>
    api.get('/credit/carriers').then((res) => {
      setCarriers(res.data.carriers);
      setWalletId((w) => w || String(res.data.carriers[0]?.id ?? ''));
    });

  useEffect(() => {
    loadCarriers();
  }, []);

  /*
   * Re-quoted as the amount is typed, so the messages appear while the cashier
   * types "10" rather than after a button nobody presses.
   */
  useEffect(() => {
    if (mode !== 'send' || !walletId || !amount) {
      setQuote(null);
      setError('');
      return;
    }

    let live = true;
    api
      .get('/credit/quote', { params: { walletId, amount } })
      .then((res) => {
        if (!live) return;
        setQuote(res.data);
        setError('');
        // The counter price — 110,000 a dollar — not the face value.
        setCharged((c) => (c === '' ? String(res.data.suggested) : c));
      })
      .catch((err) => {
        if (!live) return;
        setQuote(null);
        setError(err.response?.data?.error || 'That amount cannot be sent');
      });
    return () => {
      live = false;
    };
  }, [mode, walletId, amount]);

  const carrier = carriers.find((c) => String(c.id) === String(walletId));
  const price = charged === '' ? (quote?.suggested ?? 0) : Number(charged);
  const margin = quote ? Math.round((price - quote.realCost) * 100) / 100 : 0;
  const after = carrier && quote ? Math.round((carrier.balance - quote.cost) * 100) / 100 : null;

  function send() {
    onPicked({
      walletId: Number(walletId),
      carrierName: carrier?.name,
      msisdn: msisdn.trim(),
      amount: Number(amount),
      price,
      quote,
    });
    toast(`${carrier?.name} $${quote.amount} added`);
    onClose();
  }

  /*
   * Credit coming back does not go through the till — no money changes hands,
   * the shop's balance simply grows. So it is recorded on the spot rather than
   * added to the cart.
   */
  async function takeBack() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/credit/received', {
        walletId: Number(walletId),
        amount: Number(amount),
        costUsd: Number(cameBackCost) || 0,
        msisdn: msisdn.trim() || null,
      });
      toast(`${carrier?.name} is now at ${money(res.data.balance)}`);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  const sending = mode === 'send';
  const ready = sending
    ? Boolean(quote && msisdn.trim() && !error)
    : Number(amount) > 0 && Boolean(walletId);

  return (
    <Modal
      open
      onClose={onClose}
      title="Credit"
      subtitle={sending ? 'Top a customer up by SMS' : 'Credit coming back onto your line'}
    >
      {/* Two sides of the same balance, so one dialog with a switch rather than
          two shortcuts to remember. */}
      <div className="mb-4 flex rounded-xl bg-slate-100 p-1">
        {[
          ['send', 'Send to a customer', Send],
          ['back', 'Credit came back', ArrowDownLeft],
        ].map(([value, label, Icon]) => (
          <button
            key={value}
            onClick={() => {
              setMode(value);
              setError('');
            }}
            className={cx(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm font-medium transition',
              mode === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Select label="Carrier" name="carrier" value={walletId} onChange={(e) => setWalletId(e.target.value)}>
          {carriers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {money(c.balance)} left
            </option>
          ))}
        </Select>
        <Input
          label={sending ? "Customer's number" : 'Whose card it came off'}
          name="creditMsisdn"
          value={msisdn}
          onChange={(e) => setMsisdn(e.target.value)}
          placeholder="e.g. 03 123 456"
          hint={sending ? undefined : 'Optional — just for the record'}
          autoFocus
        />
        <Input
          label={sending ? 'How much credit' : 'How much came back'}
          name="creditAmount"
          type="number"
          min={sending ? '1' : '0.01'}
          step={sending ? '1' : '0.01'}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={sending ? 'e.g. 10' : 'e.g. 6'}
          hint={sending ? 'Whole dollars — the carrier sends 3, 2 or 1 at a time' : undefined}
        />

        {sending ? (
          <Input
            label="Charge the customer"
            name="creditCharged"
            type="number"
            min="0"
            step="0.01"
            value={charged}
            onChange={(e) => setCharged(e.target.value)}
            hint={
              quote
                ? `${lbp(quote.chargeLbp)} at ${Number(quote.priceLbp).toLocaleString('en-US')} a dollar`
                : undefined
            }
          />
        ) : (
          <Input
            label="What it cost you"
            name="cameBackCost"
            type="number"
            min="0"
            step="0.01"
            value={cameBackCost}
            onChange={(e) => setCameBackCost(e.target.value)}
            hint="Nothing, if it came off a card you already sold"
          />
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {!sending && Number(amount) > 0 && (
        <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
          {carrier?.name} goes to{' '}
          <span className="font-semibold text-slate-900">
            {money(Math.round(((carrier?.balance ?? 0) + Number(amount)) * 100) / 100)}
          </span>
          . Credit taken back off a card you have already sold cost you nothing more — leave it at zero
          and the margin on selling it on will be the truth.
        </p>
      )}

      {sending && quote && (
        <div className="mt-4 space-y-2">
          {/*
            * The messages, spelled out. This is what the cashier does next —
            * four separate sends, not one — and getting it wrong leaves the
            * customer short.
            */}
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              Send {quote.smsCount} message{quote.smsCount === 1 ? '' : 's'}
            </p>
            <p className="mt-1 flex flex-wrap gap-1.5">
              {quote.messages.map((m, i) => (
                <span
                  key={i}
                  className="tnum rounded-lg bg-white px-2.5 py-1 text-sm font-semibold text-slate-800 ring-1 ring-slate-200"
                >
                  ${m}
                </span>
              ))}
            </p>
          </div>

          {/*
            * Whose money the fees are is the one thing about this that gets
            * misread, and misreading it costs sixty cents a time in the wrong
            * direction. The customer is charged for the credit they asked for;
            * the messages are the shop's cost of delivering it, and they come
            * off the balance. Said in words because two figures a few lines
            * apart do not say it on their own.
            */}
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
            The customer pays for <strong>{money(quote.amount)}</strong> of credit and gets all of
            it. The {quote.smsCount} × {money(quote.feeEach)} comes off {carrier?.name}, not off
            them.
          </p>

          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">
                Off {carrier?.name} · {money(quote.amount)} + {quote.smsCount} × {money(quote.feeEach)}
              </dt>
              <dd className="tnum text-slate-700">{money(quote.cost)}</dd>
            </div>
            {/*
              * The line that makes the difference. Credit taken back off a
              * validity card cost the shop nothing, so costing this at face
              * value would report that the profitable half of the business
              * earns nothing at all.
              */}
            <div className="flex justify-between border-t border-slate-100 pt-1 font-medium">
              <dt className="text-slate-800">
                What it cost you{' '}
                {quote.costBasis !== 1 && (
                  <span className="text-xs font-normal text-slate-400">
                    · {money(quote.costBasis)} a dollar
                  </span>
                )}
              </dt>
              <dd className="tnum text-slate-900">{money(quote.realCost)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">You make</dt>
              <dd className={cx('tnum font-semibold', margin < 0 ? 'text-red-600' : 'text-brand-700')}>
                {money(margin)}
                {rate > 0 && (
                  <span className="ml-1 text-xs font-normal text-slate-400">
                    {lbp(Math.round(margin * rate))}
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {margin < 0 && (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <TriangleAlert size={13} className="mt-px shrink-0" />
              Charging less than it cost. Send it anyway if that is what was agreed.
            </p>
          )}

          {after !== null && after < 0 && (
            <p className="flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              <TriangleAlert size={13} className="mt-px shrink-0" />
              {carrier.name} would go to {money(after)}. It will still send — that is a balance to
              settle, not a customer to turn away.
            </p>
          )}
        </div>
      )}

      <ModalActions>
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button
          className="flex-1"
          loading={busy}
          disabled={!ready}
          onClick={sending ? send : takeBack}
        >
          {sending ? (
            <>
              <Send size={16} /> Add to the sale
            </>
          ) : (
            <>
              <ArrowDownLeft size={16} /> Add to the balance
            </>
          )}
        </Button>
      </ModalActions>
    </Modal>
  );
}
