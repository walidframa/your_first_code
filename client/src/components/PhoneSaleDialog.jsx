import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Gift, KeyRound, Search, Trash2 } from 'lucide-react';
import api from '../api';
import { useSettings, lbp } from '../context/SettingsContext';
import { Button, Modal, cx, money } from './ui';

const field =
  'h-10 w-full rounded-xl bg-slate-50 px-3 text-sm ring-1 ring-slate-200 focus:bg-white focus:ring-2 focus:ring-brand-600 focus:outline-none';

const label = 'mb-1 block text-xs font-medium text-slate-500';

/** A section that stays out of the way until it is needed. */
function Section({ icon: Icon, title, hint, count, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl ring-1 ring-slate-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <Icon size={18} className="mt-0.5 shrink-0 text-brand-600" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-slate-900">
            {title}
            {count > 0 && (
              <span className="ml-2 rounded-full bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700">
                {count}
              </span>
            )}
          </span>
          <span className="block text-sm text-slate-500">{hint}</span>
        </span>
        <ChevronDown
          size={18}
          className={cx('mt-0.5 shrink-0 text-slate-400 transition', open && 'rotate-180')}
        />
      </button>
      {open && <div className="border-t border-slate-100 px-4 py-3">{children}</div>}
    </div>
  );
}

/**
 * Selling a handset, in one place.
 *
 * A phone is not a tin of beans: the price is agreed at the counter, things get
 * thrown in with it, and the shop often sets up the customer's account before
 * they walk out. All of that has to be settled *before* the sale is rung up,
 * because afterwards the customer has gone.
 *
 * So it is a dialog on the way into the cart rather than a panel beside it —
 * a panel is something a busy cashier can finish a sale without ever opening.
 */
export default function PhoneSaleDialog({ product, unit, onCancel, onAdd }) {
  const { rate, toLbp, toUsd } = useSettings();

  const [buyerName, setBuyerName] = useState('');
  const [buyerPhone, setBuyerPhone] = useState('');
  const [priceUsd, setPriceUsd] = useState(String(product.price ?? ''));
  const [discount, setDiscount] = useState('');
  const [gifts, setGifts] = useState([]);
  const [giftTerm, setGiftTerm] = useState('');
  const [products, setProducts] = useState([]);
  const [accounts, setAccounts] = useState({
    appleId: '',
    applePassword: '',
    email: '',
    emailPassword: '',
    note: '',
  });

  useEffect(() => {
    api.get('/products', { params: { activeOnly: 'true' } }).then((res) => setProducts(res.data.products));
  }, []);

  const price = Number(priceUsd) || 0;
  const off = Number(discount) || 0;
  const total = Math.max(0, Math.round((price - off) * 100) / 100);

  /* Typing pounds is as natural as typing dollars, so both are editable. */
  const priceLbp = toLbp(price);

  const giftMatches = useMemo(() => {
    const t = giftTerm.trim().toLowerCase();
    if (!t) return [];
    return products
      .filter(
        (p) =>
          !p.tracks_units &&
          (p.name.toLowerCase().includes(t) || (p.sku || '').toLowerCase().includes(t)),
      )
      .slice(0, 6);
  }, [products, giftTerm]);

  function addGift(p) {
    if (!gifts.some((g) => g.productId === p.id)) {
      setGifts((g) => [...g, { productId: p.id, name: p.name, stock: p.stock }]);
    }
    setGiftTerm('');
  }

  function submit(e) {
    e.preventDefault();

    /*
     * Two accounts at most, and only the ones actually filled in. An empty row
     * saved as a record would show up in the counter search as an account the
     * shop cannot produce.
     */
    const filled = [];
    if (accounts.appleId.trim()) {
      filled.push({
        kind: 'icloud',
        username: accounts.appleId.trim(),
        password: accounts.applePassword,
        note: accounts.note || null,
        unitId: unit.id,
      });
    }
    if (accounts.email.trim()) {
      filled.push({
        kind: 'gmail',
        username: accounts.email.trim(),
        password: accounts.emailPassword,
        note: accounts.note || null,
        unitId: unit.id,
      });
    }

    onAdd({
      price,
      discount: off,
      buyerName: buyerName.trim(),
      buyerPhone: buyerPhone.trim(),
      gifts,
      accounts: filled,
    });
  }

  return (
    <Modal open onClose={onCancel} title={product.name} subtitle={unit.imei} size="lg">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="buyer-name">
              Buyer name
            </label>
            <input
              id="buyer-name"
              value={buyerName}
              onChange={(e) => setBuyerName(e.target.value)}
              autoFocus
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="buyer-phone">
              Buyer phone
            </label>
            <input
              id="buyer-phone"
              value={buyerPhone}
              onChange={(e) => setBuyerPhone(e.target.value)}
              className={field}
            />
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div>
            <label className={label} htmlFor="price-lbp">
              Selling price
            </label>
            {/*
              * Text rather than a number input, so the separators survive:
              * 24,920,000 is read at a glance and 24920000 is counted digit by
              * digit, which is exactly the mistake a busy counter makes.
              */}
            <input
              id="price-lbp"
              type="text"
              inputMode="numeric"
              value={priceLbp ? priceLbp.toLocaleString('en-US') : ''}
              onChange={(e) => {
                const digits = e.target.value.replace(/[^\d]/g, '');
                setPriceUsd(String(toUsd(Number(digits) || 0)));
              }}
              className={cx(field, 'tnum')}
            />
          </div>
          <div className="w-36">
            <label className={label} htmlFor="price-usd">
              $
            </label>
            <input
              id="price-usd"
              type="number"
              step="0.01"
              min="0"
              value={priceUsd}
              onChange={(e) => setPriceUsd(e.target.value)}
              className={cx(field, 'tnum')}
            />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="line-discount">
            Discount
          </label>
          <input
            id="line-discount"
            type="number"
            step="0.01"
            min="0"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            className={cx(field, 'tnum')}
          />
        </div>

        <div className="flex items-baseline justify-between rounded-xl bg-slate-50 px-4 py-3">
          <span className="font-semibold text-slate-900">Total</span>
          <span className="tnum font-semibold text-slate-900">
            {money(total)}
            {rate > 0 && <span className="text-slate-500"> · {lbp(toLbp(total))}</span>}
          </span>
        </div>

        <Section
          icon={Gift}
          title="Gifts"
          hint="Free items handed over with the phone (charger, cover, screen protector…)"
          count={gifts.length}
        >
          <div className="relative">
            <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
            <input
              value={giftTerm}
              onChange={(e) => setGiftTerm(e.target.value)}
              placeholder="Search a product to give away"
              aria-label="Search a product to give away"
              className={cx(field, 'pl-9')}
            />
          </div>

          {giftMatches.length > 0 && (
            <ul className="mt-2 space-y-1">
              {giftMatches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => addGift(p)}
                    disabled={p.stock <= 0}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-slate-50 disabled:opacity-40"
                  >
                    <span className="text-slate-700">{p.name}</span>
                    <span className="text-xs text-slate-400">
                      {p.stock > 0 ? `${p.stock} left` : 'out of stock'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {gifts.length > 0 && (
            <ul className="mt-2 space-y-1">
              {gifts.map((g) => (
                <li
                  key={g.productId}
                  className="flex items-center justify-between gap-2 rounded-lg bg-brand-50 px-2 py-1.5 text-sm"
                >
                  <span className="text-brand-800">{g.name}</span>
                  <button
                    type="button"
                    onClick={() => setGifts((list) => list.filter((x) => x.productId !== g.productId))}
                    aria-label={`Remove ${g.name}`}
                    className="rounded p-0.5 text-brand-700 transition hover:bg-brand-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-2 text-xs text-slate-500">
            A gift costs the customer nothing but still comes out of stock.
          </p>
        </Section>

        <Section
          icon={KeyRound}
          title="Account setup"
          hint="Apple ID / email accounts you created for the customer"
          count={(accounts.appleId ? 1 : 0) + (accounts.email ? 1 : 0)}
        >
          <div className="space-y-2">
            {[
              ['appleId', 'Apple ID / Email', 'text'],
              ['applePassword', 'Apple ID password', 'text'],
              ['email', 'Email / Gmail', 'text'],
              ['emailPassword', 'Email password', 'text'],
              ['note', 'Other account notes', 'text'],
            ].map(([key, text, type]) => (
              <div key={key}>
                <label className={label} htmlFor={`acct-${key}`}>
                  {text}
                </label>
                <input
                  id={`acct-${key}`}
                  type={type}
                  value={accounts[key]}
                  onChange={(e) => setAccounts((a) => ({ ...a, [key]: e.target.value }))}
                  className={field}
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Passwords are encrypted. Only an admin can read one back, from Accounts.
          </p>
        </Section>

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1">
            Add to cart
          </Button>
        </div>
      </form>
    </Modal>
  );
}
