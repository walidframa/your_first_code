#!/usr/bin/env node
/**
 * The vendor's console, as a service.
 *
 *   sudo cp deploy/pos-console.service /etc/systemd/system/
 *   sudo systemctl enable --now pos-console
 *
 * Its settings come from /etc/pos-console.env — a separate file from the shops'
 * one, holding a signing key of its own. Sharing a key with the tills would
 * mean a token minted at a till being accepted here, which is the one thing
 * this whole arrangement exists to prevent.
 */
import { createConsoleApp } from './app.js';

const controlDb = process.env.CONTROL_DB || '/var/lib/pos/control.sqlite';
const port = Number(process.env.CONSOLE_PORT || 4090);
const domain = process.env.POS_DOMAIN || 'xtechpos.com';
const secret = process.env.CONSOLE_SECRET;

/*
 * No fallback, not even in development.
 *
 * Everywhere else in this app a missing key is allowed to fall back to a random
 * one for convenience. Not here: this login can stop every shop on the machine,
 * and a console that quietly ran with a guessable key would be the single worst
 * failure available.
 */
if (!secret || secret.length < 32) {
  console.error(
    'CONSOLE_SECRET is missing or too short (32+ characters).\n' +
      'Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
  );
  process.exit(1);
}

createConsoleApp({ controlDb, secret, domain }).listen(port, '127.0.0.1', () => {
  console.log(`Console listening on http://127.0.0.1:${port}`);
  console.log(`Reading the book of shops at ${controlDb}`);
});
