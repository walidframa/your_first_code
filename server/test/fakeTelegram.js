/**
 * A stand-in Telegram.
 *
 * A real HTTP server rather than a stubbed fetch, because the thing worth
 * testing is what happens across a network — a bot that answers slowly, a chat
 * id that does not exist, a host that is not there at all. None of those are
 * exercised by replacing `fetch` with a function that returns a fixed object.
 */
import http from 'node:http';

export function createFakeTelegram() {
  const state = {
    /** Every sendMessage that arrived, in order. */
    messages: [],
    /** Set to make the next call fail the way Telegram fails. */
    failNext: 0,
    failWith: { status: 400, description: 'chat not found' },
    /** Milliseconds to sit on a request before answering. */
    delayMs: 0,
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const answer = () => {
        // /bot<token>/sendMessage — the token is part of the path, so a test
        // can check it was sent without the app ever logging it.
        const match = req.url.match(/^\/bot([^/]+)\/(\w+)/);
        const token = match?.[1] ?? null;
        const method = match?.[2] ?? null;

        if (state.failNext > 0) {
          state.failNext -= 1;
          res.writeHead(state.failWith.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, description: state.failWith.description }));
          return;
        }

        let payload = null;
        try { payload = JSON.parse(body); } catch { payload = null; }
        state.messages.push({ token, method, ...payload });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: state.messages.length } }));
      };

      if (state.delayMs > 0) setTimeout(answer, state.delayMs);
      else answer();
    });
  });

  return {
    state,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
    /** Wait for the next message to land — sends are deliberately not awaited. */
    async waitForMessage(count = 1, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (state.messages.length >= count) return state.messages;
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    },
  };
}
