// Runtime: Node.js 22 (Gen 2).
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');
const eventsRepo = require('./repos/eventsRepo');

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });
initializeApp();
const adminDb = getFirestore();

let cached = null;
function loadQuestionsFile() {
  if (cached) return cached;
  const file = path.join(__dirname, 'data', 'questions.v2.json');
  cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  return cached;
}

async function handleGetQuestions(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required.');
  }
  return loadQuestionsFile();
}

exports.getQuestionsAll = onCall({ memory: '512MiB', timeoutSeconds: 30 }, handleGetQuestions);
exports.getQuestionsAllV2 = onCall({ memory: '512MiB', timeoutSeconds: 30 }, handleGetQuestions);

exports.logEvent = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required.', { code: 'unauthenticated' });
  }
  const uid = request.auth.uid;
  const email = (request.auth.token && request.auth.token.email) || null;

  const body = request.data || {};
  const event_name = body.event_name;
  const properties = body.properties || {};
  const session_id = body.session_id || null;
  const app_version = body.app_version || null;

  if (!eventsRepo.isAllowedEvent(event_name)) {
    throw new HttpsError('invalid-argument', `Unknown event: ${event_name}`, { code: 'invalid_event_name' });
  }

  try {
    await eventsRepo.writeEvent({ uid, email, plan_id: null, event_name, properties, session_id, app_version });
    return { ok: true };
  } catch (e) {
    console.warn('[logEvent] write failed:', e && e.message);
    return { ok: false, error: 'write_failed' };
  }
});
