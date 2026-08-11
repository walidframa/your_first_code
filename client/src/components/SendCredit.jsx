import { useEffect, useState } from 'react';
import { Send, TriangleAlert } from 'lucide-react';
import api from '../api';
import { Button, Input, Modal, ModalActions, Select, cx, money, useToast } from './ui';

/**
 * Top a customer up with calling credit — the "$" a Lebanese shop sends by SMS.
 *
 * The carrier only takes 3, 2 or 1 per message, so ten dollars is four messages
 * and **each one costs the shop 0.15 out of its balance**. A shop pricing
 * against the ten is quietly losing sixty cents a time.
 *
 * So the dialog's job is to put three numbers in front of the cashier before
 * they commit: which messages to send, what the balance will actually lose, and
 * what is left over once the customer pays. The split is worked out by the
 * server rather than here, so the figure on this screen is the same arithmetic
 * that runs at checkout.
 */
export default function SendCredit({ onClose, onPicked }) {
  const toast = useToast();
  const [carriers, setCarriers] = useState([]);
  const [walletId, setWalletId] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [amount, setAmount] = useState('');
  const [charged, setCharged] = useState('');
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/credit/carriers').then((res) => {
      setCarriers(res.data.carriers);
      if (res.data.carriers.length > 0) setWalletId(String(res.data.carriers[0].id));
    });
  }, []);

  /*
   * Re-quoted as the amount is typed. Cheap, and it means the messages appear
   * as the cashier types "10" rather than after a button nobody presses.
   */
  useEffect(() => {
    if (!walletId || !amount) {
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
        /*
         * Defaults to what it actually costs, not to the face value.
         *
         * Face value looks like the natural default and is wrong every single
         * time: $10 of credit costs $10.60 to send, so a shop that takes the
         * default loses sixty cents and the screen shouts about it on every
         * sale. Break-even is the honest starting point; whatever the shop
         * really charges gets typed over it once and stays for that sale.
         */
        setCharged((c) => (c === '' ? String(res.data.cost) : c));
      })
      .catch((err) => {
        if (!live) return;
        setQuote(null);
        setError(err.response?.data?.error || 'That amount cannot be sent');
      });
    return () => {
      live = false;
    };
  }, [walletId, amount]);

  const carrier = carriers.find((c) => String(c.id) === String(walletId));
  const price = charged === '' ? (quote?.amount ?? 0) : Number(charged);
  const margin = quote ? Math.round((price - quote.cost) * 100) / 100 : 0;
  // What the balance would be left at. Below zero is a bill with the carrier,
  // not a sale to refuse — but it should be said before it happens.
  const after = carrier && quote ? Math.round((carrier.balance - quote.cost) * 100) / 100 : null;

  function put() {
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

  const ready = Boolean(quote && msisdn.trim() && !error);

  return (
    <Modal open onClose={onClose} title="Send credit" subtitle="Top a customer up by SMS">
      <div className="grid grid-cols-2 gap-3">
        <Select label="Carrier" name="carrier" value={walletId} onChange={(e) => setWalletId(e.target.value)}>
          {carriers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Input
          label="Customer's number"
          name="creditMsisdn"
          value={msisdn}
          onChange={(e) => setMsisdn(e.target.value)}
          placeholder="e.g. 03 123 456"
          autoFocus
        />
        <Input
          label="How much credit"
          name="creditAmount"
          type="number"
          min="1"
          step="1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="e.g. 10"
          hint="Whole dollars — the carrier sends 3, 2 or 1 at a time"
        />
        <Input
          label="Charge the customer"
          hint={quote ? `Costs you ${money(quote.cost)} — face value is ${money(quote.amount)}` : undefined}
          name="creditCharged"
          type="number"
          min="0"
          step="0.01"
          value={charged}
          onChange={(e) => setCharged(e.target.value)}
        />
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {quote && (
        <div className="mt-4 space-y-2">
          {/*
            * The messages, spelled out. This is what the cashier actually does
            * next — four separate sends, not one — and getting it wrong means
            * the customer is short.
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

          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Credit</dt>
              <dd className="tnum text-slate-700">{money(quote.amount)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">
                Message fees · {quote.smsCount} × {money(quote.feeEach)}
              </dt>
              <dd className="tnum text-slate-700">{money(quote.fees)}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-1 font-medium">
              <dt className="text-slate-800">Comes off {carrier?.name}</dt>
              <dd className="tnum text-slate-900">{money(quote.cost)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">You make</dt>
              <dd className={cx('tnum font-semibold', margin < 0 ? 'text-red-600' : 'text-brand-700')}>
                {money(margin)}
              </dd>
            </div>
          </dl>

          {margin < 0 && (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <TriangleAlert size={13} className="mt-px shrink-0" />
              Charging less than it costs. The message fees are the difference — send it anyway if
              that is what was agreed.
            </p>
          )}

          {after !== null && after < 0 && (
            <p className="flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              <TriangleAlert size={13} className="mt-px shrink-0" />
              {carrier.name} would go to {money(after)}. It will still send — that is a balance to
              settle with the carrier, not a customer to turn away.
            </p>
          )}
        </div>
      )}

      <ModalActions>
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1" disabled={!ready} onClick={put}>
          <Send size={16} /> Add to the sale
        </Button>
      </ModalActions>
    </Modal>
  );
}
