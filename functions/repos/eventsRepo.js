// events/{eventId} — product analytics events. Lives separately from
// audit_logs (security/admin trail) so retention and access patterns
// can diverge.
//
// TTL: writeEvent stamps `expires_at = now + 365d`. Firestore auto-deletes
// only if a TTL policy is enabled on this field. Run once:
//   gcloud firestore fields ttls update expires_at \
//     --collection-group=events \
//     --enable-ttl
// (Cloud Run / Console alternative documented in HANDOVER.md.)

const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const TTL_DAYS = 365;
const MAX_PROPS_BYTES = 2048;

// Canonical product-event vocabulary. Anything outside this set is rejected
// at the callable boundary. Keeping it small + explicit prevents typos and
// vocabulary creep that would litter dashboards later.
const EVENT_NAMES = new Set([
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
]);

function isAllowedEvent(name) {
  return typeof name === 'string' && EVENT_NAMES.has(name);
}

// Strip anything that isn't a primitive or a flat array of primitives.
// Drops nested objects, functions, etc. — keeps the payload safe to store
// and easy to query.
function sanitizeProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof k !== 'string' || !k || k.length > 64) continue;
    if (v === null) continue;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      out[k] = t === 'string' && v.length > 200 ? v.slice(0, 200) : v;
    } else if (Array.isArray(v) && v.length <= 20 && v.every(x => ['string', 'number', 'boolean'].includes(typeof x))) {
      out[k] = v.slice();
    }
  }
  const serialised = JSON.stringify(out);
  if (serialised.length > MAX_PROPS_BYTES) {
    return { _truncated: true, _original_bytes: serialised.length };
  }
  return out;
}

async function writeEvent({ uid, email, plan_id, event_name, properties, session_id, app_version }) {
  if (!isAllowedEvent(event_name)) {
    const e = new Error('invalid_event_name');
    e.code = 'invalid_event_name';
    throw e;
  }
  const db = getFirestore();
  const expires = new Date(Date.now() + TTL_DAYS * 86400000);
  const payload = {
    uid: uid || null,
    email: email || null,
    plan_id: plan_id || null,
    event_name,
    properties: sanitizeProps(properties),
    session_id: session_id || null,
    app_version: app_version || null,
    created_at: FieldValue.serverTimestamp(),
    expires_at: expires,
  };
  const ref = await db.collection('events').add(payload);
  return ref.id;
}

// Cursor is the ISO timestamp of the last returned doc's created_at. Cheap
// and stable enough for an admin viewer; we don't need full ordered keysets.
async function listEvents({ event_name = null, uid = null, since = null, until = null, limit = 50, cursor = null } = {}) {
  const db = getFirestore();
  let q = db.collection('events');
  if (event_name) q = q.where('event_name', '==', String(event_name));
  if (uid) q = q.where('uid', '==', String(uid));
  if (since) q = q.where('created_at', '>=', new Date(since));
  if (until) q = q.where('created_at', '<=', new Date(until));
  q = q.orderBy('created_at', 'desc').limit(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
  if (cursor) {
    try { q = q.startAfter(new Date(cursor)); } catch (_) {}
  }
  const snap = await q.get();
  return snap.docs.map(d => {
    const data = d.data() || {};
    const created = data.created_at;
    return {
      id: d.id,
      uid: data.uid || null,
      email: data.email || null,
      plan_id: data.plan_id || null,
      event_name: data.event_name || null,
      properties: data.properties || {},
      session_id: data.session_id || null,
      app_version: data.app_version || null,
      created_at: created && created.toDate ? created.toDate().toISOString() : (created || null),
    };
  });
}

module.exports = {
  EVENT_NAMES,
  TTL_DAYS,
  MAX_PROPS_BYTES,
  isAllowedEvent,
  sanitizeProps,
  writeEvent,
  listEvents,
};
