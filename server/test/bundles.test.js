/**
 * A product made of other products.
 *
 * A starter pack is a phone, a case and a screen protector sold as one line at
 * one price. Nothing sits on a shelf called "starter pack", so the whole
 * feature is really one claim: selling one takes a phone, a case and a
 * protector off the shelves they are actually on, and refunding one puts them
 * back.
 *
 * Stock is money. Every one of these is about the shelves being right
 * afterwards.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4634;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let ids = {};

async function req(method, route, body, auth = token) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* some replies carry no body */
  }
  return { status: res.status, json };
}

const shopDb = () => new DatabaseSync(path.join(workDir, 'shop.sqlite'));

/** What is actually on the shelf, read straight from the database. */
function onShelf(productId) {
  const db = shopDb();
  const row = db.prepare('SELECT stock FROM branch_stock WHERE product_id = ?').get(productId);
  db.close();
  return row?.stock ?? 0;
}

async function addProduct(name, sku, price, cost, stock) {
  const { json } = await req('POST', '/products', { name, sku, price, cost, stock });
  return json.product.id;
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-bundles-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'bundles-secret-long-enough-for-the-production-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };
  spawnSync('npm', ['run', 'seed'], { cwd: serverRoot, env, encoding: 'utf8' });
  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }

  const login = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' }, null);
  token = login.json.token;

  ids.phone = await addProduct('Galaxy A15', 'BND-PHONE', 179, 142, 10);
  ids.case = await addProduct('Clear case', 'BND-CASE', 10, 3, 40);
  ids.glass = await addProduct('Tempered glass', 'BND-GLASS', 8, 2, 25);
  ids.pack = await addProduct('Starter pack', 'BND-PACK', 189, 0, 0);
});

after(() => {
  child?.kill();
  rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ making one */

test('a bundle is described by what is in it', async () => {
  const { status, json } = await req('PUT', `/products/${ids.pack}/bundle`, {
    components: [
      { productId: ids.phone, quantity: 1 },
      { productId: ids.case, quantity: 1 },
      { productId: ids.glass, quantity: 2 },
    ],
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.components.length, 3);
});

test('how many can be made is decided by the shelf that runs out first', async () => {
  // 10 phones, 40 cases, 25 glasses at two per pack → 12 packs. The phone is
  // the limit at 10.
  const { json } = await req('GET', `/products/${ids.pack}/bundle`);
  assert.equal(json.canMake, 10);
});

test('the catalogue reports a bundle as what it can make, not as an empty shelf', async () => {
  // Its own stock row is zero and always will be. Reporting that would show
  // every pack as out of stock on the register.
  const { json } = await req('GET', '/products');
  const pack = json.products.find((p) => p.id === ids.pack);
  assert.equal(pack.isBundle, true);
  assert.equal(pack.stock, 10);
  // And its cost is what its parts cost: 142 + 3 + (2 × 2).
  assert.equal(pack.cost, 149);
});

/* --------------------------------------------------------------- selling */

test('selling a bundle takes its parts off the shelves', async () => {
  const before = {
    phone: onShelf(ids.phone),
    case: onShelf(ids.case),
    glass: onShelf(ids.glass),
  };

  const { status, json } = await req('POST', '/orders', {
    items: [{ productId: ids.pack, quantity: 2 }],
    paymentMethod: 'card',
  });
  assert.equal(status, 201, JSON.stringify(json));

  assert.equal(onShelf(ids.phone), before.phone - 2, 'phones');
  assert.equal(onShelf(ids.case), before.case - 2, 'cases');
  assert.equal(onShelf(ids.glass), before.glass - 4, 'glasses — two per pack');
});

test('and does not invent a shelf for the bundle itself', async () => {
  // A count of its own would be a second truth about the same phones, and
  // would be wrong within a day.
  assert.equal(onShelf(ids.pack), 0);
});

test('a bundle that cannot be made up is refused, and says which part is short', async () => {
  // 8 phones left after the sale above; ask for 9 packs.
  const { status, json } = await req('POST', '/orders', {
    items: [{ productId: ids.pack, quantity: 9 }],
    paymentMethod: 'card',
  });
  assert.equal(status, 400);
  assert.match(json.error, /Galaxy A15/, 'it did not name the part that ran out');
  assert.match(json.error, /Starter pack/);
});

test('the refusal did not take anything off the shelves', async () => {
  assert.equal(onShelf(ids.phone), 8);
  assert.equal(onShelf(ids.case), 38);
});

/* -------------------------------------------------------------- refunding */

test('refunding a bundle puts its parts back', async () => {
  const sale = await req('POST', '/orders', {
    items: [{ productId: ids.pack, quantity: 1 }],
    paymentMethod: 'card',
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const after = { phone: onShelf(ids.phone), case: onShelf(ids.case), glass: onShelf(ids.glass) };

  const refund = await req('POST', `/orders/${sale.json.order.id}/refund`, {});
  assert.equal(refund.status, 200, JSON.stringify(refund.json));

  assert.equal(onShelf(ids.phone), after.phone + 1);
  assert.equal(onShelf(ids.case), after.case + 1);
  assert.equal(onShelf(ids.glass), after.glass + 2, 'both glasses came back');
});

/* ------------------------------------------------------ what it refuses */

/* -------------------------------------------------- and on an invoice too */

/**
 * The same pack, sold on paper rather than at the till.
 *
 * Reported from the shop: an invoice for two fuse boxes was refused with "not
 * enough stock for fuse box (have 0, need 2)" while the fuse boxes were on the
 * shelf. The nought it found was the pack's own stock row, which is *supposed*
 * to be nought — nothing sits on a shelf called "starter pack". The register
 * had always known that; the invoice did not, so it both refused sales the shop
 * could make and, when it did go through, moved that meaningless row and left
 * the parts uncounted.
 */
async function invoiceFor(items, docType = 'sales_invoice') {
  const party = (
    await req('POST', docType === 'sales_invoice' ? '/customers' : '/suppliers', {
      name: `Party ${Math.random().toString(36).slice(2, 8)}`,
    })
  ).json.party;
  const { json } = await req('POST', '/documents', { docType, partyId: party.id, items });
  return json.document;
}

const stockOf = async (id) => (await req('GET', `/products/${id}`)).json.product.stock;

test('an invoice for a pack is not refused for the pack’s own empty shelf', async () => {
  const phones = await stockOf(ids.phone);
  const cases = await stockOf(ids.case);
  const glasses = await stockOf(ids.glass);

  const doc = await invoiceFor([{ productId: ids.pack, name: 'Starter pack', quantity: 2, price: 189 }]);
  const confirmed = await req('POST', `/documents/${doc.id}/confirm`);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));

  // And it came off the shelves the parts are really on: two packs is two
  // phones, two cases and four glasses.
  assert.equal(await stockOf(ids.phone), phones - 2, 'the phones came off');
  assert.equal(await stockOf(ids.case), cases - 2, 'the cases came off');
  assert.equal(await stockOf(ids.glass), glasses - 4, 'two glasses per pack');
});

test('cancelling that invoice puts the parts back, not the pack', async () => {
  const phones = await stockOf(ids.phone);
  const doc = await invoiceFor([{ productId: ids.pack, name: 'Starter pack', quantity: 1, price: 189 }]);
  await req('POST', `/documents/${doc.id}/confirm`);
  assert.equal(await stockOf(ids.phone), phones - 1);

  const cancelled = await req('POST', `/documents/${doc.id}/cancel`);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal(await stockOf(ids.phone), phones, 'the phone went back on the shelf');
  assert.equal(await stockOf(ids.pack), await stockOf(ids.pack), 'and the pack still has no shelf');
});

test('an invoice for more packs than the parts allow names the part that is short', async () => {
  const phones = await stockOf(ids.phone);
  const doc = await invoiceFor([
    { productId: ids.pack, name: 'Starter pack', quantity: phones + 1, price: 189 },
  ]);
  const refused = await req('POST', `/documents/${doc.id}/confirm`);
  assert.equal(refused.status, 400);
  /* The part, not the pack: "not enough stock for Starter pack" sends somebody
     to count a shelf that does not exist. */
  assert.match(refused.json.error, /Galaxy A15/);
  assert.equal(await stockOf(ids.phone), phones, 'and the refusal took nothing off');
});

test('a delivery of a pack puts its parts on the shelf', async () => {
  const cases = await stockOf(ids.case);
  const doc = await invoiceFor(
    [{ productId: ids.pack, name: 'Starter pack', quantity: 3, price: 150, cost: 150 }],
    'purchase_invoice',
  );
  const confirmed = await req('POST', `/documents/${doc.id}/confirm`);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(await stockOf(ids.case), cases + 3, 'what arrived in the box is on the shelf');
});

test('the stock history says which pack moved the part', async () => {
  const { json } = await req('GET', `/products/${ids.phone}/activity`);
  assert.ok(
    /* The pack's own document line names the pack, so a part that moved for it
       has no document row of its own — the adjustment's note is the only trace
       there is, which is exactly why it has to say what moved it. */
    (json.activity || []).some((r) => String(r.detail || '').includes('in Starter pack')),
    'a part that moved for a pack says so, or the history reads as an unexplained adjustment',
  );
});

test('a bundle cannot contain itself', async () => {
  const { status, json } = await req('PUT', `/products/${ids.pack}/bundle`, {
    components: [{ productId: ids.pack, quantity: 1 }],
  });
  assert.equal(status, 400);
  assert.match(json.error, /cannot contain itself/);
});

test('a bundle cannot contain another bundle', async () => {
  // A pack of packs is a tree somebody has to hold in their head at a counter.
  const other = await addProduct('Second pack', 'BND-PACK-2', 99, 0, 0);
  const { status, json } = await req('PUT', `/products/${other}/bundle`, {
    components: [{ productId: ids.pack, quantity: 1 }],
  });
  assert.equal(status, 400);
  assert.match(json.error, /bundles cannot contain bundles/);
});

test('a quantity of zero or less is refused', async () => {
  for (const quantity of [0, -1]) {
    const { status } = await req('PUT', `/products/${ids.pack}/bundle`, {
      components: [{ productId: ids.case, quantity }],
    });
    assert.equal(status, 400, `quantity ${quantity} was accepted`);
  }
});

test('emptying the list makes it an ordinary product again', async () => {
  const { status, json } = await req('PUT', `/products/${ids.pack}/bundle`, { components: [] });
  assert.equal(status, 200);
  assert.equal(json.components.length, 0);
  assert.equal(json.canMake, null, 'a product with no parts is not a bundle');

  const list = await req('GET', '/products');
  const pack = list.json.products.find((p) => p.id === ids.pack);
  assert.ok(!pack.isBundle);
});

/* ------------------------------------------- changing one at the counter */

/*
 * The reason packs exist at all: the customer wants the blue case.
 *
 * Until now the shop's only answers were to refuse them, or to sell the pack
 * and correct the shelves by hand afterwards. What is being checked here is
 * that the *right* shelves move — and, on the way back, that they move again.
 */
test('a pack can be made of something else at the counter', async () => {
  // Put the pack back together after the last test emptied it.
  await req('PUT', `/products/${ids.pack}/bundle`, {
    components: [
      { productId: ids.phone, quantity: 1 },
      { productId: ids.case, quantity: 1 },
    ],
  });
  ids.blue = await addProduct('Blue case', 'BND-BLUE', 14, 5, 6);

  const before = {
    phone: onShelf(ids.phone),
    case: onShelf(ids.case),
    blue: onShelf(ids.blue),
  };

  const sale = await req('POST', '/orders', {
    items: [
      {
        productId: ids.pack,
        quantity: 1,
        // The black case swapped for the blue one, on this sale only.
        components: [
          { productId: ids.phone, quantity: 1 },
          { productId: ids.blue, quantity: 1 },
        ],
      },
    ],
    paymentMethod: 'card',
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  assert.equal(onShelf(ids.phone), before.phone - 1, 'the phone still came off');
  assert.equal(onShelf(ids.blue), before.blue - 1, 'the blue case came off');
  assert.equal(onShelf(ids.case), before.case, 'and the black one was left alone');

  // The line says what went in the bag, so the receipt and the history do too.
  const line = sale.json.items.find((i) => i.product_id === ids.pack);
  assert.ok(line.components, 'the line carries its parts');
  assert.deepEqual(
    line.components.map((c) => c.product_id ?? c.productId).sort(),
    [ids.phone, ids.blue].sort(),
  );

  ids.swappedOrder = sale.json.order.id;
});

test('the margin is worked out from what was really in it', async () => {
  // Phone 142 + blue case 5 = 147, not the catalogue's 142 + 3 = 145.
  const { json } = await req('GET', `/orders/${ids.swappedOrder}`);
  const line = json.items.find((i) => i.product_id === ids.pack);
  assert.equal(line.cost, 147);
});

/*
 * The bug this whole table exists to prevent. Reading the definition on the way
 * back would credit a black case to the shelf, leaving the shop one short of
 * the blue and holding a phantom of the black.
 */
test('refunding it puts back what came out, not what the pack is defined as', async () => {
  const before = {
    phone: onShelf(ids.phone),
    case: onShelf(ids.case),
    blue: onShelf(ids.blue),
  };

  const refund = await req('POST', `/orders/${ids.swappedOrder}/refund`, {});
  assert.equal(refund.status, 200, JSON.stringify(refund.json));

  assert.equal(onShelf(ids.blue), before.blue + 1, 'the blue case came back');
  assert.equal(onShelf(ids.case), before.case, 'the black one was not invented');
  assert.equal(onShelf(ids.phone), before.phone + 1);
});

test('a pack still sells as the catalogue defines it when nobody says otherwise', async () => {
  const before = { phone: onShelf(ids.phone), case: onShelf(ids.case), blue: onShelf(ids.blue) };

  const sale = await req('POST', '/orders', {
    items: [{ productId: ids.pack, quantity: 1 }],
    paymentMethod: 'card',
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  assert.equal(onShelf(ids.case), before.case - 1, 'the defined case came off');
  assert.equal(onShelf(ids.blue), before.blue, 'and nothing else did');
  assert.equal(onShelf(ids.phone), before.phone - 1);
});

test('what the shelves allow is asked of the swapped parts, not the defined ones', async () => {
  // Six blue cases, and the shelf is what limits the pack — the black one has
  // forty on it and is irrelevant to a pack made of blue.
  const tooMany = await req('POST', '/orders', {
    items: [
      {
        productId: ids.pack,
        quantity: 99,
        components: [
          { productId: ids.phone, quantity: 1 },
          { productId: ids.blue, quantity: 1 },
        ],
      },
    ],
    paymentMethod: 'card',
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json.error, /Blue case/, 'the refusal names the part that is short');
});

test('the counter cannot use a swap to get round the rules on a pack', async () => {
  const cases = [
    [{ productId: ids.pack, quantity: 1 }, /cannot contain itself/i],
    [{ productId: ids.phone, quantity: 0 }, /quantity above zero/i],
    [{ productId: 999_999, quantity: 1 }, /no longer exists/i],
  ];

  for (const [component, expected] of cases) {
    const { status, json } = await req('POST', '/orders', {
      items: [{ productId: ids.pack, quantity: 1, components: [component] }],
      paymentMethod: 'card',
    });
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, expected);
  }

  // And a pack emptied out is refused rather than quietly sold as the
  // catalogue's version — taking everything out is a thing somebody meant.
  const emptied = await req('POST', '/orders', {
    items: [{ productId: ids.pack, quantity: 1, components: [] }],
    paymentMethod: 'card',
  });
  assert.equal(emptied.status, 400);
  assert.match(emptied.json.error, /at least one item/i);
});

test('one product named twice is added up, not counted twice against the shelf', async () => {
  const before = onShelf(ids.glass);

  const sale = await req('POST', '/orders', {
    items: [
      {
        productId: ids.pack,
        quantity: 1,
        components: [
          { productId: ids.glass, quantity: 1 },
          { productId: ids.glass, quantity: 2 },
        ],
      },
    ],
    paymentMethod: 'card',
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  // Three, once — not one and then two off a shelf each check thought was full.
  assert.equal(onShelf(ids.glass), before - 3);
  const line = sale.json.items.find((i) => i.product_id === ids.pack);
  assert.equal(line.components.length, 1);
  assert.equal(line.components[0].quantity, 3);
});

/*
 * A definition that moves afterwards must not rewrite what a sale took. The
 * shelves were emptied by the sale that happened, not by the pack as it is
 * described today.
 */
test('changing the definition later does not change what an old sale took', async () => {
  const sale = await req('POST', '/orders', {
    items: [
      {
        productId: ids.pack,
        quantity: 1,
        components: [
          { productId: ids.phone, quantity: 1 },
          { productId: ids.blue, quantity: 1 },
        ],
      },
    ],
    paymentMethod: 'card',
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  // The pack is redefined entirely — no phone, no blue case.
  await req('PUT', `/products/${ids.pack}/bundle`, {
    components: [{ productId: ids.glass, quantity: 5 }],
  });

  const before = { phone: onShelf(ids.phone), blue: onShelf(ids.blue), glass: onShelf(ids.glass) };
  const refund = await req('POST', `/orders/${sale.json.order.id}/refund`, {});
  assert.equal(refund.status, 200, JSON.stringify(refund.json));

  assert.equal(onShelf(ids.phone), before.phone + 1, 'the phone that left came back');
  assert.equal(onShelf(ids.blue), before.blue + 1, 'and the blue case with it');
  assert.equal(onShelf(ids.glass), before.glass, 'the new definition put nothing back');
});
