// Offline tests for functions/repos/eventsRepo.js — vocabulary + sanitizer.
// Run: node tests/events-repo.test.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const eventsRepo = require('../functions/repos/eventsRepo.js');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
    pass++;
  } catch (e) {
    console.log('FAIL ' + name);
    console.log('  ' + (e && e.message));
    fail++;
  }
}

test('EVENT_NAMES contains exactly the 12 canonical events', () => {
  const expected = [
    'signup',
    'session_start',
    'session_complete',
    'feature_first_use',
    'promo_modal_opened',
    'plans_modal_opened',
    'locked_clicked',
    'promo_redeem_attempt',
    'mastery_milestone',
    'streak_milestone',
    'question_feedback_submitted',
    'app_version_warning_shown',
  ];
  assert.equal(eventsRepo.EVENT_NAMES.size, expected.length);
  expected.forEach(n => assert.ok(eventsRepo.EVENT_NAMES.has(n), 'missing event: ' + n));
});

test('isAllowedEvent accepts canonical names, rejects garbage', () => {
  assert.equal(eventsRepo.isAllowedEvent('signup'), true);
  assert.equal(eventsRepo.isAllowedEvent('session_complete'), true);
  assert.equal(eventsRepo.isAllowedEvent('nonexistent_event'), false);
  assert.equal(eventsRepo.isAllowedEvent(''), false);
  assert.equal(eventsRepo.isAllowedEvent(null), false);
  assert.equal(eventsRepo.isAllowedEvent(123), false);
  assert.equal(eventsRepo.isAllowedEvent({}), false);
});

test('sanitizeProps keeps primitives, drops nested objects', () => {
  const out = eventsRepo.sanitizeProps({
    str: 'hi',
    n: 42,
    b: true,
    nested: { a: 1 },         // dropped — not a primitive
    fn: () => {},             // dropped
    nullish: null,            // dropped (null filtered out)
    arr_ok: [1, 2, 'three'],  // kept
    arr_bad: [{}, []],        // dropped (non-primitive elements)
  });
  assert.equal(out.str, 'hi');
  assert.equal(out.n, 42);
  assert.equal(out.b, true);
  assert.deepEqual(out.arr_ok, [1, 2, 'three']);
  assert.equal('nested' in out, false);
  assert.equal('fn' in out, false);
  assert.equal('nullish' in out, false);
  assert.equal('arr_bad' in out, false);
});

test('sanitizeProps truncates long strings to 200 chars', () => {
  const long = 'x'.repeat(500);
  const out = eventsRepo.sanitizeProps({ s: long });
  assert.equal(out.s.length, 200);
});

test('sanitizeProps drops keys with name >64 chars', () => {
  const longKey = 'k'.repeat(65);
  const out = eventsRepo.sanitizeProps({ [longKey]: 'v', ok: 'v' });
  assert.equal(longKey in out, false);
  assert.equal(out.ok, 'v');
});

test('sanitizeProps caps array length to 20', () => {
  const big = new Array(50).fill(0).map((_, i) => i);
  const out = eventsRepo.sanitizeProps({ arr: big });
  // Filter passes because length <= 20 check at top — array of 50 is dropped.
  assert.equal('arr' in out, false);
});

test('sanitizeProps returns _truncated when serialised payload exceeds budget', () => {
  const payload = {};
  for (let i = 0; i < 200; i++) {
    payload['key_' + i] = 'value_' + 'x'.repeat(20);
  }
  const out = eventsRepo.sanitizeProps(payload);
  assert.equal(out._truncated, true);
  assert.equal(typeof out._original_bytes, 'number');
});

test('sanitizeProps returns empty object for non-object input', () => {
  assert.deepEqual(eventsRepo.sanitizeProps(null), {});
  assert.deepEqual(eventsRepo.sanitizeProps(undefined), {});
  assert.deepEqual(eventsRepo.sanitizeProps('string'), {});
  assert.deepEqual(eventsRepo.sanitizeProps(42), {});
  assert.deepEqual(eventsRepo.sanitizeProps([1, 2, 3]), {});
});

test('TTL_DAYS = 365 (matches spec)', () => {
  assert.equal(eventsRepo.TTL_DAYS, 365);
});

if (fail === 0) {
  console.log('\nAll tests passed.');
  process.exit(0);
} else {
  console.log('\n' + fail + ' test(s) failed.');
  process.exit(1);
}
