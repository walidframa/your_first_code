/**
 * The ticket the console writes and the shop redeems.
 *
 * This is the whole join between the two halves, and it exists to avoid the
 * obvious design: giving the console every shop's signing key. That would make
 * one page on the open internet the single thing between an attacker and every
 * till on the machine.
 *
 * So what is checked here is mostly what a ticket is *not*: not readable back
 * out of the database, not good for a second shop, not good for an hour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureControlSchema } from '../src/lib/control.js';
import {
  TICKET_MINUTES,
  findTicket,
  hashToken,
  mintTicket,
  newToken,
  pruneTickets,
} from '../src/lib/supportTickets.js';

const book = () => ensureControlSchema(new DatabaseSync(':memory:'));

test('a fresh ticket is found by its token', () => {
  const db = book();
  const { token, ticket } = mintTicket(db, { slug: 'rami', operator: 'walid', reason: 'A price' });

  const found = findTicket(db, { token, slug: 'rami' });
  assert.equal(found.ticket, ticket);
  assert.equal(found.operator, 'walid');
  assert.equal(found.reason, 'A price');
});

test('the token itself is not in the database', () => {
  /*
   * The book of shops is the file the vendor's own backups copy around. A
   * stolen copy of it must not be a way into anybody's till — so what is kept
   * is the hash, and the secret is handed back exactly once at minting.
   */
  const db = book();
  const { token } = mintTicket(db, { slug: 'rami', operator: 'walid' });

  const row = db.prepare('SELECT * FROM support_tickets').get();
  assert.ok(!Object.values(row).includes(token), 'the token is stored in the clear');
  assert.equal(row.token_hash, hashToken(token));
});

test('a ticket for one shop does not open another', () => {
  const db = book();
  const { token } = mintTicket(db, { slug: 'rami', operator: 'walid' });
  assert.ok(findTicket(db, { token, slug: 'rami' }));
  assert.equal(findTicket(db, { token, slug: 'nabil' }), null);
});

test('a ticket stops working after five minutes', () => {
  const db = book();
  const minted = new Date('2026-01-01T10:00:00Z');
  const { token } = mintTicket(db, { slug: 'rami', operator: 'walid', now: minted });

  const stillGood = new Date(minted.getTime() + (TICKET_MINUTES - 1) * 60 * 1000);
  const tooLate = new Date(minted.getTime() + (TICKET_MINUTES + 1) * 60 * 1000);

  assert.ok(findTicket(db, { token, slug: 'rami', now: stillGood }));
  assert.equal(findTicket(db, { token, slug: 'rami', now: tooLate }), null);
});

test('a token nobody minted finds nothing', () => {
  const db = book();
  mintTicket(db, { slug: 'rami', operator: 'walid' });
  assert.equal(findTicket(db, { token: newToken(), slug: 'rami' }), null);
});

test('nothing at all is not a ticket', () => {
  const db = book();
  for (const token of [null, undefined, '', 0]) {
    assert.equal(findTicket(db, { token, slug: 'rami' }), null, String(token));
  }
});

test('an older control database without the table is not an error', () => {
  // A shop upgraded before its vendor's console was is a shop that has never
  // had a visit arranged — not one that should fail to boot.
  const bare = new DatabaseSync(':memory:');
  assert.equal(findTicket(bare, { token: newToken(), slug: 'rami' }), null);
});

test('old tickets are cleared out, and live ones are not', () => {
  const db = book();
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
  mintTicket(db, { slug: 'rami', operator: 'walid', now: old });
  const { token } = mintTicket(db, { slug: 'rami', operator: 'walid' });

  pruneTickets(db);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM support_tickets').get().n, 1);
  assert.ok(findTicket(db, { token, slug: 'rami' }), 'a live ticket was swept up with the old ones');
});
