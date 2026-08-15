/**
 * Every account the shop has, in one list.
 *
 * Four kinds of thing had grown up separately — customers, suppliers, the
 * credit held with card dealers, and the tills — and each was reached from its
 * own screen with its own idea of what a balance means. From the counter they
 * are one question: which account is this money moving to or from?
 *
 * So this is the registry, and it is deliberately a view rather than a table.
 * Each kind keeps the storage that suits it — a customer has a credit limit and
 * a ledger, a till has sittings and a count — and this puts one shape over the
 * top of them:
 *
 *   type      what the balance means
 *   cash      what is actually in the drawer, in both currencies apart
 *   wallet    credit held with a supplier, in that wallet's own currency
 *   customer  what they owe the shop
 *   supplier  what the shop owes them
 *
 * The sign convention is the one the ledger already uses: positive is
 * outstanding. A customer at −50 has paid ahead; a supplier at −50 owes a
 * refund.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';
import { balanceMap as partyBalances } from './accounts.js';
import { listAccounts as listTills } from './cashAccounts.js';
import { listWallets } from './wallets.js';

export const REGISTRY_TYPES = ['cash', 'wallet', 'customer', 'supplier', 'transfer_company'];

export const TYPE_LABELS = {
  cash: 'Cash accounts',
  wallet: 'Wallets',
  customer: 'Customers',
  supplier: 'Suppliers',
  transfer_company: 'Transfer agencies',
};

const PARTY_TABLES = {
  customer: 'customers',
  supplier: 'suppliers',
  transfer_company: 'transfer_companies',
};

function parties(type, { activeOnly }) {
  const table = PARTY_TABLES[type];
  // Agencies mark themselves away with `is_active`; the older two use `active`.
  const flag = type === 'transfer_company' ? 'is_active' : 'active';
  const rows = db
    .prepare(`SELECT * FROM ${table} ${activeOnly ? `WHERE ${flag} = 1` : ''} ORDER BY name`)
    .all();
  const balances = partyBalances(type);

  return rows.map((r) => ({
    type,
    id: r.id,
    name: r.name,
    phone: r.phone || null,
    active: !!(type === 'transfer_company' ? r.is_active : r.active),
    /* One figure, in dollars: what a party owes is a single amount however it
       was paid, unlike a till which physically holds two currencies. */
    balance: round2(balances.get(r.id) ?? 0),
    currency: 'USD',
    creditLimit: type === 'customer' ? round2(r.credit_limit || 0) : null,
  }));
}

/** The whole registry, grouped by type. */
export function accountRegistry({ activeOnly = false } = {}) {
  const cash = listTills({ activeOnly }).map((a) => ({
    type: 'cash',
    id: a.id,
    name: a.name,
    kind: a.kind,
    active: a.active,
    isDefault: a.is_default,
    openSession: a.open_session,
    balance: a.balance.usd,
    balanceLbp: a.balance.lbp,
    currency: 'USD',
  }));

  const wallet = listWallets({ activeOnly }).map((w) => ({
    type: 'wallet',
    id: w.id,
    name: w.name,
    kind: w.kind,
    active: w.active,
    balance: w.balance,
    currency: w.currency,
    productCount: w.product_count,
  }));

  return {
    cash,
    wallet,
    customer: parties('customer', { activeOnly }),
    supplier: parties('supplier', { activeOnly }),
    transfer_company: parties('transfer_company', { activeOnly }),
  };
}

/**
 * What the registry adds up to.
 *
 * The four totals a shopkeeper actually asks for: what is in my tills, what
 * credit am I holding, who owes me, and who do I owe.
 */
export function registrySummary(registry) {
  const sum = (rows, key = 'balance') => round2(rows.reduce((t, r) => t + (r[key] || 0), 0));

  const owedToUs = registry.customer.filter((c) => c.balance > 0);
  const weOwe = registry.supplier.filter((s) => s.balance > 0);

  return {
    cashUsd: sum(registry.cash),
    cashLbp: Math.round(registry.cash.reduce((t, r) => t + (r.balanceLbp || 0), 0)),
    walletUsd: sum(registry.wallet.filter((w) => w.currency === 'USD')),
    walletLbp: Math.round(
      registry.wallet.filter((w) => w.currency === 'LBP').reduce((t, w) => t + w.balance, 0),
    ),
    receivable: sum(owedToUs),
    receivableCount: owedToUs.length,
    payable: sum(weOwe),
    payableCount: weOwe.length,
    /* Money paid ahead, which is not a debt and should not be netted into one:
       a customer in credit is money the shop has already taken. */
    customerCredit: round2(-registry.customer.filter((c) => c.balance < 0).reduce((t, c) => t + c.balance, 0)),
  };
}
