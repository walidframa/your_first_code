/**
 * Regenerate the phone app's icons and splash screens from one drawing.
 *
 * A wrapper around `capacitor-assets` rather than a call to it, for one
 * reason: that tool also rewrites `public/manifest.webmanifest`, and what it
 * writes there is wrong for this app. It points the web manifest at
 * `../icons/*.webp` — a relative path that resolves outside the site root, on
 * files it puts in a directory this app does not serve — and labels the webp
 * files `image/png`. The result is a PWA whose icons all 404, replacing one
 * that worked.
 *
 * The web app's own icons are hand-kept in `public/` and are not this tool's
 * business. So the manifest is put back exactly as it was afterwards, and the
 * icons the tool scattered are cleared away.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const client = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(client, 'public', 'manifest.webmanifest');
const backup = join(client, 'public', 'manifest.webmanifest.bak');

if (!existsSync(join(client, 'resources', 'icon.png'))) {
  console.error(
    'resources/icon.png is missing. Render it from resources/icon.svg first — see docs/mobile.md.',
  );
  process.exit(1);
}

copyFileSync(manifest, backup);
try {
  execFileSync(
    'npx',
    [
      'capacitor-assets',
      'generate',
      '--iconBackgroundColor', '#047857',
      '--iconBackgroundColorDark', '#047857',
      '--splashBackgroundColor', '#0f172a',
      '--splashBackgroundColorDark', '#0f172a',
    ],
    { cwd: client, stdio: 'inherit' },
  );
} finally {
  // Whatever happened, the web app's manifest is not collateral.
  copyFileSync(backup, manifest);
  rmSync(backup, { force: true });
  rmSync(join(client, 'icons'), { recursive: true, force: true });
}

console.log('\nIcons and splash screens rebuilt for android and ios.');
console.log('The web manifest and public/ icons were left alone, on purpose.');
