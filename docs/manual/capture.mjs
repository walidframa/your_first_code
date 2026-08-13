/**
 * Photographs of the app, taken from the app.
 *
 * Every picture in the manual comes from a real running copy driven by a real
 * browser, which is the only way a manual stays true: a hand-drawn mock-up is
 * out of date the first time a button moves, and nobody notices until a
 * customer is looking at a screen that does not match the page in their hand.
 * If a screen in here has changed, this fails or the picture changes with it.
 *
 * Run by build.mjs against a throwaway database. Never point it at a real shop:
 * it signs in, clicks things and would put its fingerprints on somebody's till.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SHOTS } from './shots.mjs';

const BASE = process.env.MANUAL_BASE_URL || 'http://127.0.0.1:4621';
const OUT = process.env.MANUAL_SHOTS || path.join(process.cwd(), 'docs/manual/shots');
const LANGUAGES = (process.env.MANUAL_LANGS || 'en,ar').split(',');

/*
 * A window shaped like the machine these shops actually use.
 *
 * 1280×860 rather than something wide and cinematic: the counter PC in the
 * screenshot that started this manual had a square-ish monitor, and a picture
 * taken on a 21:9 display shows a layout none of the readers will ever see.
 *
 * deviceScaleFactor 2 because these are going into a PDF that may be printed,
 * and a 1× screenshot on paper is a blurry screenshot on paper.
 */
const VIEWPORT = { width: 1280, height: 860 };

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

/*
 * Where the app keeps things, named here rather than guessed.
 *
 * Getting one of these wrong does not fail loudly — it produces a browser that
 * is simply never signed in, and every screenshot after the first times out
 * looking for a page that was never going to load. Which is exactly what
 * happened the first time this ran.
 */
const TOKEN_KEY = 'pos_token';
const USER_KEY = 'pos_user';
const LANG_KEY = 'pos_lang';

/**
 * Sign in, and say plainly when that did not work.
 *
 * The submit button is found by its type, not its words: this runs once per
 * language, and "Sign in" is not what the button says in Arabic.
 */
async function signIn(page, username, password) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.locator('button[type=submit]').first().click();

  try {
    await page.locator('main').first().waitFor({ timeout: 20000 });
  } catch {
    // Still on the form. Whatever it is complaining about is the real error,
    // and it is worth more than "timed out waiting for main".
    const complaint = await page
      .locator('form')
      .first()
      .innerText()
      .catch(() => '');
    throw new Error(
      `could not sign in as ${username}: ${complaint.replace(/\s+/g, ' ').slice(0, 200)}`,
    );
  }
}

/**
 * Quiet the things that would make two builds of the same manual differ.
 *
 * Caret blink and CSS animation both land mid-frame, and a screenshot taken
 * half way through a transition looks like a rendering bug rather than a
 * feature. The clock is fixed for the same reason: a manual whose dashboard
 * says a different date on every build produces a pointless diff each time.
 */
const STEADY = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    caret-color: transparent !important;
  }
`;

const results = [];

for (const language of LANGUAGES) {
  const dir = path.join(OUT, language);
  mkdirSync(dir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    locale: language === 'ar' ? 'ar-LB' : 'en-GB',
    timezoneId: 'Asia/Beirut',
  });

  // The language is a device preference, kept where the app keeps it, so the
  // very first painted frame is already in the right language and reading
  // direction — signing in and switching afterwards photographs the switch.
  await context.addInitScript(
    ({ lang, key }) => {
      try {
        localStorage.setItem(key, lang);
      } catch {
        /* A context with no storage is not worth failing a build over. */
      }
    },
    { lang: language, key: LANG_KEY },
  );

  const page = await context.newPage();
  await page.addStyleTag({ content: STEADY }).catch(() => {});

  for (const shot of SHOTS) {
    const file = path.join(dir, `${shot.id}.png`);
    try {
      if (shot.anon) {
        // The sign-in screen has to be photographed signed out, which means
        // throwing away whatever session the previous shot left behind.
        await context.clearCookies();
        await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
        await page.evaluate(
          ({ token, user }) => {
            try {
              localStorage.removeItem(token);
              localStorage.removeItem(user);
            } catch {
              /* ignore */
            }
          },
          { token: TOKEN_KEY, user: USER_KEY },
        );
        await page.reload({ waitUntil: 'networkidle' });
      } else {
        if (!(await page.locator('main').count())) {
          await signIn(page, 'admin', 'admin123');
        }
        await page.goto(`${BASE}${shot.route}`, { waitUntil: 'networkidle' });
      }

      await page.addStyleTag({ content: STEADY }).catch(() => {});
      if (shot.wait) await page.locator(shot.wait).first().waitFor({ timeout: 15000 });

      for (const step of shot.steps || []) {
        if (step.click) await page.locator(step.click).first().click({ timeout: 10000 });
        if (step.fill) await page.fill(step.fill.selector, step.fill.value);
        await page.waitForTimeout(150);
      }

      // Settled, not merely loaded: a table that renders its rows after the
      // first paint photographs as an empty table.
      await page.waitForTimeout(400);
      await page.screenshot({ path: file, animations: 'disabled' });
      results.push({ id: shot.id, language, file, ok: true });
      console.log(`    ${language}/${shot.id}.png`);
    } catch (err) {
      /*
       * A screen that could not be photographed is reported and skipped, not
       * fatal. A module switched off for this build, or a screen mid-rewrite,
       * should cost the manual one figure — not the whole document, twenty
       * minutes into a build somebody is waiting on.
       */
      results.push({ id: shot.id, language, ok: false, why: err.message.split('\n')[0] });
      console.log(`    ${language}/${shot.id} — skipped: ${err.message.split('\n')[0]}`);
    }
  }

  await context.close();
}

await browser.close();

const missed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - missed.length} pictures taken, ${missed.length} skipped.\n`);

export default results;
