// One-time auth setup for Playwright UI tests.
// Run once:  node tests/auth-setup.mjs
//
// Opens a visible Chromium with a persistent profile under
// tests/.pw-user-data/. You log in with your Google account once;
// session cookies are saved. After that, tests/access-flow.spec.mjs
// can run automated against the same profile without prompting.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, '.pw-user-data');
const SITE_URL = process.env.SITE_URL || 'https://app.ms-cert.workers.dev/';

console.log('[auth-setup] user data dir:', USER_DATA_DIR);
console.log('[auth-setup] site:', SITE_URL);
console.log('[auth-setup] opening browser… sign in with Google.');
console.log('[auth-setup] Script will auto-close once it detects you are signed in (tier badge visible).');
console.log('[auth-setup] Timeout: 5 min.');

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  channel: 'chrome',
  viewport: { width: 1400, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});

const page = context.pages()[0] || await context.newPage();
await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });

// Actively poll for the tier badge — this is the only reliable signal
// that Firebase Auth restored a current user AND our backend callable
// succeeded. Reading-from-window-handle proof beats user clicking Enter.
try {
  console.log('[auth-setup] waiting for #tierBadgeBtn to become visible…');
  await page.waitForSelector('#tierBadgeBtn:not(.hidden)', { timeout: 5 * 60 * 1000 });
  const txt = (await page.locator('#tierBadgeBtn .tier-badge-text').textContent()).trim();
  console.log('[auth-setup] ✓ Tier badge visible:', txt);

  // Give Chrome a moment to flush IndexedDB writes to disk before
  // closing. Firebase Auth's token persistence is async — closing
  // too fast = next run sees no auth.
  console.log('[auth-setup] flushing storage to disk (3s)…');
  await page.waitForTimeout(3000);

  console.log('[auth-setup] ✓ Done. Closing browser. Auth state saved to', USER_DATA_DIR);
} catch (e) {
  console.error('[auth-setup] ✗ Timed out waiting for sign-in:', e.message);
  console.error('[auth-setup] Browser state was NOT verified. Tests may still fail.');
}

await context.close();
process.exit(0);
