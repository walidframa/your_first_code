/**
 * Telling the owner what happened, without ever getting in the way.
 *
 * Two claims are worth holding here and the second matters more than the first.
 *
 * One: the right message goes out on the right event, and only when the shop
 * asked for it.
 *
 * Two — **the sale wins.** A notification is a courtesy and the sale is the
 * shop's money, so a Telegram that is refusing, hanging, or simply not there
 * must not slow a sale down, must not fail one, and must not leave a cashier
 * looking at a spinner with a customer waiting. That is the property that makes
 * this feature safe to have at a counter at all, and it is tested against a
 * real server that really does refuse and really does hang.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeTelegram } from './fakeTelegram.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4645;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let telegram;
let telegramUrl;

async function req(method, route, body, bearer = token) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
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

// Shaped like a real one, because the settings route checks the shape.
const BOT_TOKEN = '123456789:AAHtesttokenforthesuite-000000000';

async function configure(extra = {}) {
  const saved = await req('PUT', '/settings', {
    telegram_enabled: 'true',
    telegram_bot_token: BOT_TOKEN,
    telegram_chat_id: '-100999',
    telegram_base_url: telegramUrl,
    telegram_events: '',
    // Reset too, or a template left by an earlier test renders this one's
    // message and the failure points at the wrong thing entirely.
    telegram_templates: '',
    ...extra,
  });
  // Asserted, or a rejected setting looks exactly like a message that did not
  // send — which is the whole failure mode this feature has.
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  return saved;
}

before(async () => {
  telegram = createFakeTelegram();
  telegramUrl = await telegram.listen();

  workDir = mkdtempSync(path.join(tmpdir(), 'pos-telegram-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'tg.sqlite'),
    JWT_SECRET: 'telegram-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  await req('POST', '/cash/open', { openingUsd: 100 });
});

after(async () => {
  child?.kill();
  await telegram?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  /*
   * Let anything still in the air from the last test land before clearing.
   * Sends are deliberately not awaited by the routes that trigger them — which
   * is the point of the feature — so a message can arrive a moment after the
   * request that caused it has already answered.
   */
  await new Promise((r) => setTimeout(r, 350));
  telegram.state.messages.length = 0;
  telegram.state.failNext = 0;
  telegram.state.delayMs = 0;
});

/** One sale, on the seeded catalogue. */
async function sell(amount = 3.5) {
  return req('POST', '/orders', {
    items: [{ productId: 1, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount }],
  });
}

/* ------------------------------------------------------- the message goes */

test('a sale reaches the owner, with the figure first', async () => {
  await configure();

  const sale = await sell();
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const messages = await telegram.waitForMessage();
  assert.ok(messages, 'no message arrived');
  assert.equal(messages.length, 1);

  const sent = messages[0];
  assert.equal(sent.chat_id, '-100999');
  assert.equal(sent.token, BOT_TOKEN, 'the bot token goes in the path, as Telegram wants it');
  assert.match(sent.text, /^🧾 <b>\$3\.50<\/b> — sale \(cash\)/, 'the money is the first thing read');
  assert.match(sent.text, new RegExp(sale.json.order.order_number));
  assert.match(sent.text, /Store Owner/, 'and who rang it up');
});

test('a void says so, and names the sale', async () => {
  await configure();
  const sale = await sell();
  // Wait for the sale's own message first, or clearing the log races it.
  await telegram.waitForMessage();
  telegram.state.messages.length = 0;

  const voided = await req('POST', `/orders/${sale.json.order.id}/refund`, { reason: 'wrong item' });
  assert.equal(voided.status, 200, JSON.stringify(voided.json));

  const messages = await telegram.waitForMessage();
  assert.ok(messages, 'no message arrived');
  assert.match(messages[0].text, /sale voided/);
  assert.match(messages[0].text, new RegExp(sale.json.order.order_number));
  assert.match(messages[0].text, /wrong item/);
});

test('the shop chooses which events it hears about', async () => {
  // Voids only — the shop that wants to know when money goes back out and
  // does not want a buzz for every bar of chocolate.
  await configure({ telegram_events: 'refund' });

  const sale = await sell();
  assert.equal(await telegram.waitForMessage(1, 700), null, 'the sale should have been quiet');

  await req('POST', `/orders/${sale.json.order.id}/refund`, {});
  const messages = await telegram.waitForMessage();
  assert.ok(messages, 'the void should still arrive');
  assert.match(messages[0].text, /voided/);
});

test('switched off means silent', async () => {
  await configure({ telegram_enabled: 'false' });
  await sell();
  assert.equal(await telegram.waitForMessage(1, 700), null);
});

/* ------------------------------------------------------------ the sale wins */

test('a sale goes through when Telegram refuses it', async () => {
  await configure();
  telegram.state.failNext = 1;

  const sale = await sell();
  assert.equal(sale.status, 201, 'the sale must not fail because a message did');
  assert.ok(sale.json.order.order_number);

  // And the failure is written down rather than swallowed, so the settings
  // screen can say so instead of the shop noticing silence.
  await new Promise((r) => setTimeout(r, 400));
  const status = await req('GET', '/settings/telegram/status');
  assert.ok(status.json.failures >= 1, 'the failure is counted');
  assert.match(status.json.lastError, /chat not found/, 'and Telegram’s own words are kept');
});

test('a sale is not held up by a Telegram that hangs', async () => {
  await configure();
  // Longer than any counter would tolerate, and longer than the send's own
  // timeout — so if the sale waited on it at all, this test would notice.
  telegram.state.delayMs = 4000;

  const started = Date.now();
  const sale = await sell();
  const took = Date.now() - started;

  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  assert.ok(took < 1500, `the sale took ${took}ms — a notification is holding the counter up`);
});

test('a sale goes through when Telegram is not there at all', async () => {
  // A port with nothing on it: the shape of a dead network, a wrong URL, or a
  // Telegram that is down.
  await configure({ telegram_base_url: 'http://127.0.0.1:9' });

  const started = Date.now();
  const sale = await sell();
  assert.equal(sale.status, 201);
  assert.ok(Date.now() - started < 1500, 'and it did not wait for the connection to fail');
});

/* ------------------------------------------------------------- the secret */

test('the bot token never comes back to the browser', async () => {
  await configure();
  const settings = await req('GET', '/settings');
  const body = JSON.stringify(settings.json);
  assert.ok(!body.includes(BOT_TOKEN), 'the token must never be sent to a browser');
  // Redacted to a boolean the way the Shopify token is, so the screen can still
  // say whether one is set.
  assert.notEqual(settings.json.settings.telegram_bot_token, BOT_TOKEN);
});

test('the test button says plainly whether it worked', async () => {
  await configure();

  const good = await req('POST', '/settings/telegram/test');
  assert.equal(good.status, 200, JSON.stringify(good.json));
  const messages = await telegram.waitForMessage();
  assert.match(messages[0].text, /connected/i);

  telegram.state.failNext = 1;
  const bad = await req('POST', '/settings/telegram/test');
  assert.equal(bad.status, 400, 'a failed test must not report success');
  assert.match(bad.json.error, /chat not found/, 'and says what Telegram actually said');
});

test('a message that gets through clears the tally', async () => {
  await configure();
  telegram.state.failNext = 1;
  await sell();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok((await req('GET', '/settings/telegram/status')).json.failures >= 1);

  await req('POST', '/settings/telegram/test');
  assert.equal((await req('GET', '/settings/telegram/status')).json.failures, 0);
});

/* --------------------------------------------------------- the wording */

test('a shop can rewrite what a message says', async () => {
  await configure({
    telegram_templates: JSON.stringify({
      sale: 'بيع {total} — {reference} · {user}',
    }),
  });

  await sell();
  /*
   * The message this test is about, rather than whichever arrived first.
   *
   * Notifications are sent and not awaited, so one raised by the test before
   * this can land after `beforeEach` has cleared the queue — and `messages[0]`
   * is then somebody else's sale. It fails in CI, once in a while, pointing at
   * a line that is perfectly correct. Same reason as `waitForMatch` further
   * down; see fakeTelegram.js.
   */
  const message = await telegram.waitForMatch(/بيع/);
  assert.ok(message, 'no message arrived');
  assert.match(message.text, /^بيع \$3\.50 — ORD-/, 'the shop’s own wording, in its own language');
  assert.ok(!message.text.includes('🧾'), 'and none of the built-in wording is left');
});

test('rewriting one event leaves the other six alone', async () => {
  await configure({ telegram_templates: JSON.stringify({ sale: 'SOLD {total}' }) });

  const sale = await sell();
  const sold = await telegram.waitForMatch(/^SOLD /);
  assert.ok(sold, 'no sale message arrived');
  assert.match(sold.text, /^SOLD \$3\.50$/);

  telegram.state.messages.length = 0;
  await req('POST', `/orders/${sale.json.order.id}/refund`, {});
  const voided = await telegram.waitForMatch(/sale voided/);
  assert.ok(voided, 'the void keeps the built-in wording');
});

test('a placeholder nobody recognises is left standing, not swallowed', async () => {
  /*
   * A typo has to be visible. Rendering `{totl}` as nothing would look like the
   * app losing the figure, and the shop would go hunting in the wrong place.
   */
  await configure({ telegram_templates: JSON.stringify({ sale: 'Sold for {totl}' }) });
  await sell();
  /*
   * Matched on the half of the wording that is not in question. If the
   * placeholder were swallowed the text would read "Sold for " and this would
   * still find it, which is what makes the assertion below worth making.
   */
  const message = await telegram.waitForMatch(/Sold for/);
  assert.ok(message, 'no message arrived');
  assert.equal(message.text, 'Sold for {totl}');
});

test('a customer’s name cannot smuggle markup into the message', async () => {
  /*
   * The template is the shop's own and may carry HTML — Telegram renders it.
   * The *values* are not, and a customer called `<b>` must not be able to
   * write the formatting, or worse, produce markup Telegram rejects and drops
   * the whole message over.
   */
  await configure();
  const customer = (await req('POST', '/customers', { name: 'Ahmad <b>Phones</b>' })).json.party;

  await req('POST', '/orders', {
    items: [{ productId: 1, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 4 }],
    customerId: customer.id,
  });

  /* Waited for by name rather than read off the front of the queue: the
     previous test's notification is fire-and-forget and can land after the
     queue was emptied, which is what broke this on CI and not here. */
  const message = await telegram.waitForMatch(/Ahmad/);
  assert.ok(message, 'no message carried the customer at all');
  assert.match(message.text, /Ahmad &lt;b&gt;Phones&lt;\/b&gt;/, 'escaped, so it reads as the name it is');
});

test('the preview is the same wording the message will use', async () => {
  await configure({ telegram_templates: JSON.stringify({ sale: 'X {total} Y {user}' }) });

  const shown = await req('POST', '/settings/telegram/preview', { event: 'sale' });
  assert.equal(shown.status, 200, JSON.stringify(shown.json));
  assert.match(shown.json.text, /^X \$27\.50 Y Store Owner$/);

  // An unsaved draft can be previewed too, which is the point of the box.
  const draft = await req('POST', '/settings/telegram/preview', {
    event: 'sale',
    template: 'draft {reference}',
  });
  assert.equal(draft.json.text, 'draft ORD-2416');
});

test('a template that could not be read is refused rather than stored', async () => {
  const bad = await req('PUT', '/settings', { telegram_templates: 'not json at all' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /could not be read/);

  const unknown = await req('PUT', '/settings', {
    telegram_templates: JSON.stringify({ nonsense: 'hello' }),
  });
  assert.equal(unknown.status, 400, 'an event name that does not exist is almost always a typo');
  assert.match(unknown.json.error, /nonsense/);
});
