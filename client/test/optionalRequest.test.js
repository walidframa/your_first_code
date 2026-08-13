/**
 * A feature the shop never bought must not take down the till.
 *
 * The register loaded five things in one `Promise.all`. `/wallets` is behind
 * the `cards` module, so a shop without recharge cards got a 403 there — and
 * because the five were one promise, the rejection landed before the first
 * `setState`. No products were ever put on the screen. The grid sat on its
 * loading skeletons for ever, with no error and nothing to press, on a shop
 * whose own stock was sitting in its own database.
 *
 * The helper under test is what separates "the till cannot open without this"
 * from "this is nice to have".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * The helper as `Checkout.jsx` defines it. Copied rather than imported because
 * that file is a React component pulling in a hundred things a plain node test
 * has no business loading — and the logic worth pinning is these two lines.
 */
const optional = (request, fallback) => request.then((res) => res.data).catch(() => fallback);

test('a request that works gives back its data', async () => {
  const got = await optional(Promise.resolve({ data: { wallets: [{ id: 1 }] } }), { wallets: [] });
  assert.deepEqual(got, { wallets: [{ id: 1 }] });
});

test('a 403 for a module the shop has not bought gives back the fallback', async () => {
  // Exactly what the live shop saw: modules were
  // ["repairs","transfers","vouchers","installments","documents","imports","labels"]
  // — no "cards" — so /wallets answered 403.
  const refused = Object.assign(new Error('Request failed with status code 403'), {
    response: { status: 403, data: { error: 'Recharge cards is not part of your plan' } },
  });
  const got = await optional(Promise.reject(refused), { wallets: [] });
  assert.deepEqual(got, { wallets: [] });
});

test('and any other failure does too, rather than escaping', async () => {
  // A server restarting mid-load, a dropped connection at the counter. None of
  // those should cost the shop the ability to sell.
  for (const failure of [new Error('Network Error'), new TypeError('fetch failed')]) {
    assert.deepEqual(await optional(Promise.reject(failure), { count: 0 }), { count: 0 });
  }
});

test('the optional half never rejects, however many of them fail', async () => {
  // The register awaits these together. One rejection escaping the group would
  // put us straight back where we started.
  const settled = await Promise.all([
    optional(Promise.reject(new Error('403')), { wallets: [] }),
    optional(Promise.reject(new Error('500')), { count: 0 }),
  ]);
  assert.deepEqual(settled, [{ wallets: [] }, { count: 0 }]);
});
