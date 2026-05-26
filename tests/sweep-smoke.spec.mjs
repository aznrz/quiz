// Smoke test for 1B.1 — admin_runExpireSweep.
// Invokes the callable; verifies it returns ok + sweep stats.
// Doesn't create test data, just confirms the function deploys + runs.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, '.pw-user-data');
const SITE_URL = (process.env.SITE_URL || 'https://app.ms-cert.workers.dev/');

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: process.env.HEADLESS === '1',
  channel: 'chrome',
  viewport: { width: 1400, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const page = context.pages()[0] || await context.newPage();

try {
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tierBadgeBtn:not(.hidden)', { timeout: 20000 });

  const result = await page.evaluate(async () => {
    return await window.cloudSync.admin_runExpireSweep();
  });

  console.log('sweep result:', JSON.stringify(result, null, 2));
  assert.equal(result.ok, true, 'sweep returns ok');
  assert.ok(Number.isInteger(result.swept), 'swept is integer');
  assert.ok(Number.isInteger(result.touched_uids), 'touched_uids is integer');
  assert.ok(Number.isInteger(result.duration_ms), 'duration_ms is integer');
  console.log('✓ PASS sweep callable returns valid stats (swept=' + result.swept + ', touched=' + result.touched_uids + ', ' + result.duration_ms + 'ms)');
} finally {
  await context.close();
}
