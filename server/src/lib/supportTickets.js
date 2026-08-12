import crypto from 'node:crypto';

/**
 * How the vendor gets into a client's shop without holding a key to it.
 *
 * The obvious design is the wrong one: give the console every shop's signing
 * key and let it mint a token for whichever till it likes. That makes one web
 * page, on the open internet, the single thing standing between an attacker and
 * every shop on the machine — and it would keep working long after the console
 * was supposed to have been locked down.
 *
 * So nothing is shared. The console writes a ticket into the book of shops; the
 * shop reads that book already, read-only, to check its own licence. The shop
 * redeems the ticket **with its own key**, on its own process. The console never
 * sees a tenant's secret and could not forge a session if it were taken over.
 *
 * What is stored is the hash, not the ticket. The book of shops is the file the
 * vendor's own backups copy around; a stolen copy of it must not be a way in.
 */

/** Long enough that guessing is not a strategy. */
export const TOKEN_BYTES = 32;

/**
 * Five minutes.
 *
 * This is the gap between the vendor clicking "open this shop" and the browser
 * arriving, not the length of the visit. A link that stays valid for an hour is
 * an hour in which it can be read out of a browser history, a chat message, or
 * over somebody's shoulder.
 */
export const TICKET_MINUTES = 5;

export const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('hex');

/**
 * Hashed, not encrypted, and with no salt on purpose.
 *
 * A salt would mean scanning every row to find the match. The input is 32 bytes
 * of randomness that lives for five minutes — there is no dictionary to build
 * against it, which is the only thing a salt would buy.
 */
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const iso = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

/**
 * Write a ticket for one shop, and hand back the secret half exactly once.
 *
 * The caller gets the token here and nowhere else — it is not readable from the
 * database afterwards, by the console or by anybody who takes a copy.
 */
export function mintTicket(db, { slug, operator, reason = '', now = new Date() }) {
  const token = newToken();
  const ticket = crypto.randomBytes(8).toString('hex');
  const expires = new Date(now.getTime() + TICKET_MINUTES * 60 * 1000);

  db.prepare(
    `INSERT INTO support_tickets (ticket, slug, operator, token_hash, reason, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ticket, slug, operator, hashToken(token), reason, iso(now), iso(expires));

  return { ticket, token, expiresAt: iso(expires) };
}

/**
 * The ticket this token stands for, if it is still good for this shop.
 *
 * The slug is part of the lookup rather than checked afterwards: a ticket for
 * one shop must never open another, and a comparison written as a separate step
 * is a comparison that can be forgotten in a later edit.
 */
export function findTicket(db, { token, slug, now = new Date() }) {
  if (!token || !slug) return null;
  try {
    return (
      db
        .prepare(
          `SELECT ticket, slug, operator, reason, expires_at
             FROM support_tickets
            WHERE token_hash = ? AND slug = ? AND expires_at > ?`,
        )
        .get(hashToken(token), slug, iso(now)) || null
    );
  } catch {
    // An older control database without this table is not an error to shout
    // about — it means no support visit has ever been arranged, so there is no
    // ticket to find.
    return null;
  }
}

/** Tickets nobody used. Kept briefly so the console can show what it issued. */
export function pruneTickets(db, { now = new Date(), keepHours = 48 } = {}) {
  const cutoff = new Date(now.getTime() - keepHours * 60 * 60 * 1000);
  db.prepare('DELETE FROM support_tickets WHERE created_at < ?').run(iso(cutoff));
}
