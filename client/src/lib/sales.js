import api from '../api';
import { forget, keep, markRefused, newRef, waiting } from './outbox';

/**
 * Sending a sale, whether or not the server is there.
 *
 * One place decides between "it went" and "it is waiting", so no screen has to
 * think about it. What the counter needs is the same either way: the sale is
 * recorded, the receipt prints, the next customer is served.
 */

/** Whether a failure was the network rather than the server's opinion. */
function unreachable(err) {
  /*
   * No response at all. A 400 is the server saying no, which is an answer and
   * must not be retried; a dropped connection is not an answer.
   *
   * A 502 or 504 is a proxy saying it could not reach the server, which for
   * this purpose is the same as silence.
   */
  if (!err.response) return true;
  return [502, 503, 504].includes(err.response.status);
}

/**
 * Ring up a sale.
 *
 * Returns `{ order, items, waiting }` — `waiting` true when it is in the outbox
 * rather than in the books. The order handed back then is the till's own
 * reckoning of it, which is enough to print a receipt and hand over change;
 * it gets its real number when the server takes it.
 */
export async function ringUp(payload) {
  const ref = newRef();
  const body = { ...payload, clientRef: ref };

  try {
    const res = await api.post('/orders', body);
    return { ...res.data, waiting: false };
  } catch (err) {
    if (!unreachable(err)) throw err;

    const sale = {
      ref,
      body,
      madeAt: new Date().toISOString(),
      // What the till believes it just sold, for the receipt and the list.
      total: payload.localTotal ?? null,
      lines: payload.localLines ?? [],
    };
    await keep(sale);

    return {
      order: {
        id: null,
        order_number: 'Waiting to be sent',
        total: sale.total,
        payment_method: payload.paymentMethod,
        created_at: sale.madeAt,
        client_ref: ref,
      },
      items: sale.lines,
      waiting: true,
    };
  }
}

/**
 * Send whatever is waiting, oldest first.
 *
 * Stops at the first one that cannot be sent: if the server is still away,
 * there is no point marching through the rest, and keeping them in order keeps
 * the drawer's story in order too.
 *
 * A sale the server refuses is kept and flagged rather than dropped — it
 * happened at the counter with real money in it, and somebody has to decide
 * what to do about it.
 */
export async function flush() {
  const queued = (await waiting()).filter((s) => !s.refused);
  let sent = 0;
  let refused = 0;

  for (const sale of queued) {
    try {
      await api.post('/orders', sale.body);
      await forget(sale.ref);
      sent += 1;
    } catch (err) {
      if (unreachable(err)) break;
      await markRefused(sale.ref, err.response?.data?.error || 'The server would not take it');
      refused += 1;
    }
  }

  return { sent, refused };
}

export { waiting, forget };
