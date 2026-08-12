import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api';
import { flush, waiting } from '../lib/sales';

const OfflineContext = createContext(null);

/**
 * Whether the server is there, and what is waiting to reach it.
 *
 * `navigator.onLine` is not the question. It answers "is this device on a
 * network", and a tablet sitting happily on the shop's wifi with the machine
 * behind the counter switched off is online by that measure and useless by
 * every other. So the question asked here is the only one that matters: does
 * the server answer.
 *
 * Asked on a timer while it is away — every few seconds, because somebody is
 * standing at the counter waiting to know — and rarely while it is there.
 */
export function OfflineProvider({ children }) {
  const [reachable, setReachable] = useState(true);
  const [queued, setQueued] = useState([]);
  const [sending, setSending] = useState(false);

  const refreshQueue = useCallback(async () => {
    try {
      setQueued(await waiting());
    } catch {
      // A browser with IndexedDB blocked cannot queue, which is a shop that
      // simply has no offline mode — not a reason to break the till.
      setQueued([]);
    }
  }, []);

  const check = useCallback(async () => {
    try {
      await api.get('/health', { timeout: 4000 });
      setReachable(true);
      return true;
    } catch {
      setReachable(false);
      return false;
    }
  }, []);

  /*
   * Send what is waiting, and say what happened. Called when the server comes
   * back, and offered on the banner for somebody who would rather not wait for
   * the next check.
   */
  const send = useCallback(async () => {
    setSending(true);
    try {
      const result = await flush();
      await refreshQueue();
      return result;
    } finally {
      setSending(false);
    }
  }, [refreshQueue]);

  useEffect(() => {
    refreshQueue();
  }, [refreshQueue]);

  /*
   * The real answer comes from real traffic, not from the heartbeat.
   *
   * Every request the app makes is already asking the question this cares
   * about, and asking it at the moment somebody is waiting for it. A poll on
   * its own means the counter can be up to half a minute into an outage before
   * the screen admits it — which is exactly the half minute a cashier spends
   * deciding the till is broken.
   */
  useEffect(() => {
    const id = api.interceptors.response.use(
      (response) => {
        setReachable(true);
        return response;
      },
      (error) => {
        // No response at all is the network; a 400 is the server, and a server
        // with an opinion is a server that is there.
        if (!error.response) setReachable(false);
        else setReachable(true);
        return Promise.reject(error);
      },
    );
    return () => api.interceptors.response.eject(id);
  }, []);

  useEffect(() => {
    let live = true;
    let timer;

    const tick = async () => {
      const up = await check();
      if (!live) return;
      if (up) {
        const pending = await waiting();
        if (pending.some((s) => !s.refused)) await send();
        else await refreshQueue();
      }
      /*
       * Impatient while it is away, and still fairly attentive while it is
       * there. Real traffic is what usually reveals an outage — see the
       * interceptor above — but a till left idle between customers has no
       * traffic to reveal it with, and finding out at the moment of the next
       * sale is finding out too late to say so calmly.
       */
      timer = setTimeout(tick, up ? 10_000 : 3_000);
    };

    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [check, send, refreshQueue]);

  const value = useMemo(() => {
    const pending = queued.filter((s) => !s.refused);
    const refused = queued.filter((s) => s.refused);
    return {
      reachable,
      sending,
      pending,
      refused,
      waitingCount: pending.length,
      check,
      send,
      refreshQueue,
    };
  }, [reachable, sending, queued, check, send, refreshQueue]);

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline() {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error('useOffline must be used within OfflineProvider');
  return ctx;
}
