import { useState } from 'react';
import { Banknote, CreditCard, Plus, Trash2, Wallet } from 'lucide-react';
import MoneyInput from './MoneyInput';
import CustomerPicker from './CustomerPicker';
import { Button, Select, cx, money } from './ui';
import { lbp, useSettings } from '../context/SettingsContext';

/**
 * Settling one sale with more than one thing.
 *
 * A customer hands over forty dollars, sends the rest on Whish, and still owes
 * ten until Friday. That is one ordinary transaction and the register could not
 * write it down — the cashier picked whichever piece was biggest and the rest
 * went unrecorded.
 *
 * Built as a list rather than a wizard because the shape of it is not known in
 * advance: it might be two pieces or four, and a screen that asks "how many?"
 * first is a screen nobody can start filling in.
 *
 * The apps are named rather than typed. Whish and OMT are what the money
 * actually came through, and from the shop's books they behave exactly like a
 * card — nothing is in the drawer and nobody is owed — so they share a method
 * and differ only in what the row is labelled.
 */
const APPS = ['Visa', 'Mastercard', 'Whish', 'OMT', 'Bank transfer'];

/*
 * Always all three, whether or not a customer has been named yet.
 *
 * "Part cash, the rest on his account" is the ordinary way half the sales in
 * this shop end, and it was offered only to a sale that already had a customer
 * on it — so the cashier had to back out of the payment sheet, find the
 * customer, and start the split again. Whose account it goes on is asked here
 * instead, at the moment it becomes a question.
 */
const KINDS = [
  ['cash', 'Cash', Banknote],
  ['card', 'Card or app', CreditCard],
  ['account', 'On account', Wallet],
];

export default function SplitPayment({ total, customer, submitting, onConfirm, onCustomer, onBack }) {
  const { rate } = useSettings();
  /*
   * Whose account the credit half lands on. Starts as whoever the sale already
   * names, and a change here is handed back up: the receipt, the balance and
   * the ledger all have to agree about who this was, and the sale is where
   * that is kept.
   */
  const [buyer, setBuyer] = useState(customer ?? null);
  const [rows, setRows] = useState([{ id: 1, method: 'cash', usd: '', lbpAmount: '', label: '' }]);
  const [changeCurrency, setChangeCurrency] = useState('USD');

  const worth = (r) =>
    (Number(r.usd) || 0) + (rate > 0 ? (Number(r.lbpAmount) || 0) / rate : 0);

  const paid = Math.round(rows.reduce((sum, r) => sum + worth(r), 0) * 100) / 100;
  const left = Math.round((total - paid) * 100) / 100;
  const covered = left <= 0.009;
  /* An account row is a promise, not a payment, so it cannot be over-paid into
     change — the shop would be handing out notes against a debt. */
  const owing = rows.filter((r) => r.method === 'account').reduce((sum, r) => sum + worth(r), 0);
  const overOnAccount = owing > 0 && left < -0.009;

  const set = (id, patch) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () =>
    setRows((prev) => [
      ...prev,
      {
        id: Math.max(0, ...prev.map((r) => r.id)) + 1,
        // The next piece defaults to whatever is still owed, which is what the
        // cashier is about to type anyway.
        method: prev.some((r) => r.method === 'cash') ? 'card' : 'cash',
        usd: left > 0 ? String(left) : '',
        lbpAmount: '',
        label: '',
      },
    ]);

  const unnamed = owing > 0 && !buyer;

  function submit() {
    onConfirm({
      // Named here rather than before the sheet was opened, so the register can
      // put the balance on the right account.
      customerId: buyer?.id ?? null,
      tenders: rows
        .map((r) => ({
          method: r.method,
          amountUsd: Number(r.usd) || 0,
          amountLbp: Number(r.lbpAmount) || 0,
          label: r.method === 'card' ? r.label || null : null,
        }))
        .filter((t) => t.amountUsd > 0 || t.amountLbp > 0),
      changeCurrency,
    });
  }

  return (
    <>
      <div className="space-y-3">
        {rows.map((row, n) => (
          <div key={row.id} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
            <div className="flex items-center gap-2">
              <Select
                aria-label={`How piece ${n + 1} was paid`}
                value={row.method}
                onChange={(e) => set(row.id, { method: e.target.value, label: '' })}
                className="max-w-[10rem]"
              >
                {KINDS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>

              {row.method === 'card' && (
                <Select
                  aria-label={`Which app for piece ${n + 1}`}
                  value={row.label}
                  onChange={(e) => set(row.id, { label: e.target.value })}
                  className="max-w-[10rem]"
                >
                  <option value="">Which one…</option>
                  {APPS.map((app) => (
                    <option key={app} value={app}>
                      {app}
                    </option>
                  ))}
                </Select>
              )}

              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                  aria-label={`Remove piece ${n + 1}`}
                  className="ms-auto rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <MoneyInput
                label="Dollars"
                name={`usd-${row.id}`}
                value={row.usd}
                onChange={(v) => set(row.id, { usd: v })}
                /* There is a Pounds box beside this one. */
                switchable={false}
              />
              {/* An account row is a figure in dollars — nobody owes pounds and
                  dollars separately, they owe one balance. */}
              {row.method !== 'account' && (
                <MoneyInput
                  label="Pounds"
                  name={`lbp-${row.id}`}
                  currency="LBP"
                  value={row.lbpAmount}
                  onChange={(v) => set(row.id, { lbpAmount: v })}
                  switchable={false}
                />
              )}
            </div>
          </div>
        ))}

        {/*
          * Asked once, and only when it is a question: a split with nothing on
          * account has no account to name.
          */}
        {owing > 0 && (
          <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
            <p className="mb-2 text-sm font-medium text-slate-700">
              {money(owing)} on whose account?
            </p>
            <CustomerPicker
              customer={buyer}
              onChange={(next) => {
                setBuyer(next);
                onCustomer?.(next);
              }}
            />
            {!buyer && (
              <p className="mt-2 text-xs text-amber-700">
                Money left on an account nobody has named is money the shop cannot collect.
              </p>
            )}
          </div>
        )}

        <Button variant="secondary" className="w-full" onClick={add} disabled={submitting}>
          <Plus size={15} /> Another payment
        </Button>

        <div className="rounded-xl bg-white px-4 py-3 ring-1 ring-slate-200">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-slate-500">Sale</span>
            <span className="tnum font-medium text-slate-800">{money(total)}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between text-sm">
            <span className="text-slate-500">Paid</span>
            <span className="tnum font-medium text-slate-800">{money(paid)}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between border-t border-slate-100 pt-1 font-semibold">
            <span className={cx(covered ? 'text-brand-700' : 'text-slate-900')}>
              {left > 0.009 ? 'Still due' : left < -0.009 ? 'Change' : 'Settled'}
            </span>
            <span className={cx('tnum', covered ? 'text-brand-700' : 'text-slate-900')}>
              {money(Math.abs(left))}
            </span>
          </div>
          {rate > 0 && Math.abs(left) > 0.009 && (
            <p className="tnum mt-0.5 text-right text-xs text-slate-400">
              {lbp(Math.round(Math.abs(left) * rate))}
            </p>
          )}
        </div>

        {/* Only worth asking once there is change to give. */}
        {left < -0.009 && !overOnAccount && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">Change in</span>
            {['USD', 'LBP'].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setChangeCurrency(c)}
                aria-pressed={changeCurrency === c}
                className={cx(
                  'rounded-lg px-3 py-1.5 text-sm font-medium ring-1 transition',
                  changeCurrency === c
                    ? 'bg-brand-600 text-white ring-brand-600'
                    : 'bg-white text-slate-600 ring-edge hover:bg-slate-50',
                )}
              >
                {c === 'USD' ? 'Dollars' : 'Pounds'}
              </button>
            ))}
          </div>
        )}

        {overOnAccount && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            More has been put on the account than is left to pay. Lower it — the shop should not be
            handing back notes against money somebody still owes.
          </p>
        )}

        {owing > 0 && buyer && (
          <p className="text-xs text-slate-500">
            {money(owing)} goes on {buyer.name}&rsquo;s account, to be paid later.
          </p>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <Button variant="secondary" size="lg" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button
          size="lg"
          className="flex-1"
          disabled={!covered || overOnAccount || unnamed}
          loading={submitting}
          onClick={submit}
        >
          {unnamed
            ? 'Name the account first'
            : covered
              ? `Confirm ${money(total)}`
              : `${money(left)} still due`}
        </Button>
      </div>
    </>
  );
}
