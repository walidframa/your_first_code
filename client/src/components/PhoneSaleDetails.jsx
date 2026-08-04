import { useState } from 'react';
import { ChevronDown, KeyRound, Plus, Trash2, UserRound } from 'lucide-react';
import { cx } from './ui';

const KINDS = [
  ['icloud', 'iCloud'],
  ['gmail', 'Gmail'],
  ['other', 'Other'],
];

const field =
  'h-8 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none';

/**
 * The paperwork of selling a phone.
 *
 * Who took it, and which account the shop set up for them. Most buyers never
 * become a customer record — they walk in, buy a handset and leave — but six
 * months later somebody has to be able to answer "whose phone is this?" and
 * "what was my iCloud?".
 *
 * Collapsed until there is a handset on the sale, because none of it applies to
 * a bag of crisps.
 */
export default function PhoneSaleDetails({ buyer, onBuyerChange, accounts, onAccountsChange, units }) {
  const [open, setOpen] = useState(false);

  const filled = (buyer.name ? 1 : 0) + (buyer.phone ? 1 : 0) + accounts.length;

  function addAccount() {
    onAccountsChange([
      ...accounts,
      { kind: 'icloud', username: '', password: '', note: '', unitId: units[0]?.unitId ?? null },
    ]);
    setOpen(true);
  }

  function patch(index, changes) {
    onAccountsChange(accounts.map((a, i) => (i === index ? { ...a, ...changes } : a)));
  }

  return (
    <div className="border-b border-slate-100">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-600 transition hover:bg-slate-50"
      >
        <UserRound size={15} className="text-slate-400" />
        <span className="flex-1">Buyer &amp; accounts</span>
        {filled > 0 && (
          <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700">
            {filled}
          </span>
        )}
        <ChevronDown size={15} className={cx('text-slate-400 transition', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-3 px-3 pb-3">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={buyer.name}
              onChange={(e) => onBuyerChange({ ...buyer, name: e.target.value })}
              placeholder="Buyer's name"
              aria-label="Buyer's name"
              className={field}
            />
            <input
              value={buyer.phone}
              onChange={(e) => onBuyerChange({ ...buyer, phone: e.target.value })}
              placeholder="Phone number"
              aria-label="Buyer's phone number"
              className={field}
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                <KeyRound size={13} className="text-slate-400" /> iCloud / Gmail set up for them
              </span>
              <button
                onClick={addAccount}
                className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-200"
              >
                <Plus size={12} /> Add
              </button>
            </div>

            {accounts.length === 0 ? (
              <p className="text-xs text-slate-400">
                Kept so you can give it back if they forget it. The password is encrypted and only an
                admin can read it again.
              </p>
            ) : (
              <ul className="space-y-2">
                {accounts.map((a, i) => (
                  <li key={i} className="space-y-1.5 rounded-xl bg-slate-50 p-2 ring-1 ring-slate-200">
                    <div className="flex gap-1.5">
                      <select
                        value={a.kind}
                        onChange={(e) => patch(i, { kind: e.target.value })}
                        aria-label="Account type"
                        className={cx(field, 'w-24 shrink-0')}
                      >
                        {KINDS.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                      <input
                        value={a.username}
                        onChange={(e) => patch(i, { username: e.target.value })}
                        placeholder="name@icloud.com"
                        aria-label="Account name"
                        className={field}
                      />
                      <button
                        onClick={() => onAccountsChange(accounts.filter((_, j) => j !== i))}
                        aria-label="Remove account"
                        className="shrink-0 rounded-lg p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <div className="flex gap-1.5">
                      <input
                        value={a.password}
                        onChange={(e) => patch(i, { password: e.target.value })}
                        placeholder="Password"
                        aria-label="Account password"
                        className={field}
                      />
                      {/* Which handset it belongs to, when more than one is going out. */}
                      {units.length > 1 && (
                        <select
                          value={a.unitId ?? ''}
                          onChange={(e) => patch(i, { unitId: Number(e.target.value) || null })}
                          aria-label="Which handset"
                          className={cx(field, 'w-36 shrink-0 font-mono text-xs')}
                        >
                          {units.map((u) => (
                            <option key={u.unitId} value={u.unitId}>
                              {u.imei}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
