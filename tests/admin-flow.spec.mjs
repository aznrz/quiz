// Admin-side E2E tests: promo CRUD, access control panel, grants list,
// revoke cycle. Uses the same persistent profile as access-flow.spec.mjs.
//
// Designed to NOT disrupt the test user's existing Gold tier — we
// create + revoke a throw-away Bronze grant so the resolver's max-RANK
// rule keeps Gold effective throughout.
//
// Usage:  node tests/admin-flow.spec.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, '.pw-user-data');
const SITE_BASE = (process.env.SITE_URL || 'https://app.ms-cert.workers.dev/').replace(/\/+$/, '');
const ADMIN_URL = SITE_BASE + '/admin';
const HEADLESS = process.env.HEADLESS === '1';

const results = [];
function record(name, ok, info) {
  results.push({ name, ok, info });
  console.log((ok ? '✓ PASS  ' : '✗ FAIL  ') + name + (info ? ' — ' + info : ''));
}

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: HEADLESS,
  channel: 'chrome',
  viewport: { width: 1400, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const page = context.pages()[0] || await context.newPage();

const consoleErrors = [];
const GENERIC_404 = /^Failed to load resource: the server responded with a status of 4\d\d/;
page.on('console', m => {
  if (m.type() !== 'error') return;
  if (GENERIC_404.test(m.text())) return;
  consoleErrors.push('console: ' + m.text());
});
page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));
page.on('response', resp => { if (resp.status() >= 500) consoleErrors.push('http ' + resp.status() + ': ' + resp.url()); });

let myUid = null;
let testGrantId = null;

try {
  // ── Open admin and confirm we're superadmin ──────────────────
  await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' });
  try {
    // Inline style="display:none" → init flips to ''. Wait for that flip.
    await page.waitForFunction(() => {
      const el = document.getElementById('accessSeedPanel');
      return el && getComputedStyle(el).display !== 'none';
    }, { timeout: 15000 });
    record('admin: access seed panel visible (= superadmin recognized)', true);
  } catch (e) {
    record('admin: access seed panel visible (= superadmin recognized)', false, e.message);
  }

  // ── Promo codes panel: PROMO30 in list with count >= 1 ───────
  try {
    await page.waitForSelector('#promoCodesPanel', { timeout: 5000 });
    // Wait for the table to load.
    await page.waitForFunction(() => {
      const tbody = document.querySelector('#promoListTable tbody');
      if (!tbody) return false;
      const txt = tbody.textContent;
      return txt && !txt.includes('Loading…');
    }, { timeout: 10000 });
    const promoRow = await page.evaluate(() => {
      const rows = document.querySelectorAll('#promoListTable tbody tr');
      for (const r of rows) {
        const code = r.querySelector('code');
        if (code && code.textContent.trim() === 'PROMO30') {
          const cells = r.querySelectorAll('td');
          return {
            code: 'PROMO30',
            plan: cells[1] && cells[1].textContent.trim(),
            usedCell: cells[3] && cells[3].textContent.trim(),
          };
        }
      }
      return null;
    });
    assert.ok(promoRow, 'PROMO30 row must be present in promo list');
    assert.equal(promoRow.plan, 'gold', 'PROMO30 plan should be gold');
    assert.ok(/^\d+\s*\/\s*\d+/.test(promoRow.usedCell), 'used/max cell should be "N / M"');
    const used = parseInt(promoRow.usedCell.split('/')[0].trim(), 10);
    assert.ok(used >= 1, 'PROMO30 used count should be >= 1 (we redeemed it earlier)');
    record('promo list: PROMO30 found with valid used count', true, 'used=' + used);
  } catch (e) {
    record('promo list: PROMO30 found with valid used count', false, e.message);
  }

  // ── Audit log panel: table renders with at least one row ────
  try {
    await page.waitForSelector('#auditLogPanel', { timeout: 5000 });
    await page.waitForFunction(() => {
      const t = document.getElementById('auditStatus');
      return t && /entr/i.test(t.textContent);
    }, { timeout: 15000 });
    const auditCount = await page.evaluate(() => {
      const rows = document.querySelectorAll('#auditTable tbody tr');
      return Array.from(rows).filter(r => r.querySelectorAll('td').length === 6).length;
    });
    assert.ok(auditCount > 0, 'audit table should have at least one row');
    record('audit log table loads with rows', true, 'rows=' + auditCount);
  } catch (e) {
    record('audit log table loads with rows', false, e.message);
  }

  // ── Audit log filter by action ──────────────────────────────
  try {
    await page.fill('#auditActionFilter', 'promo_redeemed');
    await page.click('#auditReloadBtn');
    await page.waitForFunction(() => {
      const t = document.getElementById('auditStatus');
      return t && /entr/i.test(t.textContent);
    }, { timeout: 10000 });
    const filteredOk = await page.evaluate(() => {
      const rows = document.querySelectorAll('#auditTable tbody tr');
      const dataRows = Array.from(rows).filter(r => r.querySelectorAll('td').length === 6);
      if (!dataRows.length) return true;
      return dataRows.every(r => /promo_redeemed/.test(r.children[1].textContent));
    });
    record('audit log filter by action', filteredOk);
    await page.fill('#auditActionFilter', '');
    await page.click('#auditReloadBtn');
  } catch (e) {
    record('audit log filter by action', false, e.message);
  }

  // ── Access control panel: enforcement mode and test flags load ─
  try {
    await page.waitForSelector('#accessControlPanel', { timeout: 5000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('acStatus');
      return el && el.textContent.includes('Loaded');
    }, { timeout: 10000 });
    const cfg = await page.evaluate(() => ({
      mode: document.getElementById('acEnforcementMode').value,
      enabled: document.getElementById('acEnabled').checked,
      promoEnabled: document.getElementById('acPromoRedeem').checked,
      testMode: document.getElementById('acTestMode').checked,
      defaultNonTest: document.getElementById('acDefaultModeNonTest').value,
      testEmails: document.getElementById('acAllowedTestEmails').value,
    }));
    assert.ok(['off','warn','enforce'].includes(cfg.mode), 'enforcement_mode value valid');
    assert.equal(cfg.enabled, true, 'enabled should be true');
    assert.equal(cfg.promoEnabled, true, 'promo_redeem_enabled should be true');
    assert.ok(cfg.testEmails.includes('naziz.kz@gmail.com'), 'test-emails should include the superadmin');
    record('access-control panel loads with seeded values', true,
      'mode=' + cfg.mode + ', test_mode=' + cfg.testMode);
  } catch (e) {
    record('access-control panel loads with seeded values', false, e.message);
  }

  // ── Resolve our own uid via the existing analytics row ──────
  try {
    // Pick first option from view-as select that's superadmin's row.
    await page.waitForFunction(() => {
      const sel = document.getElementById('viewAsSelect');
      if (!sel) return false;
      return sel.options.length > 1;
    }, { timeout: 10000 });
    myUid = await page.evaluate(() => {
      const sel = document.getElementById('viewAsSelect');
      for (const opt of sel.options) {
        if (opt.value && opt.textContent.includes('naziz.kz@gmail.com')) return opt.value;
      }
      return null;
    });
    assert.ok(myUid, 'should find naziz.kz@gmail.com uid in view-as select');
    record('view-as: superadmin uid resolved from select', true, 'uid=' + myUid.slice(0, 8) + '…');
  } catch (e) {
    record('view-as: superadmin uid resolved from select', false, e.message);
  }

  if (myUid) {
    // ── Select user → grants block appears with at least one row ─
    try {
      await page.selectOption('#viewAsSelect', myUid);
      await page.waitForFunction(() => {
        const block = document.getElementById('userGrantsBlock');
        if (!block || getComputedStyle(block).display === 'none') return false;
        const tbody = document.querySelector('#grantsTable tbody');
        if (!tbody) return false;
        return !tbody.textContent.includes('Loading…') && !tbody.textContent.includes('Pick a user');
      }, { timeout: 10000 });

      const grants = await page.evaluate(() => {
        const rows = document.querySelectorAll('#grantsTable tbody tr');
        return Array.from(rows).map(r => {
          const cells = r.querySelectorAll('td');
          return {
            plan: cells[0] && cells[0].textContent.trim(),
            source: cells[1] && cells[1].textContent.trim(),
            code: cells[2] && cells[2].textContent.trim(),
            status: cells[3] && cells[3].textContent.trim(),
          };
        });
      });
      assert.ok(grants.length > 0, 'should have at least one grant');
      const activeGold = grants.find(g => g.plan === 'gold' && g.status === 'active');
      assert.ok(activeGold, 'should have an active gold grant from earlier PROMO30 redeem');
      record('grants list shows active Gold from PROMO30', true, 'grants=' + grants.length);
    } catch (e) {
      record('grants list shows active Gold from PROMO30', false, e.message);
    }

    // ── Issue a TEMP bronze grant (safe; will be revoked next) ──
    try {
      // 1-day bronze grant — won't override the active Gold thanks
      // to PLAN_RANK max-wins, so user's tier stays Gold throughout.
      await page.selectOption('#grantCreatePlan', 'bronze');
      await page.fill('#grantCreateDuration', '1');
      await page.fill('#grantCreateNote', 'PW automated test — safe to revoke');
      await page.click('#grantCreateBtn');
      await page.waitForFunction(() => {
        const s = document.getElementById('grantCreateStatus');
        return s && /Granted bronze/.test(s.textContent);
      }, { timeout: 10000 });
      // Re-fetch grants table; find newest bronze active grant.
      await page.waitForFunction(() => {
        const rows = document.querySelectorAll('#grantsTable tbody tr');
        for (const r of rows) {
          const cells = r.querySelectorAll('td');
          if (cells[0] && cells[0].textContent.trim() === 'bronze'
              && cells[3] && cells[3].textContent.trim() === 'active') return true;
        }
        return false;
      }, { timeout: 5000 });
      // Extract its grant id from the revoke button.
      testGrantId = await page.evaluate(() => {
        const rows = document.querySelectorAll('#grantsTable tbody tr');
        for (const r of rows) {
          const cells = r.querySelectorAll('td');
          if (cells[0] && cells[0].textContent.trim() === 'bronze'
              && cells[3] && cells[3].textContent.trim() === 'active') {
            const btn = r.querySelector('[data-revoke-id]');
            return btn ? btn.getAttribute('data-revoke-id') : null;
          }
        }
        return null;
      });
      assert.ok(testGrantId, 'should resolve the new bronze grant id');
      record('admin_grantAccess: temp bronze grant issued', true, 'grant_id=' + testGrantId.slice(0, 8) + '…');
    } catch (e) {
      record('admin_grantAccess: temp bronze grant issued', false, e.message);
    }

    // ── Verify resolver still returns Gold (max-RANK wins) ──────
    try {
      await page.goto(SITE_BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      const access = await page.evaluate(async () => {
        return await window.cloudSync.loadAccess(true);
      });
      assert.equal(access.plan_id, 'gold', 'resolver picks Gold over Bronze (max RANK)');
      record('resolver: Gold + Bronze active → resolver still returns Gold', true,
        'plan_id=' + access.plan_id);
      // Go back to admin for revoke.
      await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const sel = document.getElementById('viewAsSelect');
        return sel && sel.options.length > 1;
      }, { timeout: 10000 });
      await page.selectOption('#viewAsSelect', myUid);
      await page.waitForFunction(() => {
        const tbody = document.querySelector('#grantsTable tbody');
        return tbody && !tbody.textContent.includes('Loading…') && !tbody.textContent.includes('Pick a user');
      }, { timeout: 10000 });
    } catch (e) {
      record('resolver: Gold + Bronze active → resolver still returns Gold', false, e.message);
    }

    // ── Revoke the temp bronze grant via admin callable directly ─
    // (avoiding window.confirm + window.prompt — they require an
    // interactive listener override which is fragile in headless.)
    if (testGrantId) {
      try {
        const revokeResult = await page.evaluate(async ({ uid, grantId }) => {
          return await window.cloudSync.admin_revokeAccess(uid, grantId, 'pw_test_cleanup');
        }, { uid: myUid, grantId: testGrantId });
        assert.ok(revokeResult && revokeResult.ok, 'revoke should return ok');
        record('admin_revokeAccess: temp bronze grant revoked', true);
      } catch (e) {
        record('admin_revokeAccess: temp bronze grant revoked', false, e.message);
      }
    }

    // ── Verify grant is now in revoked state ──────────────────
    if (testGrantId) {
      try {
        const grants = await page.evaluate(async (uid) => {
          return await window.cloudSync.admin_listGrantsForUser(uid);
        }, myUid);
        const target = grants.find(g => g.id === testGrantId);
        assert.ok(target, 'revoked grant should still appear in history');
        assert.equal(target.status, 'revoked', 'status should be revoked');
        assert.equal(target.revoked, true, 'revoked flag should be true');
        record('revoke side-effects: status=revoked, revoked=true, present in history', true,
          'reason=' + (target.revoked_reason || '—'));
      } catch (e) {
        record('revoke side-effects: status=revoked, revoked=true, present in history', false, e.message);
      }
    }

    // ── Final: user is back to plain Gold (no bronze interference) ─
    try {
      await page.goto(SITE_BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const access = await page.evaluate(async () => {
        return await window.cloudSync.loadAccess(true);
      });
      assert.equal(access.plan_id, 'gold', 'after revoke + Gold-only active → still Gold');
      assert.equal(access.source, 'promo', 'source should be promo (PROMO30 grant)');
      record('post-revoke: user remains Gold (no regression)', true);
    } catch (e) {
      record('post-revoke: user remains Gold (no regression)', false, e.message);
    }
  }

  if (consoleErrors.length) {
    console.log('\nCaptured 5xx/page errors:');
    consoleErrors.forEach((e, i) => console.log('  [' + (i+1) + '] ' + e));
  }
  record('no server errors during admin run', consoleErrors.length === 0,
    consoleErrors.length ? (consoleErrors.length + ' issue(s)') : '');

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
console.log('All admin tests passed ✓');
