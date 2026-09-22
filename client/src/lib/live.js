import { useEffect, useRef } from 'react';
import { apiBase } from './server.js';

/**
 * Hearing about changes made on other screens.
 *
 * The server keeps one connection open per screen and says, after every
 * request that changed something, which part of the shop moved (see the
 * server's lib/live.js). A screen that shows that part asks for its data
 * again. So a sale rung up on one PC takes the phone off the shelf on the
 * other PC's register, and a repair moved on the bench moves on the owner's
 * board in the back office, without anybody pressing F5.
 *
 * This screen's own changes are left alone: it already holds the new state,
 * and reloading under somebody's hands is how a half-typed form gets lost.
 * The id that says "this screen" is per tab, so two tabs on one PC do hear
 * each other.
 */
export const CLIENT_ID = (() => {
  try {
    let id = sessionStorage.getItem('pos_screen');
    if (!id) {
      id = globalThis.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      sessionStorage.setItem('pos_screen', id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2);
  }
})();

const listeners = new Set();
let token = null;
let source = null;
let sourceToken = null;
let retry = null;

function disconnect() {
  if (source) {
    source.close();
    source = null;
  }
  sourceToken = null;
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
}

function connect() {
  if (typeof EventSource === 'undefined') return;
  if (!token || listeners.size === 0) return;
  if (source && sourceToken === token) return;
  disconnect();
  sourceToken = token;
  source = new EventSource(`${apiBase()}/live?token=${encodeURIComponent(token)}`);
  source.onmessage = (e) => {
    let event;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }
    for (const listener of listeners) listener(event);
  };
  /*
   * Dropped — the server restarted, the wifi blinked, or the login ran out.
   * Try again in a moment rather than letting the browser hammer a 401.
   */
  source.onerror = () => {
    disconnect();
    retry = setTimeout(connect, 5000);
  };
}

/** Called by the API client whenever the login token changes. */
export function setLiveToken(next) {
  token = next || null;
  if (!token) disconnect();
  else connect();
}

/**
 * Run `onChange` when another screen changes something — every change, or
 * only the `topics` named (the first segment of the API path: 'orders',
 * 'products', 'repairs', …). Bounced a little so a burst of requests from
 * one action reloads once.
 */
export function useLive(onChange, topics = null) {
  const latest = useRef(onChange);
  latest.current = onChange;
  const key = Array.isArray(topics) ? topics.join(',') : '';

  useEffect(() => {
    const wanted = key ? key.split(',') : null;
    let timer = null;
    const listener = (event) => {
      if (event.origin && event.origin === CLIENT_ID) return;
      if (wanted && !wanted.includes(event.topic)) return;
      clearTimeout(timer);
      timer = setTimeout(() => latest.current?.(event), 400);
    };
    listeners.add(listener);
    connect();
    return () => {
      listeners.delete(listener);
      clearTimeout(timer);
      if (listeners.size === 0) disconnect();
    };
  }, [key]);
}
