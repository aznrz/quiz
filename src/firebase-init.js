import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, updateProfile, updatePassword, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, getDocFromServer, collection, getDocs, deleteDoc, connectFirestoreEmulator, increment, deleteField } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyBP0e2_8YnfMyi0Rs75AiBxrETej0DR4_s",
  authDomain: "naruto-quiz-98b5.firebaseapp.com",
  projectId: "naruto-quiz-98b5",
  storageBucket: "naruto-quiz-98b5.firebasestorage.app",
  messagingSenderId: "30585339854",
  appId: "1:30585339854:web:6bb72c22612b85060e759f"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, 'us-central1');
const provider = new GoogleAuthProvider();

const USE_EMULATOR = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
                  && /(?:^|[?&])emu=1\b/.test(location.search);
if (USE_EMULATOR) {
  console.log('[firebase-init] EMULATOR MODE — connecting to localhost emulators');
  try { connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true }); } catch (e) { console.warn('auth emulator skipped:', e.message); }
  try { connectFirestoreEmulator(db, 'localhost', 8080); } catch (e) { console.warn('firestore emulator skipped:', e.message); }
  try { connectFunctionsEmulator(functions, 'localhost', 5001); } catch (e) { console.warn('functions emulator skipped:', e.message); }
}

const callGetQuestionsAllV2 = httpsCallable(functions, 'getQuestionsAllV2');
const callGetQuestionsAll = httpsCallable(functions, 'getQuestionsAll');
const callLogEvent = httpsCallable(functions, 'logEvent');

const _analyticsCache = { data: null, uid: null, ts: 0, TTL: 60_000 };

window.cloudSync = {
  loadQuestions: async () => {
    try {
      const response = await fetch('./data/questions.v2.json');
      if (!response.ok) {
        throw new Error(`Failed to load questions: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.warn("Static questions load failed, trying callable", error);
      try {
        const result = await callGetQuestionsAllV2();
        return result.data;
      } catch (e) {
        const result = await callGetQuestionsAll();
        return result.data;
      }
    }
  },
  login: async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.error("Login failed", e);
    }
  },
  logout: () => signOut(auth),
  onAuthChange: (cb) => {
    onAuthStateChanged(auth, (user) => {
      cb(user);
    });
  },
  saveData: async (uid, key, data) => {
    try {
      await setDoc(doc(db, "users", uid, "data", key), { value: JSON.stringify(data) });
    } catch(e) {
      console.error("Sync error", e);
    }
  },
  loadData: async (uid, key) => {
    try {
      const snap = await getDoc(doc(db, "users", uid, "data", key));
      if (snap.exists()) {
        return JSON.parse(snap.data().value);
      }
    } catch(e) {
      console.error("Sync load error", e);
    }
    return null;
  },

  saveProfile: async (user) => {
    try {
      await setDoc(doc(db, "users", user.uid, "profile", "info"), {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || user.email,
        photoURL: user.photoURL || null,
        lastLogin: new Date().toISOString(),
      }, { merge: true });
    } catch(e) {
      console.error("Profile save error", e);
    }
  },

  saveAnalytics: async (user, store) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const sessions = store.sessions || 0;
      const dailyStats = store.dailyStats || {};
      const dailyCorrect = store.dailyCorrect || {};
      const dailyTimeMs = store.dailyTimeMs || {};
      const dailyStatsByExam = store.dailyStatsByExam || {};
      const dailyCorrectByExam = store.dailyCorrectByExam || {};
      const dailyTimeMsByExam = store.dailyTimeMsByExam || {};
      const sectionStats = store.sectionStats || {};
      const leitner = store.leitner || {};
      const hourStats = store.hourStats || {};
      const totalAnswered = Object.values(dailyStats).reduce((a, b) => a + b, 0);

      let totalCorrect = 0, totalTotal = 0;
      Object.values(sectionStats).forEach(s => {
        totalCorrect += s.correct || 0;
        totalTotal += s.total || 0;
      });
      const accuracy = totalTotal > 0 ? Math.round(totalCorrect / totalTotal * 100) : 0;

      await setDoc(doc(db, "analytics", user.uid), {
        uid: user.uid,
        // The analytics collection is readable by all signed-in users for the
        // shared leaderboard, so we don't expose email here. deleteField() also
        // scrubs the address from docs written before this became shared.
        email: deleteField(),
        displayName: user.displayName || (user.email ? user.email.split('@')[0] : 'Anonymous'),
        sessions,
        totalAnswered,
        totalCorrect,
        totalTotal,
        accuracy,
        dailyStats,
        dailyCorrect,
        dailyTimeMs,
        dailyStatsByExam,
        dailyCorrectByExam,
        dailyTimeMsByExam,
        sectionStats,
        leitner,
        hourStats,
        lastUpdated: today,
      }, { merge: true });
    } catch(e) {
      console.error("Analytics save error", e);
    }
  },

  getAllAnalytics: async () => {
    try {
      const snap = await getDocs(collection(db, "analytics"));
      return snap.docs.map(d => d.data());
    } catch(e) {
      console.error("Get all analytics error", e);
      return [];
    }
  },

  getMyAnalytics: async (uid) => {
    const now = Date.now();
    if (uid === _analyticsCache.uid && (now - _analyticsCache.ts) < _analyticsCache.TTL) {
      return _analyticsCache.data;
    }
    try {
      const snap = await getDocFromServer(doc(db, "analytics", uid));
      const data = snap.exists() ? snap.data() : null;
      _analyticsCache.data = data;
      _analyticsCache.uid = uid;
      _analyticsCache.ts = now;
      return data;
    } catch(e) {
      console.warn("getMyAnalytics error", e);
      return null;
    }
  },

  saveUserProfile: async (uid, data) => {
    try {
      await setDoc(doc(db, "users", uid), data, { merge: true });
    } catch(e) {
      console.error("User profile save error", e);
    }
  },

  loadUserProfile: async (uid) => {
    try {
      const snap = await getDoc(doc(db, "users", uid));
      return snap.exists() ? snap.data() : null;
    } catch(e) {
      console.error("User profile load error", e);
      return null;
    }
  },

  updateDisplayName: async (displayName) => {
    await updateProfile(auth.currentUser, { displayName });
  },

  changePassword: async (newPassword) => {
    await updatePassword(auth.currentUser, newPassword);
  },

  getDailyStats: async (dateStr) => {
    try {
      const snap = await getDoc(doc(db, "daily_stats", dateStr));
      return snap.exists() ? snap.data() : null;
    } catch(e) { return null; }
  },
  submitDailyAnswer: async (dateStr, questionId, chosenKeys) => {
    try {
      const ref = doc(db, "daily_stats", dateStr);
      const updates = { question_id: questionId, total: increment(1) };
      chosenKeys.forEach(k => { updates['ans_' + k] = increment(1); });
      await setDoc(ref, updates, { merge: true });
    } catch(e) { console.error("submitDailyAnswer error", e); }
  },

  submitQuestionStat: async (questionId, chosenKeys) => {
    try {
      const ref = doc(db, "question_stats", questionId);
      const updates = { total: increment(1) };
      (chosenKeys || []).forEach(k => { updates['ans_' + k] = increment(1); });
      const comboKey = (chosenKeys || []).slice().sort().join('_');
      if (comboKey) {
        updates['combo_' + comboKey] = increment(1);
        updates['combo_total'] = increment(1);
      }
      await setDoc(ref, updates, { merge: true });
    } catch(e) {}
  },
  getQuestionStat: async (questionId) => {
    try {
      const snap = await getDoc(doc(db, "question_stats", questionId));
      return snap.exists() ? snap.data() : null;
    } catch(e) { return null; }
  },

  saveReadinessSnapshot: async (uid, exam, dateStr, overall) => {
    if (!uid || !exam || !dateStr) return;
    try {
      await setDoc(doc(db, "analytics", uid), {
        readinessDaily: { [exam]: { [dateStr]: Number(overall) || 0 } },
      }, { merge: true });
      if (_analyticsCache.data && _analyticsCache.uid === uid) {
        if (!_analyticsCache.data.readinessDaily) _analyticsCache.data.readinessDaily = {};
        if (!_analyticsCache.data.readinessDaily[exam]) _analyticsCache.data.readinessDaily[exam] = {};
        _analyticsCache.data.readinessDaily[exam][dateStr] = Number(overall) || 0;
      }
    } catch(e) {
      console.error("Readiness snapshot save error", e);
    }
  },

  saveReflection: async (uid, questionId, text) => {
    try {
      await setDoc(doc(db, "users", uid, "reflections", String(questionId)), {
        questionId: String(questionId),
        text: String(text || '').slice(0, 500),
        savedAt: new Date().toISOString(),
      }, { merge: true });
    } catch(e) {
      console.error("Reflection save error", e);
      throw e;
    }
  },
  loadReflection: async (uid, questionId) => {
    try {
      const snap = await getDoc(doc(db, "users", uid, "reflections", String(questionId)));
      return snap.exists() ? snap.data() : null;
    } catch(e) {
      return null;
    }
  },

  saveQuestionFeedback: async (uid, payload) => {
    if (!uid || !payload || !payload.question_id || !payload.session_id) return null;
    const enriched = {
      ...payload,
      uid,
      email: (auth.currentUser && auth.currentUser.email) || null,
      created_at: new Date().toISOString(),
    };
    const ref = doc(collection(db, "users", uid, "question_feedback"));
    await setDoc(ref, enriched);
    return { id: ref.id };
  },

  canAccess: () => true,

  initUserProfile: async (user) => {
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (!snap.exists()) {
        const defaultName = user.displayName || user.email.split('@')[0];
        await setDoc(doc(db, "users", user.uid), {
          displayName: defaultName,
          avatar: '🎯',
          updatedAt: new Date().toISOString(),
        });
        return { displayName: defaultName, avatar: '🎯' };
      }
      return snap.data();
    } catch(e) {
      console.error("initUserProfile error", e);
      return null;
    }
  },

  logEvent: async (eventName, properties) => {
    try {
      if (!auth || !auth.currentUser) return { ok: false, error: 'no_auth' };
      const sessionId = (window.S && window.S.sessionId) || null;
      const appVersion = (typeof window.APP_VERSION === 'string' && window.APP_VERSION) || null;

      try {
        const ref = doc(collection(db, "events"));
        const expires = new Date(Date.now() + 365 * 86400000);
        await setDoc(ref, {
          uid: auth.currentUser.uid,
          email: auth.currentUser.email,
          plan_id: null,
          event_name: eventName,
          properties: properties || {},
          session_id: sessionId,
          app_version: appVersion,
          created_at: new Date().toISOString(),
          expires_at: expires.toISOString(),
        });
        return { ok: true };
      } catch (firestoreError) {
        console.warn("[cloudSync.logEvent] direct Firestore event write failed, trying callable", firestoreError);
        const result = await callLogEvent({
          event_name: eventName,
          properties: properties || {},
          session_id: sessionId,
          app_version: appVersion,
        });
        return result && result.data ? result.data : { ok: true };
      }
    } catch (e) {
      try { console.warn('[cloudSync.logEvent] all event logging methods failed:', eventName, e && (e.message || e)); } catch {}
      return { ok: false, error: 'exception' };
    }
  },
};
