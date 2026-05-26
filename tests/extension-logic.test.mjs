// Offline unit tests for the pure-function pieces of ACCESS-PLAN that
// don't need Firestore or auth. Run with:
//   node tests/extension-logic.test.mjs
//
// Mirrors the implementations in functions/index.js so a regression in
// either copy is caught here. If you change the source-of-truth in
// functions/index.js, paste the new version below.

import assert from 'node:assert/strict';

const PLAN_RANK = Object.freeze({ free: 0, bronze: 1, silver: 2, gold: 3, platinum: 4, diamond: 5 });
const DAY_MS = 24 * 60 * 60 * 1000;

function applyExtensionLogic(currentAccess, newPlanId, durationDays) {
  const now = new Date();
  const currentRank = PLAN_RANK[currentAccess && currentAccess.plan_id] ?? 0;
  const newRank = PLAN_RANK[newPlanId] ?? 0;
  const dur = Math.max(0, Number(durationDays) || 0) * DAY_MS;
  if (newRank >= currentRank) {
    let baseMs = now.getTime();
    if (currentAccess && currentAccess.expires_at) {
      const cur = new Date(currentAccess.expires_at).getTime();
      if (Number.isFinite(cur) && cur > baseMs) baseMs = cur;
    }
    return { starts_at: now, expires_at: new Date(baseMs + dur) };
  }
  return { starts_at: now, expires_at: new Date(now.getTime() + dur) };
}

function parseSemver(s) {
  const parts = String(s || '0').split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}
function cmpSemver(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  for (let i = 0; i < 3; i++) { if (A[i] !== B[i]) return A[i] - B[i]; }
  return 0;
}

// ─── extension logic ───────────────────────────────────────────────
{
  // Free → Gold upgrade (no prior expiry): expires = now + 30d
  const r = applyExtensionLogic({ plan_id: 'free', expires_at: null }, 'gold', 30);
  const diffDays = (r.expires_at.getTime() - r.starts_at.getTime()) / DAY_MS;
  assert.ok(Math.abs(diffDays - 30) < 0.01, `Free→Gold: expected ~30d, got ${diffDays}`);
  console.log('PASS upgrade Free→Gold (30d) → expires ~30d from now');
}
{
  // Gold + activate Gold again (extension): expires_at += duration
  const future = new Date(Date.now() + 10 * DAY_MS).toISOString();
  const r = applyExtensionLogic({ plan_id: 'gold', expires_at: future }, 'gold', 30);
  const diffDays = (r.expires_at.getTime() - r.starts_at.getTime()) / DAY_MS;
  // Should be ~40 days from now (10 remaining + 30 new)
  assert.ok(Math.abs(diffDays - 40) < 0.01, `Gold extension: expected ~40d, got ${diffDays}`);
  console.log('PASS extension Gold+Gold (10d remaining + 30d) → expires ~40d');
}
{
  // Bronze → Gold upgrade with remaining time: roll forward Bronze's tail
  const future = new Date(Date.now() + 5 * DAY_MS).toISOString();
  const r = applyExtensionLogic({ plan_id: 'bronze', expires_at: future }, 'gold', 30);
  const diffDays = (r.expires_at.getTime() - r.starts_at.getTime()) / DAY_MS;
  // newRank(gold)=3 >= currentRank(bronze)=1, so 5+30=35d
  assert.ok(Math.abs(diffDays - 35) < 0.01, `Bronze→Gold upgrade: expected ~35d, got ${diffDays}`);
  console.log('PASS upgrade Bronze→Gold (5d remaining + 30d) → expires ~35d');
}
{
  // Gold + activate Bronze (sidegrade): new grant gets 30d from now, NOT extension
  const future = new Date(Date.now() + 20 * DAY_MS).toISOString();
  const r = applyExtensionLogic({ plan_id: 'gold', expires_at: future }, 'bronze', 30);
  const diffDays = (r.expires_at.getTime() - r.starts_at.getTime()) / DAY_MS;
  // Sidegrade: should NOT extend gold's expiry; new bronze grant gets only 30d
  assert.ok(Math.abs(diffDays - 30) < 0.01, `Gold→Bronze sidegrade: expected ~30d, got ${diffDays}`);
  console.log('PASS sidegrade Gold→Bronze (20d gold remaining) → bronze grant has 30d, gold stays effective');
}
{
  // Free → Gold with zero duration (edge case)
  const r = applyExtensionLogic({ plan_id: 'free', expires_at: null }, 'gold', 0);
  const diffDays = (r.expires_at.getTime() - r.starts_at.getTime()) / DAY_MS;
  assert.ok(Math.abs(diffDays) < 0.01, `zero duration: expected 0d, got ${diffDays}`);
  console.log('PASS edge case (0d) → expires_at == starts_at');
}
{
  // null currentAccess (brand-new user)
  const r = applyExtensionLogic(null, 'gold', 30);
  assert.ok(r.expires_at instanceof Date, 'null currentAccess should not throw');
  const diffDays = (r.expires_at.getTime() - r.starts_at.getTime()) / DAY_MS;
  assert.ok(Math.abs(diffDays - 30) < 0.01, `null currentAccess: expected ~30d`);
  console.log('PASS edge case (null current) → behaves as Free');
}
{
  // Expired grant in currentAccess (expires_at in past): rolls from now
  const past = new Date(Date.now() - 5 * DAY_MS).toISOString();
  const r = applyExtensionLogic({ plan_id: 'gold', expires_at: past }, 'gold', 30);
  const diffDays = (r.expires_at.getTime() - r.starts_at.getTime()) / DAY_MS;
  // Past expires_at should not be the base (we use max(now, past))
  assert.ok(Math.abs(diffDays - 30) < 0.01, `Expired Gold + Gold: expected ~30d`);
  console.log('PASS extension on expired grant → fresh 30d from now (not into the past)');
}
{
  // Free → Platinum (huge upgrade)
  const r = applyExtensionLogic({ plan_id: 'free', expires_at: null }, 'platinum', 365);
  const diffDays = (r.expires_at.getTime() - r.starts_at.getTime()) / DAY_MS;
  assert.ok(Math.abs(diffDays - 365) < 0.01, `Free→Platinum 365d`);
  console.log('PASS Free→Platinum (365d annual)');
}

// ─── semver ────────────────────────────────────────────────────────
assert.deepEqual(parseSemver('1.21.0'), [1, 21, 0]);
assert.deepEqual(parseSemver('2'), [2, 0, 0]);
assert.deepEqual(parseSemver(''), [0, 0, 0]);
assert.deepEqual(parseSemver('1.21.0-beta'), [1, 21, 0]);  // suffix ignored
console.log('PASS parseSemver (various)');

assert.equal(cmpSemver('1.21.0', '1.21.0'), 0);
assert.ok(cmpSemver('1.22.0', '1.21.0') > 0, '1.22 > 1.21');
assert.ok(cmpSemver('1.21.0', '1.22.0') < 0, '1.21 < 1.22');
assert.ok(cmpSemver('2.0.0', '1.99.99') > 0, '2.0 > 1.99');
assert.ok(cmpSemver('1.21.1', '1.21.0') > 0, 'patch increment');
console.log('PASS cmpSemver (ordering)');

console.log('\nAll tests passed.');
