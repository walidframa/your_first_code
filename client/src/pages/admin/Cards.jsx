import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  CreditCard,
  ImageUp,
  Pencil,
  Plus,
  Receipt,
  Sparkles,
  Trash2,
  Wallet as WalletIcon,
} from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import LinkValidity from '../../components/LinkValidity';
import { shrink } from '../../lib/shrink';
import MoneyInput from '../../components/MoneyInput';
import { lbp, useSettings } from '../../context/SettingsContext';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ModalActions,
  Select,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';
import { useConfirm } from '../../components/ConfirmProvider';
import { when } from '../../lib/when';

const KINDS = [
  ['recharge', 'Mobile recharge'],
  ['gift_card', 'Gift cards'],
  ['app', 'Mobile app / wallet'],
  ['other', 'Other'],
];

const kindLabel = (k) => KINDS.find(([v]) => v === k)?.[1] || k;

/** Format a balance in whichever currency the wallet is kept in. */
/**
 * What a dollar of credit ends up costing, said the way a shop says it.
 *
 * "88¢ on the dollar" is the sentence somebody at a counter can check against
 * what the distributor told them. A pound wallet is converted first, because
 * cost is held in dollars everywhere in this app while the balance is not.
 */
function centsOnTheDollar(paid, added, wallet, rate = 0) {
  const gotUsd =
    wallet.currency === 'LBP' ? (rate > 0 ? Number(added) / rate : 0) : Number(added);
  if (!(gotUsd > 0)) return '—';

  const perDollar = Number(paid) / gotUsd;
  // Whole cents: a third decimal here is arithmetic nobody asked for.
  return `${Math.round(perDollar * 100)}¢ on the dollar`;
}

function walletAmount(amount, currency) {
  return currency === 'LBP' ? lbp(amount) : money(amount);
}

/* ------------------------------------------------------------- the wallet */

function WalletCard({ wallet, onTopUp, onEdit, onDelete, onStatement }) {
  const low = wallet.balance <= wallet.low_balance;
  const empty = wallet.balance <= 0;

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <span
          className={cx(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
            empty ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand-600',
          )}
        >
          <WalletIcon size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{wallet.name}</p>
          <p className="text-xs text-slate-500">
            {kindLabel(wallet.kind)} · {wallet.currency}
          </p>
        </div>
        <button
          onClick={() => onStatement(wallet)}
          aria-label={`Statement for ${wallet.name}`}
          title="Statement"
          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
        >
          <Receipt size={16} />
        </button>
      </div>

      <p
        className={cx(
          'tnum mt-3 text-3xl font-semibold',
          empty ? 'text-red-600' : low ? 'text-amber-700' : 'text-slate-900',
        )}
      >
        {walletAmount(wallet.balance, wallet.currency)}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">
        {wallet.product_count} card{wallet.product_count === 1 ? '' : 's'} funded by this
      </p>

      {/*
        * A wallet in the red is not an error to hide: the cards were sold and
        * the customers have them. It is a bill owed to the supplier, and it is
        * shown as such so it gets settled rather than discovered.
        */}
      {/*
        * What credit off this wallet is costed at, where the shop can see it.
        *
        * `1` means every top-up was recorded at face value, so a dollar sent to
        * a customer costs a dollar and the profit report shows the credit
        * business earning nothing. That is a state a shop sits in for months
        * without knowing, because nothing on any screen said so — and the fix
        * is one field on the next top-up, which is what this says.
        */}
      {wallet.sends_credit ? (
        wallet.cost_basis < 1 ? (
          <p className="mt-2 text-xs text-slate-500">
            Credit costs you {Math.round(wallet.cost_basis * 100)}¢ on the dollar.
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-400">
            Credit is costed at face value — put what you paid on your next top-up to see the margin.
          </p>
        )
      ) : null}

      {empty && (
        <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-700">
          {wallet.balance < 0
            ? 'Overdrawn — cards were sold on credit you no longer hold.'
            : 'Empty. Top it up before selling more.'}
        </p>
      )}
      {!empty && low && (
        <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          Running low — below {walletAmount(wallet.low_balance, wallet.currency)}.
        </p>
      )}

      {/* Pushed down, so a wallet carrying a warning does not leave its
          neighbour's buttons floating half way up the row. */}
      <div className="mt-auto flex items-center gap-2 pt-3">
        {/*
          * Named, because a screenful of wallets means a screenful of buttons
          * that would otherwise all read the same.
          *
          * "Top up" was the whole label, and taking credit back out lives
          * behind this same button — so a shop wanting to take money off a
          * wallet had no reason to press the one thing that would let them.
          */}
        <Button
          size="sm"
          className="flex-1"
          aria-label={`Top up or take out of ${wallet.name}`}
          onClick={() => onTopUp(wallet)}
        >
          <ArrowDownToLine size={15} /> Top up / take out
        </Button>
        <button
          onClick={() => onEdit(wallet)}
          aria-label={`Edit ${wallet.name}`}
          className="rounded-lg p-2 text-slate-400 ring-1 ring-slate-200 transition hover:bg-slate-50 hover:text-slate-700"
        >
          <Pencil size={15} />
        </button>
        <button
          onClick={() => onDelete(wallet)}
          aria-label={`Close ${wallet.name}`}
          className="rounded-lg p-2 text-slate-400 ring-1 ring-slate-200 transition hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </Card>
  );
}

function WalletDialog({ wallet, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(wallet);
  const [name, setName] = useState(wallet?.name || '');
  const [kind, setKind] = useState(wallet?.kind || 'recharge');
  const [currency, setCurrency] = useState(wallet?.currency || 'USD');
  const [lowBalance, setLowBalance] = useState(String(wallet?.low_balance ?? 0));
  const [opening, setOpening] = useState('');
  /*
   * Sending credit to a customer's line, and what the carrier charges to do it.
   *
   * All three of these have been settable on the server since the credit dialog
   * was built and have never appeared on a screen — so a shop whose carrier
   * charges something other than the built-in 15¢ a message had no way to say
   * so, and every quote at the counter was out by the difference.
   */
  const [sendsCredit, setSendsCredit] = useState(Boolean(wallet?.sends_credit));
  const [smsFee, setSmsFee] = useState(String(wallet?.sms_fee ?? 0.15));
  const [creditPriceLbp, setCreditPriceLbp] = useState(String(wallet?.credit_price_lbp ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (editing) {
        await api.put(`/wallets/${wallet.id}`, {
          name,
          kind,
          lowBalance: Number(lowBalance) || 0,
          sendsCredit,
          smsFee: Number(smsFee) || 0,
          creditPriceLbp: Number(creditPriceLbp) || 0,
        });
      } else {
        await api.post('/wallets', {
          name,
          kind,
          currency,
          lowBalance: Number(lowBalance) || 0,
          opening: Number(opening) || 0,
        });
      }
      toast(editing ? 'Wallet updated' : 'Wallet created');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit ${wallet.name}` : 'New wallet'}
      subtitle="Credit you hold with a supplier, spent whenever one of its cards sells"
    >
      <form onSubmit={submit} className="space-y-3">
        <Input
          label="Name"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Mobile recharge"
          autoFocus
        />

        <div className="grid grid-cols-2 gap-3">
          <Select label="What it holds" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
          <Select
            label="Currency"
            name="currency"
            value={currency}
            disabled={editing}
            onChange={(e) => setCurrency(e.target.value)}
          >
            <option value="USD">US dollars</option>
            <option value="LBP">Lebanese pounds</option>
          </Select>
        </div>
        {editing && (
          <p className="-mt-1 text-xs text-slate-500">
            The currency is fixed once there are movements against it.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Warn below"
            name="lowBalance"
            type="number"
            min="0"
            step={currency === 'LBP' ? '100000' : '1'}
            value={lowBalance}
            onChange={(e) => setLowBalance(e.target.value)}
            hint="0 to only warn when empty"
          />
          {!editing && (
            <Input
              label="Starting balance"
              name="opening"
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              hint="What is on it today"
            />
          )}
        </div>

        {/*
          * Only when editing. A wallet is created from the "New wallet" button
          * with the two things that cannot be changed afterwards, and this is
          * three more decisions on a form somebody is filling in to get started
          * — they belong on the second visit, not the first.
          */}
        {editing && (
          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                name="sendsCredit"
                checked={sendsCredit}
                onChange={(e) => setSendsCredit(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600"
              />
              <span>
                <span className="block text-sm font-medium text-slate-800">
                  Credit can be sent to a customer out of this
                </span>
                <span className="block text-xs text-slate-500">
                  Puts it in the register's Send credit dialog. A gift-card float is a balance too,
                  and sending dollars out of one means nothing.
                </span>
              </span>
            </label>

            {sendsCredit && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Input
                  label="Carrier's fee per message"
                  name="smsFee"
                  type="number"
                  min="0"
                  step="0.01"
                  value={smsFee}
                  onChange={(e) => setSmsFee(e.target.value)}
                  hint="What Alfa or Touch takes each time"
                />
                <Input
                  label="A dollar of credit sells for"
                  name="creditPriceLbp"
                  type="number"
                  min="0"
                  step="1000"
                  value={creditPriceLbp}
                  onChange={(e) => setCreditPriceLbp(e.target.value)}
                  hint="In pounds — 0 to quote at the day's rate"
                />
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy} disabled={!name.trim()}>
            {editing ? 'Save' : 'Create wallet'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function TopUpDialog({ wallet, onClose, onSaved }) {
  const toast = useToast();
  // Only used for a pound wallet, whose balance and whose cost are in different
  // currencies — see centsOnTheDollar.
  const { rate } = useSettings();
  const [kind, setKind] = useState('top_up');
  const [amount, setAmount] = useState('');
  /*
   * What the shop handed over, when that is not the same as what it got.
   *
   * A distributor sells $100 of line for $88, and that discount is the entire
   * margin on sending credit. Left empty this means "bought at face value",
   * which is what every top-up used to record whether it was true or not — so
   * every dollar sent to a customer was costed at exactly what it was worth and
   * the profit screen showed the credit business earning nothing.
   */
  const [paid, setPaid] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post(`/wallets/${wallet.id}/movements`, {
        kind,
        amount: Number(amount),
        note: note || null,
        costUsd: kind === 'top_up' && paid !== '' ? Number(paid) : null,
      });
      toast(`${wallet.name} is now ${walletAmount(res.data.wallet.balance, wallet.currency)}`);
      onSaved();
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
      title={wallet.name}
      subtitle={`Now at ${walletAmount(wallet.balance, wallet.currency)}`}
    >
      <form onSubmit={submit} className="space-y-3">
        <Select label="What happened" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="top_up">Topped it up — paid the supplier</option>
          <option value="withdrawal">Took credit back out</option>
          <option value="adjustment">Correction to match their statement</option>
        </Select>

        <Input
          label={`Amount (${wallet.currency})`}
          name="amount"
          type="number"
          step={wallet.currency === 'LBP' ? '1000' : '0.01'}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
          hint={
            kind === 'adjustment'
              ? 'Negative takes credit off, positive puts it on'
              : undefined
          }
        />

        {kind === 'top_up' && (
          <>
            <Input
              label="What you paid for it (USD)"
              name="paid"
              type="number"
              min="0"
              step="0.01"
              value={paid}
              onChange={(e) => setPaid(e.target.value)}
              placeholder={wallet.currency === 'USD' ? String(amount || '') : ''}
              hint="Leave empty if you paid face value"
            />

            {/*
              * Said in the shop's own terms, because "cost basis" is not a
              * phrase anybody at a counter uses, and because the number that
              * matters is what a dollar sent to a customer will be costed at.
              */}
            {Number(paid) > 0 && Number(amount) > 0 && (
              <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
                Credit off this wallet will cost you{' '}
                <strong>{centsOnTheDollar(paid, amount, wallet, rate)}</strong> — that difference is what
                you make on every dollar you send.
              </p>
            )}
          </>
        )}

        <Input
          label="Note"
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. paid the distributor in cash"
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy} disabled={!Number(amount)}>
            Record it
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function StatementDialog({ wallet, onClose }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get(`/wallets/${wallet.id}/movements`).then((res) => setData(res.data));
  }, [wallet.id]);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${wallet.name} statement`}
      subtitle={`Balance ${walletAmount(wallet.balance, wallet.currency)}`}
    >
      {!data ? (
        <Skeleton className="h-48" />
      ) : data.movements.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="Nothing yet"
          description="Top the wallet up, and every card sold out of it will appear here."
        />
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
            <tr>
              <th className="py-2 font-medium">When</th>
              <th className="py-2 font-medium">What</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {data.movements.map((m) => (
              <tr key={m.id}>
                <td className="py-2 text-slate-500">{when(m.created_at)}</td>
                <td className="py-2 text-slate-700">
                  {m.product_name || m.note || m.kind.replace('_', ' ')}
                  {(m.order_number || m.doc_number) && (
                    <span className="ml-1 text-xs text-slate-400">
                      {m.order_number || m.doc_number}
                    </span>
                  )}
                </td>
                <td
                  className={cx(
                    'tnum py-2 text-right font-medium',
                    m.amount < 0 ? 'text-slate-900' : 'text-emerald-700',
                  )}
                >
                  {m.amount > 0 ? '+' : '−'}
                  {walletAmount(Math.abs(m.amount), wallet.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------- the cards */

/**
 * The picture a cashier presses.
 *
 * Recharge cards are told apart by colour long before anybody reads the value
 * off them, so the seeded ones come with a drawn face. A shop that would rather
 * see a photograph of the real card takes one here, and every screen that shows
 * a product picture picks it up — the register tile most of all.
 *
 * Shrunk hard on the way in: this is shown at about two hundred pixels and
 * lives in the row itself, so a four-megabyte phone photo would be four
 * megabytes of database for no visible difference.
 */
function CardPicture({ value, onChange }) {
  const fileRef = useRef(null);
  const [error, setError] = useState('');

  async function pick(e) {
    const file = e.target.files?.[0];
    // Let the same file be chosen again after a removal.
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      onChange(await shrink(file, { maxEdge: 640, quality: 0.8 }));
    } catch (err) {
      setError(err.message || 'That image could not be used');
    }
  }

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">Picture</span>
      <div className="flex items-center gap-3">
        {value ? (
          <img
            src={value}
            alt=""
            className="h-20 w-32 rounded-lg object-cover ring-1 ring-slate-200"
          />
        ) : (
          <div className="flex h-20 w-32 items-center justify-center rounded-lg text-xs text-slate-400 ring-1 ring-dashed ring-edge">
            No picture
          </div>
        )}
        <div className="flex flex-col gap-2">
          <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
            <ImageUp className="h-4 w-4" />
            {value ? 'Replace' : 'Add a photo'}
          </Button>
          {value && (
            <Button type="button" variant="secondary" onClick={() => onChange('')}>
              <Trash2 className="h-4 w-4" />
              Remove
            </Button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" onChange={pick} className="hidden" />
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function CardDialog({ card, wallets, categories, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(card);

  const [name, setName] = useState(card?.name || '');
  const [sku, setSku] = useState(card?.sku || '');
  const [price, setPrice] = useState(String(card?.price ?? ''));
  const [cost, setCost] = useState(String(card?.cost ?? ''));
  const [categoryId, setCategoryId] = useState(String(card?.category_id || categories[0]?.id || ''));
  const [walletId, setWalletId] = useState(String(card?.wallet_id || wallets[0]?.id || ''));
  const [credits, setCredits] = useState(String(card?.credits_included ?? ''));
  const [picture, setPicture] = useState(card?.image_url || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const margin = (Number(price) || 0) - (Number(cost) || 0);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const body = {
      name,
      price: Number(price) || 0,
      cost: Number(cost) || 0,
      category_id: Number(categoryId) || null,
      wallet_id: Number(walletId) || null,
      credits_included: Number(credits) || null,
      image_url: picture || null,
    };
    try {
      if (editing) {
        await api.put(`/products/${card.id}`, body);
      } else {
        await api.post('/products', { ...body, sku, image_emoji: '💳', reorder_point: 0 });
      }
      toast(editing ? 'Card updated' : 'Card added');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? card.name : 'New card'}
      subtitle="Sold from a wallet, so it never runs out of stock"
    >
      <form onSubmit={submit} className="space-y-3">
        <Input
          label="Name"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. ALFA 7.58 · 1 month"
          autoFocus
        />

        {!editing && (
          <Input
            label="Code"
            name="sku"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="CARD-ALFA-7-58-1M"
            hint="Anything unique — it is what a scan or a typed code matches"
          />
        )}

        {/*
          * Both in either currency: a dealer quotes a card in pounds and the
          * counter quotes it in pounds, so making somebody divide by the rate
          * in their head is how a cost lands out by a factor of ten.
          */}
        <div className="grid grid-cols-2 gap-3">
          <MoneyInput label="Selling price" name="price" value={price} onChange={setPrice} />
          <MoneyInput
            label="What it costs you"
            name="cost"
            value={cost}
            onChange={setCost}
            hint="Comes off the wallet on every sale"
          />
        </div>

        <p className={cx('text-xs', margin < 0 ? 'text-red-600' : 'text-slate-500')}>
          {margin < 0
            ? `You would lose ${money(-margin)} on each one.`
            : `Margin ${money(margin)} a card.`}
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Section"
            name="category_id"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select
            label="Paid from"
            name="wallet_id"
            value={walletId}
            onChange={(e) => setWalletId(e.target.value)}
          >
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>

        {/*
          * What the card carries, which is none of the two figures above. A
          * "$7.58" recharge card holds 7.58 of credit whatever the dealer
          * charged for it and whatever the counter charges for it — and it is
          * the figure the validity loop needs to know how much credit a
          * scratched card put into play.
          */}
        <Input
          label="Credit inside the card"
          name="credits_included"
          type="number"
          step="0.01"
          min="0"
          value={credits}
          onChange={(e) => setCredits(e.target.value)}
          placeholder="e.g. 7.58"
          hint="What the customer receives — not the price, not the cost"
        />

        <CardPicture value={picture} onChange={setPicture} />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            className="flex-1"
            loading={busy}
            disabled={!name.trim() || (!editing && !sku.trim()) || !walletId}
          >
            {editing ? 'Save' : 'Add card'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- the page */

export default function Cards() {
  const toast = useToast();
  const { rate, toLbp } = useSettings();
  /*
   * Which cards are ticked, for moving them onto another wallet together.
   *
   * The starter catalogue funds every recharge card from one shared balance,
   * and a shop that buys its Alfa credit and its Touch credit separately needs
   * two — which is ninety dialogs, one field each, unless they can be ticked.
   */
  const [picked, setPicked] = useState(() => new Set());
  const [moving, setMoving] = useState(false);

  const [wallets, setWallets] = useState(null);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loadingStarter, setLoadingStarter] = useState(false);

  const [editingWallet, setEditingWallet] = useState(null);
  const [newWallet, setNewWallet] = useState(false);
  const [toppingUp, setToppingUp] = useState(null);
  const [statement, setStatement] = useState(null);
  const [editingCard, setEditingCard] = useState(null);
  const [newCard, setNewCard] = useState(false);

  const load = useCallback(async () => {
    const [walletsRes, productsRes, categoriesRes] = await Promise.all([
      api.get('/wallets'),
      api.get('/products'),
      api.get('/products/categories'),
    ]);
    setWallets(walletsRes.data.wallets);
    setProducts(productsRes.data.products);
    setCategories(categoriesRes.data.categories);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openWallets = useMemo(() => (wallets || []).filter((w) => w.active), [wallets]);

  /* Grouped by section, because that is how they are sold: a cashier goes to
     Recharge, not to an alphabetical list of ninety products. */
  const sections = useMemo(() => {
    const cards = products.filter((p) => p.wallet_id && p.active);
    const groups = new Map();
    for (const c of cards) {
      const key = c.category_name || 'Uncategorised';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [products]);

  const cardCount = sections.reduce((n, [, list]) => n + list.length, 0);
  // The validity card whose link is being set.
  const [linking, setLinking] = useState(null);

  /** Move everything ticked onto one wallet, in a single request. */
  async function moveTo(walletId) {
    setMoving(true);
    try {
      const { data } = await api.post('/products/paid-from', {
        productIds: [...picked],
        walletId: Number(walletId) || null,
      });
      toast(
        `${data.moved.length} card${data.moved.length === 1 ? '' : 's'} now paid from ` +
          `${data.wallet?.name || 'nothing'}`,
      );
      setPicked(new Set());
      await load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not move those', 'error');
    } finally {
      setMoving(false);
    }
  }

  const toggleCard = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Tick or clear a whole section, which is how a shelf of Alfa gets moved. */
  const toggleSection = (list) =>
    setPicked((prev) => {
      const next = new Set(prev);
      const all = list.every((c) => next.has(c.id));
      for (const c of list) {
        if (all) next.delete(c.id);
        else next.add(c.id);
      }
      return next;
    });

  async function loadStarter() {
    setLoadingStarter(true);
    try {
      const res = await api.post('/wallets/starter-catalogue');
      toast(
        res.data.added > 0
          ? `Added ${res.data.added} cards. Set what each one costs you.`
          : 'Everything in the starter set is already here',
      );
      await load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not load those', 'error');
    } finally {
      setLoadingStarter(false);
    }
  }

  const confirm = useConfirm();

  async function removeWallet(wallet) {
    const agreed = await confirm({
      title: `Close ${wallet.name}?`,
      body: 'The wallet stops being usable. Its statement and everything sold from it stay on the books.',
      confirmLabel: 'Close it',
      cancelLabel: 'Keep it open',
    });
    if (!agreed) return;

    try {
      await api.delete(`/wallets/${wallet.id}`);
      toast(`${wallet.name} closed`);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not close that', 'error');
    }
  }

  async function removeCard(card) {
    const agreed = await confirm({
      title: `Remove ${card.name}?`,
      body: 'It stops being sellable at the register. Cards already sold stay on the sales they were sold on.',
      confirmLabel: 'Remove it',
      cancelLabel: 'Keep it',
    });
    if (!agreed) return;

    try {
      await api.delete(`/products/${card.id}`);
      toast(`${card.name} removed`);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not remove that', 'error');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Cards"
        subtitle="Recharge, validity and gift cards — sold from credit, not from a shelf"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setNewWallet(true)}>
              <WalletIcon size={16} /> New wallet
            </Button>
            <Button onClick={() => setNewCard(true)} disabled={openWallets.length === 0}>
              <Plus size={16} /> Add card
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {!wallets ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Wallets</h2>
            {openWallets.length === 0 ? (
              <Card className="p-6">
                <EmptyState
                  icon={WalletIcon}
                  title="No wallets yet"
                  description="A wallet is the credit you hold with a supplier — recharge with Alfa, codes with your gift-card dealer. Cards are sold out of it, and it is topped up when you pay them."
                  action={
                    <Button onClick={() => setNewWallet(true)}>
                      <Plus size={16} /> New wallet
                    </Button>
                  }
                />
              </Card>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                {openWallets.map((w) => (
                  <WalletCard
                    key={w.id}
                    wallet={w}
                    onTopUp={setToppingUp}
                    onEdit={setEditingWallet}
                    onDelete={removeWallet}
                    onStatement={setStatement}
                  />
                ))}
              </div>
            )}

            <div className="mt-6 mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                The catalogue
                {cardCount > 0 && <span className="ml-2 font-normal text-slate-400">{cardCount} cards</span>}
              </h2>
              {/* Ninety products typed by hand is why shops give up on this
                  screen, so the common ones are one press away. */}
              <Button variant="secondary" size="sm" onClick={loadStarter} loading={loadingStarter}>
                <Sparkles size={15} /> Load the Lebanese starter set
              </Button>
            </div>

            {sections.length === 0 ? (
              <Card className="p-6">
                <EmptyState
                  icon={CreditCard}
                  title="No cards yet"
                  description="Load the starter set for Alfa and touch validity, whole recharge and the usual gift cards — then set what each costs you."
                />
              </Card>
            ) : (
              <div className="space-y-4">
                {sections.map(([section, list]) => (
                  <Card key={section}>
                    <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                      <label className="flex cursor-pointer items-center gap-2.5">
                        {/* Ticking the shelf is how a whole section moves. Alfa
                            and Touch share one, so the rows tick too. */}
                        <input
                          type="checkbox"
                          aria-label={`Select every card in ${section}`}
                          checked={list.length > 0 && list.every((c) => picked.has(c.id))}
                          onChange={() => toggleSection(list)}
                          className="size-4 accent-brand-600"
                        />
                        <span className="font-medium text-slate-900">{section}</span>
                      </label>
                      <p className="text-xs text-slate-400">{list.length} cards</p>
                    </div>
                    <table className="w-full text-sm">
                      <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                        <tr>
                          <th className="w-9 px-3 py-2" />
                          <th className="px-3 py-2 font-medium">Card</th>
                          <th className="px-3 py-2 text-right font-medium">Price</th>
                          <th className="px-3 py-2 text-right font-medium">Costs you</th>
                          <th className="px-3 py-2 text-right font-medium">Margin</th>
                          <th className="px-3 py-2 font-medium">Paid from</th>
                          {/* Only validity cards have a card behind them and
                              credit coming back off it. */}
                          {list.some((c) => c.validity_days) && (
                            <th className="px-3 py-2 font-medium">Delivered by</th>
                          )}
                          <th className="px-5 py-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-rule">
                        {list.map((c) => {
                          const margin = Math.round((c.price - c.cost) * 100) / 100;
                          return (
                            <tr
                              key={c.id}
                              className={cx(
                                'transition',
                                picked.has(c.id) ? 'bg-brand-50/60' : 'hover:bg-slate-50/60',
                              )}
                            >
                              <td className="px-3 py-2">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${c.name}`}
                                  checked={picked.has(c.id)}
                                  onChange={() => toggleCard(c.id)}
                                  className="size-4 accent-brand-600"
                                />
                              </td>
                              <td className="px-3 py-2 font-medium text-slate-800">
                                <span className="flex items-center gap-2">
                                  {/* The picture the register shows, at the size
                                      it takes to tell one card from another. */}
                                  {c.image_url && (
                                    <img
                                      src={c.image_url}
                                      alt=""
                                      className="h-8 w-12 rounded object-cover ring-1 ring-slate-200"
                                    />
                                  )}
                                  {c.name}
                                </span>
                                {c.credits_included > 0 && (
                                  <span className="block text-xs font-normal text-slate-400">
                                    carries {money(c.credits_included)} of credit
                                  </span>
                                )}
                              </td>
                              <td className="tnum px-3 py-2 text-right text-slate-900">
                                {money(c.price)}
                                {rate > 0 && (
                                  <span className="block text-xs font-normal text-slate-400">
                                    {lbp(toLbp(c.price))}
                                  </span>
                                )}
                              </td>
                              <td className="tnum px-3 py-2 text-right text-slate-600">{money(c.cost)}</td>
                              <td className="px-3 py-2 text-right">
                                {margin > 0 ? (
                                  <span className="tnum font-medium text-emerald-700">{money(margin)}</span>
                                ) : margin < 0 ? (
                                  <Badge tone="critical">−{money(-margin)}</Badge>
                                ) : (
                                  <Badge tone="warning">Set the cost</Badge>
                                )}
                              </td>
                              <td className="px-3 py-2 text-slate-500">{c.wallet_name}</td>
                              {list.some((x) => x.validity_days) && (
                                <td className="px-3 py-2">
                                  {c.validity_days ? (
                                    <button
                                      onClick={() => setLinking(c)}
                                      className="text-left text-xs text-brand-700 underline-offset-2 hover:underline"
                                    >
                                      {scratchLabel(c) ? (
                                        <>
                                          {scratchLabel(c)}
                                          {/*
                                            * A card picked with the credit left
                                            * at nothing is not set up — it just
                                            * looks it. Reading "$0.00 back to
                                            * Alfa" as finished is how a carrier
                                            * balance stays at zero all week.
                                            */}
                                          {c.credit_recovered > 0 && c.credit_wallet_name ? (
                                            <span className="block text-slate-400">
                                              {money(c.credit_recovered)} back to{' '}
                                              {c.credit_wallet_name}
                                            </span>
                                          ) : (
                                            <span className="block text-amber-700">
                                              no credit set — nothing reaches a balance
                                            </span>
                                          )}
                                        </>
                                      ) : (
                                        <span className="text-amber-700">Not linked yet</span>
                                      )}
                                    </button>
                                  ) : (
                                    <span className="text-xs text-slate-300">—</span>
                                  )}
                                </td>
                              )}
                              <td className="px-5 py-2 text-right whitespace-nowrap">
                                <button
                                  onClick={() => setEditingCard(c)}
                                  aria-label={`Edit ${c.name}`}
                                  className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                                >
                                  <Pencil size={15} />
                                </button>
                                <button
                                  onClick={() => removeCard(c)}
                                  aria-label={`Remove ${c.name}`}
                                  className="ml-1 rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                                >
                                  <Trash2 size={15} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/*
        * What to do with what is ticked, along the bottom.
        *
        * Only when something is. A bar that is always there is a bar to read
        * past on every visit, and this is a job a shop does once — when it
        * discovers its Alfa cards have been coming off a shared balance and its
        * Alfa line has not moved all month.
        */}
      {picked.size > 0 && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-4px_12px_-6px_rgba(15,23,42,0.2)] sm:px-6">
          <span className="text-sm font-medium text-slate-800">
            {picked.size} card{picked.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-sm text-slate-500">Paid from</span>
            <div className="w-56">
              <Select
                aria-label="Move the selected cards onto this wallet"
                value=""
                disabled={moving}
                onChange={(e) => e.target.value && moveTo(e.target.value)}
              >
                <option value="">Move them to…</option>
                {(wallets || [])
                  .filter((w) => w.active)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
              </Select>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())} disabled={moving}>
            Clear
          </Button>
        </div>
      )}

      {(newWallet || editingWallet) && (
        <WalletDialog
          wallet={editingWallet}
          onClose={() => {
            setNewWallet(false);
            setEditingWallet(null);
          }}
          onSaved={() => {
            setNewWallet(false);
            setEditingWallet(null);
            load();
          }}
        />
      )}

      {toppingUp && (
        <TopUpDialog
          wallet={toppingUp}
          onClose={() => setToppingUp(null)}
          onSaved={() => {
            setToppingUp(null);
            load();
          }}
        />
      )}

      {statement && <StatementDialog wallet={statement} onClose={() => setStatement(null)} />}

      {(newCard || editingCard) && (
        <CardDialog
          card={editingCard}
          wallets={openWallets}
          categories={categories}
          onClose={() => {
            setNewCard(false);
            setEditingCard(null);
          }}
          onSaved={() => {
            setNewCard(false);
            setEditingCard(null);
            load();
          }}
        />
      )}

      {linking && (
        <LinkValidity
          card={linking}
          cards={products.filter((p) => p.wallet_id && p.active)}
          carriers={(wallets || []).filter((w) => w.sends_credit && w.active)}
          onClose={() => setLinking(null)}
          onSaved={() => {
            setLinking(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/**
 * The cards a validity package scratches, as one line on the row.
 *
 * More than one is the ordinary case now — a 180-day package is often two —
 * so this reads "Alfa $11.11 + Alfa $22.73", and a repeated card is a count
 * rather than the same name twice.
 */
function scratchLabel(card) {
  const list = card.scratch_cards || [];
  if (list.length === 0) return card.linked_card_name || '';
  return list
    .map((c) => (Number(c.quantity) > 1 ? `${c.quantity} × ${c.name}` : c.name))
    .join(' + ');
}
