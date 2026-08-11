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
