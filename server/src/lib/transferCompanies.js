/**
 * The agencies the shop runs a transfer counter for, and what it owes them.
 *
 * The shop is OMT's counter, not OMT's customer. Money crossing that counter is
 * never the shop's:
 *
 *   send    the customer's cash goes into the drawer and the agency
 *           has to deliver it  →  the shop is holding the agency's money
 *   payout  the shop counts its own cash out to a recipient on the
 *           agency's behalf    →  the agency has to make the shop good
 *
 * What the shop keeps either way is the fee, which is the only part of a
 * transfer that is income. The rest is a float, and the float is what this
 * tracks — because the question an operator asks at the end of a day is "the
 * drawer says I am holding four hundred for OMT; does OMT agree", and until now
 * the shop's half of that answer was somebody's memory.
 *
 * Sign convention is the ledger's, unchanged: **positive means the shop owes
 * the agency.** So a send adds and a payout subtracts, and settling up moves it
 * back towards zero.
 */
import { db, transaction } from '../db.js';
import { round2 } from './currency.js';
import { addEntry, balanceOf } from './accounts.js';
import { getSettings } from './settings.js';
import { recordVoucher } from './vouchers.js';

/** What the balance means, in the words an operator would use. */
export function standing(balanceUsd) {
  if (Math.abs(balanceUsd) < 0.005) return 'square';
  return balanceUsd > 0 ? 'owed_to_company' : 'owed_to_shop';
}

export function companyById(id) {
  return db.prepare('SELECT * FROM transfer_companies WHERE id = ?').get(id);
}

export function companyByName(name) {
  return db
    .prepare('SELECT * FROM transfer_companies WHERE lower(name) = lower(?)')
    .get(String(name || '').trim());
}

/**
 * Every agency with what it stands at.
 *
 * The opening balance is a ledger entry rather than a column added on at read
 * time, so a statement adds up from the top and nobody has to remember that the
 * first line is special. The column is kept only to show what was typed in and
 * when — a figure somebody can be asked about later.
 */
export function listCompanies({ includeInactive = false } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM transfer_companies
       ${includeInactive ? '' : 'WHERE is_active = 1'}
       ORDER BY is_active DESC, name`,
    )
    .all();

  return rows.map((c) => {
    const balance = balanceOf('transfer_company', c.id);
    return { ...c, balance, standing: standing(balance) };
  });
}

export function createCompany({ name, phone = null, note = null, userId = null }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Name the agency');
  if (companyByName(clean)) throw new Error(`${clean} is already on the list`);

  const info = db
    .prepare('INSERT INTO transfer_companies (name, phone, note) VALUES (?, ?, ?)')
    .run(clean, phone?.trim() || null, note?.trim() || null);
  void userId;
  return companyById(info.lastInsertRowid);
}

export function updateCompany(id, { name, phone, note, isActive }) {
  const company = companyById(id);
  if (!company) throw new Error('That agency does not exist');

  if (name !== undefined) {
    const clean = String(name).trim();
    if (!clean) throw new Error('Name the agency');
    const clash = companyByName(clean);
    if (clash && clash.id !== company.id) throw new Error(`${clean} is already on the list`);
    db.prepare('UPDATE transfer_companies SET name = ? WHERE id = ?').run(clean, id);
  }
  if (phone !== undefined) {
    db.prepare('UPDATE transfer_companies SET phone = ? WHERE id = ?').run(phone?.trim() || null, id);
  }
  if (note !== undefined) {
    db.prepare('UPDATE transfer_companies SET note = ? WHERE id = ?').run(note?.trim() || null, id);
  }
  if (isActive !== undefined) {
    db.prepare('UPDATE transfer_companies SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
  }
  return companyById(id);
}

/**
 * Where the balance starts.
 *
 * A shop that has been running a transfer counter for three years is not going
 * to key in nine hundred past transfers, so it types what the agency's app says
 * today and carries on from there.
 *
 * Set again rather than added to: the entry is replaced, not stacked, because
 * "actually it was six hundred" is a correction and not a second opening. Every
 * transfer since stays exactly where it was, so the correction moves the
 * balance by the difference and nothing else.
 */
export function setOpeningBalance(id, { amountUsd = 0, amountLbp = 0, userId = null }) {
  const company = companyById(id);
  if (!company) throw new Error('That agency does not exist');

  const { exchange_rate: rate } = getSettings();
  const usd = round2(Number(amountUsd) || 0);
  const lbp = Math.round(Number(amountLbp) || 0);
  const total = round2(usd + (rate > 0 ? lbp / rate : 0));

  return transaction(() => {
    db.prepare(
      `DELETE FROM account_entries
       WHERE party_type = 'transfer_company' AND party_id = ? AND kind = 'opening'`,
    ).run(id);

    if (total !== 0) {
      addEntry({
        partyType: 'transfer_company',
        partyId: id,
        kind: 'opening',
        amountUsd: total,
        exchangeRate: rate,
        note: 'Opening balance',
        userId,
      });
    }

    db.prepare(
      `UPDATE transfer_companies
       SET opening_usd = ?, opening_lbp = ?, opening_set_at = datetime('now')
       WHERE id = ?`,
    ).run(usd, lbp, id);

    const balance = balanceOf('transfer_company', id);
    return { ...companyById(id), balance, standing: standing(balance) };
  })();
}

/**
 * The end of a day at the counter.
 *
 * A transfer counter does not settle by netting off next week's sends: the
 * agency's rider comes round, and either the shop hands over the cash it has
 * been holding or the agency makes the shop good for what it paid out. Both are
 * a voucher — money out of a named till into a named account, or the reverse —
 * and going through `recordVoucher` is what makes the drawer, the agency's
 * ledger and a numbered slip agree with each other.
 *
 * Which way round is not asked twice. The balance already says it: positive is
 * the shop holding their money, so the shop pays. It can still be overridden,
 * because an operator handing over a float in advance is settling too.
 *
 * Both currencies, separately, because that is how it is counted out on the
 * counter — a bundle of dollars and a brick of pounds — and converting one into
 * the other to store a single figure would leave the drawer disagreeing with
 * what is in it.
 */
export function settleWithCompany(
  id,
  { accountId, direction = null, amountUsd = 0, amountLbp = 0, note = null, userId = null },
) {
  const company = companyById(id);
  if (!company) throw new Error('That agency does not exist');

  const balance = balanceOf('transfer_company', company.id);
  const way = direction || (balance < 0 ? 'receive' : 'pay');
  if (way !== 'pay' && way !== 'receive') {
    throw new Error('Settling is either paying them or receiving from them');
  }

  const till = { type: 'cash', id: accountId };
  const agency = { type: 'transfer_company', id: company.id };
  const [from, to] = way === 'pay' ? [till, agency] : [agency, till];

  const voucher = recordVoucher({
    fromType: from.type,
    fromId: from.id,
    toType: to.type,
    toId: to.id,
    amountUsd,
    amountLbp,
    reason: 'transfer_agency',
    note: note?.trim() || `Settled with ${company.name}`,
    userId,
  });

  const after = balanceOf('transfer_company', company.id);
  return {
    voucher,
    company: { ...companyById(company.id), balance: after, standing: standing(after) },
  };
}

/**
 * What one transfer does to the agency's balance, in USD.
 *
 * The fee is not in it. A fee is the shop's own money, earned the moment the
 * transfer happens, and putting it here would have the shop appearing to owe
 * the agency its own commission.
 */
export function balanceEffect({ direction, amountUsd = 0, amountLbp = 0, rate = 0 }) {
  const total = round2((Number(amountUsd) || 0) + (rate > 0 ? (Number(amountLbp) || 0) / rate : 0));
  return direction === 'send' ? total : -total;
}
