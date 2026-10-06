/**
 * When a new version is announced, and when it is simply taken.
 *
 * A manual reload after a deploy used to produce the banner: the page came
 * back on the new build (navigations go to the network for index.html), and
 * the new worker that the load itself had found sat waiting behind the old
 * one, and the bar said a new version was ready for a page already running
 * it. So an update found by the load is adopted quietly, and the banner is
 * kept for the ones the hourly check finds while the till is in use.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeWorker() {
  return { messages: [], postMessage(m) { this.messages.push(m); } };
}

function fakeRegistration() {
  const handlers = {};
  return {
    waiting: null,
    installing: null,
    addEventListener(type, fn) { handlers[type] = fn; },
    update: async () => {},
    /** A new worker arrives and finishes installing. */
    arrive(worker) {
      this.installing = { state: 'installing', addEventListener(_, fn) { this.onState = fn; } };
      handlers.updatefound();
      this.installing.state = 'installed';
      this.waiting = worker;
      this.installing.onState();
    },
  };
}

async function setup({ controller = {} } = {}) {
  const swHandlers = {};
  const nav = {
    serviceWorker: {
      controller,
      addEventListener(type, fn) { swHandlers[type] = fn; },
    },
  };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  let reloads = 0;
  Object.defineProperty(globalThis, 'location', {
    value: { reload: () => { reloads += 1; } },
    configurable: true,
    writable: true,
  });
  let clock = 1_000_000;
  const mod = await import(`../src/lib/appUpdate.js?${Math.random()}`);
  const registration = fakeRegistration();
  const announced = [];
  mod.onUpdateReady((ready) => announced.push(ready));
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return 0; };
  try {
    await mod.startUpdateWatch({ now: () => clock, register: async () => registration });
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  return {
    registration,
    announced,
    tick: (ms) => { clock += ms; },
    controllerChange: () => swHandlers.controllerchange(),
    reloads: () => reloads,
    mod,
  };
}

test('a worker found by the page load takes over quietly', async () => {
  const s = await setup();
  const worker = fakeWorker();
  s.tick(2_000);
  s.registration.arrive(worker);
  assert.deepEqual(worker.messages, [{ type: 'skip-waiting' }]);
  assert.deepEqual(s.announced, [false], 'the banner was shown for a version the page already runs');
  s.controllerChange();
  assert.equal(s.reloads(), 0, 'a page that is already current was reloaded');
});

test('a worker already waiting when the page starts is taken the same way', async () => {
  const s0 = { registration: fakeRegistration() };
  const worker = fakeWorker();
  s0.registration.waiting = worker;
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { controller: {}, addEventListener() {} } },
    configurable: true,
    writable: true,
  });
  const mod = await import(`../src/lib/appUpdate.js?${Math.random()}`);
  const announced = [];
  mod.onUpdateReady((ready) => announced.push(ready));
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try {
    await mod.startUpdateWatch({ now: () => 5, register: async () => s0.registration });
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  assert.deepEqual(worker.messages, [{ type: 'skip-waiting' }]);
  assert.deepEqual(announced, [false]);
});

test('a worker found later, while the till is in use, is offered as a banner', async () => {
  const s = await setup();
  const worker = fakeWorker();
  s.tick(60 * 60 * 1000);
  s.registration.arrive(worker);
  assert.deepEqual(worker.messages, [], 'the page was swapped out from under a till in use');
  assert.deepEqual(s.announced, [false, true]);
  // Pressing Reload: the worker is asked to take over, and the page reloads
  // once the controller actually changes, not before.
  s.mod.applyUpdate();
  assert.deepEqual(worker.messages, [{ type: 'skip-waiting' }]);
  assert.equal(s.reloads(), 0);
  s.controllerChange();
  assert.equal(s.reloads(), 1);
  s.controllerChange();
  assert.equal(s.reloads(), 1, 'reloaded twice');
});

test('without a controller the first worker simply takes over, banner or not', async () => {
  const s = await setup({ controller: null });
  const worker = fakeWorker();
  s.tick(60 * 60 * 1000);
  s.registration.arrive(worker);
  assert.deepEqual(worker.messages, [{ type: 'skip-waiting' }]);
  assert.deepEqual(s.announced, [false]);
});
