// View-as shim. Runs synchronously BEFORE firebase-init.js so it can intercept
// the very first assignment of `window.cloudSync` via a property setter.
//
// Three responsibilities while view-as mode is active:
//   1. Swap localStorage stats keys with the target user's data (charts and
//      KPI cards read from localStorage via loadStore / loadMastery /
//      loadReadinessHistory — these run synchronously at render time, so we
//      must replace the cached values BEFORE app.js touches them).
//   2. Wrap cloudSync.loadData / loadUserProfile to return the bundled data
//      and turn ~15 write methods into no-ops with a console.warn.
//   3. Wrap cloudSync.getAllAnalytics so the analytics row tagged with the
//      admin's uid is replaced with the view-as user's analytics
//      (renderActivityCharts finds "me" by currentUser.uid match).
//
// Activation: admin.html writes four sessionStorage keys then redirects to
// index.html. We back up the admin's localStorage to `__viewAsBackup` (in
// localStorage so it survives tab close) and restore on Exit.

(function () {
  const VIEW_AS_UID = sessionStorage.getItem('viewAsUid');
  const ADMIN_UID = sessionStorage.getItem('viewAsAdminUid');
  const BACKUP_KEY = '__viewAsBackup';

  // localStorage keys app.js reads stats from. We swap section_stats + mastery
  // with the bundle's values, and CLEAR readiness history + weak-resolved +
  // today's daily challenge state so the view-as user starts clean — readiness
  // charts will rebuild from the analytics row (cloud) which we also patch.
  const STATS_KEYS_TO_CLEAR = [
    'exams_quiz_v2',                       // SECTION_STATS_KEY
    'eq_mastery_v1',                       // MASTERY_KEY
    'exams_quiz_readiness_history_v1',     // READINESS_HISTORY_KEY
    'eq_weak_resolved_v1',                 // WEAK_RESOLVED_KEY
  ];
  const PREFIXES_TO_CLEAR = ['eq_daily_'];

  // Orphan-backup detection: if there's no active view-as session but a backup
  // exists, the admin closed the tab without clicking Exit. Restore so their
  // own stats don't stay clobbered next time they open the site normally.
  if (!VIEW_AS_UID) {
    const orphan = localStorage.getItem(BACKUP_KEY);
    if (orphan) {
      try {
        const parsed = JSON.parse(orphan);
        localStorage.removeItem(BACKUP_KEY);
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
        keys.forEach(k => localStorage.removeItem(k));
        Object.entries(parsed).forEach(([k, v]) => localStorage.setItem(k, v));
        console.warn('[view-as] orphan backup restored');
      } catch (e) {
        console.error('[view-as] orphan restore failed', e);
      }
    }
    return;
  }

  let bundle;
  try {
    bundle = JSON.parse(sessionStorage.getItem('viewAsBundle') || '{}');
  } catch (e) {
    console.error('[view-as] bundle parse failed — exiting mode', e);
    sessionStorage.removeItem('viewAsUid');
    sessionStorage.removeItem('viewAsEmail');
    sessionStorage.removeItem('viewAsBundle');
    sessionStorage.removeItem('viewAsAdminUid');
    return;
  }

  const VIEW_AS_EMAIL = sessionStorage.getItem('viewAsEmail') || '(unknown)';
  window.__viewAs = { uid: VIEW_AS_UID, adminUid: ADMIN_UID, email: VIEW_AS_EMAIL, bundle };
  console.log('[view-as] active →', VIEW_AS_EMAIL, VIEW_AS_UID, '(admin:', ADMIN_UID, ')');

  // (1) localStorage swap — once per fresh entry, then idempotent on reloads.
  if (!localStorage.getItem(BACKUP_KEY)) {
    const backup = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === BACKUP_KEY) continue;
      backup[k] = localStorage.getItem(k);
    }
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));

    STATS_KEYS_TO_CLEAR.forEach(k => localStorage.removeItem(k));
    const prefixHits = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && PREFIXES_TO_CLEAR.some(p => k.startsWith(p))) prefixHits.push(k);
    }
    prefixHits.forEach(k => localStorage.removeItem(k));

    if (bundle.data) {
      if (bundle.data.section_stats) {
        localStorage.setItem('exams_quiz_v2', JSON.stringify(bundle.data.section_stats));
      }
      if (bundle.data.mastery) {
        localStorage.setItem('eq_mastery_v1', JSON.stringify(bundle.data.mastery));
      }
    }
  }

  // (2) + (3) cloudSync wrapping.
  const WRITES = [
    'saveData', 'saveProfile', 'saveAnalytics', 'saveUserProfile',
    'saveReflection', 'saveReadinessSnapshot',
    'saveDraft', 'deleteDraft', 'bumpDraftCounter',
    'uploadDraftImage', 'deleteDraftImage',
    'updateDisplayName', 'changePassword',
    'initUserProfile', 'submitDailyAnswer', 'submitQuestionStat',
  ];

  function wrap(cs) {
    cs.loadData = async (_uid, key) => {
      const v = bundle.data ? bundle.data[key] : undefined;
      return v === undefined ? null : v;
    };
    cs.loadUserProfile = async (_uid) => bundle.userDoc || bundle.profile || null;
    cs.loadReflection = async () => null;

    const origGetAllAnalytics = cs.getAllAnalytics;
    cs.getAllAnalytics = async () => {
      let all = [];
      try {
        all = (await origGetAllAnalytics.call(cs)) || [];
      } catch (e) {
        console.warn('[view-as] getAllAnalytics underlying call failed', e);
      }
      if (!bundle.analytics || !ADMIN_UID) return all;
      // Remove the view-as user's original row — otherwise the leaderboard
      // shows them twice (once at their real uid, once at the admin slot we
      // mask below).
      all = all.filter(u => u && u.uid !== VIEW_AS_UID);
      // Substitute the admin's analytics row with the view-as user's data,
      // but keep the admin's uid so `users.find(u => u.uid === currentUser.uid)`
      // finds it. Email/displayName mirror the target so labels match.
      const masked = { ...bundle.analytics, uid: ADMIN_UID };
      const idx = all.findIndex(u => u && u.uid === ADMIN_UID);
      if (idx >= 0) all[idx] = masked; else all.push(masked);
      return all;
    };

    WRITES.forEach(fn => {
      if (typeof cs[fn] === 'function') {
        cs[fn] = async () => {
          console.warn(`[view-as] write blocked: ${fn}`);
          return null;
        };
      }
    });
    return cs;
  }

  // Intercept the assignment that firebase-init.js performs as `window.cloudSync = {...}`.
  let _cs;
  Object.defineProperty(window, 'cloudSync', {
    configurable: true,
    get() { return _cs; },
    set(v) {
      _cs = v && typeof v === 'object' ? wrap(v) : v;
    },
  });

  function injectBanner() {
    if (document.getElementById('__viewAsBanner')) return;
    const b = document.createElement('div');
    b.id = '__viewAsBanner';
    b.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      'z-index:2147483647',
      'background:#f59e0b', 'color:#0f172a',
      'padding:6px 14px',
      'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'text-align:center',
      'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
    ].join(';');
    b.innerHTML =
      '🔒 Viewing as <span style="font-weight:800">' +
      escapeHtml(VIEW_AS_EMAIL) +
      '</span> — read-only · <button id="__viewAsExit" style="margin-left:8px;background:#0f172a;color:#fff;border:none;padding:3px 10px;border-radius:3px;cursor:pointer;font:inherit">Exit</button>';
    document.body.appendChild(b);
    document.body.style.paddingTop =
      (parseInt(getComputedStyle(document.body).paddingTop, 10) || 0) + 32 + 'px';
    document.getElementById('__viewAsExit').addEventListener('click', exitViewAs);
  }

  function exitViewAs() {
    const raw = localStorage.getItem(BACKUP_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
        keys.forEach(k => localStorage.removeItem(k));
        Object.entries(parsed).forEach(([k, v]) => localStorage.setItem(k, v));
      } catch (e) {
        console.error('[view-as] backup restore failed', e);
      }
    }
    localStorage.removeItem(BACKUP_KEY);
    sessionStorage.removeItem('viewAsUid');
    sessionStorage.removeItem('viewAsEmail');
    sessionStorage.removeItem('viewAsBundle');
    sessionStorage.removeItem('viewAsAdminUid');
    location.href = 'admin.html';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectBanner);
  } else {
    injectBanner();
  }
})();
