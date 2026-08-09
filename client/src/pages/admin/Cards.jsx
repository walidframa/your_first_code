import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  CreditCard,
  Pencil,
  Plus,
  Receipt,
  Sparkles,
  Trash2,
  Wallet as WalletIcon,
} from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
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

const KINDS = [
  ['recharge', 'Mobile recharge'],
  ['gift_card', 'Gift cards'],
  ['app', 'Mobile app / wallet'],
  ['other', 'Other'],
];

const kindLabel = (k) => KINDS.find(([v]) => v === k)?.[1] || k;

/** Format a balance in whichever currency the wallet is kept in. */
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
        {/* Named, because a screenful of wallets means a screenful of buttons
            that would otherwise all read "Top up". */}
        <Button
          size="sm"
          className="flex-1"
          aria-label={`Top up ${wallet.name}`}
          onClick={() => onTopUp(wallet)}
        >
          <ArrowDownToLine size={15} /> Top up
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (editing) {
        await api.put(`/wallets/${wallet.id}`, { name, kind, lowBalance: Number(lowBalance) || 0 });
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
  const [kind, setKind] = useState('top_up');
  const [amount, setAmount] = useState('');
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
          <tbody className="divide-y divide-slate-50">
            {data.movements.map((m) => (
              <tr key={m.id}>
                <td className="py-2 text-slate-500">{m.created_at.slice(0, 16).replace('T', ' ')}</td>
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

function CardDialog({ card, wallets, categories, onClose, onSaved }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();
  const editing = Boolean(card);

  const [name, setName] = useState(card?.name || '');
  const [sku, setSku] = useState(card?.sku || '');
  const [price, setPrice] = useState(String(card?.price ?? ''));
  const [cost, setCost] = useState(String(card?.cost ?? ''));
  const [categoryId, setCategoryId] = useState(String(card?.category_id || categories[0]?.id || ''));
  const [walletId, setWalletId] = useState(String(card?.wallet_id || wallets[0]?.id || ''));
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

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Selling price"
            name="price"
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            hint={rate > 0 && Number(price) ? lbp(toLbp(Number(price))) : undefined}
          />
          <Input
            label="What it costs you"
            name="cost"
            type="number"
            step="0.01"
            min="0"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
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

  async function removeWallet(wallet) {
    try {
      await api.delete(`/wallets/${wallet.id}`);
      toast(`${wallet.name} closed`);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not close that', 'error');
    }
  }

  async function removeCard(card) {
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

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
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
                    <div className="flex items-baseline justify-between border-b border-slate-100 px-5 py-3">
                      <p className="font-medium text-slate-900">{section}</p>
                      <p className="text-xs text-slate-400">{list.length} cards</p>
                    </div>
                    <table className="w-full text-sm">
                      <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                        <tr>
                          <th className="px-5 py-2 font-medium">Card</th>
                          <th className="px-3 py-2 text-right font-medium">Price</th>
                          <th className="px-3 py-2 text-right font-medium">Costs you</th>
                          <th className="px-3 py-2 text-right font-medium">Margin</th>
                          <th className="px-3 py-2 font-medium">Paid from</th>
                          <th className="px-5 py-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {list.map((c) => {
                          const margin = Math.round((c.price - c.cost) * 100) / 100;
                          return (
                            <tr key={c.id} className="hover:bg-slate-50/60">
                              <td className="px-5 py-2 font-medium text-slate-800">{c.name}</td>
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
    </div>
  );
}
