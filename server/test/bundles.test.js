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
