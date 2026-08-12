/**
 * Sales made while the server could not be reached.
 *
 * A till on a tablet talks to a machine behind the counter. That machine gets
 * switched off, or reboots, or the power goes — and until now the answer at the
 * counter was "wait", with a customer standing there holding a phone.
 *
 * So a sale that cannot be sent is kept here and sent when the server comes
 * back. Two things make that safe rather than merely optimistic:
 *
 * **Every sale is named before it is sent.** The dangerous failure is not the
 * send that fails; it is the one that succeeds and looks like it failed — the
 * answer lost on the way back, the till trying again, the shop having sold the
 * same phone twice. The server treats that name as unique and hands back the
 * sale it already has.
 *
 * **A refused sale is not thrown away.** The server may say no on the way in —
 * a customer over their limit, a drawer that was closed. That sale happened at
 * the counter with real money, so it is kept and shown rather than dropped for
 * being inconvenient.
 *
 * IndexedDB rather than localStorage because this is the shop's money waiting
 * to be written down, and localStorage is synchronous, five megabytes, and
 * cleared by things that mean to clear caches.
 */
const DB_NAME = 'pos-outbox';
const STORE = 'sales';

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'ref' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result?.result ?? result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** A name for a sale, unique enough that two tills cannot collide. */
export function newRef() {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

/** Put a sale by, with everything needed to send it later and to print it now. */
export async function keep(sale) {
  await withStore('readwrite', (store) => store.put(sale));
  return sale;
}

export async function waiting() {
  const all = await withStore('readonly', (store) => store.getAll());
  return (all || []).sort((a, b) => a.madeAt.localeCompare(b.madeAt));
}

export async function forget(ref) {
  await withStore('readwrite', (store) => store.delete(ref));
}

/** Mark one the server refused, with what it said, and keep it. */
export async function markRefused(ref, reason) {
  const sale = await withStore('readonly', (store) => store.get(ref));
  if (!sale) return null;
  const updated = { ...sale, refused: reason, refusedAt: new Date().toISOString() };
  await withStore('readwrite', (store) => store.put(updated));
  return updated;
}
