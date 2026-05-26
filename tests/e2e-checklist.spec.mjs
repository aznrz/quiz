// E2E checklist — automated coverage of ACCESS-PLAN section V.
//
// Test plan: only items that can be automated without flaky timing
// (offline simulation, PWA cache replay) or destructive admin moves.
// Each test creates throw-away data with a UID-prefixed code so we
// can re-run safely.
//
// Groups covered:
//   - Security: direct Firestore reads to protected collections must
//     fail with permission-denied.
//   - Anti-abuse: every business error path of redeemPromoCode.
//   - uid-hack: payload override must be ignored.
//   - Rollback drill: enforcement_mode='off' toggle + revert.
//   - Backend gating: exam_codes filter affects payload shape.
//   - Observability: audit_logs contains the expected entries.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

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

const TEST_ID = crypto.randomBytes(3).toString('hex').toUpperCase();
const TEMP_PROMO_OK = 'E2E_OK_' + TEST_ID;
const TEMP_PROMO_INACTIVE = 'E2E_INA_' + TEST_ID;
const TEMP_PROMO_EXPIRED = 'E2E_EXP_' + TEST_ID;
const TEMP_PROMO_EXHAUSTED = 'E2E_EXH_' + TEST_ID;

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: HEADLESS,
  channel: 'chrome',
  viewport: { width: 1400, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const page = context.pages()[0] || await context.newPage();

try {
  await page.goto(SITE_BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tierBadgeBtn:not(.hidden)', { timeout: 20000 });
  console.log('[e2e] auth ready, test session id:', TEST_ID);

  // Reset per-uid rate-limit cooldown for this session — prior test
  // runs may have accumulated failed attempts past threshold.
  try {
    await page.evaluate(async () => {
      const authSdk = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
      const uid = authSdk.getAuth().currentUser && authSdk.getAuth().currentUser.uid;
      if (uid && window.cloudSync && window.cloudSync.admin_clearRateLimit) {
        await window.cloudSync.admin_clearRateLimit(uid, 'redeem');
      }
    });
    console.log('[e2e] rate-limit cleared');
  } catch (e) {
    console.warn('[e2e] clearRateLimit failed:', e.message);
  }

  // ══ SECURITY: direct Firestore client reads must be denied ══════
  const securityTargets = [
    { name: 'promo_codes/*',        path: ['promo_codes'] },
    { name: 'plans/*',              path: ['plans'] },
    { name: 'audit_logs/*',         path: ['audit_logs'] },
    { name: 'payments/*',           path: ['payments'] },
    { name: 'rate_limits/*',        path: ['rate_limits'] },
    { name: 'ip_rate_limits/*',     path: ['ip_rate_limits'] },
    { name: 'promo_campaigns/*',    path: ['promo_campaigns'] },
  ];
  for (const t of securityTargets) {
    try {
      const denied = await page.evaluate(async ({ pathSegs }) => {
        const sdk = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
        const { getFirestore, collection, getDocs } = sdk;
        try {
          await getDocs(collection(getFirestore(), pathSegs[0]));
          return { denied: false };
        } catch (e) {
          return { denied: /permission|denied|insufficient/i.test(e && e.message || ''), msg: e && e.message };
        }
      }, { pathSegs: t.path });
      record('rules deny client read: ' + t.name, denied.denied, denied.msg || '');
    } catch (e) {
      record('rules deny client read: ' + t.name, false, e.message);
    }
  }

  // ── access_grants/* for OTHER uid must be denied ───────────────
  try {
    const FAKE_OTHER_UID = 'fake-other-uid-' + TEST_ID;
    const denied = await page.evaluate(async ({ otherUid }) => {
      const sdk = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
      const { getFirestore, collection, getDocs } = sdk;
      try {
        await getDocs(collection(getFirestore(), 'users', otherUid, 'access_grants'));
        return { denied: false };
      } catch (e) {
        return { denied: /permission|denied|insufficient/i.test(e && e.message || ''), msg: e && e.message };
      }
    }, { otherUid: FAKE_OTHER_UID });
    record('rules deny client read: users/OTHER/access_grants', denied.denied, denied.msg || '');
  } catch (e) {
    record('rules deny client read: users/OTHER/access_grants', false, e.message);
  }

  // ── app_config/access_control should be PUBLIC read ────────────
  try {
    const ok = await page.evaluate(async () => {
      const sdk = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
      const { getFirestore, doc, getDoc } = sdk;
      try {
        const snap = await getDoc(doc(getFirestore(), 'app_config', 'access_control'));
        return { ok: snap.exists() };
      } catch (e) { return { ok: false, msg: e.message }; }
    });
    record('rules allow public read: app_config/access_control', ok.ok, ok.msg || '');
  } catch (e) {
    record('rules allow public read: app_config/access_control', false, e.message);
  }

  // ══ ANTI-ABUSE: every redeem error path ══════════════════════════
  // Setup throwaway promos.
  try {
    await page.evaluate(async ({ codes }) => {
      const cs = window.cloudSync;
      const nowIso = new Date().toISOString();
      const pastIso = new Date(Date.now() - 86400_000).toISOString();
      await cs.admin_createPromoCode({
        code: codes.ok, plan_id: 'bronze', duration_days: 1, max_redemptions: 5, note: 'e2e',
      });
      await cs.admin_createPromoCode({
        code: codes.inactive, plan_id: 'bronze', duration_days: 1, max_redemptions: 5, note: 'e2e', active: false,
      });
      await cs.admin_createPromoCode({
        code: codes.expired, plan_id: 'bronze', duration_days: 1, max_redemptions: 5, note: 'e2e',
        valid_from: new Date(Date.now() - 2 * 86400_000).toISOString(),
        valid_until: pastIso,
      });
      // Exhausted: max=1, then we'll redeem it once first.
      await cs.admin_createPromoCode({
        code: codes.exhausted, plan_id: 'bronze', duration_days: 1, max_redemptions: 1, note: 'e2e',
      });
    }, { codes: { ok: TEMP_PROMO_OK, inactive: TEMP_PROMO_INACTIVE, expired: TEMP_PROMO_EXPIRED, exhausted: TEMP_PROMO_EXHAUSTED } });
    record('setup: 4 throw-away promos created', true);
  } catch (e) {
    record('setup: 4 throw-away promos created', false, e.message);
  }

  // Helper that captures domain code from FirebaseError.details.
  async function tryRedeem(code) {
    return page.evaluate(async (c) => {
      try {
        const res = await window.cloudSync.redeemPromoCode(c);
        return { ok: true, res };
      } catch (e) {
        return { ok: false, domain: (e && e.details && e.details.code) || null, message: e.message };
      }
    }, code);
  }

  // not_found
  const rNotFound = await tryRedeem('DOES_NOT_EXIST_' + TEST_ID);
  record('error: not_found', !rNotFound.ok && rNotFound.domain === 'not_found', rNotFound.domain || rNotFound.message);
  // inactive
  const rInactive = await tryRedeem(TEMP_PROMO_INACTIVE);
  record('error: inactive', !rInactive.ok && rInactive.domain === 'inactive', rInactive.domain || rInactive.message);
  // expired
  const rExpired = await tryRedeem(TEMP_PROMO_EXPIRED);
  record('error: expired', !rExpired.ok && rExpired.domain === 'expired', rExpired.domain || rExpired.message);
  // exhausted — redeem the max=1 code once (we already used PROMO30 by another uid;
  // but for THIS uid, naziz already redeemed PROMO30, so exhausting requires
  // setting up a code & exhausting it. Use admin to bump redemption_count
  // via re-create with overwrite + redemption_count not editable directly.
  // Workaround: redeem TEMP_PROMO_EXHAUSTED once with this uid, then check
  // already_redeemed (different error), then try a different exhausted scenario.
  // For exhausted from-this-uid, we'd need to redeem from another uid — not
  // feasible automatically. Skip exhausted-as-different-uid; cover with admin.
  // already_redeemed
  const rOk = await tryRedeem(TEMP_PROMO_OK);
  record('error: first redeem succeeds (smoke)', rOk.ok, rOk.res && rOk.res.plan_id || rOk.domain);
  const rAlready = await tryRedeem(TEMP_PROMO_OK);
  record('error: already_redeemed', !rAlready.ok && rAlready.domain === 'already_redeemed', rAlready.domain || rAlready.message);

  // ══ uid-hack: payload override of uid must be ignored ════════════
  try {
    const access = await page.evaluate(async () => {
      // Try passing { uid: 'fake' } in payload to getMyAccess — backend
      // reads only context.auth.uid, so my own access should still return.
      const sdk = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js');
      const { getFunctions, httpsCallable } = sdk;
      const fns = getFunctions(undefined, 'us-central1');
      const call = httpsCallable(fns, 'getMyAccess');
      const result = await call({ uid: 'evil-fake-uid' });
      return result.data;
    });
    record('uid-hack: payload override ignored, server uses context.auth.uid', !!access && access.plan_id === 'gold',
      'plan_id=' + (access && access.plan_id));
  } catch (e) {
    record('uid-hack: payload override ignored, server uses context.auth.uid', false, e.message);
  }

  // ══ ROLLBACK DRILL: kill switch off → UNRESTRICTED, then revert ══
  let originalMode = null;
  try {
    const cfg = await page.evaluate(async () => await window.cloudSync.admin_getAccessControl());
    originalMode = cfg && cfg.enforcement_mode;
    assert.ok(originalMode, 'should read original enforcement_mode');

    // Flip off
    await page.evaluate(async () => await window.cloudSync.admin_setAccessControl({ enforcement_mode: 'off' }));
    // Read directly from Firestore (public read for app_config) to bypass
    // the 60s in-memory cache on whichever Functions instance handles
    // the next admin_getAccessControl call.
    const newMode = await page.evaluate(async () => {
      const sdk = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
      const { getFirestore, doc, getDoc } = sdk;
      const snap = await getDoc(doc(getFirestore(), 'app_config', 'access_control'));
      return snap.exists() ? snap.data().enforcement_mode : null;
    });
    record('rollback drill: kill switch flipped to off', newMode === 'off', 'enforcement_mode=' + newMode);

    // Revert
    await page.evaluate(async (mode) => await window.cloudSync.admin_setAccessControl({ enforcement_mode: mode }), originalMode);
    const revertMode = await page.evaluate(async () => {
      const sdk = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
      const { getFirestore, doc, getDoc } = sdk;
      const snap = await getDoc(doc(getFirestore(), 'app_config', 'access_control'));
      return snap.exists() ? snap.data().enforcement_mode : null;
    });
    record('rollback drill: reverted to original mode', revertMode === originalMode,
      'enforcement_mode=' + revertMode);
  } catch (e) {
    record('rollback drill', false, e.message);
    // Best-effort revert if we screwed up partway.
    if (originalMode) {
      try { await page.evaluate(async (mode) => await window.cloudSync.admin_setAccessControl({ enforcement_mode: mode }), originalMode); } catch {}
    }
  }

  // ══ BACKEND GATING: exam_codes filter shape (admin sees all) ═════
  try {
    const payload = await page.evaluate(async () => {
      const result = await window.cloudSync.loadQuestions();
      return { hasExams: !!result.exams, examCount: Object.keys(result.exams || {}).length };
    });
    // Admin (ADMIN_EMAILS) bypasses the new filter — should see all exams.
    record('getQuestionsAllV2 returns multiple exams (admin bypass works)',
      payload.hasExams && payload.examCount >= 5, 'examCount=' + payload.examCount);
  } catch (e) {
    record('getQuestionsAllV2 returns multiple exams', false, e.message);
  }

  // ══ OBSERVABILITY: audit log entries appear for our actions ══════
  try {
    const auditMatches = await page.evaluate(async ({ code, testId }) => {
      const items = (await window.cloudSync.admin_listAuditLogs({ limit: 100 })).items || [];
      const redeemedHit = items.find(x => x.action === 'promo_redeemed' && x.promo_code === code);
      const failedHits = items.filter(x => x.action === 'redeem_failed').length;
      const promoCreatedHits = items.filter(x => x.action === 'promo_created'
        && x.promo_code && x.promo_code.endsWith(testId)).length;
      return { redeemed: !!redeemedHit, failedCount: failedHits, createdCount: promoCreatedHits };
    }, { code: TEMP_PROMO_OK, testId: TEST_ID });
    record('audit: promo_redeemed entry for OK promo',  auditMatches.redeemed);
    record('audit: redeem_failed entries logged (≥3 expected — not_found+inactive+expired)',
      auditMatches.failedCount >= 3, 'count=' + auditMatches.failedCount);
    record('audit: promo_created entries for the 4 throw-away codes',
      auditMatches.createdCount >= 4, 'count=' + auditMatches.createdCount);
  } catch (e) {
    record('audit log integration', false, e.message);
  }

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
console.log('All E2E checklist tests passed ✓');
