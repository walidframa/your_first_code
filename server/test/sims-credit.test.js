/**
 * SIM cards, and the calling credit a Lebanese shop sends by SMS.
 *
 * The arithmetic in here is the shop's money. The carrier only takes 3, 2 or 1
 * per message, so ten dollars is four sends, and **each send costs 0.15 out of
 * the balance** — $10 of credit leaves $10.60. Get the split wrong and the
 * customer is short; get the fee wrong and the shop is, silently, on every
 * single top-up. So the breakdown is pinned down case by case rather than
 * spot-checked.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SMS_FEE, describe as describeCredit, planFor, quote } from '../src/lib/credit.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4609;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;
let simProduct;
let alfa;

async function req(method, route, body, token) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Some responses legitimately carry no body.
  }
  return { status: res.status, json };
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-sims-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'sims.sqlite'),
    JWT_SECRET: 'sims-test-secret-long-enough-for-the-guard',
    ACCOUNT_SECRET: 'sims-test-account-secret-long-enough-here',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  cashierToken = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;

  simProduct = (
    await req(
      'POST',
      '/products',
      { name: 'Alfa prepaid SIM', sku: 'SIM-A', price: 5, cost: 3, tracks_units: true, is_sim: true },
      adminToken,
    )
  ).json.product;

  alfa = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.name === 'Alfa',
  );
  await req('POST', `/wallets/${alfa.id}/movements`, { kind: 'top_up', amount: 200 }, adminToken);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ the SMS plan */

test('ten dollars is three threes and a one — the shop’s own example', () => {
  assert.deepEqual(planFor(10), [3, 3, 3, 1]);

  const q = quote(10);
  assert.equal(q.smsCount, 4);
  assert.equal(q.fees, 0.6, 'four messages at fifteen cents');
  assert.equal(q.cost, 10.6, 'what actually leaves the balance');
  assert.equal(describeCredit(q), '3 × $3 + 1 × $1');
});

test('every amount splits into the fewest messages there can be', () => {
  // Each is the minimum: ceil(amount / 3), which is what the fee is charged on.
  const expected = {
    1: [1],
    2: [2],
    3: [3],
    4: [3, 1],
    5: [3, 2],
    6: [3, 3],
    7: [3, 3, 1],
    8: [3, 3, 2],
    9: [3, 3, 3],
    11: [3, 3, 3, 2],
    20: [3, 3, 3, 3, 3, 3, 2],
  };
  for (const [amount, messages] of Object.entries(expected)) {
    assert.deepEqual(planFor(Number(amount)), messages, `$${amount}`);
    assert.equal(
      messages.length,
      Math.ceil(Number(amount) / 3),
      `$${amount} should take the fewest sends`,
    );
    assert.equal(
      messages.reduce((a, b) => a + b, 0),
      Number(amount),
      `$${amount} must add up to what was asked for`,
    );
  }
});

test('the fee follows the carrier, not a number baked into the code', () => {
  assert.equal(quote(10, 0).cost, 10, 'a carrier that charges nothing costs the face value');
  assert.equal(quote(10, 0.25).cost, 11, 'four messages at a quarter');
  assert.equal(DEFAULT_SMS_FEE, 0.15);
});

test('an amount the carrier cannot send is refused, and says why', () => {
  assert.throws(() => planFor(2.5), /whole dollars/i);
  assert.throws(() => planFor(0), /how much/i);
  assert.throws(() => planFor(-5), /how much/i);
  assert.throws(() => planFor(9999), /more than \$500/);
});

/* ------------------------------------------------------------ sending it */

test('a top-up takes the credit and the message fees off the carrier', async () => {
  const before = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.id === alfa.id,
  ).balance;

  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ creditSend: { walletId: alfa.id, msisdn: '03 123 456', amount: 10 }, price: 11 }],
      paymentMethod: 'card',
    },
    adminToken,
  );

  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  const line = sale.json.items[0];
  assert.equal(line.price, 11, 'the customer was charged what the shop said');
  assert.equal(line.cost, 10.6, 'and the line carries what it really cost');
  assert.equal(line.product_id, null, 'credit is not a product on a shelf');

  const after = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.id === alfa.id,
  ).balance;
  assert.equal(after, Math.round((before - 10.6) * 100) / 100, 'fees came off too, not just the credit');
});

test('the send is recorded against the number it went to', async () => {
  const sends = (await req('GET', '/credit/sends', null, adminToken)).json.sends;
  const latest = sends[0];

  // The question a customer comes back with is "did my $10 arrive", and the
  // number it went to is nowhere on the order.
  assert.equal(latest.msisdn, '03 123 456');
  assert.equal(latest.amount, 10);
  assert.equal(latest.sms_count, 4);
  assert.equal(latest.breakdown, '3 × $3 + 1 × $1');
  assert.equal(latest.cost, 10.6);
  assert.equal(latest.charged, 11);
});

test('what it costs is worked out by the server, not taken from the browser', async () => {
  const sale = await req(
    'POST',
    '/orders',
    {
      items: [
        {
          creditSend: { walletId: alfa.id, msisdn: '03 999 111', amount: 3 },
          price: 4,
          // A browser claiming the credit is free changes nothing.
          cost: 0,
        },
      ],
      paymentMethod: 'card',
    },
    adminToken,
  );

  assert.equal(sale.json.items[0].cost, 3.15, 'one message, fee included');
});

test('a wallet that is not a carrier cannot send credit', async () => {
  const other = (
    await req('POST', '/wallets', { name: 'Gift float', kind: 'gift_card' }, adminToken)
  ).json.wallet;

  const res = await req(
    'POST',
    '/orders',
    {
      items: [{ creditSend: { walletId: other.id, msisdn: '03 123 456', amount: 5 } }],
      paymentMethod: 'card',
    },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /not set up to send credit/i);
});

test('credit with no number to send it to is refused', async () => {
  const res = await req(
    'POST',
    '/orders',
    { items: [{ creditSend: { walletId: alfa.id, amount: 5 } }], paymentMethod: 'card' },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /which number/i);
});

test('an overdrawn carrier still sends — that is a bill, not a customer to turn away', async () => {
  const touch = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.name === 'Touch',
  );
  assert.equal(touch.balance, 0, 'nothing has been bought from Touch yet');

  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ creditSend: { walletId: touch.id, msisdn: '03 555 777', amount: 5 }, price: 6 }],
      paymentMethod: 'card',
    },
    adminToken,
  );
  assert.equal(sale.status, 201);

  const after = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.id === touch.id,
  ).balance;
  assert.equal(after, -5.3, 'and the balance says so rather than hiding it');
});

/* ------------------------------------------------------------------ SIMs */

test('a delivery of SIMs is booked in by number, however it is written', async () => {
  const res = await req(
    'POST',
    '/sims/receive',
    { productId: simProduct.id, cost: 3, sims: ['03 111 222', '76/333 444', '+961 71 555 666'] },
    adminToken,
  );

  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.added, 3);
  // All three spellings land on the same footing, so a number typed one way on
  // the way in is found when typed another way on the way out.
  assert.deepEqual(res.json.numbers, ['9613111222', '96176333444', '96171555666']);
});

test('the same number cannot be booked in twice', async () => {
  const res = await req(
    'POST',
    '/sims/receive',
    { productId: simProduct.id, sims: ['03 111 222'] },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /already on file/i);
});

test('a batch with the same number twice is refused whole', async () => {
  const before = (await req('GET', '/sims', null, adminToken)).json.sims.length;

  const res = await req(
    'POST',
    '/sims/receive',
    { productId: simProduct.id, sims: ['03 777 888', '03 777 888'] },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /twice/i);

  // None of it, not the first one — a delivery half-entered is worse than not
  // entered, because the shop believes it has SIMs it cannot find.
  assert.equal((await req('GET', '/sims', null, adminToken)).json.sims.length, before);
});

test('a SIM is found by its number typed any way at all', async () => {
  for (const written of ['03 111 222', '03111222', '+961 3 111 222']) {
    const res = await req('GET', `/sims/by-number/${encodeURIComponent(written)}`, null, cashierToken);
    assert.equal(res.status, 200, written);
    assert.equal(res.json.sim.msisdn, '9613111222');
  }

  const missing = await req('GET', '/sims/by-number/03 000 000', null, cashierToken);
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /No SIM on file/i);
});

test('selling a SIM takes it off the shelf and keeps the buyer’s ID', async () => {
  const sim = (await req('GET', '/sims/by-number/03 111 222', null, cashierToken)).json.sim;

  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: simProduct.id, quantity: 1, unitId: sim.id, idPhoto: TINY_PNG }],
      paymentMethod: 'card',
    },
    cashierToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const sold = (await req('GET', '/sims?status=sold', null, adminToken)).json.sims.find(
    (s) => s.msisdn === '9613111222',
  );
  assert.equal(sold.has_id_photo, 1);
  assert.equal(sold.order_number, sale.json.order.order_number);

  // The same card cannot go out twice.
  const again = await req(
    'POST',
    '/orders',
    { items: [{ productId: simProduct.id, quantity: 1, unitId: sim.id }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(again.status, 400);
});

test('the buyer’s ID needs the same permission as a saved password', async () => {
  const sold = (await req('GET', '/sims?status=sold', null, adminToken)).json.sims.find(
    (s) => s.has_id_photo,
  );

  // The cashier took it, at the counter, with the buyer watching.
  const peek = await req('GET', `/sims/sales/${sold.order_item_id}/id-photo`, null, cashierToken);
  assert.equal(peek.status, 403, 'but cannot page back through them afterwards');

  const res = await fetch(`${BASE}/sims/sales/${sold.order_item_id}/id-photo`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /no-store/);
});

test('a SIM sold and refunded keeps the first buyer’s ID against the first sale', async () => {
  const sold = (await req('GET', '/sims?status=sold', null, adminToken)).json.sims.find(
    (s) => s.has_id_photo,
  );
  const first = sold.order_item_id;

  await req('POST', `/orders/${sold.order_id}/refund`, null, adminToken);

  /*
   * The photograph is evidence about a sale, not about a card. A refund puts
   * the SIM back on the shelf; it does not un-happen the sale it was bought in.
   */
  const res = await fetch(`${BASE}/sims/sales/${first}/id-photo`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200, 'the first sale still has its ID');
});

/* -------------------------------------------------- what the credit cost */

/*
 * The economics this shop actually runs on.
 *
 * It does not buy credit from a distributor. It sells a 30-day validity card
 * that carries $7.50, the customer sends $6 of that back onto the shop's own
 * line, and the shop resells it by the dollar at 110,000 LL. The card was
 * already bought and already sold, so those six dollars cost nothing more —
 * and costing them at face value would report that the profitable half of the
 * business earns nothing at all.
 */

test('credit taken back off a validity card costs what the shop says it cost', async () => {
  const touch = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.name === 'Touch',
  );

  // Three cards sold, $6 back off each, none of it costing anything extra.
  for (const from of ['03 101 000', '03 102 000', '03 103 000']) {
    const res = await req(
      'POST',
      '/credit/received',
      { walletId: touch.id, amount: 6, costUsd: 0, msisdn: from },
      adminToken,
    );
    assert.equal(res.status, 201);
  }

  const after = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.id === touch.id,
  );
  // It was at -5.30 from the overdrawn test above.
  assert.equal(after.balance, 12.7, '$18 came in on top of what was owed');
  assert.equal(after.costBasis, 0, 'and none of it cost anything');
});

test('the margin is against what the credit cost, not its face value', async () => {
  const touch = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.name === 'Touch',
  );
  const rate = (await req('GET', '/settings', null, adminToken)).json.settings.exchange_rate;

  const q = (await req('GET', `/credit/quote?walletId=${touch.id}&amount=10`, null, adminToken)).json;

  assert.equal(q.cost, 10.6, 'the balance still loses the full ten-sixty');
  assert.equal(q.realCost, 0, 'but it cost the shop nothing to have');
  assert.equal(q.priceLbp, 110_000);
  assert.equal(q.chargeLbp, 1_100_000, 'ten dollars at a hundred and ten thousand');
  assert.equal(q.suggested, Math.round((1_100_000 / rate) * 100) / 100);
});

test('a sale carries the real cost onto the line, so profit reports read true', async () => {
  const touch = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.name === 'Touch',
  );

  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ creditSend: { walletId: touch.id, msisdn: '03 123 456', amount: 10 } }],
      paymentMethod: 'card',
    },
    adminToken,
  );

  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  const line = sale.json.items[0];

  // Priced in pounds and converted, because that is how credit is quoted here.
  const rate = (await req('GET', '/settings', null, adminToken)).json.settings.exchange_rate;
  assert.equal(line.price, Math.round((1_100_000 / rate) * 100) / 100, 'the counter price');
  assert.equal(line.cost, 0, 'and what it really cost');

  // The balance still loses the face value: that credit is gone whatever it
  // cost to get hold of.
  const after = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.id === touch.id,
  );
  assert.equal(after.balance, 2.1, '12.70 less 10.60');
});

test('credit genuinely bought at face value still costs face value', async () => {
  const bought = (
    await req('POST', '/wallets', { name: 'Bought at par', kind: 'recharge' }, adminToken)
  ).json.wallet;
  await req('PUT', `/wallets/${bought.id}`, { sendsCredit: true }, adminToken);

  // Cash handed to a distributor: what it added is what it cost.
  await req(
    'POST',
    '/credit/received',
    { walletId: bought.id, amount: 100, costUsd: 100 },
    adminToken,
  );

  const q = (await req('GET', `/credit/quote?walletId=${bought.id}&amount=10`, null, adminToken)).json;
  assert.equal(q.costBasis, 1);
  assert.equal(q.realCost, 10.6, 'no arbitrage, no discount');
});

test('credit bought at a discount is costed at the discount', async () => {
  const deal = (await req('POST', '/wallets', { name: 'Discounted', kind: 'recharge' }, adminToken))
    .json.wallet;
  await req('PUT', `/wallets/${deal.id}`, { sendsCredit: true }, adminToken);

  // $95 paid for $100 of balance.
  await req('POST', '/credit/received', { walletId: deal.id, amount: 100, costUsd: 95 }, adminToken);

  const q = (await req('GET', `/credit/quote?walletId=${deal.id}&amount=10`, null, adminToken)).json;
  assert.equal(q.costBasis, 0.95);
  assert.equal(q.realCost, 10.07, '10.60 of credit at ninety-five cents a dollar');
});

test('the price a dollar sells for is a setting, not a number in the code', async () => {
  const touch = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.name === 'Touch',
  );
  await req('PUT', `/wallets/${touch.id}`, { creditPriceLbp: 120_000 }, adminToken);

  const q = (await req('GET', `/credit/quote?walletId=${touch.id}&amount=5`, null, adminToken)).json;
  assert.equal(q.chargeLbp, 600_000);

  await req('PUT', `/wallets/${touch.id}`, { creditPriceLbp: 110_000 }, adminToken);
});

test('credit coming back has to be a real amount', async () => {
  const touch = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.name === 'Touch',
  );

  assert.equal(
    (await req('POST', '/credit/received', { walletId: touch.id, amount: 0 }, adminToken)).status,
    400,
  );
  assert.equal(
    (await req('POST', '/credit/received', { walletId: touch.id, amount: 6, costUsd: -1 }, adminToken))
      .status,
    400,
  );
});

/* ------------------------------------------------------- validity cards */

/*
 * Selling a month of validity is three things at once: the customer pays for
 * days, a whole recharge card is scratched to deliver them, and the credit that
 * card carries lands on the shop's own line to be resold. Doing the last two by
 * hand is how a credit balance becomes a number nobody trusts.
 */

let validity30;
let fullCard;

test('the starter set brings the validity cards a Lebanese shop sells', async () => {
  await req('POST', '/wallets/starter-catalogue', null, adminToken);

  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const cards = products.filter((p) => p.validity_days);

  assert.equal(cards.length, 10, 'five durations for each of the two carriers');
  assert.deepEqual(
    [...new Set(cards.map((c) => c.validity_days))].sort((a, b) => a - b),
    [30, 60, 90, 180, 360],
  );
  for (const carrier of ['Alfa', 'Touch']) {
    assert.ok(cards.some((c) => c.name.startsWith(carrier)), `${carrier} has its own`);
  }

  validity30 = cards.find((c) => c.sku === 'CARD-VAL-ALFA-30');
  fullCard = products.find((p) => p.sku === 'CARD-ALFA-WHOLE-758');
  assert.ok(validity30 && fullCard);
});

test('the recharge ladder is the one the carriers actually print', async () => {
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const whole = products.filter((p) => p.sku.includes('-WHOLE-') && p.active);

  /*
   * Six printed values, for each of the two carriers. Round $5 / $10 / $20 /
   * $50 cards are not sold in Lebanon, and a tile a cashier cannot actually
   * hand over is worse than no tile.
   */
  assert.deepEqual(
    [...new Set(whole.map((c) => c.credits_included))].sort((a, b) => a - b),
    [3.79, 4.5, 7.58, 15.15, 22.73, 77.28],
  );
  assert.equal(whole.length, 12, 'six each for Alfa and Touch');

  // The number on the card is the credit inside it, not its price or its cost.
  assert.equal(fullCard.credits_included, 7.58);

  // And each one carries a picture, so the register is a wall of cards rather
  // than a wall of identical tiles.
  assert.ok(
    whole.every((c) => String(c.image_url || '').startsWith('data:image/svg+xml')),
    'every recharge card has a face',
  );
});

test('a validity card is linked to the full card it is delivered by', async () => {
  // The shop's own numbers: the $10 card costs it $8, and $6 comes back.
  await req('PUT', `/products/${fullCard.id}`, { ...fullCard, cost: 8 }, adminToken);

  const res = await req(
    'PUT',
    `/products/${validity30.id}`,
    { ...validity30, linked_card_id: fullCard.id, credit_recovered: 6, credit_wallet_id: alfa.id },
    adminToken,
  );
  assert.equal(res.status, 200);

  const saved = (await req('GET', '/products', null, adminToken)).json.products.find(
    (p) => p.id === validity30.id,
  );
  assert.equal(saved.linked_card_id, fullCard.id);
  assert.equal(saved.credit_recovered, 6);
  assert.equal(saved.linked_card_name, fullCard.name, 'named, so the screen can show the link');
});

test('selling one scratches the card and credits the balance, with nothing typed in', async () => {
  const before = {
    credit: (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
      (c) => c.id === alfa.id,
    ).balance,
    supplier: (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
      (w) => w.name === 'Mobile recharge',
    ).balance,
  };

  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: validity30.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const after = {
    credit: (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
      (c) => c.id === alfa.id,
    ).balance,
    supplier: (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
      (w) => w.name === 'Mobile recharge',
    ).balance,
  };

  assert.equal(after.supplier, Math.round((before.supplier - 8) * 100) / 100, 'the card was scratched');
  assert.equal(after.credit, Math.round((before.credit + 6) * 100) / 100, 'and the credit came back');
});

test('two of them scratch two cards and bring back twice the credit', async () => {
  const before = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.id === alfa.id,
  ).balance;

  await req(
    'POST',
    '/orders',
    { items: [{ productId: validity30.id, quantity: 2 }], paymentMethod: 'card' },
    adminToken,
  );

  const after = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.id === alfa.id,
  ).balance;
  assert.equal(after, Math.round((before + 12) * 100) / 100);
});

test('an unlinked validity card still sells — it just brings nothing back', async () => {
  const spare = (await req('GET', '/products', null, adminToken)).json.products.find(
    (p) => p.sku === 'CARD-VAL-TOUCH-30',
  );
  assert.equal(spare.linked_card_id, null, 'nothing linked to it yet');

  const before = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.name === 'Touch',
  ).balance;

  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: spare.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );
  assert.equal(sale.status, 201, 'a shop mid-setup can still trade');

  assert.equal(
    (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
      (c) => c.name === 'Touch',
    ).balance,
    before,
  );
});

test('a validity card whose card has been retired refuses the sale', async () => {
  const retired = (
    await req(
      'POST',
      '/products',
      { name: 'Discontinued card', sku: 'CARD-OLD', price: 8, cost: 8, stock: 5 },
      adminToken,
    )
  ).json.product;
  const validity = (
    await req(
      'POST',
      '/products',
      {
        name: 'Broken validity',
        sku: 'VAL-BROKEN',
        price: 3,
        validity_days: 30,
        linked_card_id: retired.id,
      },
      adminToken,
    )
  ).json.product;

  // Retiring a product hides it rather than deleting it, so the link survives.
  await req('DELETE', `/products/${retired.id}`, null, adminToken);

  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: validity.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );
  /*
   * Better a refused sale than one that silently delivers nothing: the card it
   * points at is what the customer is actually being given.
   */
  assert.equal(res.status, 400);
  assert.match(res.json.error, /no longer stocked/i);
});

test('a validity card with no card behind it just sells the days', async () => {
  const daysOnly = (
    await req(
      'POST',
      '/products',
      { name: 'Days only', sku: 'VAL-DAYSONLY', price: 4, validity_days: 60 },
      adminToken,
    )
  ).json.product;

  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: daysOnly.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );
  /*
   * Leaving the link empty is a real arrangement, not a half-finished one, so
   * it must not be turned away for having nothing on a shelf.
   */
  assert.equal(res.status, 201);
  assert.equal(res.json.order.subtotal, 4);
});

/**
 * More than one card behind a package.
 *
 * A 180-day top-up is often delivered by scratching two cards, sometimes two of
 * the same denomination, because the carrier sells the denominations it sells
 * and the package is priced against a total. Before this the app held exactly
 * one, so a shop with a two-card package named one of them and took the other
 * off its books by hand on every sale — which is the credit balance nobody
 * trusts that this whole feature exists to prevent.
 */
test('a package can be delivered by two different cards at once', async () => {
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const small = products.find((p) => p.sku === 'CARD-ALFA-WHOLE-1515');
  const big = products.find((p) => p.sku === 'CARD-ALFA-WHOLE-2273');
  const package180 = products.find((p) => p.sku === 'CARD-VAL-ALFA-180');
  assert.ok(small && big && package180);

  // The shop's own numbers, so the arithmetic below has something to check.
  await req('PUT', `/products/${small.id}`, { ...small, cost: 14 }, adminToken);
  await req('PUT', `/products/${big.id}`, { ...big, cost: 21 }, adminToken);

  const res = await req(
    'PUT',
    `/products/${package180.id}`,
    {
      ...package180,
      linked_card_id: null,
      scratch_cards: [
        { cardId: small.id, quantity: 1 },
        { cardId: big.id, quantity: 1 },
      ],
      credit_recovered: 30,
      credit_wallet_id: alfa.id,
    },
    adminToken,
  );
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.product.scratch_cards.length, 2);

  const supplierBefore = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.name === 'Mobile recharge',
  ).balance;
  const creditBefore = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.id === alfa.id,
  ).balance;

  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: package180.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const supplierAfter = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.name === 'Mobile recharge',
  ).balance;
  const creditAfter = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.id === alfa.id,
  ).balance;

  // Both cards, not one: what the shop paid for each, $14 + $21.
  assert.equal(
    supplierAfter,
    Math.round((supplierBefore - 14 - 21) * 100) / 100,
    'both cards were scratched',
  );
  assert.equal(creditAfter, Math.round((creditBefore + 30) * 100) / 100);
});

test('two of the same card is a count, not two rows', async () => {
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const card = products.find((p) => p.sku === 'CARD-TOUCH-WHOLE-758');
  const package90 = products.find((p) => p.sku === 'CARD-VAL-TOUCH-90');
  const touch = (await req('GET', '/credit/carriers', null, adminToken)).json.carriers.find(
    (c) => c.name === 'Touch',
  );

  await req(
    'PUT',
    `/products/${package90.id}`,
    {
      ...package90,
      linked_card_id: null,
      scratch_cards: [{ cardId: card.id, quantity: 2 }],
      credit_recovered: 12,
      credit_wallet_id: touch.id,
    },
    adminToken,
  );

  const before = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.name === 'Mobile recharge',
  ).balance;

  await req(
    'POST',
    '/orders',
    { items: [{ productId: package90.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );

  const after = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.name === 'Mobile recharge',
  ).balance;
  assert.equal(after, Math.round((before - 7.58 * 2) * 100) / 100, 'two cards went, not one');
});

test('the count multiplies with how many are sold', async () => {
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const package90 = products.find((p) => p.sku === 'CARD-VAL-TOUCH-90');

  const before = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.name === 'Mobile recharge',
  ).balance;

  await req(
    'POST',
    '/orders',
    { items: [{ productId: package90.id, quantity: 3 }], paymentMethod: 'card' },
    adminToken,
  );

  const after = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.name === 'Mobile recharge',
  ).balance;
  // Three sold × two cards each.
  assert.equal(after, Math.round((before - 7.58 * 6) * 100) / 100);
});

test('the same card cannot be listed twice — that is what the count is for', async () => {
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const card = products.find((p) => p.sku === 'CARD-ALFA-WHOLE-758');
  const package60 = products.find((p) => p.sku === 'CARD-VAL-ALFA-60');

  const res = await req(
    'PUT',
    `/products/${package60.id}`,
    {
      ...package60,
      linked_card_id: null,
      scratch_cards: [
        { cardId: card.id, quantity: 1 },
        { cardId: card.id, quantity: 1 },
      ],
    },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /listed twice/);
});

test('cards are scratched whole, so half a card is refused', async () => {
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const card = products.find((p) => p.sku === 'CARD-ALFA-WHOLE-758');
  const package60 = products.find((p) => p.sku === 'CARD-VAL-ALFA-60');

  const res = await req(
    'PUT',
    `/products/${package60.id}`,
    { ...package60, linked_card_id: null, scratch_cards: [{ cardId: card.id, quantity: 1.5 }] },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /whole/);
});

test('a validity card cannot be delivered by another validity card', async () => {
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const package60 = products.find((p) => p.sku === 'CARD-VAL-ALFA-60');
  const other = products.find((p) => p.sku === 'CARD-VAL-ALFA-360');

  const res = await req(
    'PUT',
    `/products/${package60.id}`,
    { ...package60, linked_card_id: null, scratch_cards: [{ cardId: other.id, quantity: 1 }] },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /itself a validity card/);
});

test('a package with one of its cards retired refuses the sale, and says which', async () => {
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const good = products.find((p) => p.sku === 'CARD-ALFA-WHOLE-379');
  const doomed = (
    await req(
      'POST',
      '/products',
      { name: 'About to be dropped', sku: 'CARD-DOOMED', price: 8, cost: 8, stock: 5 },
      adminToken,
    )
  ).json.product;
  const package360 = products.find((p) => p.sku === 'CARD-VAL-ALFA-360');

  await req(
    'PUT',
    `/products/${package360.id}`,
    {
      ...package360,
      linked_card_id: null,
      scratch_cards: [
        { cardId: good.id, quantity: 1 },
        { cardId: doomed.id, quantity: 1 },
      ],
    },
    adminToken,
  );

  // Retiring a product hides it rather than deleting it, so the link survives.
  await req('DELETE', `/products/${doomed.id}`, null, adminToken);

  const before = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.name === 'Mobile recharge',
  ).balance;

  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: package360.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /About to be dropped/);

  /*
   * And nothing was half delivered. The refusal has to come before any card is
   * scratched, or a shop that hits it has spent the good card and handed the
   * customer nothing.
   */
  const after = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.name === 'Mobile recharge',
  ).balance;
  assert.equal(after, before, 'the other card was not spent on a refused sale');
});

test('a single link set the old way still works, and reads back as a list of one', async () => {
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const card = products.find((p) => p.sku === 'CARD-TOUCH-WHOLE-450');
  const package60 = products.find((p) => p.sku === 'CARD-VAL-TOUCH-60');

  // Exactly what an older caller sends: the one column, nothing else.
  const res = await req(
    'PUT',
    `/products/${package60.id}`,
    { ...package60, linked_card_id: card.id },
    adminToken,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.json.product.scratch_cards.map((c) => [c.cardId, c.quantity]),
    [[card.id, 1]],
  );
});
