// Automated UI tests for ACCESS-PLAN Phase 1A.
// Runs against the live site reusing the persistent profile created
// by tests/auth-setup.mjs.
//
// Usage:  node tests/access-flow.spec.mjs
// Optional env:
//   HEADLESS=1 - run headless (default: headed for easier debugging)
//   SITE_URL=https://app.ms-cert.workers.dev/  - target site

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, '.pw-user-data');
const SITE_URL = process.env.SITE_URL || 'https://app.ms-cert.workers.dev/';
const HEADLESS = process.env.HEADLESS === '1';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

import { mkdir } from 'node:fs/promises';
await mkdir(SCREENSHOTS_DIR, { recursive: true });

const results = [];
function record(name, ok, info) {
  results.push({ name, ok, info });
  console.log((ok ? '✓ PASS  ' : '✗ FAIL  ') + name + (info ? ' — ' + info : ''));
}

// Use real Chrome + strip automation flag so Google OAuth + our app
// don't fingerprint the browser as automation-only. Must match the
// flags used in auth-setup.mjs.
const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: HEADLESS,
  channel: 'chrome',
  viewport: { width: 1400, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const page = context.pages()[0] || await context.newPage();

// Capture only UNEXPECTED issues: page errors, 5xx server errors, and
// non-business console errors. 4xx on our own callables is by-design
// (e.g. invalid_promo returns 404 not-found) and shouldn't trip the test.
const consoleErrors = [];
const GENERIC_404_MSG = /^Failed to load resource: the server responded with a status of 4\d\d/;
page.on('console', m => {
  if (m.type() !== 'error') return;
  // Generic browser 4xx noise — the more specific entry below (or business
  // error on screen) is the canonical signal.
  if (GENERIC_404_MSG.test(m.text())) return;
  consoleErrors.push('console: ' + m.text());
});
page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
page.on('requestfailed', req => {
  consoleErrors.push('requestfailed: ' + req.url() + ' (' + (req.failure() && req.failure().errorText) + ')');
});
page.on('response', resp => {
  const s = resp.status();
  // Only flag 5xx (server crash). 4xx are expected for negative tests.
  if (s >= 500) consoleErrors.push('http ' + s + ': ' + resp.url());
});

try {
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });

  // ── Test 1: tier badge is visible and reflects access ────────────
  try {
    // Firebase Auth needs time to restore from IndexedDB on cold load.
    // Then loadAccess() callable → cache → renderTierBadge. Allow ~20s.
    await page.waitForSelector('#tierBadgeBtn:not(.hidden)', { timeout: 20000 });
    const txt = (await page.locator('#tierBadgeBtn .tier-badge-text').textContent()).trim();
    const cls = await page.locator('#tierBadgeBtn').getAttribute('class');
    const hasTier = /tier-(free|bronze|silver|gold|platinum|diamond)/.test(cls);
    record('tier badge visible with valid tier class', hasTier, 'text=' + txt + ', class=' + cls);
  } catch (e) {
    record('tier badge visible', false, 'badge never appeared: ' + e.message);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-no-badge.png'), fullPage: true });
  }

  // ── Test 2: getMyAccess returns expected shape ──────────────────
  try {
    const access = await page.evaluate(async () => {
      if (!window.cloudSync || !window.cloudSync.getMyAccess) return null;
      return await window.cloudSync.getMyAccess();
    });
    assert.ok(access, 'access object returned');
    assert.ok(typeof access.plan_id === 'string', 'plan_id is string');
    assert.ok(['enforce','warn','off'].includes(access.effective_mode), 'effective_mode is enum');
    assert.ok(typeof access.features === 'object' && access.features, 'features object');
    assert.ok(Array.isArray(access.allowed_exam_codes), 'allowed_exam_codes is array');
    record('getMyAccess shape', true, 'plan_id=' + access.plan_id + ', mode=' + access.effective_mode);
  } catch (e) {
    record('getMyAccess shape', false, e.message);
  }

  // ── Test 3: listPlans returns 5 plans, no leak ──────────────────
  try {
    const plans = await page.evaluate(async () => {
      return await window.cloudSync.listPlans();
    });
    assert.ok(Array.isArray(plans), 'plans is array');
    assert.equal(plans.length, 5, 'should have 5 plans (diamond hidden)');
    // Check NO features/quota/allowed_exam_codes leak
    for (const p of plans) {
      assert.ok(p.plan_id, 'has plan_id');
      assert.ok(p.display, 'has display');
      assert.equal(p.features, undefined, 'features must not leak: ' + p.plan_id);
      assert.equal(p.daily_quota, undefined, 'daily_quota must not leak: ' + p.plan_id);
      assert.equal(p.allowed_exam_codes, undefined, 'allowed_exam_codes must not leak: ' + p.plan_id);
    }
    record('listPlans count + no server-field leak', true, plans.map(p => p.plan_id).join(','));
  } catch (e) {
    record('listPlans count + no server-field leak', false, e.message);
  }

  // ── Test 4: promo modal open → close (Esc) ──────────────────────
  try {
    await page.click('#tierBadgeBtn');
    await page.waitForSelector('#promoCodeModal:not(.hidden)', { timeout: 2000 });
    await page.keyboard.press('Escape');
    // Playwright's :not(.hidden) visibility check fights our CSS where
    // `.hidden { display:none }`. Use a class-based DOM check instead.
    await page.waitForFunction(() => {
      const m = document.getElementById('promoCodeModal');
      return m && m.classList.contains('hidden');
    }, { timeout: 2000 });
    record('promo modal open + Esc closes', true);
  } catch (e) {
    record('promo modal open + Esc closes', false, e.message);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-promo-modal.png'), fullPage: true });
  }

  // ── Test 5: plans modal opens, renders 5 cards ──────────────────
  try {
    await page.click('#tierBadgeBtn');
    await page.waitForSelector('#promoCodeModal:not(.hidden)', { timeout: 2000 });
    await page.click('#promoToPlansBtn');
    await page.waitForSelector('#plansModal:not(.hidden)', { timeout: 2000 });
    await page.waitForSelector('.plan-card', { timeout: 4000 });
    const count = await page.locator('.plan-card').count();
    assert.equal(count, 5, 'should render 5 plan cards');
    record('plans modal renders 5 cards', true, 'count=' + count);
    // Close
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const m = document.getElementById('plansModal');
      return m && m.classList.contains('hidden');
    }, { timeout: 2000 });
  } catch (e) {
    record('plans modal renders 5 cards', false, e.message);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-plans-modal.png'), fullPage: true });
  }

  // ── Test 6: invalid promo → friendly error ──────────────────────
  try {
    await page.click('#tierBadgeBtn');
    await page.waitForSelector('#promoCodeModal:not(.hidden)', { timeout: 2000 });
    await page.fill('#promoCodeInput', 'NOPE_DOES_NOT_EXIST_' + Date.now());
    await page.click('#promoCodeSubmit');
    await page.waitForFunction(() => {
      const e = document.getElementById('promoCodeError');
      return e && e.textContent && e.textContent.trim().length > 0;
    }, { timeout: 6000 });
    const err = (await page.locator('#promoCodeError').textContent()).trim();
    const ok = /не найден|not found/i.test(err);
    record('invalid promo → friendly error message', ok, 'msg="' + err + '"');
    await page.keyboard.press('Escape');
  } catch (e) {
    record('invalid promo → friendly error message', false, e.message);
  }

  // ── Test 7: locked Mock card reflects access ────────────────────
  try {
    const cardLocked = await page.evaluate(() => {
      const card = document.querySelector('.mode-card[data-mode="mock_exam"]');
      if (!card) return null;
      return card.classList.contains('is-locked');
    });
    const hasMockAccess = await page.evaluate(() => window.cloudSync && window.cloudSync.canAccess && window.cloudSync.canAccess('mock_exam'));
    // Locked iff no access. Match expected.
    const consistent = (cardLocked === !hasMockAccess);
    record('mock card is-locked matches access.features.mock_exam', consistent,
      'cardLocked=' + cardLocked + ', canAccess=' + hasMockAccess);
  } catch (e) {
    record('mock card is-locked matches access.features.mock_exam', false, e.message);
  }

  // ── Test 8: header (#mainHeader) is hidden after consolidation ──
  try {
    const headerHidden = await page.evaluate(() => {
      const h = document.getElementById('mainHeader');
      if (!h) return true;   // not present is also fine
      const cs = getComputedStyle(h);
      return cs.display === 'none';
    });
    record('top header is display:none (sidebar consolidation)', headerHidden);
  } catch (e) {
    record('top header is display:none', false, e.message);
  }

  // ── Test 9: sidebar logout button present ───────────────────────
  try {
    const hasLogout = await page.evaluate(() => !!document.querySelector('.s2-sidebar-item.s2-sidebar-logout'));
    record('sidebar has Sign out button', hasLogout);
  } catch (e) {
    record('sidebar has Sign out button', false, e.message);
  }

  // ── Test 10: sidebar tier badge slot present ────────────────────
  try {
    const hasSlot = await page.evaluate(() => !!document.querySelector('.s2-sidebar-tier-slot'));
    record('sidebar has tier-badge slot', hasSlot);
  } catch (e) {
    record('sidebar has tier-badge slot', false, e.message);
  }

  // ── Console errors check ────────────────────────────────────────
  if (consoleErrors.length) {
    console.log('\nAll captured console/network errors:');
    consoleErrors.forEach((e, i) => console.log('  [' + (i+1) + '] ' + e));
  }
  record('no console errors during run', consoleErrors.length === 0,
    consoleErrors.length ? (consoleErrors.length + ' issue(s) — see above') : '');

} finally {
  await context.close();
}

const failed = results.filter(r => !r.ok);
console.log('\n' + '─'.repeat(50));
console.log(`Passed: ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('\nFailures:');
  failed.forEach(f => console.log('  - ' + f.name + ': ' + f.info));
  process.exit(1);
}
console.log('All UI tests passed ✓');
