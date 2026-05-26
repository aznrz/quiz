'use strict';

const SECTION_STATS_KEY = 'exams_quiz_v2';
const MASTERY_KEY = 'eq_mastery_v1';
const VERSION_FILTER_KEY = 'eq_version_filter';
const LANG_FILTER_KEY = 'eq_lang_filter';
const LESSON_FILTER_KEY = 'eq_lesson_filter';
// 'all' | 'unseen' — narrow the practice pool to questions the user has
// never answered (no entry in store.questionStats or total === 0). Sits
// after the version/lang/lesson filters in getExamQuestions.
const COVERAGE_FILTER_KEY = 'eq_coverage_filter';

const S = {
  db: null,
  exam: null,
  mode: 'practice',
  flashDomain: 'all',
  flashcardQuestionCount: 10,
  flashRevealed: false,
  section: 'all',
  sectionQuestionCount: 10,
  sectionTimerMinutes: 0,
  practiceQuestionCount: 10,
  mockNum: null,
  csLabel: null,
  questions: [],
  idx: 0,
  correct: 0,
  sessionSectionStats: {},
  sessionLegacyStats: {},
  sessionWrongQuestions: [],
  timerInterval: null,
  timerSec: 0,
  lastSession: null,
  versionFilter: 'all',  // 'all' | 'gen1' | 'gen2' | 'cs24' | 'db1'
  langFilter: 'all',     // 'all' | 'ru' | 'en'
  lessonFilter: 'all',   // 'all' | <lesson label>; only meaningful when version is db1/db2
};

// Firebase auth is handled via src/firebase-init.js (module)
// Credentials are no longer stored client-side


const $ = id => document.getElementById(id);
const screens = { home: $('screenHome'), quiz: $('screenQuiz'), result: $('screenResult') };
let homeEventsBound = false;
function normalizeStore(store) {
  const next = store && typeof store === 'object' ? store : {};
  if (!next.sectionStats) next.sectionStats = {};
  if (!next.questionStats) next.questionStats = {};
  if (!next.leitner) next.leitner = {};
  if (!next.favorites) next.favorites = {};
  if (!next.sessions) next.sessions = 0;
  if (!next.dailyTimeMs || typeof next.dailyTimeMs !== 'object') next.dailyTimeMs = {};
  if (!next.dailyStatsByExam || typeof next.dailyStatsByExam !== 'object') next.dailyStatsByExam = {};
  if (!next.dailyCorrectByExam || typeof next.dailyCorrectByExam !== 'object') next.dailyCorrectByExam = {};
  if (!next.dailyTimeMsByExam || typeof next.dailyTimeMsByExam !== 'object') next.dailyTimeMsByExam = {};
  if (!next.leitnerSnapshotByDay || typeof next.leitnerSnapshotByDay !== 'object') next.leitnerSnapshotByDay = {};
  if (!next.leitnerSnapshotByDayByExam || typeof next.leitnerSnapshotByDayByExam !== 'object') next.leitnerSnapshotByDayByExam = {};
  // One-time backfill: ~99% of historical daily counters belong to PL-300.
  // Migrate them into the per-exam buckets so per-exam tabs aren't empty for old days.
  if (!next.perExamBackfillV1) {
    const target = 'PL-300';
    if (!next.dailyStatsByExam[target]) next.dailyStatsByExam[target] = {};
    if (!next.dailyCorrectByExam[target]) next.dailyCorrectByExam[target] = {};
    if (!next.dailyTimeMsByExam[target]) next.dailyTimeMsByExam[target] = {};
    Object.entries(next.dailyStats || {}).forEach(([day, val]) => {
      if (next.dailyStatsByExam[target][day] == null) next.dailyStatsByExam[target][day] = val;
    });
    Object.entries(next.dailyCorrect || {}).forEach(([day, val]) => {
      if (next.dailyCorrectByExam[target][day] == null) next.dailyCorrectByExam[target][day] = val;
    });
    Object.entries(next.dailyTimeMs || {}).forEach(([day, val]) => {
      if (next.dailyTimeMsByExam[target][day] == null) next.dailyTimeMsByExam[target][day] = val;
    });
    next.perExamBackfillV1 = true;
  }
  if (!next.hourStats || typeof next.hourStats !== 'object') next.hourStats = {};
  if (next.stats && !next.legacyDomainStats) next.legacyDomainStats = next.stats;
  pruneOrphanSectionStats(next);
  return next;
}

function pruneOrphanSectionStats(store) {
  if (typeof getExamProfile !== 'function' || typeof EXAM_PROFILES !== 'object') return;
  const stats = store.sectionStats || {};
  Object.keys(stats).forEach(key => {
    const sep = key.indexOf('__');
    if (sep < 0) return;
    const exam = key.slice(0, sep);
    const section = key.slice(sep + 2);
    const profile = EXAM_PROFILES[exam];
    if (!profile) return;
    const weights = profile.sectionWeights || {};
    if (!(section in weights)) {
      delete stats[key];
    }
  });
}

function loadStore() {
  try {
    return normalizeStore(JSON.parse(localStorage.getItem(SECTION_STATS_KEY)) || {});
  } catch {
    return normalizeStore({});
  }
}

function saveStore(data) {
  const normalized = normalizeStore(data);
  localStorage.setItem(SECTION_STATS_KEY, JSON.stringify(normalized));
  // Push to cloud in background (no await — don't block UI)
  syncPush('section_stats', normalized).catch(() => {});
  // Update Power BI analytics snapshot
  if (isCloudSyncEligible()) {
    window.cloudSync.saveAnalytics(currentUser, normalized).catch(() => {});
  }
}

function loadMastery() {
  try {
    return JSON.parse(localStorage.getItem(MASTERY_KEY)) || {};
  } catch {
    return {};
  }
}

function saveMastery(data) {
  localStorage.setItem(MASTERY_KEY, JSON.stringify(data));
  // Push to cloud in background
  syncPush('mastery', data).catch(() => {});
}

const READINESS_HISTORY_KEY = 'exams_quiz_readiness_history_v1';
function loadReadinessHistory() {
  try { return JSON.parse(localStorage.getItem(READINESS_HISTORY_KEY)) || {}; }
  catch { return {}; }
}
function saveReadinessSnapshot(exam) {
  if (!exam) return;
  const eng = window.readinessEngine;
  if (!eng || typeof eng.getReadinessBreakdown !== 'function') return;
  let overall;
  try { overall = Number(eng.getReadinessBreakdown(exam).overall) || 0; }
  catch { return; }
  const dateStr = new Date().toISOString().slice(0, 10);
  const hist = loadReadinessHistory();
  if (!hist[exam]) hist[exam] = {};
  hist[exam][dateStr] = overall;
  try { localStorage.setItem(READINESS_HISTORY_KEY, JSON.stringify(hist)); } catch {}
  if (isCloudSyncEligible() && currentUser && window.cloudSync && window.cloudSync.saveReadinessSnapshot) {
    window.cloudSync.saveReadinessSnapshot(currentUser.uid, exam, dateStr, overall).catch(() => {});
  }
}

async function fetchJsonOrThrow(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Failed to load ${path}: ${res.status}`);
  }
  return res.json();
}

function isLocalDevHost() {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

function renderDataLoadError(err) {
  const detail = err?.cause?.message || err?.message || 'Unknown error';
  const detailHtml = escapeHtml(detail);
  const message = isLocalDevHost()
    ? 'Local question data could not be loaded.'
    : 'The question service is temporarily unavailable.';
  const hint = isLocalDevHost()
    ? 'Check that `data/questions.v2.json` is available from your local static server.'
    : 'Please refresh and sign in again. If the problem persists, redeploy Firebase Functions.';

  document.body.innerHTML = `
    <div class="loading" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#0f172a;">
      <div style="width:min(520px,100%);border:1px solid rgba(148,163,184,0.24);border-radius:24px;padding:24px;background:rgba(15,23,42,0.92);box-shadow:0 24px 80px rgba(2,6,23,0.45);">
        <div style="font-size:1.35rem;font-weight:700;color:#f8fafc;margin-bottom:10px;">Exam data unavailable</div>
        <div style="color:#cbd5e1;line-height:1.6;margin-bottom:8px;">${message}</div>
        <div style="color:#94a3b8;line-height:1.5;margin-bottom:18px;">${hint}</div>
        <div style="font-size:0.82rem;color:#94a3b8;border:1px solid rgba(148,163,184,0.16);border-radius:16px;padding:12px 14px;background:rgba(15,23,42,0.78);margin-bottom:18px;">
          <strong style="color:#e2e8f0;">Technical detail:</strong> ${detailHtml}
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <button id="retryDataLoadBtn" type="button" style="border:none;border-radius:999px;padding:12px 18px;font-weight:700;cursor:pointer;background:#38bdf8;color:#082f49;">Retry</button>
          <button id="signOutDataLoadBtn" type="button" style="border:1px solid rgba(148,163,184,0.28);border-radius:999px;padding:12px 18px;font-weight:600;cursor:pointer;background:transparent;color:#e2e8f0;">Sign out</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('retryDataLoadBtn')?.addEventListener('click', () => {
    window.location.reload();
  });
  document.getElementById('signOutDataLoadBtn')?.addEventListener('click', async () => {
    try {
      await window.cloudSync?.logout?.();
    } catch (logoutError) {
      console.warn('Sign out after data-load failure failed:', logoutError);
    }
    window.location.reload();
  });
}


function normalizeExamPayload(examCode, payload, meta = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const questions = Array.isArray(source.questions)
    ? source.questions
    : Array.isArray(source.items)
      ? source.items
      : Array.isArray(payload)
        ? payload
        : [];

  const title = source.title || source.name || meta.title || meta.name || examCode;
  const questionCount = Number.isFinite(source.question_count)
    ? Number(source.question_count)
    : Number.isFinite(meta.question_count)
      ? Number(meta.question_count)
      : questions.length;
  return {
    version: source.version || meta.version || '',
    generated_at: source.generated_at || meta.generated_at || '',
    exam_code: examCode,
    name: source.name || meta.name || title,
    title,
    file: meta.file || meta.path || meta.href || meta.url || meta.artifact || '',
    publish_ready: typeof meta.publish_ready === 'boolean' ? meta.publish_ready : questionCount > 0,
    available_types: Array.isArray(meta.available_types) ? meta.available_types : [],
    status: meta.status || '',
    loaded: !!questions.length || !!source.questions,
    question_count: questionCount,
    sections: source.sections || meta.sections || {},
    domains: source.domains || meta.domains || {},
    questions,
  };
}

function normalizeDb(payload) {
  if (payload?.exams && typeof payload.exams === 'object') {
    const typeMap = { mini_test: 'mini', std_test: 'std', case_study: 'case' };
    const exams = Object.fromEntries(
      Object.entries(payload.exams).map(([examCode, examPayload]) => {
        const ex = normalizeExamPayload(examCode, examPayload);
        const types = [...new Set((ex.questions || []).map(q => typeMap[q.group_type]).filter(Boolean))];
        ex.available_types = types;
        ex.loaded = true;
        return [examCode, ex];
      })
    );
    return {
      version: payload.version || '',
      generated_at: payload.generated_at || '',
      exams,
    };
  }

  return { version: '', generated_at: '', exams: {} };
}

function getExamQuestionCount(exam = S.exam) {
  const ex = getExam(exam);
  if (!ex) return 0;
  if (ex.loaded) return getExamQuestions(exam).length;
  return Number.isFinite(ex.question_count) ? ex.question_count : 0;
}

function isExamAvailable(exam = S.exam) {
  const ex = getExam(exam);
  if (!ex) return false;
  // When any global filter is active, ignore the static publish_ready flag —
  // an exam with zero questions in the filtered pool isn't actually playable.
  const hasFilter = (S.versionFilter && S.versionFilter !== 'all') ||
                    (S.langFilter && S.langFilter !== 'all');
  if (hasFilter) {
    return getExamQuestionCount(exam) > 0;
  }
  if (typeof ex.publish_ready === 'boolean') return ex.publish_ready;
  return getExamQuestionCount(exam) > 0;
}

// Returns the list of exam codes that should appear in user-facing pickers
// (home cards, shared tabs, Favorites tabs, etc.). Composes two filters:
//   1) access control — keep codes the user is allowed to see (via
//      access.allowed_exam_codes; '*' means no restriction)
//   2) visibility preference — user-curated subset from My Profile →
//      "Visible Exams" (userProfile.visibleExams). Null/undefined means
//      "no preference yet" → no filter (first-load default).
// Admin screens that need the full list (e.g. All Questions explorer)
// pass { ignoreVisible: true } to bypass step 2.
function getDisplayedExamCodes(allCodes, opts) {
  if (!Array.isArray(allCodes)) return [];
  opts = opts || {};
  var access = (window.cloudSync && typeof window.cloudSync.getCachedAccess === 'function')
    ? (window.cloudSync.getCachedAccess() || {})
    : {};
  var allowed = Array.isArray(access.allowed_exam_codes) ? access.allowed_exam_codes : ['*'];
  var hasWildcard = allowed.indexOf('*') !== -1;
  var visible = (!opts.ignoreVisible
                  && typeof userProfile === 'object' && userProfile
                  && Array.isArray(userProfile.visibleExams))
    ? userProfile.visibleExams
    : null;
  return allCodes.filter(function(code) {
    if (!hasWildcard && allowed.indexOf(code) === -1) return false;
    if (visible && visible.indexOf(code) === -1) return false;
    return true;
  });
}

// Pick the margin to display next to Readiness — bootstrap CI (cached
// 24h, ~100ms compute) when the user opted in via Profile, otherwise
// the analytical Wilson margin already supplied by readinessEngine.
// Returns { margin, method } — method ∈ 'bootstrap' | 'wilson'.
function resolveReadinessMargin(examCode, wilsonMargin) {
  var w = Number(wilsonMargin) || 0;
  var useBoot = (typeof userProfile === 'object' && userProfile && userProfile.useBootstrapCI);
  if (!useBoot || !examCode || !window.readinessEngine
      || typeof window.readinessEngine.bootstrapMargin !== 'function') {
    return { margin: w, method: 'wilson' };
  }
  try {
    var res = window.readinessEngine.bootstrapMargin(examCode);
    var bm = Number(res && res.margin) || 0;
    return { margin: bm, method: 'bootstrap', meta: res };
  } catch (_) {
    return { margin: w, method: 'wilson' };
  }
}

function getDefaultExamKey() {
  const examKeys = Object.keys(S.db?.exams || {});
  return examKeys.find(key => isExamAvailable(key)) || examKeys[0] || null;
}


async function selectExam(exam, options = {}) {
  const examCode = exam || getDefaultExamKey();
  if (!examCode || !getExam(examCode)) return;

  S.exam = examCode;
  if (options.renderCards !== false) renderExamCards();
  updateHomeForExam();
  updateHeaderBadge();
  if (typeof updateGlobalStats === 'function') updateGlobalStats();
  if (typeof renderStudyPlan === 'function') renderStudyPlan();
  if (typeof renderLessonFilterPicker === 'function') renderLessonFilterPicker();
  if (typeof renderCoverageFilterPanel === 'function') renderCoverageFilterPanel();
}

function getExamStatusLabel(exam = S.exam) {
  const ex = getExam(exam);
  if (!ex) return '';
  if (isExamAvailable(exam)) return `${getExamQuestionCount(exam)} questions`;
  const s = (ex.status || '').toLowerCase().replace(/[-_\s]/g, '');
  if (['draft', 'blocked', 'wip'].includes(s)) return 'In development';
  if (['inprogress', 'inprep', 'preparation'].includes(s)) return 'In preparation';
  return 'Coming soon';
}

// Returns false only when exam has explicit available_types and mode needs a type not in that list.
function isModeAvailableForExam(mode, exam = S.exam) {
  const ex = getExam(exam);
  if (!ex) return true;
  const types = ex.available_types;
  if (!Array.isArray(types) || !types.length) return true;
  const requires = { case_study: ['case'] };
  const needed = requires[mode];
  if (!needed) return true;
  return needed.some(t => types.includes(t));
}

function getQuestionKey(q) {
  return q.id ? String(q.id) : btoa(encodeURIComponent((q.prompt || '').slice(0, 80))).slice(0, 24);
}

function getExam(exam = S.exam) {
  return S.db?.exams?.[exam] || null;
}

function getExamQuestions(exam = S.exam) {
  let qs = getExam(exam)?.questions || [];
  const v = S.versionFilter;
  if (v && v !== 'all') qs = qs.filter(q => (q.version || 'gen1') === v);
  const lang = S.langFilter;
  if (lang && lang !== 'all') qs = qs.filter(q => (q.language || 'ru') === lang);
  const lesson = S.lessonFilter;
  if (lesson && lesson !== 'all') {
    qs = qs.filter(q => String(q.lesson || '') === String(lesson));
  }
  if (S.coverageFilter === 'unseen') {
    const stats = getQuestionStatsMap();
    qs = qs.filter(q => {
      const s = stats[getQuestionKey(q)];
      return !s || !(s.total > 0);
    });
  }
  return qs;
}

// Unfiltered exam questions — ignores versionFilter and langFilter.
// Used by readiness/study-plan so the overall readiness number stays stable
// when the user toggles version/language filters (which only scope the
// active practice pool, not exam-wide preparedness).
function getAllExamQuestions(exam = S.exam) {
  return getExam(exam)?.questions || [];
}

function getAvailableVersions() {
  const seen = new Set();
  const exams = S.db?.exams || {};
  Object.values(exams).forEach(ex => {
    (ex.questions || []).forEach(q => seen.add(q.version || 'gen1'));
  });
  return Array.from(seen).sort();
}

function loadVersionFilter() {
  try {
    let v = localStorage.getItem(VERSION_FILTER_KEY) || 'all';
    const MIGRATE = { 'gen.1.0': 'gen1', 'gen.2.0': 'gen2', 'real.1.0': 'cs24', 'real1': 'cs24' };
    if (MIGRATE[v]) {
      v = MIGRATE[v];
      try { localStorage.setItem(VERSION_FILTER_KEY, v); } catch {}
    }
    return v;
  } catch { return 'all'; }
}

function saveVersionFilter(v) {
  try { localStorage.setItem(VERSION_FILTER_KEY, v); } catch {}
}

function loadLessonFilter() {
  try { return localStorage.getItem(LESSON_FILTER_KEY) || 'all'; }
  catch { return 'all'; }
}
function saveLessonFilter(v) {
  try { localStorage.setItem(LESSON_FILTER_KEY, v); } catch {}
}

// Lessons available in the active exam under the *current* version+lang
// filter, ignoring the current lessonFilter itself (so the dropdown doesn't
// shrink to one option after the user picks one). Sorts numeric labels
// numerically; dotted labels (10-23, 11-6) get natural sort.
function getAvailableLessons(exam = S.exam) {
  const lessons = new Set();
  const ex = getExam(exam);
  if (!ex) return [];
  const v = S.versionFilter;
  const lang = S.langFilter;
  (ex.questions || []).forEach(q => {
    if (!q.lesson) return;
    if (v && v !== 'all' && (q.version || 'gen1') !== v) return;
    if (lang && lang !== 'all' && (q.language || 'ru') !== lang) return;
    lessons.add(String(q.lesson));
  });
  return Array.from(lessons).sort((a, b) => {
    const ai = parseInt(a, 10), bi = parseInt(b, 10);
    if (!Number.isNaN(ai) && !Number.isNaN(bi) && a.indexOf('-') === -1 && b.indexOf('-') === -1) {
      return ai - bi;
    }
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

function getAvailableLanguages() {
  const seen = new Set();
  const exams = S.db?.exams || {};
  Object.values(exams).forEach(ex => {
    (ex.questions || []).forEach(q => seen.add(q.language || 'ru'));
  });
  return Array.from(seen).sort();
}

function loadLangFilter() {
  try { return localStorage.getItem(LANG_FILTER_KEY) || 'all'; }
  catch { return 'all'; }
}

function saveLangFilter(v) {
  try { localStorage.setItem(LANG_FILTER_KEY, v); } catch {}
}

function loadCoverageFilter() {
  try {
    const v = localStorage.getItem(COVERAGE_FILTER_KEY) || 'all';
    return v === 'unseen' ? 'unseen' : 'all';
  } catch { return 'all'; }
}

function saveCoverageFilter(v) {
  try { localStorage.setItem(COVERAGE_FILTER_KEY, v); } catch {}
}

function isSectionBackedQuestion(q) {
  return ['mini_test', 'std_test', 'case_study'].includes(q.group_type) && !!q.section_key;
}

function isReviewableQuestion(q) {
  const isTypeSupported = ['mini_test', 'std_test', 'case_study'].includes(q.group_type);
  const hasContent = hasChoiceOptions(q) || (q.question_type === 'open_answer' && (q.answer_text || q.details?.answer || q.details?.remember));
  return isTypeSupported && hasContent;
}

function hasChoiceOptions(q) {
  return q.question_type !== 'open_answer' && Array.isArray(q.options) && q.options.length > 0;
}

function getQuestionSectionKey(q) {
  return isSectionBackedQuestion(q) ? q.section_key : null;
}

function getSectionLabel(exam, sectionKey) {
  if (!sectionKey) return 'No section';
  const ex = getExam(exam);
  return ex?.sections?.[sectionKey] || sectionKey;
}

function getSectionLabelFromQuestion(exam, q) {
  if (!q) return '—';
  if (isSectionBackedQuestion(q)) {
    return q.section_label || getSectionLabel(exam, q.section_key);
  }
  return q.domain || q.exam_code || '—';
}

function getQuestionMetaLabel(q) {
  if (!q) return '—';
  const primary = getSectionLabelFromQuestion(q.exam_code || S.exam, q);
  if (isSectionBackedQuestion(q) && q.domain && q.domain !== primary) {
    return `${primary} · ${q.domain}`;
  }
  return primary;
}

function wrapRadarLabel(label, maxLineLength = 16) {
  const words = String(label || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ['Section'];

  const lines = [];
  let current = '';

  words.forEach(word => {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLineLength || !current) {
      current = next;
      return;
    }
    lines.push(current);
    current = word;
  });

  if (current) lines.push(current);
  return lines;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Returns shuffled options for display. Skips shuffle when any option
// text cross-references another option by letter (e.g. "Both A and B").
function shuffleOptionsForDisplay(options) {
  if (!Array.isArray(options) || options.length < 2) return options;
  const crossRef = /\b[A-F]\b/;
  if (options.some(o => crossRef.test(o.text || ''))) return options;
  return shuffle(options);
}

// Stratified random session — replaces the legacy mock_test/std_test pre-built
// groups with on-the-fly weighted sampling per exam blueprint. Case_study
// questions live in a separate mode and are excluded from this pool.
//
// Algorithm: largest-remainder method to allocate `totalCount` slots across
// sections by `sectionWeights`, capped by pool size per section, with the
// leftover redistributed to sections that still have spare questions.
function buildStratifiedSession(examCode, totalCount) {
  if (!Number.isFinite(totalCount) || totalCount <= 0) return [];
  const exam = examCode || S.exam;
  const profile = (typeof getExamProfile === 'function') ? getExamProfile(exam) : null;
  const weights = (profile && profile.sectionWeights) || {};

  const pool = getExamQuestions(exam).filter(q => q.group_type !== 'case_study');
  if (!pool.length) return [];

  const buckets = {};
  for (const q of pool) {
    if (q.section_key) (buckets[q.section_key] = buckets[q.section_key] || []).push(q);
  }
  const sectionKeys = Object.keys(weights).filter(k => buckets[k] && buckets[k].length);
  if (!sectionKeys.length) {
    return shuffle(pool).slice(0, Math.min(totalCount, pool.length));
  }

  const wSum = sectionKeys.reduce((s, k) => s + (weights[k] || 0), 0) || 1;
  const ideal = sectionKeys.map(k => totalCount * (weights[k] / wSum));
  const targets = ideal.map(v => Math.floor(v));
  let toDistribute = totalCount - targets.reduce((s, v) => s + v, 0);
  const byRemainder = ideal
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < toDistribute; k++) targets[byRemainder[k % byRemainder.length].i] += 1;

  for (let i = 0; i < sectionKeys.length; i++) {
    const cap = buckets[sectionKeys[i]].length;
    if (targets[i] > cap) targets[i] = cap;
  }
  let leftover = totalCount - targets.reduce((s, v) => s + v, 0);
  while (leftover > 0) {
    let placed = false;
    for (let i = 0; i < sectionKeys.length && leftover > 0; i++) {
      if (targets[i] < buckets[sectionKeys[i]].length) {
        targets[i] += 1;
        leftover -= 1;
        placed = true;
      }
    }
    if (!placed) break;
  }

  let picked = [];
  for (let i = 0; i < sectionKeys.length; i++) {
    picked = picked.concat(shuffle(buckets[sectionKeys[i]]).slice(0, targets[i]));
  }
  return shuffle(picked);
}

// Inspector for debugging — returns the per-section breakdown without picking.
function previewStratifiedSession(examCode, totalCount) {
  const session = buildStratifiedSession(examCode, totalCount);
  const counts = {};
  for (const q of session) {
    const k = q.section_key || '(no section)';
    counts[k] = (counts[k] || 0) + 1;
  }
  return { total: session.length, bySection: counts };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatScenarioText(raw) {
  const lines = String(raw || '').split('\n');
  const out = [];
  let inList = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const isBullet = /^[-*•]\s+/.test(line);
    if (!line) {
      if (inList) { out.push('</ul>'); inList = false; }
      continue;
    }
    const content = escapeHtml(line.replace(/^[-*•]\s+/, '')).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (isBullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${content}</li>`);
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      if (line.endsWith(':') && line.length < 60) {
        out.push(`<div class="scenario-heading">${content}</div>`);
      } else {
        out.push(`<p>${content}</p>`);
      }
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

const HTML_ENTITY_MAP = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', times: '×', divide: '÷',
  deg: '°', permil: '‰', dagger: '†', Dagger: '‡',
  prime: '′', Prime: '″',
  copy: '©', reg: '®', trade: '™',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓',
};
function decodeNamedEntities(text) {
  return String(text || '')
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      if (HTML_ENTITY_MAP.hasOwnProperty(name)) return HTML_ENTITY_MAP[name];
      const lower = name.toLowerCase();
      return HTML_ENTITY_MAP.hasOwnProperty(lower) ? HTML_ENTITY_MAP[lower] : m;
    })
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return m; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return m; } });
}

function stripExplanationGarbage(rawText) {
  return String(rawText || '')
    .replace(/\r\n?/g, '\n')
    // Strip leading "Принят!" / "Не принят!" / "Принято!" / "Не принято!"
    // verdict markers captured from the source review widget, plus the
    // tab/space pile-up that follows them.
    .replace(/^\s*(Не\s+принят[оы]?!|Принят[оы]?!)[\s\t]*/i, '')
    // Collapse 3+ tabs/spaces (review widget left long indents).
    .replace(/[\t]{2,}/g, ' ')
    .replace(/[ ]{3,}/g, ' ');
}

function extractSourcesFromExplanation(rawText) {
  const sources = [];
  const seen = new Set();
  const push = (title, url) => {
    if (!url) return;
    const cleanUrl = url.replace(/[.,);:!?\]]+$/, '');
    if (seen.has(cleanUrl)) return;
    seen.add(cleanUrl);
    sources.push({ title: (title || cleanUrl).trim(), url: cleanUrl });
  };
  // 1) "Title (https://url)" — Markdown-style citations.
  let text = stripExplanationGarbage(rawText).replace(
    /([^\n()]{2,160}?)\s*\((https?:\/\/[^\s)]+)\)/g,
    (_, title, url) => { push(title, url); return ''; }
  );
  // 2) Bare URLs surviving step 1.
  text = text.replace(/(https?:\/\/[^\s<>'"\\]+)/g, (url) => { push(url, url); return ''; });
  // Tidy whitespace where citations were removed.
  text = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { cleanText: text, sources };
}

function formatQuestionText(text) {
  const decoded = decodeNamedEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n');
  const parts = String(decoded).split(/(```[\w]*\n?[\s\S]*?```)/g);
  return parts.map(part => {
    const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
    if (match) {
      const lang = match[1] || 'none';
      const code = match[2].trimEnd();
      return `<pre><code class="language-${lang}">${escapeHtml(code)}</code></pre>`;
    }
    // Process inline `code` first into a placeholder so **bold** doesn't
    // touch asterisks that live inside a code span.
    const codeStash = [];
    let safe = escapeHtml(part).replace(/`([^`]+)`/g, (_, c) => {
      codeStash.push(c);
      return ` CODE${codeStash.length - 1} `;
    });
    safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/ CODE(\d+) /g, (_, i) => `<code class="inline-code">${codeStash[+i]}</code>`);
    safe = safe.replace(/(https?:\/\/[^\s<>'"\\]+)/g, (url) => {
      let trail = '';
      while (url.length && '.,);:!?]'.indexOf(url[url.length - 1]) >= 0) {
        trail = url[url.length - 1] + trail;
        url = url.slice(0, -1);
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="inline-link">${url}</a>${trail}`;
    });
    safe = safe
      .replace(/[ \t ]+\n/g, '\n')
      .replace(/\n[ \t ]+/g, '\n')
      .replace(/\n{2,}/g, '\n');
    return safe.replace(/\n/g, '<br>');
  }).join('');
}

let currentUser = null;
let userProfile = { displayName: '', avatar: '🎯' };

const AVATARS = ['🦊','🐼','🦁','🐯','🐻','🦄','🐸','🦅','🦋','🎭','🤖','👾','🧠','💎','🔥','⚡','🌊','🎯','🚀','🏆'];
const TODAY_STR = new Date().toISOString().slice(0, 10);

// ── Exam Countdown ───────────────────────────────────────────────
function renderExamCountdown() {
  const panel = $('examCountdownPanel');
  if (!panel) return;
  // Sibling ETA card to the right — kept in sync with every countdown
  // re-render. Async + self-contained: it hides itself when there's no
  // target exam or the trajectory is too short.
  try { renderHomeReadinessEta(); } catch (_) {}
  // No exam date set yet — render a CTA card instead of hiding the panel,
  // so the user discovers where to configure it.
  if (!userProfile.examDate || !userProfile.targetExam) {
    panel.classList.remove('hidden');
    const targetExam = userProfile.targetExam || S.exam || 'your exam';
    panel.innerHTML = `
      <div class="section-label" style="margin-bottom:10px">📅 Until exam ${escapeHtml(targetExam)}</div>
      <div class="countdown-empty">
        <div class="countdown-empty-copy">Set your exam date to see a countdown and personalized weekly tips.</div>
        <button class="result-btn" id="countdownSetDateBtn">Set exam date</button>
      </div>
    `;
    const btn = $('countdownSetDateBtn');
    if (btn) btn.addEventListener('click', () => { try { openProfileScreen(); } catch {} });
    return;
  }
  const examDate = new Date(userProfile.examDate);
  const now = new Date();
  const daysLeft = Math.ceil((examDate - now) / 86400000);
  if (daysLeft < 0) { panel.classList.add('hidden'); return; }

  // Readiness + weak-section — single source of truth: readinessEngine
  // (Same numbers Study Plan shows, so the two cards agree.)
  const store = loadStore();
  let readiness = 0;
  let readinessMargin = 0;
  let marginMethod = 'wilson';
  let weakLabel = '';
  let worstAcc = 0;
  let breakdown = null;
  try {
    const eng = window.readinessEngine;
    if (eng && typeof eng.getReadinessBreakdown === 'function') {
      breakdown = eng.getReadinessBreakdown(userProfile.targetExam);
      readiness = Number(breakdown && breakdown.overall) || 0;
      const resolved = resolveReadinessMargin(userProfile.targetExam, breakdown && breakdown.overallMargin);
      readinessMargin = resolved.margin;
      marginMethod = resolved.method;
    }
  } catch {}
  if (!readiness) {
    const mastery = store.mastery_v1 || {};
    const vals = Object.values(mastery).map(m => m.level || 0);
    readiness = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  }
  if (breakdown && breakdown.minSectionKey && breakdown.sectionDetails) {
    const w = breakdown.sectionDetails[breakdown.minSectionKey];
    if (w) {
      weakLabel = w.label || breakdown.minSectionKey;
      worstAcc = Math.round(w.score);
    }
  }

  const urgency = daysLeft <= 3 ? `<div class="countdown-tip">⚠️ ${daysLeft} days left — take a final mock test!</div>` :
    daysLeft <= 7 ? `<div class="countdown-tip">🔥 Final week! Tap your weak topics.</div>` :
    weakLabel ? `<div class="countdown-tip">💡 Today: drill «${weakLabel}» (${worstAcc}%)</div>` : '';

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="section-label" style="margin-bottom:10px">📅 Until exam ${escapeHtml(userProfile.targetExam)}</div>
    <div class="countdown-row">
      <div>
        <div class="countdown-days">${daysLeft}</div>
        <div class="countdown-label">days left</div>
      </div>
      <div style="text-align:right">
        <div class="countdown-readiness" title="${readinessMargin > 0 ? `95% confidence interval: ${Math.max(0,readiness-readinessMargin)}–${Math.min(100,readiness+readinessMargin)} · method: ${marginMethod}` : ''}">${readiness}%${readinessMargin > 0 ? `<span class="countdown-readiness-margin"> ± ${readinessMargin}</span>` : ''}</div>
        <div class="countdown-label">readiness</div>
      </div>
    </div>
    ${urgency}
  `;
}

// Home-screen counterpart of the Readiness ETA widget. Pulls one
// Firestore doc (analytics/{uid}) so the trend line has the same depth
// the Stats v1 / Result charts use, then delegates to renderReadinessEta
// with home panel IDs. Hides itself silently when there's no target exam
// or the history is too short for OLS (handled inside renderReadinessEta).
async function renderHomeReadinessEta() {
  const panel = $('homeReadinessEtaPanel');
  if (!panel) return;
  const exam = userProfile && userProfile.targetExam;
  if (!exam) { panel.style.display = 'none'; return; }
  let meRow = null;
  try {
    const uid = currentUser && currentUser.uid;
    if (uid && window.cloudSync && typeof window.cloudSync.getMyAnalytics === 'function') {
      meRow = await window.cloudSync.getMyAnalytics(uid);
    }
  } catch (_) {}
  try {
    renderReadinessEta(exam, meRow, 'me', null, {
      panelId: 'homeReadinessEtaPanel',
      elId: 'homeReadinessEta',
    });
  } catch (_) {}
}

// ── Daily Challenge ──────────────────────────────────────────────
function getDailyQuestion() {
  if (!S.db) return null;
  const pool = [];
  Object.keys(S.db.exams).forEach(code => {
    getExamQuestions(code).forEach(q => {
      if (q.question_type === 'mcq_single' && Array.isArray(q.options) && q.options.length >= 2 && q.correct_answers?.length) {
        pool.push(q);
      }
    });
  });
  if (!pool.length) return null;

  const cacheKey = 'eq_daily_pick_' + TODAY_STR;
  const cachedId = localStorage.getItem(cacheKey);
  if (cachedId) {
    const cached = pool.find(q => getQuestionKey(q) === cachedId);
    if (cached) return cached;
  }

  const statsMap = getQuestionStatsMap();
  const MIN_TOTAL = 3;
  const ranked = pool
    .map(q => {
      const s = statsMap[getQuestionKey(q)];
      if (!s || (s.total || 0) < MIN_TOTAL) return null;
      const wrongPct = 1 - (s.correct || 0) / s.total;
      return { q, wrongPct, total: s.total };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.wrongPct !== a.wrongPct) return b.wrongPct - a.wrongPct;
      return String(getQuestionKey(a.q)).localeCompare(String(getQuestionKey(b.q)));
    });

  const picked = ranked.length
    ? ranked[0].q
    : pool[Math.floor(Date.now() / 86400000) % pool.length];

  localStorage.setItem(cacheKey, getQuestionKey(picked));
  return picked;
}

function getDailyRecord() {
  const s = localStorage.getItem('eq_daily_' + TODAY_STR);
  return s ? JSON.parse(s) : null;
}
function saveDailyRecord(r) {
  localStorage.setItem('eq_daily_' + TODAY_STR, JSON.stringify(r));
}

async function renderDailyChallenge() {
  const section = $('dailyChallengeSection');
  if (!section) return;
  // User-controlled toggle in profile (default: shown).
  if (userProfile && userProfile.hideQuestionOfDay) {
    section.innerHTML = '';
    section.classList.add('hidden');
    return;
  }
  const q = getDailyQuestion();
  if (!q) return;
  section.classList.remove('hidden');
  const record = getDailyRecord();
  if (record) {
    renderDailyResult(section, q, record, null);
    if (window.cloudSync) {
      const stats = await window.cloudSync.getDailyStats(TODAY_STR);
      renderDailyResult(section, q, record, stats);
    }
  } else {
    renderDailyQuestion(section, q);
  }
}

function renderDailyQuestion(section, q) {
  const displayOpts = shuffleOptionsForDisplay(q.options);
  const optsHtml = displayOpts.map((o, idx) =>
    `<button class="daily-opt-btn" data-key="${escapeHtml(o.key)}">
       <span class="daily-opt-key">${String.fromCharCode(65 + idx)}</span>
       <span>${escapeHtml(o.text)}</span>
     </button>`
  ).join('');
  const collapsed = localStorage.getItem('daily_collapsed') !== '0';
  section.innerHTML = `
    <div class="daily-header">
      <span class="section-label" style="margin:0">🧠 Question of the day</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="daily-date">${TODAY_STR}</span>
        <button class="daily-toggle" aria-label="Collapse">${collapsed ? 'Show' : 'Hide'}</button>
      </div>
    </div>
    <div class="daily-body"${collapsed ? ' style="display:none"' : ''}>
      <div class="daily-exam-tag">${escapeHtml(q.exam_code)}</div>
      <div class="daily-question-text">${escapeHtml(q.prompt)}</div>
      <div class="daily-opts" id="dailyOpts">${optsHtml}</div>
      <button class="start-btn" id="dailySubmitBtn" disabled style="margin-top:4px">Submit</button>
    </div>
  `;
  section.querySelector('.daily-toggle').addEventListener('click', function() {
    const body = section.querySelector('.daily-body');
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    this.textContent = hidden ? 'Hide' : 'Show';
    localStorage.setItem('daily_collapsed', hidden ? '0' : '1');
  });
  let selectedKey = null;
  section.querySelectorAll('.daily-opt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      section.querySelectorAll('.daily-opt-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedKey = btn.dataset.key;
      $('dailySubmitBtn').disabled = false;
    });
  });
  $('dailySubmitBtn').addEventListener('click', async () => {
    if (!selectedKey) return;
    $('dailySubmitBtn').disabled = true;
    const isCorrect = (q.correct_answers || []).includes(selectedKey);
    const record = { chosen: [selectedKey], correct: isCorrect, questionId: q.id };
    saveDailyRecord(record);
    if (window.cloudSync) await window.cloudSync.submitDailyAnswer(TODAY_STR, q.id, [selectedKey]);
    const stats = window.cloudSync ? await window.cloudSync.getDailyStats(TODAY_STR) : null;
    renderDailyResult(section, q, record, stats);
  });
}

// ── Landing demo (login screen) ───────────────────────────────
async function renderLandingDemo() {
  const wrap = document.getElementById('landingDemo');
  if (!wrap || wrap.dataset.rendered === '1') return;
  let payload;
  try {
    const r = await fetch('data/demo.json', { cache: 'force-cache' });
    if (!r.ok) return;
    payload = await r.json();
  } catch (e) { return; }

  const pool = [];
  Object.keys(payload.exams || {}).forEach(code => {
    (payload.exams[code]?.questions || []).forEach(q => {
      if (q.question_type === 'mcq_single'
          && Array.isArray(q.options) && q.options.length >= 4
          && Array.isArray(q.correct_answers) && q.correct_answers.length === 1
          && q.explanation
          && (q.prompt || '').length < 350) {
        pool.push({ ...q, _exam_code: code });
      }
    });
  });
  if (!pool.length) return;

  const q = pool[Math.floor(Math.random() * pool.length)];
  const examEl = document.getElementById('landingDemoExam');
  const promptEl = document.getElementById('landingDemoPrompt');
  const optsEl = document.getElementById('landingDemoOpts');
  const submitBtn = document.getElementById('landingDemoSubmit');
  const resultEl = document.getElementById('landingDemoResult');
  if (!examEl || !promptEl || !optsEl || !submitBtn || !resultEl) return;

  examEl.textContent = q._exam_code;
  promptEl.textContent = q.prompt || '';
  optsEl.innerHTML = '';
  resultEl.classList.add('hidden');
  resultEl.innerHTML = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Check answer';

  let selectedKey = null;
  const buttons = q.options.map(opt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'landing-demo-opt';
    btn.dataset.key = opt.key;
    btn.innerHTML = `<span class="landing-demo-opt-key">${opt.key}.</span><span>${escapeHtml(opt.text)}</span>`;
    btn.addEventListener('click', () => {
      if (submitBtn.dataset.locked === '1') return;
      buttons.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedKey = opt.key;
      submitBtn.disabled = false;
    });
    optsEl.appendChild(btn);
    return btn;
  });

  submitBtn.onclick = () => {
    if (!selectedKey || submitBtn.dataset.locked === '1') return;
    submitBtn.dataset.locked = '1';
    submitBtn.disabled = true;
    const correctKey = q.correct_answers[0];
    const isCorrect = selectedKey === correctKey;
    buttons.forEach(b => {
      b.disabled = true;
      if (b.dataset.key === correctKey) b.classList.add('correct');
      else if (b.dataset.key === selectedKey) b.classList.add('wrong');
    });
    const verdict = isCorrect
      ? '<span class="demo-verdict demo-correct">✓ Correct</span>'
      : `<span class="demo-verdict demo-wrong">✗ Incorrect. Correct answer: ${escapeHtml(correctKey)}</span>`;
    resultEl.innerHTML = `${verdict}<div class="demo-explanation">${escapeHtml(q.explanation)}</div>`;
    resultEl.classList.remove('hidden');
  };

  if (currentUser) return;
  wrap.style.display = '';
  wrap.dataset.rendered = '1';
}

function hideLandingDemo() {
  const wrap = document.getElementById('landingDemo');
  if (wrap) {
    wrap.style.display = 'none';
    wrap.dataset.rendered = '';
  }
}

function renderDailyResult(section, q, record, stats) {
  const correctKeys = q.correct_answers || [];
  const badge = record.correct
    ? '<span style="color:#22c55e;font-weight:700">✅ Correct!</span>'
    : '<span style="color:#ef4444;font-weight:700">❌ Incorrect</span>';

  let crowdHtml = '';
  if (stats && (stats.total || 0) >= 3) {
    crowdHtml = '<div class="daily-crowd"><div class="daily-crowd-title">How everyone answered</div>';
    if (correctKeys.length > 1) {
      crowdHtml += '<div class="daily-crowd-hint">Multi-answer · each bar is % who picked that option (sum can exceed 100%)</div>';
    }
    q.options.forEach(o => {
      const cnt = stats['ans_' + o.key] || 0;
      const pct = stats.total > 0 ? Math.round(cnt / stats.total * 100) : 0;
      const isC = correctKeys.includes(o.key);
      const isMe = record.chosen.includes(o.key);
      const col = isC ? '#22c55e' : '#ef4444';
      crowdHtml += `<div class="daily-crowd-row">
        <span class="daily-crowd-key">${escapeHtml(o.key)}</span>
        <div class="daily-crowd-bar-wrap"><div class="daily-crowd-bar" style="width:${pct}%;background:${col}"></div></div>
        <span class="daily-crowd-pct" style="color:${isC?'#22c55e':isMe?'#ef4444':'var(--text-muted)'}">${pct}%${isMe?' ← you':''}</span>
      </div>`;
    });
    crowdHtml += `<div class="daily-crowd-total">${stats.total} answers today</div></div>`;
  } else {
    crowdHtml = '<div style="color:var(--text-muted);font-size:0.82rem;margin-top:10px">Stats will appear after a few answers</div>';
  }

  const shareText = `🧠 PL-300 Challenge — ${TODAY_STR}\n${record.correct?'✅ Got it right!':'❌ Got it wrong — still learning'}\n${stats?.total?`📊 ${stats.total} participants today\n`:''}Try it: https://app.ms-cert.workers.dev/`;

  const collapsed = localStorage.getItem('daily_collapsed') !== '0';
  section.innerHTML = `
    <div class="daily-header">
      <span class="section-label" style="margin:0">🧠 Question of the day ${badge}</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="daily-date">${TODAY_STR}</span>
        <button class="daily-toggle" aria-label="Collapse">${collapsed ? 'Show' : 'Hide'}</button>
      </div>
    </div>
    <div class="daily-body"${collapsed ? ' style="display:none"' : ''}>
      <div class="daily-exam-tag">${escapeHtml(q.exam_code)}</div>
      <div class="daily-question-text">${escapeHtml(q.prompt)}</div>
      <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:4px">Correct answer: <strong style="color:#22c55e">${correctKeys.map(k => { const o = q.options.find(o => o.key === k); return o ? k + '. ' + escapeHtml(o.text) : k; }).join('; ')}</strong></div>
      ${crowdHtml}
      <button class="start-btn" id="dailyShareBtn" style="background:rgba(255,255,255,0.07);color:var(--text-primary);margin-top:12px">📤 Share</button>
    </div>
  `;
  section.querySelector('.daily-toggle').addEventListener('click', function() {
    const body = section.querySelector('.daily-body');
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    this.textContent = hidden ? 'Hide' : 'Show';
    localStorage.setItem('daily_collapsed', hidden ? '0' : '1');
  });
  section.querySelector('#dailyShareBtn')?.addEventListener('click', () => {
    if (navigator.share) {
      navigator.share({ text: shareText }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(shareText).then(() => {
        const btn = section.querySelector('#dailyShareBtn');
        if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = '📤 Share'; }, 2000); }
      });
    }
  });
}

// ————————————————— Email whitelist (только эти могут проходить тесты) ————————————————————————
const ALLOWED_EMAILS = [
  'naziz.kz@gmail.com',
  'ulkenbayeva.aidana@gmail.com',
  'akbobekkuramys@gmail.com',
];

let isPremium = false; // true если email в белом списке

function checkAuth() {
  return currentUser !== null;
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => el.classList.toggle('active', key === name));
  const homeBar = $('homeActionBar');
  if (homeBar) homeBar.classList.toggle('hidden', name !== 'home');
  $('nextBtn').classList.toggle('hidden', name !== 'quiz');
  $('skipBtn').classList.toggle('hidden', name !== 'quiz');
  $('finishEarlyBtn').classList.toggle('hidden', name !== 'quiz');
  $('progressWrap').classList.toggle('hidden', name !== 'quiz');
  if (name === 'quiz') {
    const hdr = document.getElementById('mainHeader');
    if (hdr) document.documentElement.style.setProperty('--header-h', hdr.offsetHeight + 'px');
  }
  document.body.dataset.screen = name;
  window.scrollTo(0, 0);
  if (name === 'home') updateResumePanel();
  if (name !== 'result') {
    const sc = $('resultStickyCta');
    if (sc) { sc.classList.add('hidden'); if (sc._obs) { sc._obs.disconnect(); sc._obs = null; } }
  }
  
  const h1 = document.querySelector('.header h1');
  if (h1) {
    if (name === 'quiz' && S.exam) {
      const ex = getExam(S.exam);
      h1.textContent = ex?.exam_code || S.exam;
    } else {
      h1.textContent = 'MS Cert Practice';
    }
  }

  if (typeof handleSidebarForScreenChange === 'function') {
    handleSidebarForScreenChange(name);
  }
}

function stopTimer() {
  clearInterval(S.timerInterval);
  S.timerInterval = null;
}

function renderTimer() {
  const m = Math.floor(S.timerSec / 60).toString().padStart(2, '0');
  const s = (S.timerSec % 60).toString().padStart(2, '0');
  $('timerDisplay').textContent = `${m}:${s}`;
}

function startTimer(seconds) {
  stopTimer();
  S.timerSec = seconds;
  const el = $('timerDisplay');
  el.classList.remove('hidden', 'warning', 'danger');
  renderTimer();
  S.timerInterval = setInterval(() => {
    S.timerSec -= 1;
    if (S.timerSec <= 0) {
      stopTimer();
      finishQuiz();
      return;
    }
    renderTimer();
    el.classList.toggle('warning', S.timerSec <= 300 && S.timerSec > 60);
    el.classList.toggle('danger', S.timerSec <= 60);
  }, 1000);
}

function logout() {
  stopTimer();
  clearActiveSession();
  currentUser = null;
  window.currentUser = null;
  S.db = null;
  $('mainHeader').classList.add('hidden');
  Object.values(screens).forEach(el => el.classList.remove('active'));
  $('screenLogin').classList.add('active');
  // Firebase sign out
  if (window.cloudSync) window.cloudSync.logout();
}

// Cloud sync helpers
function isCloudSyncEligible() {
  if (!currentUser || !window.cloudSync) return false;
  // Dev bypass users have uid 'dev' or 'dev-user' — skip Firestore writes
  // since strict Rules require request.auth.uid == uid and these aren't authenticated.
  const uid = currentUser.uid || '';
  if (uid === 'dev' || uid === 'dev-user' || uid.startsWith('dev-')) return false;
  return true;
}

async function syncPush(key, data) {
  if (!isCloudSyncEligible()) return;
  await window.cloudSync.saveData(currentUser.uid, key, data);
}

async function syncPull(key) {
  if (!currentUser || !window.cloudSync) return null;
  return await window.cloudSync.loadData(currentUser.uid, key);
}

async function pullCloudProgress() {
  try {
    const remoteStore = await syncPull('section_stats');
    if (remoteStore) {
      localStorage.setItem(SECTION_STATS_KEY, JSON.stringify(remoteStore));
    } else {
      // Defense in depth — if cloud has no doc for this uid, also drop any
      // stale local data so we don't pollute analytics/{uid} with whatever
      // was cached from a previous account on this browser.
      localStorage.removeItem(SECTION_STATS_KEY);
    }
    const remoteMastery = await syncPull('mastery');
    if (remoteMastery) {
      localStorage.setItem(MASTERY_KEY, JSON.stringify(remoteMastery));
    } else {
      localStorage.removeItem(MASTERY_KEY);
    }
  } catch(e) {
    console.warn('Cloud pull failed, using local data', e);
  }
}

function initLogin() {
  const btn = $('googleSignInBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (window.cloudSync) {
      window.cloudSync.login();
    } else {
      $('loginError').classList.remove('hidden');
    }
  });
}

async function loadDB() {
  let payload = null;
  let cloudLoadError = null;
  const shouldUseCloud = !!(window.cloudSync && currentUser && !String(currentUser.uid || '').startsWith('dev'));

  if (shouldUseCloud) {
    try {
      payload = await window.cloudSync.loadQuestions();
    } catch (e) {
      cloudLoadError = e;
      console.warn(
        isLocalDevHost()
          ? 'Cloud questions load failed, using local dev file:'
          : 'Cloud questions load failed:',
        e?.code || e?.message || e
      );
    }
  }

  if (!payload && isLocalDevHost()) {
    payload = await fetchJsonOrThrow('data/questions.v2.json');
  }
  if (!payload && cloudLoadError) {
    const err = new Error('Firebase question fetch failed.');
    err.cause = cloudLoadError;
    err.code = cloudLoadError?.code || 'questions-unavailable';
    throw err;
  }
  if (!payload) {
    throw new Error('No exam payload was loaded.');
  }
  S.db = normalizeDb(payload);
  // Прибраться в Leitner-карте от записей-сирот — DB уже загружена, safe.
  cleanupStaleLeitnerEntries();
  // Record today's Leitner box snapshot so the per-day chart has at least
  // one data point even before the user answers anything today.
  try {
    const _s = loadStore();
    recordLeitnerSnapshot(_s);
    saveStore(_s);
  } catch (e) { /* non-fatal */ }
  const el = document.getElementById('dbDate');
  if (el && S.db?.generated_at) {
    const d = new Date(S.db.generated_at);
    const day = String(d.getDate()).padStart(2, '0');
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    const yr = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    el.textContent = `${day}.${mon}.${yr} — ${hh}:${mm}`;
  }
  await initHome();
}

function getModeLabel(mode) {
  const labels = {
    section: 'By section',
    practice: 'Quick practice',
    blitz: 'Blitz (Swipe)',
    flashcard: 'Flashcards',
    mock: 'Exam simulation',
    case_study: 'Case study',
    weak: 'Weak topics',
    smart: 'Smart Review',
    leitner: 'Scheduled review',
  };
  return labels[mode] || mode;
}

function getSelectedOptionText(selectId, fallback) {
  const select = $(selectId);
  return select?.selectedOptions?.[0]?.textContent?.trim() || fallback;
}

function getQuestionStatsMap() {
  return loadStore().questionStats || {};
}

function getFavoritesMap() {
  return loadStore().favorites || {};
}

function isFavoriteQuestion(q) {
  if (!q) return false;
  const map = getFavoritesMap();
  return !!map[getQuestionKey(q)];
}

function toggleFavoriteQuestion(q) {
  if (!q) return false;
  const store = loadStore();
  if (!store.favorites) store.favorites = {};
  const key = getQuestionKey(q);
  if (store.favorites[key]) {
    delete store.favorites[key];
    saveStore(store);
    return false;
  }
  store.favorites[key] = {
    exam: q.exam_code || S.exam,
    domain: q.domain || '',
    sectionKey: getQuestionSectionKey(q) || '',
    sectionLabel: getQuestionSectionKey(q) ? getSectionLabelFromQuestion(q.exam_code || S.exam, q) : '',
    title: q.title || (q.prompt || '').slice(0, 100),
    addedAt: Date.now(),
  };
  saveStore(store);
  return true;
}

function getFavoritesList(exam) {
  const map = getFavoritesMap();
  const rows = Object.entries(map).map(([key, meta]) => ({ key, ...meta }));
  const filtered = exam ? rows.filter(r => (r.exam || '') === exam) : rows;
  return filtered.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

function renderDifficultyBadge(q) {
  const el = $('qDifficultyBadge');
  if (!el) return;
  el.classList.add('hidden');
  el.textContent = '';
  el.removeAttribute('title');
  if (!q || !q.id || S.demoMode) return;
  if (!window.cloudSync || typeof window.cloudSync.getQuestionStat !== 'function') return;

  const myQid = q.id;
  window.cloudSync.getQuestionStat(myQid).then(stats => {
    // Race-guard: another question might have rendered in the meantime
    const cur = S.questions[S.idx];
    if (!cur || cur.id !== myQid) return;
    if (!stats || (stats.total || 0) < 10) return; // need ≥10 attempts for stable signal
    const correctKeys = (typeof getCorrectAnswerKeys === 'function') ? getCorrectAnswerKeys(q) : (q.correct_answers || []);
    // Single-answer: ans_<correct>/total is exact.
    // Multi-answer: read combo_<sorted>/combo_total for exact-combo %; skip
    // the badge if no combo data yet (avoid showing a misleading per-option
    // upper bound that would mark hard questions as easy).
    let pCorrect;
    if (correctKeys.length <= 1) {
      const correctCount = correctKeys.reduce((a, k) => a + (stats['ans_' + k] || 0), 0);
      pCorrect = stats.total > 0 ? Math.min(1, correctCount / stats.total) : 0;
    } else {
      const comboTotal = stats.combo_total || 0;
      if (comboTotal < 10) return;
      const comboKey = 'combo_' + correctKeys.slice().sort().join('_');
      const exact = stats[comboKey] || 0;
      pCorrect = Math.min(1, exact / comboTotal);
    }
    const pct = Math.min(100, Math.round(pCorrect * 100));
    let tier, label, icon;
    if (pCorrect >= 0.85)      { tier = 'easy'; label = 'Easy'; icon = '✅'; }
    else if (pCorrect >= 0.60) { tier = 'medium'; label = 'Medium'; icon = '⚖️'; }
    else                       { tier = 'hard'; label = 'Hard'; icon = '🔥'; }
    el.className = 'difficulty-badge difficulty-' + tier;
    el.textContent = `${icon} ${label} · ${pct}% correct`;
    el.title = `Based on ${stats.total} answers from all users: ${pct}% choose correctly, ${100 - pct}% get it wrong.`;
  }).catch(() => {});
}

// Cache 1-based question position within a lesson, keyed by exam → lesson group.
// Computed lazily on first lookup and reused; S.db is loaded once at login.
const LESSON_INDEX_CACHE = {};

function getQuestionLessonIndex(q) {
  if (!q || !q.lesson || !q.exam_code) return null;
  const examCode = q.exam_code;
  const lessonKey = (q.version || 'gen1') + '|' + (q.language || 'ru') + '|' + String(q.lesson);
  if (!LESSON_INDEX_CACHE[examCode]) LESSON_INDEX_CACHE[examCode] = {};
  let map = LESSON_INDEX_CACHE[examCode][lessonKey];
  if (!map) {
    const pool = (S.db && S.db.exams && S.db.exams[examCode] && S.db.exams[examCode].questions) || [];
    const same = pool.filter(x =>
      x && x.lesson && String(x.lesson) === String(q.lesson)
      && (x.version || 'gen1') === (q.version || 'gen1')
      && (x.language || 'ru') === (q.language || 'ru')
    );
    same.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    map = {};
    same.forEach((x, i) => { map[x.id] = i + 1; });
    LESSON_INDEX_CACHE[examCode][lessonKey] = map;
  }
  return map[q.id] || null;
}

// Render a rekhert-style lesson coordinate from `q.lesson`.
//   "11-16" / "10-23"  → "W11-L16" / "W10-L23"   (db1 new modules, all of db2)
//   "10"               → "W26-L10"               (legacy db1 — Microsoft Exam Prep всё в W26)
//   anything else      → "L<lesson>"             (gen1/gen2/cs* — week not tracked)
function formatLessonCoord(version, lesson) {
  if (!lesson) return '';
  const m = String(lesson).match(/^(\d+)-(\d+)$/);
  if (m) return `W${m[1]}-L${m[2]}`;
  if (version === 'db1') return `W26-L${lesson}`;
  return `L${lesson}`;
}

function refreshVersionBadge(q, el) {
  el = el || $('qVersionBadge');
  if (!el) return;
  const v = (q && q.version) || '';
  if (!v) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.className = 'question-version-badge ' +
    (v === 'cs24' ? 'is-cs24'
      : v === 'db1' ? 'is-db'
      : v === 'db2' ? 'is-db'
      : v === 'gen2' ? 'is-gen2'
      : 'is-gen1');
  // Lesson label as a rekhert-style coordinate W<week> L<lesson> Q<num>.
  // Q-number: prefer `source_num` (rekhert's original Q index, lets the user
  // navigate back to the source page); fall back to `num`; finally to a
  // computed 1-based position among lesson-mates.
  let lessonSuffix = '';
  if (q.lesson) {
    const coord = formatLessonCoord(v, q.lesson);
    const qNum = (typeof q.source_num === 'number' && q.source_num > 0) ? q.source_num
               : (typeof q.num === 'number' && q.num > 0) ? q.num
               : getQuestionLessonIndex(q);
    const qPart = qNum ? ` Q${qNum}` : '';
    lessonSuffix = `<span class="q-lesson-label"> · ${escapeHtml(coord + qPart)}</span>`;
  }
  el.innerHTML = escapeHtml(v) + lessonSuffix;
}

// Short exam prefix used to compose copyable IDs like "pl300_247".
// Mirrors ID_PREFIX in src/admin.js and scripts/export_drafts_to_v2.py.
const EXAM_SHORT_PREFIX = {
  'PL-300': 'pl300',
  'AI-900': 'ai900',
  'DP-900': 'dp900',
  'MO-200': 'mo200',
  'IT-Specialist-Python': 'python',
  'STATS': 'stats',
  'ML': 'ml',
  'MATHDS': 'mathds',
  'SQL': 'sql',
  'MIX': 'mix',
  'BI': 'bi',
};

function refreshIdBadge(q, el) {
  el = el || $('qIdBadge');
  if (!el) return;
  if (!q) { el.classList.add('hidden'); el.textContent = ''; return; }
  // Prefer short seq when available; fall back to canonical id (legacy questions
  // not yet migrated).
  const seq = (typeof q.seq === 'number' && q.seq > 0) ? q.seq : null;
  const prefix = EXAM_SHORT_PREFIX[q.exam_code] || '';
  // Prefer the full short form (e.g. pl300_4246) when both seq + prefix exist —
  // that's the canonical short ID users reference in feedback / search.
  const display = (seq !== null && prefix)
    ? `${prefix}_${seq}`
    : (seq !== null ? `#${seq}` : (q.id || ''));
  if (!display) { el.classList.add('hidden'); el.textContent = ''; return; }
  const copyValue = display;
  el.classList.remove('hidden');
  el.classList.remove('copied');
  el.textContent = display;
  el.title = `Click to copy: ${copyValue}`;
  el.onclick = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(copyValue).then(() => {
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1000);
    }).catch(() => {});
  };
}

function refreshQuestionStatsBadge(q, el) {
  el = el || $('qStatsBadge');
  if (!el) return;
  if (!q) { el.classList.add('hidden'); el.textContent = ''; return; }
  const stats = getQuestionStatsMap()[getQuestionKey(q)];
  const total = (stats && typeof stats.total === 'number') ? stats.total : 0;
  if (total === 0) { el.classList.add('hidden'); el.textContent = ''; el.title = ''; return; }
  const correct = (stats && typeof stats.correct === 'number') ? stats.correct : 0;
  el.classList.remove('hidden');
  if (total === 1) {
    el.className = 'question-stats-badge';
    el.textContent = `👁 1× встречался`;
  } else {
    const acc = Math.round((correct / total) * 100);
    const colour = acc >= 80 ? 'stats-badge-green'
                 : acc >= 50 ? 'stats-badge-yellow'
                 : 'stats-badge-red';
    el.className = `question-stats-badge ${colour}`;
    el.textContent = `👁 ${total}× · ${acc}%`;
  }
  const last = stats && stats.lastSeen
    ? new Date(stats.lastSeen).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
    : '—';
  el.title = `Встречался ${total}× · правильно ${correct} · ошибок ${total - correct} · последний раз ${last}`;
}

// Leitner box badge. Hidden when the question has no schedule yet (user
// never answered it) — first answer creates a Box 1 entry, then this
// badge appears on subsequent encounters. Box-colour matches the
// mastery-distribution palette so this stays visually consistent with
// the rest of the app. Intervals are read from LEITNER_INTERVAL_DAYS so
// the tooltip can never drift from the scheduler.
function refreshQuestionBoxBadge(q, el) {
  el = el || $('qBoxBadge');
  if (!el) return;
  if (!q) { el.classList.add('hidden'); el.textContent = ''; return; }
  const key = getQuestionKey(q);
  let entry = null;
  try {
    entry = (loadStore().leitner || {})[key] || null;
  } catch (_) {}
  if (!entry || !entry.box) {
    el.className = 'question-box-badge box-new';
    el.classList.remove('hidden');
    el.textContent = '📦 New';
    el.title = 'Новый вопрос — ещё нет Leitner-записи. После ответа попадёт в Box 1.';
    return;
  }
  const box = Math.max(1, Math.min(5, parseInt(entry.box, 10) || 1));
  el.className = `question-box-badge box-${box}`;
  el.classList.remove('hidden');
  el.textContent = `📦 Box ${box}`;
  const nextStr = entry.nextReviewAt
    ? new Date(entry.nextReviewAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
    : '—';
  const interval = (typeof LEITNER_INTERVAL_DAYS !== 'undefined' && LEITNER_INTERVAL_DAYS[box]) || box;
  el.title = `Leitner Box ${box}/5 · повтор через ${interval} дн. · следующий ${nextStr}. Box 1 = свежая, Box 5 = mastered.`;
}

function refreshFavoriteBtn(q) {
  const btn = $('favoriteBtn');
  if (!btn) return;
  if (!q || S.demoMode) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  const fav = isFavoriteQuestion(q);
  btn.classList.toggle('is-active', fav);
  btn.setAttribute('aria-pressed', fav ? 'true' : 'false');
  btn.title = fav ? 'Remove from favorites' : 'Add to favorites';
  btn.querySelector('.favorite-icon').textContent = fav ? '★' : '☆';
}

function updateMastery(q, correct) {
  const mastery = loadMastery();
  const key = getQuestionKey(q);
  const current = mastery[key] || 0;
  mastery[key] = correct ? Math.min(current + 1, 5) : 0;
  saveMastery(mastery);
}

function updateQuestionStats(q, correct, elapsedMs, selectedKeys) {
  const store = loadStore();
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const examCode = q.exam_code || S.exam;
  if(!store.dailyStats) store.dailyStats = {};
  store.dailyStats[today] = (store.dailyStats[today] || 0) + 1;
  if(!store.dailyCorrect) store.dailyCorrect = {};
  if (correct) store.dailyCorrect[today] = (store.dailyCorrect[today] || 0) + 1;
  let cappedElapsed = 0;
  if (typeof elapsedMs === 'number' && isFinite(elapsedMs) && elapsedMs > 0) {
    if(!store.dailyTimeMs) store.dailyTimeMs = {};
    cappedElapsed = Math.min(elapsedMs, 180000);
    store.dailyTimeMs[today] = (store.dailyTimeMs[today] || 0) + cappedElapsed;
  }
  if (examCode) {
    if(!store.dailyStatsByExam) store.dailyStatsByExam = {};
    if(!store.dailyStatsByExam[examCode]) store.dailyStatsByExam[examCode] = {};
    store.dailyStatsByExam[examCode][today] = (store.dailyStatsByExam[examCode][today] || 0) + 1;
    if (correct) {
      if(!store.dailyCorrectByExam) store.dailyCorrectByExam = {};
      if(!store.dailyCorrectByExam[examCode]) store.dailyCorrectByExam[examCode] = {};
      store.dailyCorrectByExam[examCode][today] = (store.dailyCorrectByExam[examCode][today] || 0) + 1;
    }
    if (cappedElapsed > 0) {
      if(!store.dailyTimeMsByExam) store.dailyTimeMsByExam = {};
      if(!store.dailyTimeMsByExam[examCode]) store.dailyTimeMsByExam[examCode] = {};
      store.dailyTimeMsByExam[examCode][today] = (store.dailyTimeMsByExam[examCode][today] || 0) + cappedElapsed;
    }
  }
  if(!store.hourStats) store.hourStats = {};
  const hour = now.getHours();
  const hb = store.hourStats[hour] || { total: 0, correct: 0 };
  hb.total = (hb.total || 0) + 1;
  if (correct) hb.correct = (hb.correct || 0) + 1;
  store.hourStats[hour] = hb;
  const key = getQuestionKey(q);
  const sectionKey = getQuestionSectionKey(q);
  const current = store.questionStats[key] || {
    exam: q.exam_code || S.exam,
    domain: q.domain || '',
    sectionKey: sectionKey || '',
    sectionLabel: sectionKey ? getSectionLabelFromQuestion(q.exam_code || S.exam, q) : '',
    title: q.title || (q.prompt || '').slice(0, 100),
    correct: 0,
    total: 0,
    wrongStreak: 0,
    lastSeen: 0,
    lastCorrect: 0,
    lastWrong: 0,
  };

  current.total += 1;
  current.exam = q.exam_code || S.exam;
  current.domain = q.domain || current.domain || '';
  current.sectionKey = sectionKey || current.sectionKey || '';
  current.sectionLabel = sectionKey ? getSectionLabelFromQuestion(current.exam, q) : current.sectionLabel || '';
  current.title = q.title || current.title || (q.prompt || '').slice(0, 100);
  current.lastSeen = Date.now();

  if (correct) {
    current.correct += 1;
    current.wrongStreak = 0;
    current.lastCorrect = current.lastSeen;
  } else {
    current.wrongStreak = (current.wrongStreak || 0) + 1;
    current.lastWrong = current.lastSeen;
  }
  // Ring buffer of last 3 outcomes per question — feeds readiness engine's
  // majority-of-3 "currently mastered" check, which is more robust than
  // looking at the single latest answer (a lucky/unlucky single attempt
  // shouldn't flip a question's state in or out of "known").
  var rr = Array.isArray(current.recentResults) ? current.recentResults : [];
  rr.push(!!correct);
  if (rr.length > 3) rr = rr.slice(-3);
  current.recentResults = rr;

  if (Array.isArray(selectedKeys) && selectedKeys.length) {
    if (!current.picks || typeof current.picks !== 'object') current.picks = {};
    selectedKeys.forEach(k => {
      if (!k) return;
      current.picks[k] = (current.picks[k] || 0) + 1;
    });
  }

  store.questionStats[key] = current;

  // Per-answer sectionStats bump. Was previously gated on `cappedElapsed > 0`,
  // which silently dropped stats whenever a session ended without finishQuiz
  // (closed tab, refresh mid-session) since the session-accumulator commit
  // never fired. Now total/correct are written immediately on every MCQ
  // answer, time-tracking stays conditional on a real elapsed measurement.
  if (sectionKey) {
    const exam = current.exam;
    const ssKey = exam + '__' + sectionKey;
    if (!store.sectionStats) store.sectionStats = {};
    if (!store.sectionStats[ssKey]) {
      store.sectionStats[ssKey] = {
        label: getSectionLabelFromQuestion(exam, q) || sectionKey,
        total: 0, correct: 0,
      };
    }
    store.sectionStats[ssKey].total += 1;
    if (correct) store.sectionStats[ssKey].correct += 1;
    store.sectionStats[ssKey].label = getSectionLabelFromQuestion(exam, q) || store.sectionStats[ssKey].label;
    if (cappedElapsed > 0) {
      store.sectionStats[ssKey].timeMs = (store.sectionStats[ssKey].timeMs || 0) + cappedElapsed;
    }
  }

  saveStore(store);
}

// ── Leitner spaced repetition (Tier 7.3) ──────────────────────
// Boxes: 1=tomorrow, 2=+3d, 3=+7d, 4=+14d, 5=+30d.
// Rules:
//  - Wrong (always)           → reset to Box 1, reschedule.
//  - Correct AND due           → advance Box (capped at 5), reschedule.
//  - Correct but NOT due       → keep box and existing schedule untouched.
//    (This is what stops a user from grinding the same question 5x in one
//    session and "fake-advancing" it to Box 5. Spaced repetition requires
//    that retention is tested AFTER the scheduled interval, not within it.
//    Early correct attempts still update questionStats.recentResults for
//    the accuracy signal, just not Leitner box.)
const LEITNER_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];
const LEITNER_DAY_MS = 86400000;

function updateLeitner(q, correct) {
  const store = loadStore();
  const key = getQuestionKey(q);
  const now = Date.now();
  const prev = store.leitner[key] || { box: 1, nextReviewAt: now, lastReviewedAt: 0, exam: q.exam_code || S.exam };
  const wasDue = !prev.nextReviewAt || prev.nextReviewAt <= now;
  let newBox;
  let newNextReviewAt;
  if (!correct) {
    newBox = 1;
    newNextReviewAt = now + LEITNER_INTERVAL_DAYS[1] * LEITNER_DAY_MS;
  } else if (wasDue) {
    newBox = Math.min((prev.box || 1) + 1, 5);
    newNextReviewAt = now + LEITNER_INTERVAL_DAYS[newBox] * LEITNER_DAY_MS;
  } else {
    // Correct but not yet due — leave Box and schedule alone.
    newBox = prev.box || 1;
    newNextReviewAt = prev.nextReviewAt;
  }
  store.leitner[key] = {
    box: newBox,
    nextReviewAt: newNextReviewAt,
    lastReviewedAt: now,
    exam: prev.exam || q.exam_code || S.exam,
  };
  recordLeitnerSnapshot(store);
  saveStore(store);

  // ── Phase 4.1 event: mastery milestone — when a card crosses into
  // long-retention boxes (4 = "+14d", 5 = "mastered"). Skip on incorrect
  // (box reset to 1) and only fire on an actual box advance, not on a
  // not-due no-op. ──
  try {
    if (correct && newBox !== prev.box && (newBox === 4 || newBox === 5)) {
      window.cloudSync?.logEvent?.('mastery_milestone', {
        box: newBox,
        from_box: prev.box || 1,
        exam: q.exam_code || S.exam || null,
        question_id: q.id || null,
      });
    }
  } catch (_) {}
}

// Snapshot the CURRENT Leitner box distribution for today. Same data shape
// as the Mastery Distribution panel but keyed by day, so the per-day chart
// can show how the 1→5 ladder shifts over time. Overwrites today's entry
// every call (cheap — O(N) over the leitner map) so the latest activity
// is always reflected.
function recordLeitnerSnapshot(store) {
  if (!store || typeof store !== 'object') return;
  const today = new Date().toISOString().slice(0, 10);
  const counts = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  const byExam = {};
  const lt = store.leitner || {};
  Object.values(lt).forEach(info => {
    if (!info || typeof info !== 'object') return;
    const box = Number(info.box) || 0;
    if (box < 1 || box > 5) return;
    counts[box] += 1;
    const exam = info.exam;
    if (exam) {
      if (!byExam[exam]) byExam[exam] = { 1:0, 2:0, 3:0, 4:0, 5:0 };
      byExam[exam][box] += 1;
    }
  });
  if (!store.leitnerSnapshotByDay) store.leitnerSnapshotByDay = {};
  store.leitnerSnapshotByDay[today] = counts;
  if (!store.leitnerSnapshotByDayByExam) store.leitnerSnapshotByDayByExam = {};
  Object.entries(byExam).forEach(([exam, c]) => {
    if (!store.leitnerSnapshotByDayByExam[exam]) store.leitnerSnapshotByDayByExam[exam] = {};
    store.leitnerSnapshotByDayByExam[exam][today] = c;
  });
}

function getLeitnerMap() {
  return loadStore().leitner || {};
}

function getLeitnerDuePool(exam) {
  // Leitner due pool ignores version/language/lesson filters AND question_type
  // — the spaced repetition schedule is global to the user, and the question
  // renderer (setQuestion dispatcher) supports every type the user has ever
  // answered (mcq_single, mcq_multiple, drag_drop, hotspot, case_study,
  // open_answer). Otherwise the Scheduled Review CTA count (from
  // getLeitnerStats.due) would disagree with the actual session size.
  const all = getAllExamQuestions(exam);
  if (!all.length) return [];
  const map = getLeitnerMap();
  const now = Date.now();
  return all.filter(q => {
    const entry = map[getQuestionKey(q)];
    if (!entry) return false;
    return (entry.nextReviewAt || 0) <= now;
  });
}

function getLeitnerDueCount(exam) {
  return getLeitnerDuePool(exam).length;
}

const LEITNER_BATCH_SIZE = 30;

function getLeitnerDueBatch(exam) {
  const pool = getLeitnerDuePool(exam);
  if (pool.length <= LEITNER_BATCH_SIZE) return pool;
  const map = getLeitnerMap();
  return pool
    .slice()
    .sort((a, b) => {
      const ta = (map[getQuestionKey(a)] || {}).nextReviewAt || 0;
      const tb = (map[getQuestionKey(b)] || {}).nextReviewAt || 0;
      return ta - tb;
    })
    .slice(0, LEITNER_BATCH_SIZE);
}

// Garbage-collect stale Leitner entries: questions that were removed/renamed
// during content refactors leave dangling entries in localStorage. After
// getLeitnerStats was cross-referenced (commit f165df6) they're already
// invisible to the CTA / Mastery panel / playable pool, but they still take
// up localStorage space and pollute the raw map for any future caller.
// Runs ONCE per session, gated by sessionStorage. Hard safety: requires DB to
// hold >=1000 questions across all exams (sanity floor) before touching the
// map — otherwise a transient load failure could nuke the whole history.
function cleanupStaleLeitnerEntries() {
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('mscp_leitner_cleaned') === '1') {
      return;
    }
    if (!S.db || !S.db.exams) return;
    const allKeys = new Set();
    let totalQ = 0;
    Object.keys(S.db.exams).forEach(code => {
      (S.db.exams[code].questions || []).forEach(q => {
        const k = getQuestionKey(q);
        if (k) { allKeys.add(k); totalQ += 1; }
      });
    });
    if (totalQ < 1000) return;       // sanity floor — DB looks incomplete

    const store = loadStore();
    const map = store.leitner || {};
    const beforeKeys = Object.keys(map);
    if (!beforeKeys.length) {
      try { sessionStorage.setItem('mscp_leitner_cleaned', '1'); } catch (_) {}
      return;
    }
    let removed = 0;
    beforeKeys.forEach(k => {
      if (!allKeys.has(k)) { delete map[k]; removed++; }
    });
    if (removed > 0) {
      store.leitner = map;
      saveStore(store);
      console.log(`[leitner-cleanup] removed ${removed} stale entries (${beforeKeys.length} -> ${beforeKeys.length - removed})`);
    }
    try { sessionStorage.setItem('mscp_leitner_cleaned', '1'); } catch (_) {}
  } catch (e) {
    console.warn('[leitner-cleanup] skipped due to error:', e);
  }
}

function getLeitnerStats(exam) {
  const map = getLeitnerMap();
  const now = Date.now();
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, due: 0, total: 0 };
  // Cross-reference with the currently loaded question DB: legacy Leitner
  // entries for questions that have been removed/renamed in content refactors
  // would otherwise inflate the due count and make "Review N" promise sessions
  // that can't actually load N questions. Mirrors the filter in
  // getLeitnerDuePool so the CTA, the Mastery panel and the playable pool
  // all agree.
  const currentKeys = exam ? new Set(getAllExamQuestions(exam).map(getQuestionKey)) : null;
  Object.entries(map).forEach(([key, e]) => {
    if (exam && e.exam !== exam) return;
    if (currentKeys && !currentKeys.has(key)) return;
    counts.total += 1;
    counts[e.box] = (counts[e.box] || 0) + 1;
    if ((e.nextReviewAt || 0) <= now) counts.due += 1;
  });
  return counts;
}

function updateSectionStats(exam, sectionKey, sectionLabel, correct, total) {
  if (!sectionKey || total <= 0) return;
  const store = loadStore();
  const statsKey = `${exam}__${sectionKey}`;
  if (!store.sectionStats[statsKey]) {
    store.sectionStats[statsKey] = { correct: 0, total: 0, label: sectionLabel || getSectionLabel(exam, sectionKey) };
  }
  store.sectionStats[statsKey].correct += correct;
  store.sectionStats[statsKey].total += total;
  store.sectionStats[statsKey].label = sectionLabel || store.sectionStats[statsKey].label;
  saveStore(store);
}

function updateLegacyDomainStats(exam, domainKey, correct, total) {
  if (!domainKey || total <= 0) return;
  const store = loadStore();
  if (!store.legacyDomainStats) store.legacyDomainStats = {};
  const statsKey = `${exam}__${domainKey}`;
  if (!store.legacyDomainStats[statsKey]) {
    store.legacyDomainStats[statsKey] = { correct: 0, total: 0, label: domainKey };
  }
  store.legacyDomainStats[statsKey].correct += correct;
  store.legacyDomainStats[statsKey].total += total;
  saveStore(store);
}

function incrementSessions() {
  const store = loadStore();
  store.sessions = (store.sessions || 0) + 1;
  saveStore(store);
}

function getWeakSections(exam, minTotal = 3) {
  const store = loadStore();
  return Object.entries(store.sectionStats || {})
    .filter(([key]) => key.startsWith(`${exam}__`))
    .map(([key, value]) => ({
      sectionKey: key.replace(`${exam}__`, ''),
      sectionLabel: value.label || getSectionLabel(exam, key.replace(`${exam}__`, '')),
      pct: value.total > 0 ? Math.round((value.correct / value.total) * 100) : 0,
      total: value.total || 0,
    }))
    .filter(item => item.total >= minTotal && item.pct < 70)
    .sort((a, b) => a.pct - b.pct);
}

function saveLastResult(data) {
  const store = loadStore();
  store.lastResult = data;
  saveStore(store);
}

function loadLastResult() {
  return loadStore().lastResult || null;
}

function clearActiveSession() {
  const store = loadStore();
  delete store.activeSession;
  saveStore(store);
  S.sessionId = null;
}

function loadActiveSession() {
  return loadStore().activeSession || null;
}

function saveActiveSessionSnapshot() {
  if (!S.questions.length) return;
  const store = loadStore();
  store.activeSession = {
    exam: S.exam,
    mode: S.mode,
    section: S.section,
    sessionId: S.sessionId,
    sectionQuestionCount: S.sectionQuestionCount,
    sectionTimerMinutes: S.sectionTimerMinutes,
    practiceQuestionCount: S.practiceQuestionCount,
    mockNum: S.mockNum,
    csLabel: S.csLabel,
    idx: S.idx,
    correct: S.correct,
    timerSec: S.timerSec,
    sessionSectionStats: S.sessionSectionStats,
    sessionLegacyStats: S.sessionLegacyStats,
    sessionWrongQuestions: [...new Set(S.sessionWrongQuestions)],
    questionKeys: S.questions.map(getQuestionKey),
    lastSession: S.lastSession,
    savedAt: Date.now(),
  };
  saveStore(store);
}

function buildQuestionIndex(exam) {
  // Use the UNFILTERED pool so question lookup by key works regardless of
  // the active version/language filter. Otherwise clicking a row in
  // Wrong-answer patterns / Favorites / Weak Questions for a question
  // from a different version threw "Could not find the question".
  const map = new Map();
  const pool = (typeof getAllExamQuestions === 'function')
    ? getAllExamQuestions(exam)
    : getExamQuestions(exam);
  pool.forEach(q => map.set(getQuestionKey(q), q));
  return map;
}

function restoreQuestionsByKeys(exam, keys) {
  const index = buildQuestionIndex(exam);
  return (keys || []).map(key => index.get(key)).filter(Boolean);
}

function getSectionQuestionPool(exam, sectionKey = 'all', includeCaseStudy = true) {
  const ex = getExam(exam);
  if (!ex) return [];
  
  const allowedGroupTypes = includeCaseStudy
    ? new Set(['mini_test', 'std_test', 'case_study'])
    : new Set(['mini_test', 'std_test']);
    
  const allQs = getExamQuestions(exam);

  const questions = allQs.filter(q => {
    if (!allowedGroupTypes.has(q.group_type)) return false;
    return isReviewableQuestion(q);
  });

  if (sectionKey === 'all') return questions;
  return questions.filter(q => (q.section_key || 'other') === sectionKey);
}

function getBlitzQuestionPool(exam) {
  return getPracticeQuestionPool(exam);
}

function getFlashcardQuestionPool(exam, sectionKey = 'all') {
  const qs = getExamQuestions(exam).filter(q =>
    ['mcq_single', 'mcq_multiple'].includes(q.question_type) &&
    Array.isArray(q.options) && q.options.length > 0
  );
  if (sectionKey === 'all') return qs;
  return qs.filter(q => (q.section_key || 'other') === sectionKey);
}

function getFlashSections(exam) {
  const seen = new Map();
  getFlashcardQuestionPool(exam, 'all').forEach(q => {
    const key = q.section_key || 'other';
    if (!seen.has(key)) seen.set(key, getSectionLabel(exam, key));
  });
  return [...seen.entries()].map(([key, name]) => ({ key, name }));
}

function renderFlashDomainCards() {
  const container = $('flashDomainCards');
  if (!container) return;
  const sections = getFlashSections(S.exam);
  const allCount = getFlashcardQuestionPool(S.exam, 'all').length;
  const cards = [{ key: 'all', name: 'All sections', count: allCount }];
  sections.forEach(s => {
    cards.push({ key: s.key, name: s.name, count: getFlashcardQuestionPool(S.exam, s.key).length });
  });
  container.innerHTML = cards.map(card => `
    <div class="domain-card${card.key === S.flashDomain ? ' selected' : ''}" data-key="${card.key}">
      <span>${escapeHtml(card.name)}</span>
      <span class="domain-card-count">${card.count} q.</span>
    </div>
  `).join('');
  container.querySelectorAll('.domain-card').forEach(card => {
    card.addEventListener('click', () => {
      container.querySelectorAll('.domain-card').forEach(n => n.classList.remove('selected'));
      card.classList.add('selected');
      S.flashDomain = card.dataset.key;
      refreshSelectionSummary();
    });
  });
}

function getPracticeQuestionPool(exam) {
  const allQs = getExamQuestions(exam);
  const hasMcq = allQs.some(q => hasChoiceOptions(q));

  return allQs.filter(q => {
    if (q.group_type === 'case_study') return false;
    if (hasMcq && q.question_type === 'open_answer') return false;
    return isReviewableQuestion(q);
  });
}

function getSessionQuestionCount(mode) {
  if (mode === 'practice') {
    const pool = (S.section && S.section !== 'all')
      ? getSectionQuestionPool(S.exam, S.section, true)
      : getPracticeQuestionPool(S.exam);
    return Math.min(pool.length, S.practiceQuestionCount);
  }
  if (mode === 'blitz') return Math.min(getBlitzQuestionPool(S.exam).length, S.practiceQuestionCount);
  if (mode === 'case_study') return getExamQuestions(S.exam).filter(q => q.group_type === 'case_study' && q.group_id === S.csLabel).length;
  if (mode === 'leitner') return getLeitnerDueBatch(S.exam).length;
  if (Array.isArray(S.questions)) return S.questions.length;
  return 0;
}

function formatTimerMinutes(minutes) {
  return minutes ? `${minutes} min` : '—';
}

function getWeakQuestionPool(exam) {
  const pool = getSectionQuestionPool(exam, 'all', true);
  const statsMap = getQuestionStatsMap();
  const weakSections = getWeakSections(exam).map(item => item.sectionKey);

  const scored = pool.map(q => {
    const stats = statsMap[getQuestionKey(q)] || {};
    const total = stats.total || 0;
    const accuracy = total ? stats.correct / total : 1;
    const priority = total === 0 ? -1 : ((1 - accuracy) * 100) + ((stats.wrongStreak || 0) * 20);
    return { q, total, priority };
  })
    .filter(item => item.total > 0 && item.priority > 25)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 12)
    .map(item => item.q);

  if (scored.length) return scored;
  if (weakSections.length) {
    return shuffle(pool.filter(q => weakSections.includes(q.section_key))).slice(0, 10);
  }
  return shuffle(pool).slice(0, 10);
}

function getSmartReviewQuestions(exam, limit = 40) {
  const mastery = loadMastery();
  const statsMap = getQuestionStatsMap();
  const now = Date.now();

  return getExamQuestions(exam)
    .filter(q => isReviewableQuestion(q))
    .map(q => {
      const key = getQuestionKey(q);
      const masteryLevel = mastery[key] || 0;
      const stats = statsMap[key] || {};
      const total = stats.total || 0;
      const accuracyPenalty = total ? (1 - (stats.correct / total)) * 50 : 35;
      const masteryPenalty = (5 - masteryLevel) * 12;
      const wrongStreakBonus = (stats.wrongStreak || 0) * 18;
      const recencyBonus = stats.lastSeen ? Math.min(18, Math.floor((now - stats.lastSeen) / 86400000)) : 10;
      return {
        q,
        score: accuracyPenalty + masteryPenalty + wrongStreakBonus + recencyBonus,
        masteryLevel,
        total,
      };
    })
    .filter(item => item.masteryLevel < 3 || item.total === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.q);
}

function getResultCopy(pct) {
  if (pct >= 90) {
    return { eyebrow: 'Mastery level', message: 'You are showing deep understanding of the material. Keep it up!', grade: 'Elite result', className: 'score-grade excellent' };
  }
  if (pct >= 75) {
    return { eyebrow: 'Strong result', message: 'Excellent foundation. Focus on targeted review of weak spots.', grade: 'High readiness', className: 'score-grade good' };
  }
  if (pct >= 60) {
    return { eyebrow: 'Good foundation', message: 'Most concepts are understood, but more practice is needed.', grade: 'Solid base', className: 'score-grade warm' };
  }
  if (pct >= 50) {
    return { eyebrow: 'On the right track', message: 'You are starting to master the topic. We recommend reviewing theory.', grade: 'Practice needed', className: 'score-grade warm' };
  }
  return { eyebrow: 'Just getting started', message: "Don't get discouraged. This is a great chance to find and close gaps.", grade: 'More time needed', className: 'score-grade bad' };
}

function updateGlobalStats() {
  const store = loadStore();
  const questionStats = store.questionStats || {};

  // Pool respects the active language/version filters AND the currently
  // selected exam (when one is set) — so picking PL-300 scopes the cards
  // to PL-300 questions only. With no exam selected we fall back to the
  // sum across all available exams.
  let totalQuestions = 0;        // exam-wide pool, ignores filters
  let filteredPoolSize = 0;      // pool size after version+language filter
  let filteredCorrect = 0;
  let filteredAttempts = 0;
  let filteredAnsweredUnique = 0;

  if (S.db) {
    const allExamKeys = Object.keys(S.db.exams || {});
    const examScope = (S.exam && allExamKeys.includes(S.exam)) ? [S.exam] : allExamKeys;
    examScope.forEach(examCode => {
      if (!isExamAvailable(examCode)) return;
      const allQs = getAllExamQuestions(examCode);
      totalQuestions += allQs.length;
      const qs = getExamQuestions(examCode); // filtered by version + language
      filteredPoolSize += qs.length;
      qs.forEach(q => {
        const key = getQuestionKey(q);
        const s = questionStats[key];
        if (s && s.total > 0) {
          filteredAnsweredUnique += 1;
          filteredCorrect += s.correct || 0;
          filteredAttempts += s.total || 0;
        }
      });
    });
  }

  $('statTotal').textContent = totalQuestions;
  // Pool sub-line: show "<filtered> in <activeFilter>" when version/lang filter is active.
  const filterNoteEl = $('statTotalFilterNote');
  if (filterNoteEl) {
    const v = S.versionFilter && S.versionFilter !== 'all' ? S.versionFilter : null;
    const lang = S.langFilter && S.langFilter !== 'all' ? S.langFilter : null;
    const parts = [v, lang].filter(Boolean);
    if (parts.length && S.exam) {
      filterNoteEl.textContent = `${filteredPoolSize} in ${parts.join(' + ')}`;
      filterNoteEl.classList.remove('hidden');
    } else {
      filterNoteEl.textContent = '';
      filterNoteEl.classList.add('hidden');
    }
  }
  // Attempts + Accuracy: hybrid by filter state.
  //   • No filter active → canonical Metrics.getAccuracy(sectionStats, exam)
  //     so the card matches Statistics page exactly (per METRICS.md §1).
  //   • Filter active (version / language / lesson / coverage=unseen) →
  //     filter-aware sum from questionStats, so the card reflects the
  //     narrowed pool just like Pool and Coverage cards do.
  // sectionStats doesn't carry version/language metadata, so we can't filter
  // it — questionStats keyed by question id is the only filter-aware source.
  const hasActiveFilter =
       (S.versionFilter && S.versionFilter !== 'all')
    || (S.langFilter && S.langFilter !== 'all')
    || (S.lessonFilter && S.lessonFilter !== 'all')
    || S.coverageFilter === 'unseen';
  let displayAttempts, displayAccuracyPct;
  if (hasActiveFilter) {
    displayAttempts = filteredAttempts;
    displayAccuracyPct = filteredAttempts > 0
      ? Math.round((filteredCorrect / filteredAttempts) * 100)
      : null;
  } else {
    // Read from dailyStatsByExam (per-answer immediate writes) instead of
    // sectionStats, which historically lost answers from unfinished sessions
    // (closed-tab before Finish). After commit 693f122 new sessions write
    // sectionStats per-answer too, but legacy data has a ~555 q gap.
    const accCanonical = (typeof Metrics !== 'undefined' && Metrics.getOverallAttempts)
      ? Metrics.getOverallAttempts(store, S.exam || null)
      : { total: filteredAttempts, correct: filteredCorrect, accuracy: 0 };
    displayAttempts = accCanonical.total;
    displayAccuracyPct = accCanonical.total > 0 ? accCanonical.accuracy : null;
  }
  $('statSessions').textContent = displayAttempts;

  const setTickerTone = (el, tone, pct, arcId) => {
    const ticker = el?.closest('.stat-ticker') || el?.closest('.stat-card');
    if (!ticker) return;
    ticker.removeAttribute('data-tone');
    if (tone) ticker.setAttribute('data-tone', tone);
    if (arcId) {
      const arc = document.getElementById(arcId);
      if (arc && typeof pct === 'number') {
        arc.setAttribute('stroke-dasharray', `${pct} ${100 - pct}`);
      } else if (arc) {
        arc.setAttribute('stroke-dasharray', '0 100');
      }
    }
  };

  const accuracyPct = displayAccuracyPct;
  const accuracyEl = $('statAccuracy');
  if (accuracyEl) {
    accuracyEl.textContent = accuracyPct === null ? '—' : `${accuracyPct}%`;
    setTickerTone(accuracyEl,
      accuracyPct === null ? null
        : accuracyPct >= 70 ? 'good' : accuracyPct >= 50 ? 'warn' : 'bad',
      accuracyPct, 'statAccuracyArc');
  }

  // Coverage = unique answered within the active filter, divided by the
  // size of that filter's pool. Using the exam-wide pool here would always
  // show a tiny number when the user narrows by version/language.
  // Note: intentionally NOT using Metrics.getCoverage — helper is global,
  // this is filter-aware (b219fee). See METRICS.md Known Issues #4.
  const coverageDenom = filteredPoolSize > 0 ? filteredPoolSize : totalQuestions;
  const coveragePct = coverageDenom > 0
    ? Math.round((filteredAnsweredUnique / coverageDenom) * 100)
    : null;
  const coverageEl = $('statCoverage');
  if (coverageEl) {
    coverageEl.textContent = coveragePct === null ? '—' : `${coveragePct}%`;
    setTickerTone(coverageEl,
      coveragePct === null ? null
        : coveragePct >= 50 ? 'good' : coveragePct >= 20 ? 'warn' : 'bad',
      coveragePct, 'statCoverageArc');
  }

  // Sparklines + deltas for home Overall progress cards. Series are
  // exam-aware when an exam filter is active; otherwise use global maps.
  try {
    if (typeof drawSpark === 'function' && typeof _daySeries === 'function') {
      const exam = (S && S.exam) ? S.exam : null;
      const statsMap = (exam && store.dailyStatsByExam && store.dailyStatsByExam[exam])
        || store.dailyStats || {};
      const correctMap = (exam && store.dailyCorrectByExam && store.dailyCorrectByExam[exam])
        || store.dailyCorrect || {};

      // Pool — static count, no time series.
      drawSpark('homeSparkPool', [], false);

      // 7d-window baseline (matches Statistics / Detailed Statistics so the
      // same KPI shows the same Δ across screens — per METRICS.md rule №1).

      // Attempts — daily answer count.
      drawSpark('homeSparkAttempts', _daySeries(statsMap, 14), false);
      const a7 = _sumWindow(statsMap, 0, 7);
      const aPrev7 = _sumWindow(statsMap, 7, 14);
      setDelta('homeDeltaAttempts', a7, aPrev7, '');
      const attEl = $('homeDeltaAttempts');
      if (attEl) attEl.title = `Последние 7д: ${a7} · Пред. 7д: ${aPrev7} (ответов в сумме)`;

      // Accuracy — daily correct/total %.
      const accPts = _daySeries(statsMap, 14, function(total, k) {
        if (!total) return null;
        const c = Number(correctMap[k]) || 0;
        return Math.round((c / total) * 100);
      });
      drawSpark('homeSparkAccuracy', accPts, true);
      if (typeof computeAccuracyWindowDeltas === 'function') {
        const ad = computeAccuracyWindowDeltas(store, exam);
        setDelta('homeDeltaAccuracy', ad.last7, ad.prev7, '%');
        const accDeltaEl = $('homeDeltaAccuracy');
        if (accDeltaEl) {
          const fmt = (acc, total, correct) => acc != null
            ? `${acc}% (${correct}/${total})`
            : (total > 0 ? `${correct}/${total}` : 'нет ответов');
          accDeltaEl.title =
            `Последние 7д: ${fmt(ad.last7, ad.last7Total, ad.last7Correct)} · ` +
            `Пред. 7д: ${fmt(ad.prev7, ad.prev7Total, ad.prev7Correct)}`;
        }
      }

      // Coverage — daily snapshot from leitnerSnapshotByDay(ByExam). Compares
      // latest non-null snapshot vs ~7 entries back in the non-null series.
      const covPts = (typeof _coverageDaySeries === 'function')
        ? _coverageDaySeries(store, exam, coverageDenom)
        : [];
      drawSpark('homeSparkCoverage', covPts, true);
      const covVals = covPts.filter(p => p.y != null);
      const covEl = $('homeDeltaCoverage');
      if (covVals.length >= 2) {
        const lastCov = covVals[covVals.length - 1].y;
        const weekAgoCov = covVals[Math.max(0, covVals.length - 8)].y;
        setDelta('homeDeltaCoverage', lastCov, weekAgoCov, '%');
        if (covEl) covEl.title = `Сейчас: ${lastCov}% · ~7д назад: ${weekAgoCov}% (охват пула)`;
      } else {
        setDelta('homeDeltaCoverage', null, null, '');
        if (covEl) covEl.title = 'Недостаточно данных для сравнения';
      }
    }
  } catch (e) { console.warn('home sparkline populate failed', e); }

  // Heatmap & Streaks
  const dailyStats = store.dailyStats || {};
  const todayStr = new Date().toISOString().split('T')[0];
  const streak = Metrics.getStreak(store);
  const streakEl = $('headerStreak');
  if (streakEl) {
    streakEl.querySelector('span').textContent = streak;
    streakEl.classList.toggle('hidden', streak === 0);
  }

  // Lift strip: today count, streak, contextual CTA
  const liftCountEl = document.getElementById('liftTodayCount');
  if (liftCountEl) liftCountEl.textContent = (dailyStats[todayStr] || 0);
  const liftStreakNumEl = document.getElementById('liftStreakNum');
  if (liftStreakNumEl) liftStreakNumEl.textContent = streak;

  const liftSubEl = document.getElementById('liftSubline');
  const liftCtaEl = document.getElementById('liftCta');
  // Inline daily-plan progress line, lives directly under #liftSubline in
  // the meta area. Echoes the chip on the right for at-a-glance reading
  // without forcing eyes to jump across the strip.
  const liftPlanInlineEl = document.getElementById('liftPlanInline');
  if (liftPlanInlineEl) {
    const { answered: todayG, goal: planT, pct: pctG } =
      Metrics.getTodayProgress(store, userProfile);
    liftPlanInlineEl.innerHTML =
      '🎯 <strong>' + todayG + '<span class="lift-plan-inline-sep">/</span>' + planT + '</strong> daily plan · ' + pctG + '%';
    liftPlanInlineEl.classList.toggle('is-hit', pctG >= 100);
    liftPlanInlineEl.classList.toggle('is-mid', pctG >= 50 && pctG < 100);
    liftPlanInlineEl.classList.toggle('is-low', pctG < 50);
  }
  if (liftSubEl && liftCtaEl) {
    const resumePanel = document.getElementById('resumePanel');
    const hasResume = resumePanel && !resumePanel.classList.contains('hidden');
    const ctaLabel = liftCtaEl.querySelector('.lift-cta-label');
    if (hasResume) {
      liftSubEl.textContent = 'You have a paused session ready.';
      if (ctaLabel) ctaLabel.textContent = 'Resume session';
      liftCtaEl.onclick = () => document.getElementById('resumeBtn')?.click();
    } else if ((dailyStats[todayStr] || 0) === 0) {
      liftSubEl.textContent = streak > 0
        ? 'Warm up with one quick question to keep the streak.'
        : 'Try one quick question — no commitment.';
      if (ctaLabel) ctaLabel.textContent = 'Daily question';
      liftCtaEl.onclick = () => {
        const dailyToggle = document.querySelector('#dailyChallengeSection .daily-toggle');
        if (dailyToggle) dailyToggle.click();
        else document.querySelector('.mode-card[data-mode="practice"]')?.click();
      };
    } else {
      liftSubEl.textContent = 'Nice — pick a section to focus on next.';
      if (ctaLabel) ctaLabel.textContent = 'Pick section';
      liftCtaEl.onclick = () => {
        document.getElementById('domainSection')?.classList.remove('is-collapsed');
        document.getElementById('domainSectionToggle')?.setAttribute('aria-expanded', 'true');
        document.getElementById('domainSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    }
  }
  const heatmapWrap = $('heatmapWrap');
  if (heatmapWrap) {
    const dailyCorrect = store.dailyCorrect || {};
    let html = '';
    // 28-day window (4 weeks). Title says "Activity" so the cell color
    // encodes question count only (more questions ⇒ greener). Accuracy
    // is surfaced in the tooltip, not the color, so 200 q at 65% doesn't
    // look "worse" than 50 q at 95% on a panel literally labelled
    // "Activity". Buckets are tuned to this user's range (median ~50,
    // peak ~300).
    for(let i=27; i>=0; i--) {
      let d2 = new Date();
      d2.setUTCDate(d2.getUTCDate() - i);
      const ds = d2.toISOString().split('T')[0];
      const count = dailyStats[ds] || 0;
      const correct = dailyCorrect[ds] || 0;
      const pct = count > 0 ? Math.round(correct / count * 100) : null;
      let intensityCls = '';
      if (count >= 100) intensityCls = 'acc-good active-high';
      else if (count >= 30) intensityCls = 'acc-good active-med';
      else if (count > 0)  intensityCls = 'acc-good active-low';
      const dayNum = d2.getDate();
      const inner = count > 0
        ? `<div class="heatmap-day-date">${dayNum}</div><div class="heatmap-day-count">${count}</div>`
        : `<div class="heatmap-day-date heatmap-day-date-empty">${dayNum}</div>`;
      const tip = count > 0 ? `${ds}: ${count} q.${pct !== null ? ', ' + pct + '% correct' : ''}` : `${ds}: no activity`;
      html += `<div class="heatmap-day ${intensityCls}" title="${tip}">${inner}</div>`;
    }
    heatmapWrap.innerHTML = html;
    // Weekday header was useful for 7 cells; at 28 cells in 4 rows the
    // weekday labels no longer column-align cleanly, so we hide it.
    const weekdayContainer = document.querySelector('.heatmap-weekdays');
    if (weekdayContainer) weekdayContainer.innerHTML = '';
  }
}

function updateHeaderBadge() {
  const store = loadStore();
  const stats = [
    ...Object.values(store.sectionStats || {}),
    ...Object.values(store.legacyDomainStats || {}),
  ];
  const badge = $('headerBadge');
  if (badge) badge.remove();
}

function getSectionCards(exam) {
  const ex = getExam(exam);
  const pool = getSectionQuestionPool(exam, 'all', true);
  if (!pool.length) return [];

  const counts = pool.reduce((acc, q) => {
    const key = q.section_key || 'other';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  
  const sectionKeys = Object.keys(ex?.sections || {});
  const keysWithData = Object.keys(counts).filter(key => counts[key]);
  
  // Sort keys: defined sections first, then 'other'
  const orderedKeys = [
    ...sectionKeys.filter(k => counts[k]),
    ...keysWithData.filter(k => !sectionKeys.includes(k))
  ];

  const cards = orderedKeys.map(key => ({
    key,
    name: key === 'other' ? 'No section' : getSectionLabel(exam, key),
    count: counts[key] || 0,
  }));

  // Only show "All Sections" if there's more than one section with data
  if (cards.length > 1) {
    return [{ key: 'all', name: 'All sections', count: pool.length }, ...cards];
  }
  return cards;
}

function renderScopeCards() {
  const container = $('domainCards');
  const label = $('domainSectionLabel');
  const examLabel = $('domainExamLabel');
  const cards = getSectionCards(S.exam);
  const selectedKey = S.section;

  label.textContent = 'Section';
  examLabel.textContent = `— ${getExam(S.exam)?.name || S.exam}`;
  container.innerHTML = cards.map(card => `
    <div class="domain-card${card.key === selectedKey ? ' selected' : ''}" data-key="${card.key}">
      <span>${card.name}</span>
      <span class="domain-card-count">${card.count} q.</span>
    </div>
  `).join('');

  container.querySelectorAll('.domain-card').forEach(card => {
    card.addEventListener('click', () => {
      container.querySelectorAll('.domain-card').forEach(node => node.classList.remove('selected'));
      card.classList.add('selected');
      S.section = card.dataset.key;
      updateBadges();
      refreshSelectionSummary();
    });
  });
}

function updatePickersForExam() {
  const allQs = getExamQuestions(S.exam);

  const caseQs = allQs.filter(q => q.group_type === 'case_study');
  const caseIds = [...new Set(caseQs.map(q => q.group_id))].sort((a, b) => String(a).localeCompare(String(b), 'en'));
  const casePicker = $('casePicker');
  casePicker.innerHTML = caseIds.length
    ? caseIds.map(id => {
        const sample = caseQs.find(q => q.group_id === id);
        const count = caseQs.filter(q => q.group_id === id).length;
        const name = sample?.section_label || sample?.title || id;
        return `<option value="${id}">Case ${id}: ${name} (${count} q.)</option>`;
      }).join('')
    : '<option value="">No cases</option>';
  S.csLabel = caseIds[0] || null;
  casePicker.onchange = () => {
    S.csLabel = casePicker.value;
    refreshSelectionSummary();
  };
}

function updateBadges() {
  $('badgePractice').textContent = `${Math.min(S.practiceQuestionCount, getPracticeQuestionPool(S.exam).length)} q.`;
  $('badgeCase').textContent = S.csLabel ? `${$('casePicker').options.length} cases` : 'none';
  const badgeWeakEl = $('badgeWeak');
  if (badgeWeakEl) badgeWeakEl.textContent = `${getWeakSections(S.exam).length} topics`;
  $('badgeSmart').textContent = `${getSmartReviewQuestions(S.exam, S.practiceQuestionCount).length} q.`;
  const leitnerBadge = $('badgeLeitner');
  if (leitnerBadge) {
    const due = getLeitnerDueCount(S.exam);
    leitnerBadge.textContent = due ? `${due} due today` : 'none';
  }
  const flashBadge = $('badgeFlashcard');
  if (flashBadge) {
    const total = getFlashcardQuestionPool(S.exam, 'all').length;
    flashBadge.textContent = total ? `${Math.min(S.flashcardQuestionCount, total)} cards` : 'none';
  }
}

function updateHomeForExam() {
  S.section = 'all';
  S.flashDomain = 'all';
  S.flashcardQuestionCount = 10;
  S.sectionTimerMinutes = 0;
  S.practiceQuestionCount = 10;
  $('practiceCountPicker').value = String(S.practiceQuestionCount);
  $('flashcardCountPicker').value = String(S.flashcardQuestionCount);
  updatePickersForExam();
  updateBadges();
  updateModeUI();
}

function updateModeUI() {
  const isFlash = S.mode === 'flashcard';
  const flashSec = $('flashDomainSection');
  if (flashSec) flashSec.classList.toggle('hidden', !isFlash);
  $('flashcardCountWrap').classList.toggle('hidden', !isFlash);

  const showScopePicker = S.mode === 'practice';
  $('domainSection').classList.toggle('hidden', !showScopePicker);
  $('practiceCountWrap').classList.toggle('hidden', !['practice', 'blitz', 'smart'].includes(S.mode));
  $('casePickerWrap').classList.toggle('hidden', S.mode !== 'case_study');
  document.querySelectorAll('.mode-card').forEach(card => {
    const m = card.dataset.mode;
    if (m) card.classList.toggle('unavailable', !isModeAvailableForExam(m));
  });
  if (isFlash) renderFlashDomainCards();
  if (showScopePicker) renderScopeCards();
  refreshSelectionSummary();
}

function getCurrentSectionName() {
  if (S.section === 'all') return 'All sections';
  return getSectionLabel(S.exam, S.section);
}

function getSessionPreview() {
  const ex = getExam(S.exam);
  if (!ex) {
    return {
      title: 'Choose your training format',
      desc: 'Pick an exam, a mode and a question pool to start without extra clicks.',
      ctaTitle: 'Ready to start',
      ctaSub: 'Review your selection and start the session.',
      buttonLabel: 'Start test',
      count: 0,
      disabledReason: '',
      pills: [],
    };
  }

  if (!isExamAvailable(S.exam)) {
    return {
      title: 'Exam not available yet',
      desc: 'This exam pack is not yet published in the new export layer, so a session cannot be started.',
      ctaTitle: ex.name || ex.title || S.exam,
      ctaSub: ex.status || 'Awaiting publication',
      buttonLabel: 'Unavailable',
      count: 0,
      disabledReason: 'Choose a published exam from data/questions.v2.json to start a session.',
      pills: [
        { label: 'Exam', value: ex.name || ex.title || S.exam },
        { label: 'Status', value: ex.status || 'not publish-ready' },
      ],
    };
  }

  const preview = {
    title: 'Session ready',
    desc: 'All key parameters are set — you can start the session.',
    ctaTitle: 'Ready to start',
    ctaSub: 'Review your selection and start the session.',
    buttonLabel: 'Start test',
    count: 0,
    disabledReason: '',
    pills: [
      { label: 'Exam', value: ex.name || S.exam },
      { label: 'Mode', value: getModeLabel(S.mode) },
    ],
  };

  if (S.mode === 'practice') {
    const isSectionFocus = S.section && S.section !== 'all';
    const pool = isSectionFocus
      ? getSectionQuestionPool(S.exam, S.section, true)
      : getPracticeQuestionPool(S.exam);
    const count = Math.min(S.practiceQuestionCount, pool.length);
    const timerMinutes = count * 2;
    preview.title = 'Practice';
    preview.desc = isSectionFocus
      ? 'Questions only from the selected section, regular random sampling.'
      : 'Random sampling by exam weights — section proportions as in the real test.';
    preview.ctaTitle = isSectionFocus ? getCurrentSectionName() : 'All sections (by weights)';
    preview.ctaSub = count ? `${count} questions · timer ${timerMinutes} min.` : 'No matching questions.';
    preview.buttonLabel = count ? 'Start practice' : 'No questions to start';
    preview.count = count;
    preview.disabledReason = count ? '' : 'Change section or exam to build a session.';
    const sizeLabel = count < S.practiceQuestionCount
      ? `${count} of ${S.practiceQuestionCount} questions`
      : `${count} questions`;
    preview.pills.push(
      { label: 'Section', value: isSectionFocus ? getCurrentSectionName() : 'All' },
      { label: 'Size', value: sizeLabel },
      { label: 'Timer', value: formatTimerMinutes(timerMinutes) }
    );
    return preview;
  }

  if (S.mode === 'blitz') {
    const total = getBlitzQuestionPool(S.exam).length;
    const count = Math.min(S.practiceQuestionCount, total);
    preview.title = 'Blitz (Swipe cards)';
    preview.desc = 'Swipe cards right (know) or left (don\'t know) for quick answers.';
    preview.ctaTitle = 'Quick cards';
    preview.ctaSub = count ? `${count} questions from the pool.` : 'No questions for blitz.';
    preview.buttonLabel = count ? 'Start blitz' : 'No questions';
    preview.count = count;
    preview.disabledReason = count ? '' : 'Need questions for Blitz mode.';
    preview.pills.push(
      { label: 'Size', value: `${S.practiceQuestionCount} questions` },
      { label: 'Mechanic', value: 'Swipe / Cards' }
    );
    return preview;
  }

  if (S.mode === 'case_study') {
    const count = getExamQuestions(S.exam).filter(q => q.group_type === 'case_study' && q.group_id === S.csLabel).length;
    preview.title = 'Scenario thinking practice';
    preview.desc = 'One scenario, multiple questions — a more realistic way to practice cases.';
    preview.ctaTitle = getSelectedOptionText('casePicker', 'No case selected');
    const timerMinutes = count * 2;
    preview.ctaSub = count ? `${count} questions with a ${timerMinutes} min timer.` : 'No case available to start.';
    preview.buttonLabel = count ? 'Open case study' : 'No case';
    preview.count = count;
    preview.disabledReason = count ? '' : 'Select a different case study.';
    preview.pills.push(
      { label: 'Timer', value: formatTimerMinutes(timerMinutes) },
      { label: 'In session', value: `${count} questions` }
    );
    return preview;
  }

  if (S.mode === 'weak') {
    const weakSections = getWeakSections(S.exam);
    const count = getWeakQuestionPool(S.exam).length;
    preview.title = 'Review weak sections';
    preview.desc = 'Session is built from sections based on your stats and error history.';
    preview.ctaTitle = weakSections.length ? `${weakSections.length} weak sections found` : 'Stats still being collected';
    preview.ctaSub = count ? `${count} questions ready for review.` : 'Not enough data yet for a weak session.';
    preview.buttonLabel = count ? 'Review weak topics' : 'Not enough data';
    preview.count = count;
    preview.disabledReason = count ? '' : 'You need accumulated progress first (at least 3 attempts per question).';
    preview.pills.push(
      { label: 'Weak areas', value: `${weakSections.length}` },
      { label: 'In session', value: `${count} questions` }
    );
    return preview;
  }

  if (S.mode === 'smart') {
    const count = getSmartReviewQuestions(S.exam, S.practiceQuestionCount).length;
    preview.title = 'Spaced repetition';
    preview.desc = 'Selection of questions based on mastery, error history and how long since last review.';
    preview.ctaTitle = 'Smart Review';
    preview.ctaSub = count ? `${count} questions ready for review right now.` : 'No questions need smart review right now.';
    preview.buttonLabel = count ? 'Start Smart Review' : 'Smart Review is empty';
    preview.count = count;
    preview.disabledReason = count ? '' : 'Complete a few sessions first to build up history.';
    preview.pills.push(
      { label: 'Filter', value: 'Mastery + errors' },
      { label: 'In session', value: `${count} questions` }
    );
  }

  if (S.mode === 'leitner') {
    const stats = getLeitnerStats(S.exam);
    const due = stats.due;
    const sessionSize = Math.min(due, LEITNER_BATCH_SIZE);
    const timerMinutes = sessionSize * 2;
    const isPartial = due > LEITNER_BATCH_SIZE;
    preview.title = 'Scheduled review (Leitner)';
    preview.desc = 'Long-term retention via boxes: correct answer — interval grows, wrong — back to tomorrow.';
    preview.ctaTitle = due
      ? (isPartial
          ? `${sessionSize} of ${due} due — this session · timer ${timerMinutes} min.`
          : `${due} questions due today · timer ${timerMinutes} min.`)
      : 'All caught up for today';
    preview.ctaSub = stats.total
      ? (isPartial
          ? `Most-overdue cards first. Remaining ${due - sessionSize} stay queued for next session.`
          : `Tracking ${stats.total} questions total · boxes: 1=${stats[1]}, 2=${stats[2]}, 3=${stats[3]}, 4=${stats[4]}, 5=${stats[5]}`)
      : 'Answer any question — it goes into box 1 and shows up tomorrow.';
    preview.buttonLabel = due ? 'Start review' : 'Nothing overdue';
    preview.count = due;
    preview.disabledReason = due ? '' : 'Come back tomorrow — the next batch will be ready.';
    preview.pills.push(
      { label: 'In session', value: `${sessionSize}` },
      { label: 'Total due', value: `${due}` },
      { label: 'Timer', value: formatTimerMinutes(timerMinutes) }
    );
  }

  if (S.mode === 'flashcard') {
    const total = getFlashcardQuestionPool(S.exam, S.flashDomain).length;
    const count = Math.min(S.flashcardQuestionCount, total);
    const sectionLabel = S.flashDomain === 'all' ? 'All sections' : getSectionLabel(S.exam, S.flashDomain);
    preview.title = 'Flashcards';
    preview.desc = 'Reveal the answer, then swipe: right — know, left — don\'t know.';
    preview.ctaTitle = sectionLabel;
    preview.ctaSub = total ? `${total} cards in the section, ${count} in this session.` : 'No cards for the selected section.';
    preview.buttonLabel = total ? 'Start flashcards' : 'No cards';
    preview.count = total;
    preview.disabledReason = total ? '' : 'No MCQ questions for this exam.';
    preview.pills.push(
      { label: 'Section', value: sectionLabel },
      { label: 'In session', value: String(count) }
    );
    return preview;
  }

  if (preview.count === 0 && !preview.disabledReason) {
    preview.disabledReason = 'No questions yet for this exam in the selected mode.';
    preview.buttonLabel = 'Mode unavailable';
  }

  return preview;
}

function refreshSelectionSummary() {
  const preview = getSessionPreview();
  // Selection panel was removed — write only to elements that still exist.
  const t = $('selectionTitle'); if (t) t.textContent = preview.title;
  const d = $('selectionDesc'); if (d) d.textContent = preview.desc;
  const p = $('selectionPills');
  if (p) {
    p.innerHTML = preview.pills.map(item => `
      <div class="selection-pill">
        <span>${item.label}</span>
        <strong>${item.value}</strong>
      </div>
    `).join('');
  }
  $('startHintTitle').textContent = preview.ctaTitle;
  $('startHintSub').textContent = preview.disabledReason || preview.ctaSub;
  $('startBtn').textContent = isPremium ? preview.buttonLabel : '🔒 Access locked';
  $('startBtn').disabled = preview.count === 0 || !isPremium;
  if (!isPremium) {
    $('actionSub').textContent = 'Your account is in view-only mode. Contact the administrator to get test access.';
  }
}

function buildQuestionSet() {
  if (S.mode === 'practice') {
    if (S.section && S.section !== 'all') {
      return shuffle(getSectionQuestionPool(S.exam, S.section, true)).slice(0, S.practiceQuestionCount);
    }
    return buildStratifiedSession(S.exam, S.practiceQuestionCount);
  }
  if (S.mode === 'blitz') return shuffle(getBlitzQuestionPool(S.exam)).slice(0, S.practiceQuestionCount);
  if (S.mode === 'flashcard') return shuffle(getFlashcardQuestionPool(S.exam, S.flashDomain)).slice(0, S.flashcardQuestionCount);
  if (S.mode === 'case_study') return getExamQuestions(S.exam).filter(q => q.group_type === 'case_study' && q.group_id === S.csLabel);
  if (S.mode === 'weak') return getWeakQuestionPool(S.exam);
  if (S.mode === 'smart') return getSmartReviewQuestions(S.exam, S.practiceQuestionCount);
  if (S.mode === 'leitner') return shuffle(getLeitnerDueBatch(S.exam));
  return [];
}

function getTimerForMode(mode) {
  if (mode === 'practice' || mode === 'case_study' || mode === 'leitner') {
    return getSessionQuestionCount(mode) * 2 * 60;
  }
  if (mode === 'smart') {
    return getSessionQuestionCount(mode) * 90;
  }
  return null;
}

function startPreparedSession(qs, meta, options = {}) {
  if (!qs.length) {
    alert('No questions for the selected mode');
    return;
  }

  S.exam = meta.exam;
  // Stable session id (per Start until finishQuiz). Generated once; reused
  // when resumeSavedSession passes options.sessionId from the snapshot.
  S.sessionId = options.sessionId
    || S.sessionId
    || `${meta.exam}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // Migration: legacy mock and section modes no longer have their own cards;
  // both route to practice (practice now carries the section filter).
  S.mode = (meta.mode === 'mock' || meta.mode === 'section') ? 'practice' : meta.mode;
  S.flashDomain = meta.flashDomain || S.flashDomain || 'all';
  S.flashRevealed = false;
  S.section = meta.section ?? 'all';
  S.sectionQuestionCount = meta.sectionQuestionCount ?? S.sectionQuestionCount ?? 10;
  S.sectionTimerMinutes = meta.sectionTimerMinutes ?? S.sectionTimerMinutes ?? 0;
  S.practiceQuestionCount = meta.practiceQuestionCount ?? S.practiceQuestionCount ?? 10;
  S.mockNum = meta.mockNum ?? null;
  S.csLabel = meta.csLabel ?? null;
  S.questions = qs;
  S.idx = options.idx || 0;
  S.correct = options.correct || 0;
  S.sessionSectionStats = options.sessionSectionStats || {};
  S.sessionLegacyStats = options.sessionLegacyStats || {};
  S.sessionWrongQuestions = options.sessionWrongQuestions || [];
  S.lastSession = {
    exam: meta.exam,
    mode: meta.mode,
    section: meta.section ?? 'all',
    sectionQuestionCount: meta.sectionQuestionCount ?? S.sectionQuestionCount ?? 10,
    sectionTimerMinutes: meta.sectionTimerMinutes ?? S.sectionTimerMinutes ?? 0,
    practiceQuestionCount: meta.practiceQuestionCount ?? S.practiceQuestionCount ?? 10,
    mockNum: meta.mockNum ?? null,
    csLabel: meta.csLabel ?? null,
    questionKeys: qs.map(getQuestionKey),
    source: meta.source || meta.mode,
  };

  const restoreTimer = Number.isFinite(options.timerSec) ? options.timerSec : null;
  if (restoreTimer !== null) {
    if (restoreTimer > 0) {
      startTimer(restoreTimer);
    } else {
      stopTimer();
      $('timerDisplay').classList.add('hidden');
    }
  } else {
    const seconds = getTimerForMode(meta.mode);
    if (seconds) {
      startTimer(seconds);
    } else {
      stopTimer();
      $('timerDisplay').classList.add('hidden');
    }
  }

  showScreen('quiz');
  renderQuestion();

  // ── Phase 4.1 event: session lifecycle ──
  try {
    window.cloudSync?.logEvent?.('session_start', {
      mode: S.mode || null,
      exam: S.exam || null,
      count: qs.length,
      source: meta.source || meta.mode || null,
      resumed: !!options.sessionId,
    });
  } catch (_) {}
}

async function startQuiz() {
  const qs = buildQuestionSet();
  startPreparedSession(qs, {
    exam: S.exam,
    mode: S.mode,
    section: S.section,
    sectionQuestionCount: S.sectionQuestionCount,
    sectionTimerMinutes: S.sectionTimerMinutes,
    practiceQuestionCount: S.practiceQuestionCount,
    mockNum: S.mockNum,
    csLabel: S.csLabel,
    flashDomain: S.flashDomain,
  });
}

async function retrySession() {
  if (!S.lastSession?.questionKeys) {
    showScreen('home');
    return;
  }
  const qs = restoreQuestionsByKeys(S.lastSession.exam, S.lastSession.questionKeys);
  startPreparedSession(qs, S.lastSession);
}

async function startWeakSession() {
  startPreparedSession(getWeakQuestionPool(S.exam), {
    exam: S.exam,
    mode: 'weak',
    section: S.section,
    sectionQuestionCount: S.sectionQuestionCount,
    sectionTimerMinutes: S.sectionTimerMinutes,
    practiceQuestionCount: S.practiceQuestionCount,
    mockNum: null,
    csLabel: null,
    source: 'weak',
  });
}

async function resumeSavedSession() {
  const active = loadActiveSession();
  if (!active || !getExam(active.exam)) {
    updateResumePanel();
    return;
  }
  const qs = restoreQuestionsByKeys(active.exam, active.questionKeys);
  if (!qs.length) {
    clearActiveSession();
    updateResumePanel();
    return;
  }
  startPreparedSession(qs, {
    exam: active.exam,
    mode: active.mode,
    section: active.section,
    sectionQuestionCount: active.sectionQuestionCount,
    sectionTimerMinutes: active.sectionTimerMinutes,
    practiceQuestionCount: active.practiceQuestionCount,
    mockNum: active.mockNum,
    csLabel: active.csLabel,
    source: 'resume',
  }, {
    idx: Math.min(active.idx || 0, Math.max(qs.length - 1, 0)),
    correct: active.correct || 0,
    sessionSectionStats: active.sessionSectionStats || {},
    sessionLegacyStats: active.sessionLegacyStats || {},
    sessionWrongQuestions: active.sessionWrongQuestions || [],
    timerSec: active.timerSec,
    sessionId: active.sessionId,
  });
}

async function retryWrongAnswers() {
  const lastResult = loadLastResult();
  if (!lastResult?.wrongQuestionKeys?.length) {
    alert('No saved mistakes to review');
    return;
  }
  const qs = restoreQuestionsByKeys(lastResult.exam, lastResult.wrongQuestionKeys);
  if (!qs.length) {
    alert('Could not gather questions for mistake review');
    return;
  }
  startPreparedSession(qs, {
    exam: lastResult.exam,
    mode: 'smart',
    section: 'all',
    sectionQuestionCount: S.sectionQuestionCount,
    sectionTimerMinutes: 0,
    practiceQuestionCount: S.practiceQuestionCount,
    mockNum: null,
    csLabel: null,
    source: 'retry_wrong',
  });
}

function updateResumePanel() {
  const panel = $('resumePanel');
  const active = loadActiveSession();
  if (!panel || !active || !getExam(active.exam)) {
    panel?.classList.add('hidden');
    return;
  }

  const examName = getExam(active.exam).name || active.exam;
  const total = (active.questionKeys || []).length;
  const current = Math.min((active.idx || 0) + 1, Math.max(total, 1));
  $('resumeTitle').textContent = `${examName} · ${getModeLabel(active.mode)}`;
  $('resumeDesc').textContent = `Continue from question ${current} of ${total}. Progress is saved locally.`;
  panel.classList.remove('hidden');
}

function getOptionMeta(opt, idx) {
  if (opt && typeof opt === 'object') {
    // Support both schemas: {key,text} (legacy) and {id,text} (DataBoom imports)
    const k = opt.key || opt.id;
    if (k) {
      return { label: k, answerKey: String(k).toUpperCase(), text: opt.text || '' };
    }
  }

  const raw = String(opt || '').trim();
  const prefixed = raw.match(/^([A-ZА-ЯЁ])[\.\)]\s+([\s\S]+)$/u);
  const answerKey = prefixed ? prefixed[1].toUpperCase() : String.fromCharCode(65 + idx);
  const label = String.fromCharCode(65 + idx);
  const text = prefixed ? prefixed[2] : raw;
  return { label, answerKey, text };
}

function getCorrectAnswerKeys(q) {
  if (!Array.isArray(q.correct_answers)) return [];
  const validKeys = Array.isArray(q.options)
    ? q.options.map((opt, idx) => getOptionMeta(opt, idx).answerKey)
    : [];
  const validSet = new Set(validKeys);

  return [...new Set(
    q.correct_answers
      .map(answer => String(answer).trim().toUpperCase())
      .filter(answer => !validSet.size || validSet.has(answer))
  )];
}

function renderMCQ(q) {
  const list = $('optionsList');
  const multiAnswer = q.question_type === 'mcq_multiple';
  const displayOptions = shuffleOptionsForDisplay(q.options);
  list.innerHTML = displayOptions.map((opt, idx) => {
    const meta = getOptionMeta(opt, idx);
    const displayLabel = String.fromCharCode(65 + idx);
    return `
      <button class="option-btn" data-answer-key="${meta.answerKey}" data-idx="${idx}">
        <span class="option-letter">${displayLabel}</span>
        <span>${escapeHtml(meta.text)}</span>
      </button>
    `;
  }).join('');

  const submitBtn = $('mcqSubmitBtn');
  submitBtn.textContent = multiAnswer ? 'Check answers' : 'Check answer';
  submitBtn.classList.toggle('hidden', !multiAnswer);
  submitBtn.disabled = true;

  list.querySelectorAll('.option-btn').forEach(btn => {
    if (multiAnswer) {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        btn.classList.toggle('selected');
        submitBtn.disabled = list.querySelectorAll('.option-btn.selected').length === 0;
      });
      return;
    }

    btn.addEventListener('click', () => handleMCQAnswer([btn], q));
  });
}

function renderOpen(q) {
  $('answerReveal').classList.remove('visible');
  $('selfAssess').classList.remove('visible');
  $('revealText').textContent = q.answer_text || '—';
  $('revealBtn').classList.remove('hidden');
  $('revealBtn').disabled = false;
}

// Drag-and-drop (sequence) renderer. Click-to-add UX: clicking a card in
// the pool moves it to the answer area; clicking in the answer area sends
// it back. ↑/↓ buttons reorder. Correct = exact ordered match to
// q.correct_sequence (no partial credit, matches Microsoft scoring).
function renderDragDrop(q) {
  const pool = $('ddPool');
  const answer = $('ddAnswer');
  const submitBtn = $('ddSubmitBtn');
  if (!pool || !answer || !submitBtn) return;

  // S.ddState lives only for the current question; reset on each render.
  S.ddState = { selected: [], poolKeys: (q.actions_pool || []).map(a => a.key) };
  const byKey = {};
  (q.actions_pool || []).forEach(a => { byKey[a.key] = a; });

  function rerender() {
    const targetLen = (q.correct_sequence || []).length;
    pool.innerHTML = S.ddState.poolKeys.map(k => {
      const a = byKey[k];
      if (!a) return '';
      return '<button class="dd-card" data-key="' + escapeHtml(k) + '">'
        + '<span class="dd-card-text">' + escapeHtml(a.text) + '</span>'
      + '</button>';
    }).join('');
    answer.innerHTML = S.ddState.selected.map((k, i) => {
      const a = byKey[k];
      if (!a) return '';
      const isFirst = i === 0;
      const isLast  = i === S.ddState.selected.length - 1;
      return '<div class="dd-card" data-key="' + escapeHtml(k) + '" data-slot="' + i + '">'
        + '<span class="dd-slot-num">' + (i + 1) + '</span>'
        + '<span class="dd-card-text">' + escapeHtml(a.text) + '</span>'
        + '<span class="dd-reorder-btns">'
          + '<button type="button" class="dd-reorder-btn" data-move="up" data-slot="' + i + '"' + (isFirst ? ' disabled' : '') + ' title="Move up">↑</button>'
          + '<button type="button" class="dd-reorder-btn" data-move="down" data-slot="' + i + '"' + (isLast ? ' disabled' : '') + ' title="Move down">↓</button>'
        + '</span>'
      + '</div>';
    }).join('');

    submitBtn.disabled = S.ddState.selected.length !== targetLen;
    submitBtn.classList.remove('hidden');

    pool.querySelectorAll('.dd-card').forEach(card => {
      card.addEventListener('click', () => {
        if (card.hasAttribute('disabled')) return;
        const k = card.getAttribute('data-key');
        if (S.ddState.selected.length >= targetLen) return; // ignore extra clicks
        S.ddState.poolKeys = S.ddState.poolKeys.filter(x => x !== k);
        S.ddState.selected.push(k);
        rerender();
      });
    });
    answer.querySelectorAll('.dd-card').forEach(card => {
      // Click body (not a reorder button) — return to pool.
      card.addEventListener('click', (e) => {
        if (e.target.closest('.dd-reorder-btn')) return;
        if (card.hasAttribute('disabled')) return;
        const k = card.getAttribute('data-key');
        S.ddState.selected = S.ddState.selected.filter(x => x !== k);
        // Put it back into pool in the original action_pool order, not at the end.
        const origOrder = (q.actions_pool || []).map(a => a.key);
        const stillNeeded = new Set(origOrder.filter(x =>
          !S.ddState.selected.includes(x) && !S.ddState.poolKeys.includes(x)
        ));
        stillNeeded.add(k);
        S.ddState.poolKeys = origOrder.filter(x =>
          S.ddState.poolKeys.includes(x) || stillNeeded.has(x)
        );
        rerender();
      });
    });
    answer.querySelectorAll('.dd-reorder-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const slot = Number(btn.getAttribute('data-slot'));
        const move = btn.getAttribute('data-move');
        const swapWith = move === 'up' ? slot - 1 : slot + 1;
        if (swapWith < 0 || swapWith >= S.ddState.selected.length) return;
        const arr = S.ddState.selected;
        [arr[slot], arr[swapWith]] = [arr[swapWith], arr[slot]];
        rerender();
      });
    });
  }

  rerender();
}

function handleDragDropAnswer(q) {
  if (!q || !q.correct_sequence || !S.ddState) return;
  const user = (S.ddState.selected || []).slice();
  const correct = q.correct_sequence;
  const isCorrect = user.length === correct.length
    && user.every((k, i) => k === correct[i]);

  const submitBtn = $('ddSubmitBtn');
  submitBtn.disabled = true;

  // Mark each slot correct/wrong; also lock further interactions.
  const answer = $('ddAnswer');
  const pool   = $('ddPool');
  answer.querySelectorAll('.dd-card').forEach((card, i) => {
    const k = card.getAttribute('data-key');
    const expected = correct[i];
    if (k === expected) card.classList.add('is-correct');
    else {
      card.classList.add('is-wrong');
      // Append hint: which card should be in this slot.
      const expectedAction = (q.actions_pool || []).find(a => a.key === expected);
      if (expectedAction) {
        const hint = document.createElement('div');
        hint.className = 'dd-card-hint';
        hint.textContent = '✓ Здесь должно быть: ' + expectedAction.text;
        card.appendChild(hint);
      }
    }
    card.setAttribute('disabled', 'true');
    card.querySelectorAll('.dd-reorder-btn').forEach(b => { b.disabled = true; });
  });
  pool.querySelectorAll('.dd-card').forEach(c => c.setAttribute('disabled', 'true'));

  recordAnswer(q, isCorrect, user);
  showExplanation(q);
  if (typeof renderQuestionFeedback === 'function') {
    renderQuestionFeedback(q, user, isCorrect);
  }
  if (!isCorrect && typeof renderRemediationCard === 'function') {
    renderRemediationCard(q);
  } else if (typeof clearRemediationCard === 'function') {
    clearRemediationCard();
  }
  $('nextBtn').classList.add('visible');
  $('nextBtn').style.display = '';
  $('skipBtn').style.display = 'none';
}

function renderHotspot(q) {
  const rows = $('hotspotRows');
  const submitBtn = $('hotspotSubmitBtn');
  if (!rows || !submitBtn) return;

  // S.hotspotState lives only for the current question; reset on each render.
  S.hotspotState = { boxes: (q.hotspot_boxes || []).map(b => ({ id: b.id, selected: null })) };

  function syncSubmit() {
    const allFilled = S.hotspotState.boxes.every(b => b.selected !== null);
    submitBtn.disabled = !allFilled;
  }

  rows.innerHTML = (q.hotspot_boxes || []).map((box, i) => {
    const opts = (box.choices || []).map(c =>
      '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>'
    ).join('');
    return '<div class="hotspot-row" data-box-id="' + escapeHtml(box.id) + '" data-box-idx="' + i + '">'
      +   '<label class="hotspot-label" for="hotspot-sel-' + i + '">' + escapeHtml(box.label) + '</label>'
      +   '<select class="hotspot-select" id="hotspot-sel-' + i + '">'
      +     '<option value="">— select —</option>'
      +     opts
      +   '</select>'
      +   '<span class="hotspot-hint hidden"></span>'
      + '</div>';
  }).join('');

  rows.querySelectorAll('.hotspot-select').forEach((sel, i) => {
    sel.addEventListener('change', () => {
      S.hotspotState.boxes[i].selected = sel.value || null;
      syncSubmit();
    });
  });

  submitBtn.classList.remove('hidden');
  submitBtn.disabled = true;
}

function handleHotspotAnswer(q) {
  if (!q || !Array.isArray(q.hotspot_boxes) || !S.hotspotState) return;
  const submitBtn = $('hotspotSubmitBtn');
  submitBtn.disabled = true;

  const userMap = {};
  S.hotspotState.boxes.forEach(b => { userMap[b.id] = b.selected; });
  const correctMap = {};
  q.hotspot_boxes.forEach(b => { correctMap[b.id] = b.correct; });

  const wrongBoxes = q.hotspot_boxes.filter(b => userMap[b.id] !== correctMap[b.id]);
  const isCorrect = wrongBoxes.length === 0;

  const rows = $('hotspotRows');
  rows.querySelectorAll('.hotspot-row').forEach(row => {
    const boxId = row.getAttribute('data-box-id');
    const sel = row.querySelector('.hotspot-select');
    const hint = row.querySelector('.hotspot-hint');
    const correctVal = correctMap[boxId];
    if (sel.value === correctVal) {
      row.classList.add('is-correct');
      if (hint) hint.classList.add('hidden');
    } else {
      row.classList.add('is-wrong');
      if (hint) {
        hint.textContent = '✓ ' + correctVal;
        hint.classList.remove('hidden');
      }
    }
    sel.disabled = true;
  });

  const userTokens = q.hotspot_boxes.map(b => b.id + '=' + (userMap[b.id] || ''));
  recordAnswer(q, isCorrect, userTokens);
  showExplanation(q);
  if (typeof renderQuestionFeedback === 'function') {
    renderQuestionFeedback(q, userTokens, isCorrect);
  }
  if (!isCorrect && typeof renderRemediationCard === 'function') {
    renderRemediationCard(q);
  } else if (typeof clearRemediationCard === 'function') {
    clearRemediationCard();
  }
  $('nextBtn').classList.add('visible');
  $('nextBtn').style.display = '';
  $('skipBtn').style.display = 'none';
}

function renderMatching(q) {
  const rowsEl = $('matchingRows');
  const bankEl = $('matchingBank');
  const submitBtn = $('matchingSubmitBtn');
  if (!rowsEl || !bankEl || !submitBtn) return;

  const pairs = q.pairs || [];
  const choices = q.choices || [];

  S.matchingState = {
    pairs: pairs.map((p, i) => ({ id: p.id || ('p' + i), selected: null })),
    activeIdx: null,
  };

  function syncSubmit() {
    submitBtn.disabled = !S.matchingState.pairs.every(p => p.selected !== null);
  }

  function rerender() {
    rowsEl.innerHTML = pairs.map((p, i) => {
      const state = S.matchingState.pairs[i];
      const isActive = S.matchingState.activeIdx === i;
      const filled = state.selected !== null;
      const slotText = filled ? escapeHtml(state.selected) : 'Tap to assign';
      return '<div class="matching-row' + (isActive ? ' is-active' : '') + '" data-row-idx="' + i + '">'
        +   '<div class="matching-label">' + escapeHtml(p.label) + '</div>'
        +   '<span class="matching-arrow" aria-hidden="true">↔</span>'
        +   '<div class="matching-slot' + (filled ? ' filled' : '') + '" data-row-idx="' + i + '" role="button" tabindex="0">'
        +     '<span class="matching-slot-text">' + slotText + '</span>'
        +     '<span class="matching-hint hidden"></span>'
        +   '</div>'
        +   '<button type="button" class="matching-clear" data-row-idx="' + i + '" title="Clear"' + (filled ? '' : ' disabled') + '>✕</button>'
        + '</div>';
    }).join('');

    bankEl.innerHTML = choices.map(c =>
      '<button type="button" class="matching-bank-card" data-value="' + escapeHtml(c) + '">'
      +   escapeHtml(c)
      + '</button>'
    ).join('');

    rowsEl.querySelectorAll('.matching-slot').forEach(slot => {
      slot.addEventListener('click', () => {
        const i = Number(slot.getAttribute('data-row-idx'));
        const state = S.matchingState.pairs[i];
        if (state.selected !== null) {
          state.selected = null;
          S.matchingState.activeIdx = i;
        } else {
          S.matchingState.activeIdx = i;
        }
        rerender();
        syncSubmit();
      });
    });
    rowsEl.querySelectorAll('.matching-clear').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = Number(btn.getAttribute('data-row-idx'));
        S.matchingState.pairs[i].selected = null;
        S.matchingState.activeIdx = i;
        rerender();
        syncSubmit();
      });
    });
    bankEl.querySelectorAll('.matching-bank-card').forEach(card => {
      card.addEventListener('click', () => {
        const v = card.getAttribute('data-value');
        let targetIdx = S.matchingState.activeIdx;
        if (targetIdx === null || S.matchingState.pairs[targetIdx].selected !== null) {
          const empty = S.matchingState.pairs.findIndex(p => p.selected === null);
          if (empty === -1) return;
          targetIdx = empty;
        }
        S.matchingState.pairs[targetIdx].selected = v;
        const nextEmpty = S.matchingState.pairs.findIndex(p => p.selected === null);
        S.matchingState.activeIdx = nextEmpty === -1 ? null : nextEmpty;
        rerender();
        syncSubmit();
      });
    });
  }

  rerender();
  submitBtn.classList.remove('hidden');
  submitBtn.disabled = true;
}

function handleMatchingAnswer(q) {
  if (!q || !Array.isArray(q.pairs) || !S.matchingState) return;
  const submitBtn = $('matchingSubmitBtn');
  submitBtn.disabled = true;

  const userMap = {};
  S.matchingState.pairs.forEach(p => { userMap[p.id] = p.selected; });
  const correctMap = {};
  q.pairs.forEach((p, i) => { correctMap[p.id || ('p' + i)] = p.correct; });

  const pairIds = q.pairs.map((p, i) => p.id || ('p' + i));
  const wrongIds = pairIds.filter(id => userMap[id] !== correctMap[id]);
  const isCorrect = wrongIds.length === 0;

  const rowsEl = $('matchingRows');
  rowsEl.querySelectorAll('.matching-row').forEach(row => {
    const i = Number(row.getAttribute('data-row-idx'));
    const pid = pairIds[i];
    const slot = row.querySelector('.matching-slot');
    const hint = row.querySelector('.matching-hint');
    const correctVal = correctMap[pid];
    row.classList.remove('is-active');
    if (userMap[pid] === correctVal) {
      row.classList.add('is-correct');
      if (hint) hint.classList.add('hidden');
    } else {
      row.classList.add('is-wrong');
      if (hint) {
        hint.textContent = '✓ ' + correctVal;
        hint.classList.remove('hidden');
      }
    }
    if (slot) slot.style.pointerEvents = 'none';
  });

  const bankEl = $('matchingBank');
  bankEl.querySelectorAll('.matching-bank-card').forEach(c => { c.disabled = true; });
  rowsEl.querySelectorAll('.matching-clear').forEach(c => { c.disabled = true; });

  const userTokens = pairIds.map(id => id + '=' + (userMap[id] || ''));
  recordAnswer(q, isCorrect, userTokens);
  showExplanation(q);
  if (typeof renderQuestionFeedback === 'function') {
    renderQuestionFeedback(q, userTokens, isCorrect);
  }
  if (!isCorrect && typeof renderRemediationCard === 'function') {
    renderRemediationCard(q);
  } else if (typeof clearRemediationCard === 'function') {
    clearRemediationCard();
  }
  $('nextBtn').classList.add('visible');
  $('nextBtn').style.display = '';
  $('skipBtn').style.display = 'none';
}

function renderQuestion() {
  const q = S.questions[S.idx];
  S.questionStartTs = Date.now();

  const oldBanner = document.getElementById('mcqStatusBanner');
  if (oldBanner) oldBanner.remove();

  const qCard = document.querySelector('.question-card');
  if(qCard) {
    qCard.classList.remove('answered');
    qCard.style.transform = '';
    qCard.style.opacity = '1';
    const leftInd = qCard.querySelector('.swipe-indicator.left');
    const rightInd = qCard.querySelector('.swipe-indicator.right');
    if(leftInd) leftInd.style.opacity = 0;
    if(rightInd) rightInd.style.opacity = 0;
  }
  if (S.mode === 'blitz' || S.mode === 'flashcard') {
    const opts = document.getElementById('optionsList');
    if(opts) opts.classList.add('hidden');
    const mcqBtn = document.getElementById('mcqSubmitBtn');
    if(mcqBtn) mcqBtn.classList.add('hidden');
    const hBtn = document.getElementById('hintBtn');
    if(hBtn) hBtn.classList.add('hidden');
    const tEl = document.getElementById('tipText');
    if(tEl) tEl.classList.add('hidden');
  }

  const total = S.questions.length;
  const pct = Math.round((S.idx / total) * 100);

  $('progressBar').style.width = `${pct}%`;
  $('qCounter').textContent = `Q${S.idx + 1} / ${total}`;
  const accEl = $('qAccuracy');
  if (accEl) {
    const answered = S.idx;
    if (answered > 0) {
      const correct = S.correct || 0;
      const accPct = Math.round((correct / answered) * 100);
      accEl.textContent = `${accPct}% (${correct}/${answered})`;
      accEl.classList.remove('hidden', 'is-good', 'is-mid', 'is-low');
      if (accPct >= 80) accEl.classList.add('is-good');
      else if (accPct >= 60) accEl.classList.add('is-mid');
      else accEl.classList.add('is-low');
    } else {
      accEl.classList.add('hidden');
    }
  }
  $('qDomainTag').textContent = getQuestionMetaLabel(q);
  $('nextBtn').textContent = S.idx === total - 1 ? 'Show results' : 'Next question \u2192';
  $('finishEarlyBtn').textContent = S.idx === total - 1 ? 'Finish and open results' : 'Finish test';
  if (S.idx === total - 1) $('skipBtn').style.display = 'none';

  const scenarioBlock = $('scenarioBlock');
  if (q.scenario) {
    $('scenarioText').innerHTML = formatScenarioText(q.scenario);
    scenarioBlock.classList.remove('hidden');
    if (S.idx === 0) scenarioBlock.open = true;
  } else {
    scenarioBlock.classList.add('hidden');
    scenarioBlock.open = false;
  }

  $('qTitle').textContent = q.title || '';
  $('qText').innerHTML = formatQuestionText(q.prompt || '');
  if (window.Prism) Prism.highlightAllUnder($('qText'));

  // Reset explanation images (post-check). Always cleared on new question
  // load so leftover images from the previous q don't flash through.
  const explImagesEl = $('qExplanationImages');
  if (explImagesEl) {
    explImagesEl.classList.add('hidden');
    explImagesEl.innerHTML = '';
  }

  // Render in-quiz images. Field was renamed 'images' → 'quiz_images'
  // for symmetry with 'explanation_images' (post-Check). Legacy 'images'
  // still read as fallback so existing data keeps working — Python
  // importers (DataBoom, attach_manual_images) continue writing the
  // legacy name. External hosts may require auth and fail to load; on
  // error we replace the broken image with a small unobtrusive notice
  // instead of leaving an empty box.
  const imagesEl = $('qImages');
  if (imagesEl) {
    const imgsSrc = Array.isArray(q.quiz_images) ? q.quiz_images
                  : (Array.isArray(q.images) ? q.images : []);
    const imgs = imgsSrc.filter(u => typeof u === 'string' && u);
    if (imgs.length) {
      imagesEl.classList.remove('hidden');
      const figuresHtml = imgs.map((url, i) =>
        `<figure class="q-image-figure">
           <img class="q-image" loading="lazy" src="${escapeHtml(url)}" alt="Question image ${i + 1}">
         </figure>`
      ).join('');
      imagesEl.innerHTML =
        `<button type="button" class="q-images-toggle" aria-expanded="false">
           <span class="q-images-toggle-label">📷 Show Picture (${imgs.length})</span>
           <span class="q-images-toggle-caret" aria-hidden="true">▾</span>
         </button>
         <div class="q-images-grid hidden">${figuresHtml}</div>`;
      const toggleBtn = imagesEl.querySelector('.q-images-toggle');
      const grid = imagesEl.querySelector('.q-images-grid');
      const labelEl = imagesEl.querySelector('.q-images-toggle-label');
      if (toggleBtn && grid && labelEl) {
        toggleBtn.addEventListener('click', function() {
          const willOpen = grid.classList.contains('hidden');
          grid.classList.toggle('hidden', !willOpen);
          toggleBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
          labelEl.textContent = willOpen
            ? `📷 Hide Picture (${imgs.length})`
            : `📷 Show Picture (${imgs.length})`;
          toggleBtn.classList.toggle('is-open', willOpen);
        });
      }
      // Wire image behaviour: lightbox click-to-zoom, error fallback.
      // (We intentionally keep all thumbnails in the 2-col grid — clicking
      // opens the lightbox for the full-size view, so no auto-wide span.)
      imagesEl.querySelectorAll('img.q-image').forEach(function(img) {
        img.addEventListener('click', function() {
          openImageLightbox(img.src, img.alt || '');
        });
        img.addEventListener('error', function() {
          var fallback = document.createElement('div');
          fallback.className = 'q-image-fallback';
          fallback.textContent = 'Image not available';
          if (img.parentNode) img.parentNode.classList.add('is-broken');
          img.replaceWith(fallback);
        });
      });
    } else {
      imagesEl.classList.add('hidden');
      imagesEl.innerHTML = '';
    }
  }

  const multiHintEl = $('qMultiHint');
  if (multiHintEl) {
    const showMultiHint = q.question_type === 'mcq_multiple' && S.mode !== 'flashcard';
    multiHintEl.classList.toggle('hidden', !showMultiHint);
  }

  refreshFavoriteBtn(q);
  refreshVersionBadge(q);
  refreshIdBadge(q);
  refreshQuestionStatsBadge(q);
  refreshQuestionBoxBadge(q);
  renderDifficultyBadge(q);

  $('explanation').classList.remove('visible');
  $('reflectionPrompt')?.classList.add('hidden');
  if (typeof clearRemediationCard === 'function') clearRemediationCard();
  if (typeof clearQuestionFeedback === 'function') clearQuestionFeedback();
  $('nextBtn').classList.remove('visible');
  $('nextBtn').style.display = 'none';
  $('skipBtn').style.display = '';
  $('mcqSubmitBtn').classList.add('hidden');
  const _ce = $('crowdStatsEl'); if (_ce) _ce.classList.add('hidden');
  $('mcqSubmitBtn').disabled = true;

  // Reset drag-drop UI on every render — keeps it hidden for non-DnD.
  const ddBlock = $('ddBlock');
  if (ddBlock) ddBlock.classList.add('hidden');
  const ddBtn = $('ddSubmitBtn');
  if (ddBtn) ddBtn.classList.add('hidden');
  // Reset hotspot UI on every render — keeps it hidden for non-hotspot.
  const hotspotBlock = $('hotspotBlock');
  if (hotspotBlock) hotspotBlock.classList.add('hidden');
  const hotspotBtn = $('hotspotSubmitBtn');
  if (hotspotBtn) hotspotBtn.classList.add('hidden');
  // Reset matching UI on every render — keeps it hidden for non-matching.
  const matchingBlock = $('matchingBlock');
  if (matchingBlock) matchingBlock.classList.add('hidden');
  const matchingBtn = $('matchingSubmitBtn');
  if (matchingBtn) matchingBtn.classList.add('hidden');

  if (S.mode === 'flashcard') {
    S.flashRevealed = false;
    $('optionsList').classList.add('hidden');
    $('openBlock').classList.remove('hidden');
    $('nextBtn').classList.remove('visible');
    renderOpen(q);
    // For MCQ domain questions show the correct option text in the reveal
    if (!q.answer_text && hasChoiceOptions(q) && Array.isArray(q.correct_answers)) {
      const correctKeys = getCorrectAnswerKeys(q);
      const correctOpts = q.options
        .map((opt, idx) => getOptionMeta(opt, idx))
        .filter(m => correctKeys.includes(m.answerKey));
      if (correctOpts.length) {
        $('revealText').textContent = correctOpts.map(m => `${m.label}. ${m.text}`).join(' / ');
      }
    }
    $('revealBtn').textContent = 'Show answer';
  } else if (q.question_type === 'matching' && Array.isArray(q.pairs) && Array.isArray(q.choices) && q.pairs.length && q.choices.length) {
    $('optionsList').classList.add('hidden');
    $('openBlock').classList.add('hidden');
    if (ddBlock) ddBlock.classList.add('hidden');
    if (hotspotBlock) hotspotBlock.classList.add('hidden');
    if (matchingBlock) matchingBlock.classList.remove('hidden');
    renderMatching(q);
  } else if (q.question_type === 'hotspot' && Array.isArray(q.hotspot_boxes) && q.hotspot_boxes.length) {
    $('optionsList').classList.add('hidden');
    $('openBlock').classList.add('hidden');
    if (ddBlock) ddBlock.classList.add('hidden');
    if (hotspotBlock) hotspotBlock.classList.remove('hidden');
    renderHotspot(q);
  } else if (q.question_type === 'drag_drop' && Array.isArray(q.actions_pool) && Array.isArray(q.correct_sequence)) {
    $('optionsList').classList.add('hidden');
    $('openBlock').classList.add('hidden');
    if (ddBlock) ddBlock.classList.remove('hidden');
    renderDragDrop(q);
  } else if (q.question_type !== 'open_answer' && hasChoiceOptions(q)) {
    $('optionsList').classList.remove('hidden');
    $('openBlock').classList.add('hidden');
    renderMCQ(q);
  } else {
    $('optionsList').classList.add('hidden');
    $('openBlock').classList.remove('hidden');
    renderOpen(q);
  }

  saveActiveSessionSnapshot();
}

function renderLearnUrls(wrapId, q, extraSources) {
  const wrap = $(wrapId);
  if (!wrap) return;
  const urls = (q.learn_urls || []).filter(u => u).slice(0, 3);
  if (!urls.length && q.learn_url) urls.push(q.learn_url);
  wrap.innerHTML = '';
  urls.forEach((url, i) => {
    const a = document.createElement('a');
    a.href = url;
    a.className = 'learn-url';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = urls.length > 1 ? `📚 Microsoft Learn (${i + 1}) →` : '📚 Microsoft Learn →';
    wrap.appendChild(a);
  });
  const known = new Set(urls);
  const extras = Array.isArray(extraSources)
    ? extraSources.filter(s => s && s.url && !known.has(s.url)).slice(0, 6)
    : [];
  extras.forEach(src => {
    const a = document.createElement('a');
    a.href = src.url;
    a.className = 'source-url';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const labelText = String(src.title || src.url).trim();
    const display = labelText.length > 60 ? labelText.slice(0, 57) + '…' : labelText;
    a.textContent = '🔗 ' + display;
    a.title = src.url;
    wrap.appendChild(a);
  });
  wrap.classList.toggle('hidden', urls.length === 0 && extras.length === 0);
}

function showExplanation(q) {
  const hasLearn = q.learn_url || (q.learn_urls && q.learn_urls.length);
  const explImagesArr = Array.isArray(q.explanation_images)
    ? q.explanation_images.filter(u => typeof u === 'string' && u)
    : [];
  const hasExplImages = explImagesArr.length > 0;
  if (!q.explanation && !q.tip && !hasLearn && !q.explanation2 && !hasExplImages) return;

  // Render explanation images first — they sit at the top of the
  // explanation block. Default to EXPANDED (user just clicked Check —
  // don't hide the supporting image behind another tap). Toggle remains
  // so the user can collapse if the image is in the way.
  const explImagesEl = $('qExplanationImages');
  if (explImagesEl && hasExplImages) {
    const figuresHtml = explImagesArr.map((url, i) =>
      `<figure class="q-image-figure">
         <img class="q-image" loading="lazy" src="${escapeHtml(url)}" alt="Explanation image ${i + 1}">
       </figure>`
    ).join('');
    explImagesEl.classList.remove('hidden');
    explImagesEl.innerHTML =
      `<button type="button" class="q-images-toggle" aria-expanded="false">
         <span class="q-images-toggle-label">📷 Show Picture (${explImagesArr.length})</span>
         <span class="q-images-toggle-caret" aria-hidden="true">▾</span>
       </button>
       <div class="q-images-grid hidden">${figuresHtml}</div>`;
    const toggleBtn = explImagesEl.querySelector('.q-images-toggle');
    const grid = explImagesEl.querySelector('.q-images-grid');
    const labelEl = explImagesEl.querySelector('.q-images-toggle-label');
    if (toggleBtn && grid && labelEl) {
      toggleBtn.addEventListener('click', function() {
        const willOpen = grid.classList.contains('hidden');
        grid.classList.toggle('hidden', !willOpen);
        toggleBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        labelEl.textContent = willOpen
          ? `📷 Hide Picture (${explImagesArr.length})`
          : `📷 Show Picture (${explImagesArr.length})`;
        toggleBtn.classList.toggle('is-open', willOpen);
      });
    }
    explImagesEl.querySelectorAll('img.q-image').forEach(function(img) {
      img.addEventListener('click', function() {
        openImageLightbox(img.src, img.alt || '');
      });
      img.addEventListener('error', function() {
        var fallback = document.createElement('div');
        fallback.className = 'q-image-fallback';
        fallback.textContent = 'Image not available';
        img.parentNode.replaceChild(fallback, img);
      });
    });
  }

  // Edge case: only explanation images, no text/tip/learn/exp2.
  // We still want the explanation panel visible to host the image block.
  if (!q.explanation && !q.tip && !hasLearn && !q.explanation2) {
    $('explanation').classList.add('visible');
    return;
  }
  const { cleanText, sources } = extractSourcesFromExplanation(q.explanation || '');
  $('explanationText').innerHTML = formatQuestionText(cleanText);
  if (q.tip) {
    $('tipText').innerHTML = `💡 Hint: ${formatQuestionText(q.tip)}`;
    $('tipText').classList.remove('hidden');
  } else {
    $('tipText').classList.add('hidden');
  }
  renderLearnUrls('learnUrlWrap', q, sources);
  const exp2Wrap = $('explanation2Wrap');
  if (exp2Wrap) {
    if (q.explanation2) {
      const isEn = (q.language || 'ru') === 'en';
      const summary = exp2Wrap.querySelector('.explanation2-summary');
      if (summary) summary.textContent = isEn ? '📚 Cheat sheet · expand for details' : '📚 Шпаргалка · нажми чтобы раскрыть';
      $('explanation2Text').innerHTML = formatQuestionText(q.explanation2);
      exp2Wrap.classList.remove('hidden');
      exp2Wrap.open = false;
    } else {
      exp2Wrap.classList.add('hidden');
    }
  }
  $('explanation').classList.add('visible');
}

function maybeShowReflectionPrompt(q, correct) {
  if (correct || S.demoMode) return;
  const stats = getQuestionStatsMap()[getQuestionKey(q)];
  if (!stats) return;
  const wrongCount = (stats.total || 0) - (stats.correct || 0);
  if (wrongCount < 2) return;
  showReflectionPrompt(q);
}

function showReflectionPrompt(q) {
  const wrap = $('reflectionPrompt');
  if (!wrap) return;
  const text = $('reflectionText');
  const status = $('reflectionStatus');
  const saveBtn = $('reflectionSaveBtn');
  const skipBtn = $('reflectionSkipBtn');
  if (!text || !saveBtn || !skipBtn) return;

  text.value = '';
  status.textContent = '';
  status.classList.add('hidden');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save';
  wrap.classList.remove('hidden');

  const cleanup = () => {
    wrap.classList.add('hidden');
    saveBtn.onclick = null;
    skipBtn.onclick = null;
  };

  saveBtn.onclick = async () => {
    const value = text.value.trim();
    if (!value) { cleanup(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const uid = window.cloudSync && currentUser?.uid;
      if (uid) {
        await window.cloudSync.saveReflection(uid, q.id || getQuestionKey(q), value);
      }
      status.textContent = '✓ Saved';
      status.classList.remove('hidden');
      setTimeout(cleanup, 1200);
    } catch (e) {
      status.textContent = 'Could not save';
      status.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Retry';
    }
  };
  skipBtn.onclick = cleanup;
}

function recordAnswer(q, correct, selectedKeys) {
  if (correct) S.correct += 1;

  const sectionKey = getQuestionSectionKey(q);
  if (sectionKey) {
    if (!S.sessionSectionStats[sectionKey]) {
      S.sessionSectionStats[sectionKey] = {
        label: getSectionLabelFromQuestion(S.exam, q),
        correct: 0,
        total: 0,
      };
    }
    S.sessionSectionStats[sectionKey].total += 1;
    if (correct) S.sessionSectionStats[sectionKey].correct += 1;
  } else if (q.domain) {
    if (!S.sessionLegacyStats[q.domain]) {
      S.sessionLegacyStats[q.domain] = { correct: 0, total: 0 };
    }
    S.sessionLegacyStats[q.domain].total += 1;
    if (correct) S.sessionLegacyStats[q.domain].correct += 1;
  }

  const elapsedMs = S.questionStartTs ? (Date.now() - S.questionStartTs) : 0;
  S.questionStartTs = null;

  updateMastery(q, correct);
  updateQuestionStats(q, correct, elapsedMs, selectedKeys);
  updateLeitner(q, correct);
  maybeShowReflectionPrompt(q, correct);

  if (!correct) {
    S.sessionWrongQuestions.push(getQuestionKey(q));
  }
}

function renderMcqStatusBanner({ matchedCorrect, wrongPicks, missedCorrect, total }) {
  const optionsList = $('optionsList');
  if (!optionsList) return;
  const old = document.getElementById('mcqStatusBanner');
  if (old) old.remove();
  const banner = document.createElement('div');
  banner.id = 'mcqStatusBanner';
  let kind, msg;
  if (matchedCorrect === total && wrongPicks === 0) {
    kind = 'ok';
    msg = `✔ All correct — ${total}/${total}`;
  } else if (matchedCorrect === 0) {
    kind = 'bad';
    msg = wrongPicks
      ? `✖ Wrong — none of your picks were correct (${total} correct missed)`
      : `✖ No options selected (${total} correct missed)`;
  } else {
    kind = 'partial';
    const pct = Math.round((Math.max(0, matchedCorrect - wrongPicks) / total) * 100);
    const parts = [`${matchedCorrect}/${total} correct`];
    if (wrongPicks)    parts.push(`${wrongPicks} wrong pick${wrongPicks > 1 ? 's' : ''}`);
    if (missedCorrect) parts.push(`${missedCorrect} missed correct`);
    msg = `△ Partial credit — ${parts.join(' · ')} (${pct}%)`;
  }
  banner.className = `mcq-status mcq-status--${kind}`;
  banner.textContent = msg;
  optionsList.insertAdjacentElement('afterend', banner);
}

function handleMCQAnswer(selectedButtons, q) {
  const allButtons = [...$('optionsList').querySelectorAll('.option-btn')];
  const correctKeys = getCorrectAnswerKeys(q);
  const selectedKeys = selectedButtons.map(btn => btn.dataset.answerKey);
  const correctSet = new Set(correctKeys);
  const matchedCorrect = selectedKeys.filter(k => correctSet.has(k)).length;
  const wrongPicks = selectedKeys.filter(k => !correctSet.has(k)).length;
  const missedCorrect = correctKeys.filter(k => !selectedKeys.includes(k)).length;
  const isCorrect = wrongPicks === 0 && missedCorrect === 0;

  allButtons.forEach(btn => { btn.disabled = true; });
  $('mcqSubmitBtn').disabled = true;

  selectedButtons.forEach(btn => {
    btn.classList.remove('selected');
    btn.classList.add(correctSet.has(btn.dataset.answerKey) ? 'correct' : 'wrong');
  });

  allButtons.forEach(btn => {
    if (correctSet.has(btn.dataset.answerKey) && !btn.classList.contains('correct')) {
      btn.classList.add('revealed');
    }
  });

  if (q.question_type === 'mcq_multiple') {
    renderMcqStatusBanner({ matchedCorrect, wrongPicks, missedCorrect, total: correctKeys.length });
  }

  recordAnswer(q, isCorrect, selectedKeys);
  showExplanation(q);
  if (typeof renderQuestionFeedback === 'function') {
    renderQuestionFeedback(q, selectedKeys, isCorrect);
  }
  if (!isCorrect && typeof renderRemediationCard === 'function') {
    renderRemediationCard(q);
  } else if (typeof clearRemediationCard === 'function') {
    clearRemediationCard();
  }
  $('nextBtn').classList.add('visible'); $('nextBtn').style.display = ''; $('skipBtn').style.display = 'none';

  if (window.cloudSync && q.id && S.mode !== 'flashcard') {
    const crowdEl = $('crowdStatsEl');
    if (crowdEl) crowdEl.classList.add('hidden');
    window.cloudSync.submitQuestionStat(q.id, selectedKeys).then(() =>
      window.cloudSync.getQuestionStat(q.id)
    ).then(stats => renderCrowdStats(q, selectedKeys, stats));
  }
}

function renderCrowdStats(q, selectedKeys, stats) {
  const el = $('crowdStatsEl');
  if (!el || !stats || (stats.total || 0) < 5) return;
  const correctKeys = getCorrectAnswerKeys(q);
  const isMulti = correctKeys.length > 1;

  // Single-answer: ans_<correct>/total is exact.
  // Multi-answer: ans_* per-option counts can't recover exact combos, so
  // we read combo_<sorted>/combo_total (recorded since combo tracking was
  // added). If not enough new submissions have combo data yet, we skip the
  // "% answer correctly" line entirely instead of showing a misleading
  // per-option upper bound.
  let correctPct = null;
  if (!isMulti) {
    const correctVotes = correctKeys.reduce((a, k) => a + (stats['ans_' + k] || 0), 0);
    correctPct = stats.total > 0 ? Math.round(correctVotes / stats.total * 100) : 0;
  } else {
    const comboTotal = stats.combo_total || 0;
    if (comboTotal >= 5) {
      const comboKey = 'combo_' + correctKeys.slice().sort().join('_');
      const exact = stats[comboKey] || 0;
      correctPct = Math.round(exact / comboTotal * 100);
    }
  }

  const userCorrect = selectedKeys.length === correctKeys.length
    && selectedKeys.every(k => correctKeys.includes(k));

  let personal = '';
  if (correctPct !== null) {
    if (userCorrect) {
      if (correctPct < 40) {
        personal = `🔥 Only <b>${correctPct}%</b> answer correctly — and you're in that minority. Tough question — well done.`;
      } else if (correctPct > 70) {
        personal = `✓ Standard question — you're with the majority (<b>${correctPct}%</b> answer correctly). Lock the fact into memory.`;
      } else {
        personal = `✓ You're with the <b>${correctPct}%</b> who answer correctly. Tricky topic — review it to lock it in.`;
      }
    } else {
      if (correctPct > 70) {
        personal = `⚠️ <b>${correctPct}%</b> answer correctly; you're currently in the <b>${100 - correctPct}%</b> who get it wrong. Worth memorizing this topic well.`;
      } else if (correctPct < 40) {
        personal = `🤔 Tough question — <b>${100 - correctPct}%</b> get it wrong. No worries — remember the logic for next time.`;
      } else {
        personal = `You're in the <b>${100 - correctPct}%</b> who got it wrong. Tricky question — sort it out for the future.`;
      }
    }
  }

  let html = '<div class="crowd-stats-title">How everyone answered</div>';
  if (isMulti) {
    html += '<div class="crowd-stats-hint">Multi-answer · each bar is % who picked that option (sum can exceed 100%)</div>';
  }
  if (personal) {
    html += `<div class="crowd-personal ${userCorrect ? 'is-correct' : 'is-wrong'}">${personal}</div>`;
  }
  q.options.forEach(o => {
    const cnt = stats['ans_' + o.key] || 0;
    const pct = stats.total > 0 ? Math.round(cnt / stats.total * 100) : 0;
    const isC = correctKeys.includes(o.key);
    const isMe = selectedKeys.includes(o.key);
    const col = isC ? '#22c55e' : '#ef4444';
    html += `<div class="crowd-row">
      <span class="crowd-key">${escapeHtml(o.key)}</span>
      <div class="crowd-bar-wrap"><div class="crowd-bar" style="width:${pct}%;background:${col}"></div></div>
      <span class="crowd-pct" style="color:${isC?'#22c55e':isMe?'#ef4444':'var(--text-muted)'}">${pct}%${isMe?' ←':''}</span>
    </div>`;
  });
  html += `<div class="crowd-total">${stats.total} answers</div>`;
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function submitMCQAnswer() {
  const selectedButtons = [...$('optionsList').querySelectorAll('.option-btn.selected')];
  if (!selectedButtons.length) return;
  handleMCQAnswer(selectedButtons, S.questions[S.idx]);
}

function revealOpen() {
  const q = S.questions[S.idx];
  $('answerReveal').classList.add('visible');
  $('revealBtn').classList.add('hidden');
  showExplanation(q);

  if (S.mode === 'flashcard') {
    S.flashRevealed = true;
    // No anki self-assess — swipe is the scoring mechanic
    $('selfAssess').classList.remove('visible');
    // Show next button as a fallback (skip without scoring)
    $('nextBtn').classList.add('visible'); $('nextBtn').style.display = ''; $('skipBtn').style.display = 'none';
  } else {
    $('selfAssess').classList.add('visible');
  }
}


function assessOpenAnki(level) {
  if ($('nextBtn').classList.contains('visible')) return;

  const isCorrect = level === 'normal' || level === 'easy';
  const q = S.questions[S.idx];
  // Self-graded open-answer practice does NOT contribute to Attempts /
  // Accuracy / Readiness — it's learning support, not an exam attempt.
  // Only mastery (Leitner-style schedule for spaced repetition) is updated.
  updateMastery(q, isCorrect);

  // Custom mastery tweak
  const mastery = loadMastery();
  const key = getQuestionKey(q);
  if (level === 'hard') mastery[key] = 0;
  if (level === 'normal') mastery[key] = Math.min((mastery[key] || 0) + 1, 3);
  if (level === 'easy') mastery[key] = 5;
  saveMastery(mastery);

  if (isCorrect) S.correct++;
  else S.sessionWrongQuestions.push(getQuestionKey(q));

  updateGlobalStats();
  $('nextBtn').classList.add('visible'); $('nextBtn').style.display = ''; $('skipBtn').style.display = 'none';
}

function skipQuestion() {
  const q = S.questions[S.idx];
  S.questions.splice(S.idx, 1);
  S.questions.push(q);
  // Don't increment idx — the next question slides into the current position
  if (S.idx >= S.questions.length) {
    finishQuiz();
    return;
  }
  renderQuestion();
}

function nextQuestion() {
  S.idx += 1;
  if (S.idx >= S.questions.length) {
    finishQuiz();
    return;
  }
  renderQuestion();
}

// Per-section session breakdown — horizontal bar list. Replaces the radar
// chart which used to need ≥2 sections to be visible; bars work with 1+
// section and surface weak areas through proportional widths + green fill.
// Sorted weak→strong so the gap is the first thing the user sees.
function renderRadarChart() {
  const wrap = $('radarSection');
  const host = $('sessionSectionsBars');
  if (!wrap || !host) return;

  const rows = Object.entries(S.sessionSectionStats || {})
    .map(([key, v]) => ({
      key,
      label: v.label || getSectionLabel(S.exam, key) || key,
      total: v.total || 0,
      correct: v.correct || 0,
      pct: v.total > 0 ? Math.round((v.correct / v.total) * 100) : 0,
    }))
    .filter(r => r.total > 0)
    .sort((a, b) => a.pct - b.pct || b.total - a.total);

  if (!rows.length) {
    wrap.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  const maxTotal = Math.max.apply(null, rows.map(r => r.total));
  const html = rows.map(r => {
    const widthPct = Math.max(10, (r.total / maxTotal) * 100);
    const correctPct = r.total > 0 ? (r.correct / r.total) * 100 : 0;
    const tone = r.pct >= 85 ? '#22c55e' : r.pct >= 60 ? '#eab308' : '#ef4444';
    return `
      <div class="result-bar-row">
        <div class="result-bar-label">${escapeHtml(r.label)}</div>
        <div class="result-bar-track">
          <div class="result-bar-fill-wrap" style="width:${widthPct}%">
            <div class="result-bar-fill" style="width:${correctPct}%"></div>
          </div>
        </div>
        <div class="result-bar-value" style="color:${tone}">
          ${r.pct}% <span class="result-bar-count">· ${r.correct}/${r.total}</span>
        </div>
      </div>`;
  }).join('');

  wrap.classList.remove('hidden');
  host.innerHTML = html;
}

function finishQuiz() {
  stopTimer();
  incrementSessions();
  // ── Phase 4.1 event: session completion ──
  try {
    const total = S.questions ? S.questions.length : 0;
    const correct = S.correct || 0;
    window.cloudSync?.logEvent?.('session_complete', {
      mode: S.mode || null,
      exam: S.exam || null,
      total,
      correct,
      accuracy: total > 0 ? Math.round((correct / total) * 100) : 0,
    });
  } catch (_) {}
  clearActiveSession();

  // sectionStats is now written immediately per-answer inside
  // updateQuestionStats, so we no longer commit the session accumulator here
  // (would double-count). Legacy domain stats still commit at session end —
  // they aren't yet wired into the per-answer path.
  Object.entries(S.sessionLegacyStats).forEach(([domainKey, value]) => {
    updateLegacyDomainStats(S.exam, domainKey, value.correct, value.total);
  });

  saveReadinessSnapshot(S.exam);

  const total = S.questions.length;
  const pct = total > 0 ? Math.round((S.correct / total) * 100) : 0;
  const resultCopy = getResultCopy(pct);
  const sessionWeak = Object.entries(S.sessionSectionStats)
    .map(([sectionKey, value]) => ({
      sectionKey,
      sectionLabel: value.label || getSectionLabel(S.exam, sectionKey),
      pct: value.total > 0 ? Math.round((value.correct / value.total) * 100) : 0,
      total: value.total,
    }))
    .filter(item => item.total >= 2 && item.pct < 70)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 5);

  $('progressBar').style.width = '100%';
  $('resPct').textContent = `${pct}%`;
  $('resCount').textContent = `${S.correct} / ${total}`;
  $('resEyebrow').textContent = resultCopy.eyebrow;
  $('resMessage').textContent = resultCopy.message;
  $('resGrade').textContent = resultCopy.grade;
  $('resGrade').className = resultCopy.className;
  $('resSummaryAccuracy').textContent = `${pct}%`;
  $('resSummaryAnswers').textContent = `${S.correct}/${total}`;
  const hasSessionSections = Object.keys(S.sessionSectionStats).length > 0;
  $('resSummaryWeak').textContent = hasSessionSections ? `${sessionWeak.length}` : '—';

  // The standalone «Weak section» panel was replaced by the Pass-probability
  // chart on the result screen — keep the sessionWeak data flow for the
  // resSummaryWeak counter (above) and for the Weak topics CTA logic
  // (below), but don't render a per-session weakSection list anymore.

  $('weakBtn').disabled = getWeakQuestionPool(S.exam).length === 0;
  const historicalThreshold = (S.questions && S.questions.length <= 10) ? 2 : 3;
  const historicalWeak = getWeakSections(S.exam, historicalThreshold);
  $('weakBtn').textContent = (sessionWeak.length || historicalWeak.length) ? 'Weak topics' : 'Continue practice';
  $('retryWrongBtn').disabled = !S.sessionWrongQuestions.length;

  // Dynamic CTA priority
  const wrongCount = S.sessionWrongQuestions.length;
  const retryWrong = $('retryWrongBtn');
  const retryBtn = $('retryBtn');
  ['primary', 'secondary'].forEach(c => { retryWrong.classList.remove(c); retryBtn.classList.remove(c); });
  if (wrongCount > 0) {
    retryWrong.classList.add('primary');
    retryBtn.classList.add('secondary');
  } else {
    retryBtn.classList.add('primary');
  }

  // Sticky bottom CTA — mirrors the primary action button
  const stickyCta = $('resultStickyCta');
  const stickyPrimary = $('stickyPrimaryBtn');
  if (stickyCta && stickyPrimary) {
    stickyPrimary.textContent = wrongCount > 0 ? 'Review mistakes' : 'Retry session';
    stickyPrimary.onclick = wrongCount > 0 ? retryWrongAnswers : retrySession;
    const actionsEl = document.querySelector('.result-actions');
    if (actionsEl && 'IntersectionObserver' in window) {
      if (stickyCta._obs) stickyCta._obs.disconnect();
      const obs = new IntersectionObserver(([entry]) => {
        stickyCta.classList.toggle('hidden', entry.isIntersecting);
      }, { threshold: 0.25 });
      obs.observe(actionsEl);
      stickyCta._obs = obs;
    }
  }

  // Delta vs last session (read BEFORE saveLastResult below)
  const prevResult = loadLastResult();
  const deltaEl = $('resDelta');
  if (deltaEl && prevResult?.scorePct != null && prevResult.exam === S.exam) {
    const delta = pct - prevResult.scorePct;
    const sign = delta > 0 ? '+' : '';
    deltaEl.textContent = delta === 0 ? 'Same as last time' : `${sign}${delta}% vs last time`;
    deltaEl.className = `result-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'}`;
  } else if (deltaEl) {
    deltaEl.className = 'result-delta hidden';
  }

  // Next-step recommendation
  const recEl = $('resRecommend');
  if (recEl) {
    let rec = '';
    if (wrongCount > 0) {
      const n = wrongCount;
      const noun = n === 1 ? 'mistake' : 'mistakes';
      rec = `Review your ${n} ${noun} — that's the fastest way to grow`;
    } else if (pct >= 90) {
      rec = 'Excellent result. Try Smart Review or a harder mock';
    } else if (pct >= 70) {
      rec = 'Good result. Keep up regular sessions';
    } else {
      rec = 'Review your weak sections before the next session';
    }
    recEl.textContent = rec;
    recEl.classList.toggle('hidden', !rec);
  }

  saveLastResult({
    exam: S.exam,
    mode: S.mode,
    wrongQuestionKeys: [...new Set(S.sessionWrongQuestions)],
    scorePct: pct,
    savedAt: Date.now(),
  });

  if (typeof renderExamCoachReport === 'function') {
    renderExamCoachReport({
      examCode: S.exam,
      mode: S.mode,
      score: S.correct,
      total,
      pct,
      sectionStats: S.sessionSectionStats || {},
      wrongQuestions: [...new Set(S.sessionWrongQuestions)],
    });
  }

  renderResultCoachMini({
    examCode: S.exam,
    mode: S.mode,
    score: S.correct,
    total,
    pct,
    sectionStats: S.sessionSectionStats || {},
    wrongQuestions: [...new Set(S.sessionWrongQuestions)],
  });

  updateBadges();
  updateGlobalStats();
  updateHeaderBadge();
  renderRadarChart();
  showScreen('result');
  // Chart.js needs measurable canvas dimensions — defer to after the
  // screen becomes visible so it can size correctly.
  requestAnimationFrame(() => renderResultHistoryCharts(S.exam));
}

// Compact "Exam Coach" chip for the result screen — replaces the long
// multi-row examCoachReport block in the 2-col layout. Uses
// buildCoachReport from src/ui/exam-coach.js for the verdict + nextAction.
function renderResultCoachMini(summary) {
  const root = $('examCoachMini');
  if (!root) return;
  const report = (typeof buildCoachReport === 'function') ? buildCoachReport(summary) : null;
  if (!report || !report.eligible) {
    root.classList.add('hidden');
    return;
  }
  const headline = `${report.verdict.verdict} · ${report.pct}%`;
  const headlineEl = $('ecMiniHeadline');
  if (headlineEl) headlineEl.textContent = headline;

  const next = report.nextAction;
  const ctaLabel = $('ecMiniCtaLabel');
  const ctaReason = $('ecMiniReason');
  const ctaBtn = $('ecMiniReviewBtn');
  if (next) {
    if (ctaLabel) ctaLabel.textContent = next.title || 'Next step';
    if (ctaReason) ctaReason.textContent = next.reason || '';
    if (ctaBtn) {
      ctaBtn.textContent = next.cta || 'Start';
      ctaBtn.onclick = () => {
        if (typeof launchRecommendedAction === 'function') launchRecommendedAction(next);
      };
    }
  } else {
    if (ctaLabel) ctaLabel.textContent = 'Next step';
    if (ctaReason) ctaReason.textContent = 'Keep practising — Coach has no new action.';
    if (ctaBtn) {
      ctaBtn.textContent = 'Home';
      ctaBtn.onclick = () => { if (typeof goHome === 'function') goHome(); else showScreen('home'); };
    }
  }
  root.classList.remove('hidden');
}

// Two compact 14-day line charts at the bottom of the result screen.
// Reuses renderActivityCharts (already used by Statistics v2). When the
// user has no chart data yet (first session, ever), the chart still
// draws with blank points — no crash, just a sparse line.
const _resultChartSlots = {};
// _v2 — bumped so users with a saved 30/7 preference get reset to the new
// 14-day default. After this, persistence resumes from whatever they pick.
const RESULT_CHART_RANGE_KEY = 'exams_quiz_result_chart_range_v2';
const RESULT_CHART_RANGE_ALLOWED = [7, 14, 30];
function loadResultChartRange() {
  const raw = parseInt(localStorage.getItem(RESULT_CHART_RANGE_KEY), 10);
  return RESULT_CHART_RANGE_ALLOWED.includes(raw) ? raw : 14;
}
function saveResultChartRange(range) {
  try { localStorage.setItem(RESULT_CHART_RANGE_KEY, String(range)); } catch {}
}
function setResultChartTitles(range) {
  const actTitle = document.getElementById('resActivityChartTitle');
  const rdTitle = document.getElementById('resReadinessChartTitle');
  const passTitle = document.getElementById('resPassChartTitle');
  const masteryTitle = document.getElementById('resLeitnerBoxChartTitle');
  if (actTitle) actTitle.textContent = `📅 Activity over ${range} days`;
  if (rdTitle) rdTitle.textContent = `Readiness · last ${range} days`;
  if (passTitle) passTitle.textContent = `Pass probability · last ${range} days`;
  if (masteryTitle) masteryTitle.textContent = `Mastery distribution · last ${range} days`;
}
function syncResultChartRangeButtons(range) {
  const wrap = document.getElementById('resultChartRange');
  if (!wrap) return;
  wrap.querySelectorAll('.admin-chart-scope-btn').forEach(btn => {
    const active = parseInt(btn.dataset.range, 10) === range;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}
// Async because we fetch this user's cloud analytics doc (readinessDaily +
// dailyStats) so the chart can show history older than localStorage.
async function renderResultHistoryCharts(exam) {
  if (typeof renderActivityCharts !== 'function') return;
  if (!document.getElementById('resActivityChart')) return;
  initResultChartRangeToggle();
  const range = loadResultChartRange();
  syncResultChartRangeButtons(range);
  setResultChartTitles(range);

  let meAnalytics = null;
  if (window.cloudSync && typeof window.cloudSync.getMyAnalytics === 'function'
      && currentUser && currentUser.uid) {
    try { meAnalytics = await window.cloudSync.getMyAnalytics(currentUser.uid); }
    catch {}
  }

  try {
    renderActivityCharts({
      range,
      scope: 'me',
      isFiltered: true,
      examFilter: exam,
      users: meAnalytics ? [meAnalytics] : [],
      currentUser: typeof currentUser !== 'undefined' ? currentUser : null,
      readinessExam: exam,
      ids: {
        barId: 'resActivityChart',
        readinessId: 'resReadinessChart',
        passId: 'resPassChart',
        leitnerBoxId: 'resLeitnerBoxChart',
      },
      slots: _resultChartSlots,
    });
  } catch (e) {
    console.warn('[result charts] render failed', e);
  }
}
function initResultChartRangeToggle() {
  const wrap = document.getElementById('resultChartRange');
  if (!wrap || wrap.dataset.bound === '1') return;
  wrap.dataset.bound = '1';
  wrap.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.admin-chart-scope-btn');
    if (!btn) return;
    const next = parseInt(btn.dataset.range, 10);
    if (!next || !RESULT_CHART_RANGE_ALLOWED.includes(next)) return;
    if (next === loadResultChartRange()) return;
    saveResultChartRange(next);
    if (typeof S !== 'undefined' && S && S.exam) renderResultHistoryCharts(S.exam);
  });
}

const EXAM_TYPE_LABELS = { mini: 'Practice', std: 'Mock', case: 'Case' };

function renderExamCards() {
  const examKeys = getDisplayedExamCodes(Object.keys(S.db?.exams || {}));
  $('examSelector').innerHTML = examKeys.map(key => {
    const ex = getExam(key);
    const available = isExamAvailable(key);
    const total = available ? getExamQuestionCount(key) : 0;
    const fullName = ex?.name || ex?.title || key;
    const tooltip = available
      ? `${fullName} · ${total} questions`
      : `${fullName} · ${getExamStatusLabel(key)}`;
    const activeCls = key === S.exam ? ' is-active' : '';
    const disabledAttrs = available
      ? ''
      : ' disabled aria-disabled="true" style="opacity:0.45;cursor:not-allowed"';
    return `<button type="button" class="version-pill${activeCls}" data-exam="${escapeHtml(key)}" title="${escapeHtml(tooltip)}"${disabledAttrs}>${escapeHtml(key)}</button>`;
  }).join('');

  $('examSelector').querySelectorAll('button[data-exam]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const examCode = btn.dataset.exam;
      if (!examCode || !isExamAvailable(examCode)) return;
      await selectExam(examCode, { renderCards: false });
      renderExamCards();
    });
  });
}

function bindHomeEvents() {
  if (homeEventsBound) return;
  homeEventsBound = true;

  $('logoutBtn').addEventListener('click', logout);
  // Admin tools — header icons hidden; entries live inside My Profile.
  // Wire click handlers on header icons so any external code that calls .click()
  // still works, but visibility is managed via #profileAdminTools.
  if ($('adminBtn')) { $('adminBtn').addEventListener('click', openAdminDashboard); }
  if ($('allQuestionsBtn')) { $('allQuestionsBtn').addEventListener('click', openAllQuestionsDashboard); }
  syncAdminToolsVisibility();
  // profileAnalyticsBtn was removed — "My statistics" now lives in the
  // header dropdown (📚) so users can reach it from any screen.
  if ($('profileAllQuestionsBtn')) {
    $('profileAllQuestionsBtn').addEventListener('click', function() {
      closeProfileScreen();
      openAllQuestionsDashboard();
    });
  }
  if ($('referencesBtn')) $('referencesBtn').addEventListener('click', openReferences);
  if ($('referencesCloseBtn')) $('referencesCloseBtn').addEventListener('click', closeReferences);

  // Study insights dropdown — replaces former #weakQBtn + #topicsBtn header
  // icons with a single 📚 trigger that fans out to: My statistics / Topics /
  // Weak. Outside-click and Escape close the menu; item click routes to
  // existing open* handlers (which auto-close other aux screens).
  var studyTrigger = $('studyDropdownTrigger');
  var studyMenu = $('studyDropdownMenu');
  if (studyTrigger && studyMenu) {
    var closeStudyMenu = function() {
      studyMenu.classList.add('hidden');
      studyTrigger.setAttribute('aria-expanded', 'false');
    };
    studyTrigger.addEventListener('click', function(e) {
      e.stopPropagation();
      var isOpen = !studyMenu.classList.contains('hidden');
      if (isOpen) closeStudyMenu();
      else {
        studyMenu.classList.remove('hidden');
        studyTrigger.setAttribute('aria-expanded', 'true');
      }
    });
    document.addEventListener('click', function(e) {
      if (!studyMenu.classList.contains('hidden') &&
          !studyMenu.contains(e.target) && !studyTrigger.contains(e.target)) {
        closeStudyMenu();
      }
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeStudyMenu();
    });
    studyMenu.querySelectorAll('.header-dropdown-item').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var action = btn.dataset.action;
        closeStudyMenu();
        if (action === 'myStats') openAdminDashboard();
        else if (action === 'myStatsV2') openStatsV2();
        else if (action === 'topics') openTopicsDashboard();
        else if (action === 'weak') openWeakQDashboard();
      });
    });
  }
  if ($('adminCloseBtn')) $('adminCloseBtn').addEventListener('click', closeAdminDashboard);
  if ($('statsV2CloseBtn')) $('statsV2CloseBtn').addEventListener('click', closeStatsV2);
  if ($('homeV2CloseBtn')) $('homeV2CloseBtn').addEventListener('click', closeHomeV2);
  if ($('profileBtn')) $('profileBtn').addEventListener('click', openProfileScreen);
  if ($('profileCloseBtn')) $('profileCloseBtn').addEventListener('click', closeProfileScreen);
  if ($('hotkeysCloseBtn')) $('hotkeysCloseBtn').addEventListener('click', closeHotkeys);
  if ($('profileSaveBtn')) $('profileSaveBtn').addEventListener('click', saveUserProfile);
  if ($('changePasswordBtn')) $('changePasswordBtn').addEventListener('click', changeUserPassword);
  const sectionToggleBtn = $('domainSectionToggle');
  if (sectionToggleBtn) {
    sectionToggleBtn.addEventListener('click', () => {
      const panel = $('domainSection');
      if (!panel) return;
      const willCollapse = !panel.classList.contains('is-collapsed');
      panel.classList.toggle('is-collapsed', willCollapse);
      sectionToggleBtn.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
    });
  }
  const flashSectionToggleBtn = $('flashDomainSectionToggle');
  if (flashSectionToggleBtn) {
    flashSectionToggleBtn.addEventListener('click', () => {
      const panel = $('flashDomainSection');
      if (!panel) return;
      const willCollapse = !panel.classList.contains('is-collapsed');
      panel.classList.toggle('is-collapsed', willCollapse);
      flashSectionToggleBtn.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
    });
  }
  $('practiceCountPicker').addEventListener('change', event => {
    S.practiceQuestionCount = Number(event.target.value) || 10;
    updateBadges();
    refreshSelectionSummary();
  });
  $('flashcardCountPicker').addEventListener('change', event => {
    S.flashcardQuestionCount = Number(event.target.value) || 20;
    updateBadges();
    refreshSelectionSummary();
  });
  $('startBtn').addEventListener('click', startQuiz);
  $('nextBtn').addEventListener('click', nextQuestion);
  $('skipBtn').addEventListener('click', skipQuestion);

  // Floating "Next" FAB — mirrors #nextBtn visibility so the user can
  // advance without scrolling past the explanation block. We watch the
  // inline button's class/style attrs and forward clicks to it.
  const fab = document.getElementById('floatingNextFab');
  const inlineNext = document.getElementById('nextBtn');
  if (fab && inlineNext) {
    fab.addEventListener('click', () => inlineNext.click());
    const syncFab = () => {
      const visible = inlineNext.classList.contains('visible')
        && !inlineNext.classList.contains('hidden')
        && inlineNext.style.display !== 'none'
        && inlineNext.offsetParent !== null;
      // Match the inline button's label intent (last question shows "Show results")
      const isLast = (inlineNext.textContent || '').toLowerCase().includes('result');
      fab.textContent = isLast ? '✓' : '→';
      fab.setAttribute('aria-label', isLast ? 'Show results' : 'Next question');
      fab.classList.toggle('visible', visible);
      fab.classList.toggle('hidden', !visible);
    };
    syncFab();
    new MutationObserver(syncFab).observe(inlineNext, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      childList: true,
      characterData: true,
      subtree: true,
    });
    // Hotkeys inside a quiz session:
    //   A-F           — select / toggle option by letter (matches the
    //                   visual letter rendered by renderMCQ, which uses
    //                   String.fromCharCode(65 + idx))
    //   Enter         — if answered → next; if multi-select with ≥1 picked
    //                   and submit button enabled → submit; otherwise no-op
    //   ArrowRight    — if answered → next; otherwise → skip (sends q to
    //                   the end of the queue)
    // Bail-outs: focus in INPUT/TEXTAREA/contentEditable, or any modifier
    // key held — so typing in the reflection box / search field doesn't
    // accidentally answer or skip.
    document.addEventListener('keydown', (e) => {
      // "?" needs Shift+/ on most layouts — handle it before the modifier
      // bail-out so the help shortcut still works.
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t0 = e.target;
        const tag0 = (t0 && t0.tagName) || '';
        if (tag0 !== 'INPUT' && tag0 !== 'TEXTAREA' && !(t0 && t0.isContentEditable)) {
          e.preventDefault();
          if (typeof openHotkeys === 'function') openHotkeys();
          return;
        }
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      const tag = (t && t.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      const key = e.key;

      // Already answered → ArrowRight/Enter advances.
      if (fab.classList.contains('visible')) {
        if (key !== 'ArrowRight' && key !== 'Enter') return;
        e.preventDefault();
        inlineNext.click();
        return;
      }

      // S → toggle Star/favorite on the current question (uses S, not F,
      // because F is also an option letter on multi-choice questions).
      if (key === 's' || key === 'S') {
        const favBtn = document.getElementById('favoriteBtn');
        if (favBtn && favBtn.offsetParent !== null) {
          e.preventDefault();
          favBtn.click();
        }
        return;
      }

      // H → reveal hint (tip) on the current question, if available.
      if (key === 'h' || key === 'H') {
        const hintBtn = document.getElementById('hintBtn');
        if (hintBtn && !hintBtn.classList.contains('hidden') && hintBtn.offsetParent !== null) {
          e.preventDefault();
          hintBtn.click();
        }
        return;
      }

      // Letter A-F or digit 1-6 selects/toggles the matching option.
      // Digits work both from the main number row and the numpad (e.key is
      // the character, so we just look at it directly).
      if (key.length === 1) {
        let idx = -1;
        const upper = key.toUpperCase();
        if (upper >= 'A' && upper <= 'F') {
          idx = upper.charCodeAt(0) - 65;
        } else if (key >= '1' && key <= '6') {
          idx = parseInt(key, 10) - 1;
        }
        if (idx >= 0) {
          const optionsList = document.getElementById('optionsList');
          if (!optionsList || optionsList.classList.contains('hidden')) return;
          if (optionsList.offsetParent === null) return;
          const optBtn = optionsList.querySelector(`.option-btn[data-idx="${idx}"]`);
          if (optBtn && !optBtn.disabled && optBtn.offsetParent !== null) {
            e.preventDefault();
            optBtn.click();
          }
          return;
        }
      }

      // Multi-select: Enter submits the current selection when allowed.
      if (key === 'Enter') {
        const submitBtn = document.getElementById('mcqSubmitBtn');
        if (submitBtn
            && !submitBtn.disabled
            && !submitBtn.classList.contains('hidden')
            && submitBtn.offsetParent !== null) {
          e.preventDefault();
          submitBtn.click();
        }
        return;
      }

      // ArrowRight on unanswered question skips it.
      if (key === 'ArrowRight') {
        const skipBtn = document.getElementById('skipBtn');
        const skipVisible = skipBtn
          && !skipBtn.classList.contains('hidden')
          && skipBtn.style.display !== 'none'
          && skipBtn.offsetParent !== null;
        if (skipVisible) {
          e.preventDefault();
          skipBtn.click();
        }
      }
    });
  }
  $('mcqSubmitBtn').addEventListener('click', submitMCQAnswer);
  const _ddBtn = $('ddSubmitBtn');
  if (_ddBtn) _ddBtn.addEventListener('click', () => handleDragDropAnswer(S.questions[S.idx]));
  const _hotspotBtn = $('hotspotSubmitBtn');
  if (_hotspotBtn) _hotspotBtn.addEventListener('click', () => handleHotspotAnswer(S.questions[S.idx]));
  const _matchingBtn = $('matchingSubmitBtn');
  if (_matchingBtn) _matchingBtn.addEventListener('click', () => handleMatchingAnswer(S.questions[S.idx]));
  $('revealBtn').addEventListener('click', revealOpen);
  
  $('assessHard').addEventListener('click', () => assessOpenAnki('hard'));
  $('assessNormal').addEventListener('click', () => assessOpenAnki('normal'));
  $('assessEasy').addEventListener('click', () => assessOpenAnki('easy'));

  $('retryBtn').addEventListener('click', retrySession);
  $('weakBtn').addEventListener('click', startWeakSession);
  $('retryWrongBtn').addEventListener('click', retryWrongAnswers);
  $('resumeBtn').addEventListener('click', resumeSavedSession);
  const goHome = () => {
    stopTimer();
    updateModeUI();
    // Close any open aux screen and ensure main .app is visible
    _hideAllAuxScreens();
    var mainApp = document.querySelector('.app:not([id])');
    if (mainApp) mainApp.style.display = 'flex';
    showScreen('home');
    updateGlobalStats();
    updateHeaderBadge();
    if (typeof renderStudyPlan === 'function') renderStudyPlan();
    try { renderExamCountdown && renderExamCountdown(); } catch {}
    // Unseen count drops with every answered question — refresh on return.
    try { renderCoverageFilterPanel && renderCoverageFilterPanel(); } catch {}
    if (typeof clearExamCoachReport === 'function') clearExamCoachReport();
  };
  // #homeBtn was removed from the result page (Home lives in the sidebar);
  // bind only if a host page (e.g. legacy embeds) still has it.
  const resultHome = $('homeBtn');
  if (resultHome) resultHome.addEventListener('click', goHome);
  const headerHome = $('headerHomeBtn');
  if (headerHome) headerHome.addEventListener('click', goHome);
  // Expose so sidebar handlers (in other scopes) can call the full
  // goHome reset instead of their own partial close logic.
  window.goHome = goHome;
  $('finishEarlyBtn').addEventListener('click', () => {
    if (S.idx === 0 || confirm(`Finish test? Answered ${S.idx} of ${S.questions.length} questions.`)) {
      finishQuiz();
    }
  });
}

async function initHome() {
  S.exam = getDefaultExamKey();
  S.versionFilter = loadVersionFilter();
  S.langFilter = loadLangFilter();
  S.lessonFilter = loadLessonFilter();
  S.coverageFilter = loadCoverageFilter();
  renderLanguageFilterPanel();
  renderVersionFilterPanel();
  renderLessonFilterPicker();
  renderCoverageFilterPanel();
  renderExamCards();

  if (!homeEventsBound) {
    document.querySelectorAll('.mode-card').forEach(card => {
      card.addEventListener('click', () => {
        // mock_exam is locked for Free — click opens the plans modal.
        if (card.dataset.mode === 'mock_exam'
            && window.cloudSync && typeof window.cloudSync.canAccess === 'function'
            && !window.cloudSync.canAccess('mock_exam')) {
          // ── Phase 4.1 event ──
          try {
            const access = window.cloudSync?.getCachedAccess?.() || null;
            window.cloudSync?.logEvent?.('locked_clicked', {
              feature: 'mock_exam',
              current_plan: access && (access.plan_id || access.tier) || null,
              surface: 'mode_card',
            });
          } catch (_) {}
          if (typeof openPlansModal === 'function') openPlansModal();
          return;
        }
        document.querySelectorAll('.mode-card').forEach(node => node.classList.remove('selected'));
        card.classList.add('selected');
        S.mode = card.dataset.mode;
        updateModeUI();
        // ── Phase 4.1 event: feature_first_use (dedup per device) ──
        try {
          const m = card.dataset.mode;
          const flagKey = 'eq_feat_first_' + m;
          if (m && !localStorage.getItem(flagKey)) {
            localStorage.setItem(flagKey, '1');
            window.cloudSync?.logEvent?.('feature_first_use', {
              feature: m,
              surface: 'mode_card',
            });
          }
        } catch (_) {}
      });
    });
  }

  bindHomeEvents();
  await selectExam(S.exam, { renderCards: false });
  updateGlobalStats();
  updateHeaderBadge();
  showScreen('home');
  renderDailyChallenge();
  renderExamCountdown();
  if (typeof renderStudyPlan === 'function') renderStudyPlan();
}

function renderLanguageFilterPanel() {
  const panel = $('languageFilterPanel');
  const pills = $('languagePills');
  if (!panel || !pills) return;
  const langs = getAvailableLanguages();
  if (langs.length < 2) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const current = S.langFilter || 'all';
  const LABELS = { all: 'All languages', ru: '🇷🇺 Russian', en: '🇬🇧 English' };
  const buttons = [{ value: 'all', label: LABELS.all }].concat(
    langs.map(v => ({ value: v, label: LABELS[v] || v }))
  );
  pills.innerHTML = buttons.map(b => {
    const active = b.value === current ? ' is-active' : '';
    return `<button type="button" class="version-pill${active}" data-lang="${escapeHtml(b.value)}">${escapeHtml(b.label)}</button>`;
  }).join('');
  pills.querySelectorAll('button[data-lang]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-lang');
      if (!next || next === S.langFilter) return;
      S.langFilter = next;
      saveLangFilter(next);
      pills.querySelectorAll('button[data-lang]').forEach(b => {
        b.classList.toggle('is-active', b.getAttribute('data-lang') === next);
      });
      try { renderExamCards && renderExamCards(); } catch {}
      try { selectExam && selectExam(S.exam, { renderCards: false }); } catch {}
      try { updateGlobalStats && updateGlobalStats(); } catch {}
      try { renderStudyPlan && renderStudyPlan(); } catch {}
      try { renderExamCountdown && renderExamCountdown(); } catch {}
      try { renderLessonFilterPicker && renderLessonFilterPicker(); } catch {}
      try { renderCoverageFilterPanel && renderCoverageFilterPanel(); } catch {}
    });
  });
}

// "Question status" pills: All / Unseen. Unseen = no entry in
// store.questionStats for q.id, or stored total === 0. Lets the user
// jump into Practice on questions they've never attempted before.
// Counts are computed under the active version/lang/lesson filters so
// the number reflects exactly what Start will play.
function renderCoverageFilterPanel() {
  const panel = $('coverageFilterPanel');
  const pills = $('coveragePills');
  if (!panel || !pills) return;
  const ex = getExam();
  const all = (ex && ex.questions) || [];
  const v = S.versionFilter;
  const lang = S.langFilter;
  const lesson = S.lessonFilter;
  const stats = getQuestionStatsMap();
  let total = 0, unseen = 0;
  for (const q of all) {
    if (v && v !== 'all' && (q.version || 'gen1') !== v) continue;
    if (lang && lang !== 'all' && (q.language || 'ru') !== lang) continue;
    if (lesson && lesson !== 'all' && String(q.lesson || '') !== String(lesson)) continue;
    total += 1;
    const s = stats[getQuestionKey(q)];
    if (!s || !(s.total > 0)) unseen += 1;
  }
  panel.classList.remove('hidden');
  const current = S.coverageFilter === 'unseen' ? 'unseen' : 'all';
  const buttons = [
    { value: 'all',    label: 'All (' + total + ')' },
    { value: 'unseen', label: '✨ Unseen (' + unseen + ')' },
  ];
  pills.innerHTML = buttons.map(b => {
    const active = b.value === current ? ' is-active' : '';
    return '<button type="button" class="version-pill' + active + '" data-coverage="' + escapeHtml(b.value) + '">' + escapeHtml(b.label) + '</button>';
  }).join('');
  pills.querySelectorAll('button[data-coverage]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-coverage');
      const curr = S.coverageFilter || 'all';
      if (!next || next === curr) return;
      S.coverageFilter = next;
      saveCoverageFilter(next);
      pills.querySelectorAll('button[data-coverage]').forEach(b => {
        b.classList.toggle('is-active', b.getAttribute('data-coverage') === next);
      });
      try { renderExamCards && renderExamCards(); } catch {}
      try { selectExam && selectExam(S.exam, { renderCards: false }); } catch {}
      try { updateGlobalStats && updateGlobalStats(); } catch {}
      try { renderStudyPlan && renderStudyPlan(); } catch {}
      try { renderExamCountdown && renderExamCountdown(); } catch {}
      try { renderLessonFilterPicker && renderLessonFilterPicker(); } catch {}
    });
  });
}

function renderVersionFilterPanel() {
  const panel = $('versionFilterPanel');
  const pills = $('versionPills');
  if (!panel || !pills) return;
  const versions = getAvailableVersions();
  if (versions.length < 2) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const current = S.versionFilter || 'all';
  const buttons = [
    { value: 'all', label: 'All versions' },
    ...versions.map(v => ({ value: v, label: v })),
  ];
  pills.innerHTML = buttons.map(b => {
    const active = b.value === current ? ' is-active' : '';
    return `<button type="button" class="version-pill${active}" data-version="${escapeHtml(b.value)}">${escapeHtml(b.label)}</button>`;
  }).join('');
  pills.querySelectorAll('button[data-version]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-version');
      if (!next || next === S.versionFilter) return;
      S.versionFilter = next;
      saveVersionFilter(next);
      pills.querySelectorAll('button[data-version]').forEach(b => {
        b.classList.toggle('is-active', b.getAttribute('data-version') === next);
      });
      // Re-derive pool-dependent UI: exam cards (counts), badges, study plan.
      try { renderExamCards && renderExamCards(); } catch {}
      try { selectExam && selectExam(S.exam, { renderCards: false }); } catch {}
      try { updateGlobalStats && updateGlobalStats(); } catch {}
      try { renderStudyPlan && renderStudyPlan(); } catch {}
      try { renderExamCountdown && renderExamCountdown(); } catch {}
      try { renderLessonFilterPicker && renderLessonFilterPicker(); } catch {}
      try { renderCoverageFilterPanel && renderCoverageFilterPanel(); } catch {}
    });
  });
}

// Lesson dropdown next to "Number of questions". Visible only when the
// current version+lang+exam combination has at least one question with a
// `lesson` field (db1 / db2 today; gen1/gen2/cs24 don't carry lessons).
function renderLessonFilterPicker() {
  const cell = $('lessonFilterCell');
  const sel = $('lessonFilterPicker');
  if (!cell || !sel) return;
  const lessons = getAvailableLessons();
  if (!lessons.length) {
    cell.classList.add('hidden');
    return;
  }
  cell.classList.remove('hidden');
  const current = S.lessonFilter || 'all';
  // If the previously-selected lesson disappeared from the pool (e.g. user
  // switched version), silently fall back to "all".
  const effective = current !== 'all' && !lessons.includes(String(current)) ? 'all' : current;
  if (effective !== current) {
    S.lessonFilter = effective;
    saveLessonFilter(effective);
  }
  sel.innerHTML = '<option value="all">All lessons</option>' +
    lessons.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(formatLessonCoord(S.versionFilter, l))}</option>`).join('');
  sel.value = effective;
  sel.onchange = () => {
    const next = sel.value || 'all';
    S.lessonFilter = next;
    saveLessonFilter(next);
    try { renderExamCards && renderExamCards(); } catch {}
    try { selectExam && selectExam(S.exam, { renderCards: false }); } catch {}
    try { updateGlobalStats && updateGlobalStats(); } catch {}
    try { renderStudyPlan && renderStudyPlan(); } catch {}
    try { renderExamCountdown && renderExamCountdown(); } catch {}
  };
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

function installCopyGuard() {
  // Copy/selection protection was disabled by request — keeping only the
  // watermark CSS as a soft deterrent. The Ctrl+S/P/U guard stays.
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'p' || k === 'u')) {
      e.preventDefault();
    }
  });
}

function updateWatermark() {
  document.documentElement.style.setProperty('--wm-text', '"https://app.ms-cert.workers.dev"');
}

document.addEventListener('DOMContentLoaded', () => {
  initLogin();
  installCopyGuard();

  // Local dev bypass
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    const logo = document.querySelector('.login-logo');
    if (logo) {
      logo.style.cursor = 'pointer';
      logo.title = 'Dev Bypass';
      logo.addEventListener('click', () => {
        console.log('Dev bypass triggered');
        currentUser = { email: 'naziz.kz@gmail.com', uid: 'dev-user', displayName: 'Developer' };
        window.currentUser = currentUser;
        updateWatermark();
        isPremium = true;
        syncAdminToolsVisibility();
        hideLandingDemo();
        $('screenLogin').classList.remove('active');
        // Top header permanently hidden — all nav lives in #appSidebar.
        $('homeActionBar').classList.remove('hidden');
        setAppSidebarVisible(true);
        loadDB().catch(console.error);
      });
    }
  }

  // Wait for Firebase module to load, then hook into auth state
  const tryBindFirebase = () => {
    if (!window.cloudSync) {
      setTimeout(tryBindFirebase, 200);
      return;
    }
    window.cloudSync.onAuthChange(async (user) => {
      if (user) {
        // Cross-account contamination guard. localStorage (SECTION_STATS_KEY,
        // MASTERY_KEY, READINESS_HISTORY_KEY) is per-browser, not per-uid.
        // If a different Google account previously used this browser, the
        // store still carries their data. Without this clear, pullCloudProgress
        // would leave stale data when the new account has no cloud doc yet,
        // and saveAnalytics(user, loadStore()) would then overwrite the new
        // user's analytics doc with the previous user's stats.
        try {
          const LAST_UID_KEY = 'eq_last_uid';
          const prevUid = localStorage.getItem(LAST_UID_KEY);
          if (prevUid && prevUid !== user.uid) {
            console.warn('[auth] uid changed:', prevUid, '→', user.uid, '— clearing local store to avoid cross-account contamination');
            localStorage.removeItem(SECTION_STATS_KEY);
            localStorage.removeItem(MASTERY_KEY);
            localStorage.removeItem(READINESS_HISTORY_KEY);
          }
          localStorage.setItem(LAST_UID_KEY, user.uid);
        } catch (_) {}
        currentUser = user;
        window.currentUser = currentUser;
        // ── Phase 4.1 event: signup — fire once per uid per device.
        // Uses Firebase Auth metadata (creationTime ≈ lastSignInTime within
        // 30s ⇒ brand-new account) plus a localStorage dedupe flag so we
        // don't re-fire on every reload of a fresh-but-not-new user. ──
        try {
          const signupKey = 'eq_signup_fired_' + user.uid;
          if (!localStorage.getItem(signupKey)) {
            const created = new Date(user.metadata?.creationTime || 0).getTime();
            const lastSignIn = new Date(user.metadata?.lastSignInTime || 0).getTime();
            const isFresh = created && lastSignIn && Math.abs(lastSignIn - created) < 30_000;
            if (isFresh) {
              window.cloudSync?.logEvent?.('signup', { provider: 'google' });
            }
            localStorage.setItem(signupKey, '1');
          }
        } catch (_) {}
        updateWatermark();
        isPremium = ALLOWED_EMAILS.includes(user.email);
        syncAdminToolsVisibility();
        hideLandingDemo();
        $('screenLogin').classList.remove('active');
        // Top header permanently hidden — all nav lives in #appSidebar.
        $('homeActionBar').classList.remove('hidden');
        setAppSidebarVisible(true);
        // Pull cloud progress before loading app
        await pullCloudProgress();
        // Save profile & analytics snapshot
        if (window.cloudSync) {
          window.cloudSync.saveProfile(user).catch(() => {});
          window.cloudSync.initUserProfile(user).then(p => {
            if (p) userProfile = p;
            // Hydrate visibleExams: prefer cloud, fall back to LS, else
            // first-load default (all accessible exams).
            if (!Array.isArray(userProfile.visibleExams)) {
              var fromLS = (typeof loadVisibleExamsFromLS === 'function') ? loadVisibleExamsFromLS() : null;
              if (fromLS && fromLS.length) {
                userProfile.visibleExams = fromLS;
              } else if (typeof _accessibleExamCodes === 'function') {
                userProfile.visibleExams = _accessibleExamCodes();
              }
            }
            // Cache to LS for next reload-before-firebase boot.
            if (Array.isArray(userProfile.visibleExams) && typeof saveVisibleExamsToLS === 'function') {
              saveVisibleExamsToLS(userProfile.visibleExams);
            }
            if (typeof _refreshAllExamPickers === 'function') _refreshAllExamPickers();
          }).catch(() => {});
          const store = loadStore();
          window.cloudSync.saveAnalytics(user, store).catch(() => {});
          renderTierBadge(null);
          if (typeof updateLockedModeCards === 'function') updateLockedModeCards();
          if (typeof updateLockedSidebarItems === 'function') updateLockedSidebarItems();
        }
        loadDB().then(() => { maybeShowStreakBanner(); }).catch(err => {
          renderDataLoadError(err);
          console.error(err);
        });
      } else {
        // Not logged in — show login screen
        currentUser = null;
        window.currentUser = null;
        S.db = null;
        $('mainHeader').classList.add('hidden');
        $('homeActionBar').classList.add('hidden');
        setAppSidebarVisible(false);
        Object.values(screens).forEach(el => el.classList.remove('active'));
        $('screenLogin').classList.add('active');
        renderLandingDemo();
        renderTierBadge(null);
      }
    });
  };

  // Dev mode: skip auth on localhost
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    currentUser = { uid: 'dev', email: 'dev@localhost', displayName: 'Dev' };
    window.currentUser = currentUser;
    isPremium = true;
    hideLandingDemo();
    $('screenLogin').classList.remove('active');
    $('mainHeader').classList.remove('hidden');
    $('homeActionBar').classList.remove('hidden');
    setAppSidebarVisible(true);
    loadDB().catch(console.error);
  } else {
    renderLandingDemo();
    tryBindFirebase();
  }
});


// ══ Profile Screen ══════════════════════════════════════════════
function openProfileScreen() {
  document.querySelector('.app:not([id])').style.display = 'none';
  _hideAllAuxScreens('profileApp');
  const app = $('profileApp');
  app.style.display = 'flex';
  $('profileAvatar').textContent = userProfile.avatar || '🎯';
  $('profileNameInput').value = userProfile.displayName || '';
  $('profileError').textContent = '';
  renderAvatarGrid();
  if (typeof renderProfileSubscription === 'function') renderProfileSubscription();
  const isEmailAuth = currentUser?.providerData?.some(p => p.providerId === 'password');
  $('passwordSection').style.display = isEmailAuth ? 'block' : 'none';
  if ($('targetExamPicker')) $('targetExamPicker').value = userProfile.targetExam || '';
  if ($('examDatePicker')) $('examDatePicker').value = userProfile.examDate || '';
  if ($('dailyPlanPicker')) $('dailyPlanPicker').value = String((userProfile && Number(userProfile.dailyPlan)) || MetricsConfig.DAILY_PLAN.defaultGoal);
  if ($('useBootstrapCI')) $('useBootstrapCI').checked = !!(userProfile && userProfile.useBootstrapCI);
  if ($('hideQODToggle')) $('hideQODToggle').checked = !!userProfile.hideQuestionOfDay;
  if (typeof renderVisibleExamsPanel === 'function') renderVisibleExamsPanel();
  if (typeof updateAppSidebarActive === 'function') updateAppSidebarActive();
}

// ── Visible Exams panel (My Profile) ──
// User preference: which exams should appear in UI pickers across the
// site. Stored on userProfile.visibleExams; persisted via cloudSync
// saveUserProfile() merge. Migration default = all accessible exams.
var VISIBLE_EXAMS_LS_KEY = 'eq_visible_exams_v1';
var _visibleExamsSaveTimer = null;

function loadVisibleExamsFromLS() {
  try {
    var raw = localStorage.getItem(VISIBLE_EXAMS_LS_KEY);
    if (!raw) return null;
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch (_) { return null; }
}
function saveVisibleExamsToLS(arr) {
  try { localStorage.setItem(VISIBLE_EXAMS_LS_KEY, JSON.stringify(arr || [])); } catch (_) {}
}

function _accessibleExamCodes() {
  // All "candidate" exams come from EXAM_PROFILES (the canonical app
  // catalogue). Filter to access only — ignore visibility, since this
  // panel IS where visibility is chosen.
  var profiles = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES) ? EXAM_PROFILES : {};
  return getDisplayedExamCodes(Object.keys(profiles), { ignoreVisible: true });
}

function renderVisibleExamsPanel() {
  var grid = $('visibleExamsGrid');
  var countEl = $('visibleExamsCount');
  var warnEl = $('visibleExamsWarn');
  if (!grid) return;
  var accessible = _accessibleExamCodes();
  // First-load migration: if user has never set visibleExams, default to
  // every accessible exam (everything visible).
  if (!Array.isArray(userProfile.visibleExams)) {
    var fromLS = loadVisibleExamsFromLS();
    userProfile.visibleExams = (fromLS && fromLS.length) ? fromLS : accessible.slice();
  }
  var visible = userProfile.visibleExams;
  var profiles = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES) ? EXAM_PROFILES : {};
  grid.innerHTML = accessible.map(function(code) {
    var profile = profiles[code] || {};
    var label = profile.label ? profile.label : code;
    var checked = visible.indexOf(code) !== -1 ? ' checked' : '';
    return '<label class="visible-exams-item" data-exam-code="' + escapeHtml(code) + '">'
      + '<input type="checkbox" data-exam="' + escapeHtml(code) + '"' + checked + '>'
      + '<span><strong>' + escapeHtml(code) + '</strong>'
      + (label && label !== code ? ' <span style="color:var(--text-muted);font-weight:400">— ' + escapeHtml(label) + '</span>' : '')
      + '</span></label>';
  }).join('');
  _updateVisibleExamsCount();
  if (warnEl) warnEl.classList.add('hidden');

  // Wire bindings once per panel render — innerHTML reset clears prior listeners.
  grid.querySelectorAll('input[type="checkbox"][data-exam]').forEach(function(cb) {
    cb.addEventListener('change', _onVisibleExamCheckboxChange);
  });
  if (!grid.dataset.bound) {
    var panel = $('visibleExamsPanel');
    if (panel) {
      panel.querySelectorAll('button[data-action]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var action = btn.getAttribute('data-action');
          if (action === 'select-all') {
            userProfile.visibleExams = _accessibleExamCodes().slice();
          } else if (action === 'clear') {
            // Don't actually clear — keep at least 1; surface warning instead.
            userProfile.visibleExams = [];
          }
          _persistVisibleExamsAndSync();
          renderVisibleExamsPanel();
        });
      });
      var search = $('visibleExamsSearch');
      if (search) {
        search.addEventListener('input', function() {
          var q = (search.value || '').toLowerCase().trim();
          grid.querySelectorAll('.visible-exams-item').forEach(function(it) {
            var code = it.getAttribute('data-exam-code') || '';
            var label = it.textContent || '';
            var match = !q || code.toLowerCase().indexOf(q) !== -1 || label.toLowerCase().indexOf(q) !== -1;
            it.classList.toggle('is-hidden', !match);
          });
        });
      }
    }
    grid.dataset.bound = '1';
  }
}

function _onVisibleExamCheckboxChange(ev) {
  var code = ev.target.getAttribute('data-exam');
  if (!code) return;
  if (!Array.isArray(userProfile.visibleExams)) userProfile.visibleExams = [];
  var idx = userProfile.visibleExams.indexOf(code);
  if (ev.target.checked && idx === -1) userProfile.visibleExams.push(code);
  if (!ev.target.checked && idx !== -1) userProfile.visibleExams.splice(idx, 1);
  _persistVisibleExamsAndSync();
}

function _updateVisibleExamsCount() {
  var countEl = $('visibleExamsCount');
  var warnEl = $('visibleExamsWarn');
  var n = Array.isArray(userProfile.visibleExams) ? userProfile.visibleExams.length : 0;
  if (countEl) countEl.textContent = '(' + n + ' selected)';
  if (warnEl) warnEl.classList.toggle('hidden', n > 0);
}

function _persistVisibleExamsAndSync() {
  _updateVisibleExamsCount();
  saveVisibleExamsToLS(userProfile.visibleExams || []);
  // Re-render all open exam pickers so visibility takes effect immediately.
  _refreshAllExamPickers();
  // Debounced Firestore save (avoid spam on rapid checkbox-toggle).
  if (_visibleExamsSaveTimer) clearTimeout(_visibleExamsSaveTimer);
  _visibleExamsSaveTimer = setTimeout(function() {
    _visibleExamsSaveTimer = null;
    if (window.cloudSync && typeof window.cloudSync.saveUserProfile === 'function'
        && currentUser && currentUser.uid && currentUser.uid !== 'dev') {
      try {
        window.cloudSync.saveUserProfile(currentUser.uid, {
          visibleExams: Array.isArray(userProfile.visibleExams) ? userProfile.visibleExams : [],
          updatedAt: new Date().toISOString(),
        });
      } catch (_) {}
    }
  }, 400);
}

function _refreshAllExamPickers() {
  try {
    if (typeof renderExamCards === 'function' && $('examSelector')) renderExamCards();
  } catch (_) {}
  try {
    if ($('weakGlobalExamTabs')) renderSharedExamTabs($('weakGlobalExamTabs'), S.exam, typeof setSharedExam === 'function' ? setSharedExam : null);
  } catch (_) {}
  try {
    if ($('topicsGlobalExamTabs')) renderSharedExamTabs($('topicsGlobalExamTabs'), S.exam, typeof setSharedExam === 'function' ? setSharedExam : null);
  } catch (_) {}
  try {
    if ($('favoritesExamTabs') && typeof initFavoritesExamTabs === 'function') initFavoritesExamTabs();
  } catch (_) {}
  // Stats v2 has its own tabs — re-render its body if open.
  try {
    if ($('statsV2App') && $('statsV2App').style.display !== 'none' && typeof renderStatsV2 === 'function') renderStatsV2();
  } catch (_) {}
}

function closeProfileScreen() {
  $('profileApp').style.display = 'none';
  document.querySelector('.app:not([id])').style.display = 'flex';
  _restoreMainHeader();
}

function renderAvatarGrid() {
  const grid = $('avatarGrid');
  if (!grid) return;
  grid.innerHTML = AVATARS.map(a =>
    `<button class="avatar-btn${a === userProfile.avatar ? ' selected' : ''}" data-avatar="${a}"
      style="font-size:1.6rem;background:${a === userProfile.avatar ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.05)'};border:2px solid ${a === userProfile.avatar ? 'var(--accent-primary)' : 'transparent'};border-radius:10px;padding:6px 8px;cursor:pointer;line-height:1">${a}</button>`
  ).join('');
  grid.querySelectorAll('.avatar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      userProfile.avatar = btn.dataset.avatar;
      $('profileAvatar').textContent = userProfile.avatar;
      grid.querySelectorAll('.avatar-btn').forEach(b => {
        const sel = b.dataset.avatar === userProfile.avatar;
        b.style.background = sel ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.05)';
        b.style.borderColor = sel ? 'var(--accent-primary)' : 'transparent';
      });
    });
  });
}

async function saveUserProfile() {
  const name = $('profileNameInput').value.trim();
  $('profileError').textContent = '';
  if (name.length < 2 || name.length > 20) {
    $('profileError').textContent = 'Nickname: 2–20 characters';
    return;
  }
  if (/@/.test(name)) {
    $('profileError').textContent = "Nickname can't contain @";
    return;
  }
  if (!/^[\w\-]+$/u.test(name)) {
    $('profileError').textContent = 'Letters, digits, hyphen or _ only';
    return;
  }
  const btn = $('profileSaveBtn');
  btn.disabled = true;
  try {
    const targetExam = $('targetExamPicker')?.value || '';
    const examDate = $('examDatePicker')?.value || '';
    const hideQuestionOfDay = $('hideQODToggle') ? !!$('hideQODToggle').checked : false;
    const visibleExams = Array.isArray(userProfile.visibleExams) ? userProfile.visibleExams : null;
    const dailyPlanRaw = $('dailyPlanPicker') ? $('dailyPlanPicker').value : '';
    const dailyPlanParsed = Number(dailyPlanRaw);
    const dailyPlan = (isFinite(dailyPlanParsed) && dailyPlanParsed > 0)
      ? Math.max(1, Math.min(2000, Math.round(dailyPlanParsed)))
      : 30;
    const useBootstrapCI = $('useBootstrapCI') ? !!$('useBootstrapCI').checked : false;
    if (window.cloudSync && currentUser?.uid !== 'dev') {
      await window.cloudSync.updateDisplayName(name);
      await window.cloudSync.saveUserProfile(currentUser.uid, {
        displayName: name,
        avatar: userProfile.avatar,
        targetExam,
        examDate,
        hideQuestionOfDay,
        visibleExams,
        dailyPlan,
        useBootstrapCI,
        updatedAt: new Date().toISOString(),
      });
    }
    userProfile.displayName = name;
    userProfile.targetExam = targetExam;
    userProfile.examDate = examDate;
    userProfile.hideQuestionOfDay = hideQuestionOfDay;
    userProfile.dailyPlan = dailyPlan;
    userProfile.useBootstrapCI = useBootstrapCI;
    // When the user just enabled bootstrap CI, kick off a fresh compute
    // so the cache is warm by the time they navigate to Stats/Home.
    if (useBootstrapCI && window.readinessEngine && typeof window.readinessEngine.bootstrapMargin === 'function') {
      try {
        const exam = userProfile.targetExam || (typeof S === 'object' && S && S.exam) || 'PL-300';
        window.readinessEngine.bootstrapMargin(exam, { force: true });
      } catch (_) {}
    }
    renderExamCountdown();
    try { renderDailyChallenge(); } catch {}
    // Refresh whichever home is open so the chip reflects the new plan.
    try {
      if ($('liftStrip') && document.querySelector('.app:not([id])').style.display !== 'none' && typeof renderHome === 'function') {
        renderHome();
      }
    } catch (_) {}
    try {
      if ($('homeV2App') && $('homeV2App').style.display !== 'none' && typeof renderHomeV2 === 'function') {
        renderHomeV2();
      }
    } catch (_) {}
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = 'Save profile'; btn.disabled = false; }, 2000);
  } catch(e) {
    $('profileError').textContent = 'Error: ' + e.message;
    btn.disabled = false;
  }
}

async function changeUserPassword() {
  const p1 = $('newPasswordInput').value;
  const p2 = $('confirmPasswordInput').value;
  $('passwordError').textContent = '';
  if (p1.length < 8) { $('passwordError').textContent = 'Minimum 8 characters'; return; }
  if (p1 !== p2) { $('passwordError').textContent = 'Passwords do not match'; return; }
  const btn = $('changePasswordBtn');
  btn.disabled = true;
  try {
    await window.cloudSync.changePassword(p1);
    btn.textContent = 'Changed ✓';
    $('newPasswordInput').value = '';
    $('confirmPasswordInput').value = '';
    setTimeout(() => { btn.textContent = 'Change password'; btn.disabled = false; }, 2000);
  } catch(e) {
    const msg = e.code === 'auth/requires-recent-login'
      ? 'Sign in again to change password' : e.message;
    $('passwordError').textContent = 'Error: ' + msg;
    btn.disabled = false;
  }
}

// ══ Admin Analytics Dashboard ══════════════════════════════════
const adminSlots = { bar:null, time:null, accuracy:null, readiness:null, pass:null };
const v2Slots = { bar:null, time:null, accuracy:null, readiness:null, pass:null };
function openAdminDashboard() { document.querySelector('.app:not([id])').style.display='none'; _hideAllAuxScreens('adminApp'); $('adminApp').style.display='flex'; loadAdminData(); if (typeof updateAppSidebarActive === 'function') updateAppSidebarActive(); }
function closeAdminDashboard() { $('adminApp').style.display='none'; document.querySelector('.app:not([id])').style.display='flex'; _restoreMainHeader(); }
var statsV2Exam = 'PL-300';
var statsV2Scope = 'me';
async function openStatsV2() {
  document.querySelector('.app:not([id])').style.display='none';
  _hideAllAuxScreens('statsV2App');
  var el = $('statsV2App'); if (el) el.style.display='flex';
  initStatsV2Sidebar();
  if (typeof updateAppSidebarActive === 'function') updateAppSidebarActive();
  // Seed local statsV2Exam from shared S.exam so the tab strip matches
  // whatever exam was last chosen on Weak/Topics.
  if (S.exam) statsV2Exam = S.exam;
  // Render placeholder, then populate with real data.
  initStatsV2Tabs();
  renderStatsV2();
  if (!adminUsers.length) {
    try { adminUsers = await window.cloudSync.getAllAnalytics(); } catch { adminUsers = []; }
  }
  renderStatsV2();
}
function closeStatsV2() { var el = $('statsV2App'); if (el) el.style.display='none'; document.querySelector('.app:not([id])').style.display='flex'; _restoreMainHeader(); }

// Bind delegated click handler on the Stats v2 left sidebar nav. Items route
// to existing aux screens via their open*/close* functions. Bound once per
// page lifetime (dataset.bound), so opening Stats v2 multiple times is safe.
function initStatsV2Sidebar() {
  var sidebar = $('statsV2Sidebar');
  if (!sidebar || sidebar.dataset.bound === '1') return;
  sidebar.addEventListener('click', function(ev) {
    var btn = ev.target.closest('.s2-sidebar-item');
    if (!btn) return;
    var key = btn.getAttribute('data-nav');
    if (!key) return;
    if (key === 'stats') return;  // already on this page
    closeStatsV2();
    if (key === 'home') {
      if (typeof window.goHome === 'function') window.goHome();
      return;
    }
    if (key === 'weak'   && typeof openWeakQDashboard   === 'function') { openWeakQDashboard();   return; }
    if (key === 'favorites' && typeof openFavoritesDashboard === 'function') { openFavoritesDashboard(); return; }
    if (key === 'topics' && typeof openTopicsDashboard  === 'function') { openTopicsDashboard();  return; }
  });
  sidebar.dataset.bound = '1';
}

// Sidebar router for Weak Questions screen — mirrors initStatsV2Sidebar.
function initWeakQSidebar() {
  var sidebar = $('weakQSidebar');
  if (!sidebar || sidebar.dataset.bound === '1') return;
  sidebar.addEventListener('click', function(ev) {
    var btn = ev.target.closest('.s2-sidebar-item');
    if (!btn) return;
    var key = btn.getAttribute('data-nav');
    if (!key) return;
    if (key === 'weak') return;  // already here
    var weakApp = $('weakQApp'); if (weakApp) weakApp.style.display = 'none';
    if (key === 'home') {
      if (typeof window.goHome === 'function') window.goHome();
      else document.querySelector('.app:not([id])').style.display = 'flex';
      return;
    }
    if (key === 'stats'  && typeof openStatsV2         === 'function') { openStatsV2();         return; }
    if (key === 'favorites' && typeof openFavoritesDashboard === 'function') { openFavoritesDashboard(); return; }
    if (key === 'topics' && typeof openTopicsDashboard === 'function') { openTopicsDashboard(); return; }
  });
  sidebar.dataset.bound = '1';
}

// Shared exam-tabs strip used by Stats v2 / Weak / Topics.
// Renders one tab per exam profile into `tabsEl`, marks `activeExam` as
// is-active, and wires a click handler that calls `onChange(exam)` whenever
// the user picks a different exam. Idempotent (uses dataset.bound).
function renderSharedExamTabs(tabsEl, activeExam, onChange) {
  if (!tabsEl) return;
  var profiles = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES) ? EXAM_PROFILES : {};
  var codes = getDisplayedExamCodes(Object.keys(profiles));
  if (!codes.length) return;
  if (codes.indexOf(activeExam) < 0) activeExam = codes[0];
  tabsEl.innerHTML = codes.map(function(c) {
    var on = c === activeExam ? ' is-active' : '';
    var sel = c === activeExam ? 'true' : 'false';
    return '<button class="s2-tab' + on + '" type="button" role="tab" aria-selected="' + sel + '" data-exam="' + escapeHtml(c) + '">' + escapeHtml(c) + '</button>';
  }).join('');
  if (tabsEl.dataset.bound !== '1') {
    tabsEl.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.s2-tab'); if (!btn) return;
      var exam = btn.dataset.exam; if (!exam) return;
      if (typeof onChange === 'function') onChange(exam);
    });
    tabsEl.dataset.bound = '1';
  }
}

// Apply a chosen exam globally and re-render whichever dashboard is open.
// Keeps S.exam, statsV2Exam, weakFilterState.exam and topicsExamSelect in sync.
function setSharedExam(exam) {
  if (!exam) return;
  S.exam = exam;
  if (typeof statsV2Exam !== 'undefined') statsV2Exam = exam;
  if (typeof weakFilterState === 'object' && weakFilterState) weakFilterState.exam = exam;
  var topicsSel = $('topicsExamSelect');
  if (topicsSel && topicsSel.value !== exam) {
    // Only assign when option exists; otherwise leave as-is.
    var has = Array.prototype.some.call(topicsSel.options, function(o) { return o.value === exam; });
    if (has) topicsSel.value = exam;
  }
  // Re-render the shared exam tabs so the active highlight tracks the new
  // selection on every dashboard. Without this the data updates but the
  // user sees the old tab highlighted and thinks the filter did nothing.
  if ($('weakGlobalExamTabs'))   renderSharedExamTabs($('weakGlobalExamTabs'),   exam, setSharedExam);
  if ($('topicsGlobalExamTabs')) renderSharedExamTabs($('topicsGlobalExamTabs'), exam, setSharedExam);
  // Re-render the visible dashboard body.
  if ($('statsV2App')  && $('statsV2App').style.display  !== 'none' && typeof renderStatsV2     === 'function') renderStatsV2();
  if ($('weakQApp')    && $('weakQApp').style.display    !== 'none' && typeof renderWeakQFilters === 'function') { renderWeakQFilters(); renderWeakQList(); }
  if ($('topicsApp')   && $('topicsApp').style.display   !== 'none' && typeof renderTopicsList   === 'function') renderTopicsList(exam);
}

// ── Tier badge + promo code modal (Step 1A.3.a) ───────────────
// Reads cloudSync.getCachedAccess() to render the badge in the header.
// Click on the badge opens the promo-code modal; on success the badge
// re-renders with the new tier.
const TIER_LABELS = {
  free: 'Free', bronze: 'Bronze', silver: 'Silver',
  gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond',
};
const TIER_CLASSES = ['tier-free','tier-bronze','tier-silver','tier-gold','tier-platinum','tier-diamond'];
const PROMO_ERROR_MESSAGES = {
  not_found:        'Промокод не найден',
  inactive:         'Промокод отключён',
  expired:          'Срок действия промокода истёк',
  exhausted:        'Лимит активаций исчерпан',
  already_redeemed: 'Вы уже активировали этот промокод',
  rate_limited:     'Слишком много попыток. Попробуйте позже',
  service_disabled: 'Активация временно недоступна',
  redeem_disabled:  'Активация временно недоступна',
  invalid_code:     'Неверный формат промокода',
  unauthenticated:  'Войдите в аккаунт',
  internal:         'Не удалось активировать. Попробуйте позже',
};

function formatExpiryShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return dd + ' ' + months[d.getMonth()];
}

function renderTierBadge(access) {
  const btn = document.getElementById('tierBadgeBtn');
  if (!btn) return;
  if (!access || !access.plan_id) { btn.classList.add('hidden'); return; }
  TIER_CLASSES.forEach(c => btn.classList.remove(c));
  btn.classList.add('tier-' + access.plan_id);
  btn.classList.remove('hidden');
  const label = TIER_LABELS[access.plan_id] || access.plan_id;
  const textEl = btn.querySelector('.tier-badge-text');
  if (textEl) {
    const exp = formatExpiryShort(access.expires_at);
    textEl.textContent = exp ? (label + ' · ' + exp) : label;
  }
  btn.title = access.expires_at
    ? (label + ' plan — expires ' + new Date(access.expires_at).toLocaleDateString())
    : (label + ' plan');
}

// Phase 2.2 — renders My Subscription panel inside profileApp.
// Pulls from access cache; falls back to a "Sign in to see" message.
const TIER_GRADIENTS = {
  free:     'rgba(100,116,139,0.18)',
  bronze:   'linear-gradient(135deg, rgba(205,127,50,0.18), rgba(139,69,19,0.10))',
  silver:   'linear-gradient(135deg, rgba(192,192,192,0.20), rgba(64,64,64,0.10))',
  gold:     'linear-gradient(135deg, rgba(255,215,0,0.22), rgba(184,134,11,0.10))',
  platinum: 'linear-gradient(135deg, rgba(121,215,224,0.20), rgba(74,154,170,0.10))',
  diamond:  'linear-gradient(135deg, rgba(167,139,250,0.22), rgba(111,72,239,0.12))',
};
function renderProfileSubscription() {
  const body = document.getElementById('profileSubscriptionBody');
  if (!body) return;
  const cs = window.cloudSync;
  const a = (cs && cs.getCachedAccess && cs.getCachedAccess()) || null;
  if (!a || !a.plan_id) {
    body.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">Connecting — please refresh.</div>';
    return;
  }
  const label = TIER_LABELS[a.plan_id] || a.plan_id;
  const bg = TIER_GRADIENTS[a.plan_id] || TIER_GRADIENTS.free;
  const expStr = a.expires_at
    ? 'until ' + new Date(a.expires_at).toLocaleDateString('en-US', { day: '2-digit', month: 'long', year: 'numeric' })
    : 'no expiration';
  const sourceMap = {
    promo: 'activated via promo code',
    admin: 'granted by admin',
    payment: 'paid',
    trial: 'trial period',
    email_override: 'service (email override)',
    default: 'default plan (no grant)',
    kill_switch: 'kill switch (global access)',
  };
  const sourceTxt = sourceMap[a.source] || a.source;
  const featOk = Object.keys(a.features || {}).filter(k => a.features[k]);
  const featLocked = Object.keys(a.features || {}).filter(k => !a.features[k]);
  const FEATURE_LABELS = {
    practice: 'Practice mode',
    leitner: 'Leitner spaced repetition',
    review_mistakes: 'Review mistakes',
    mock_exam: 'Mock exam',
    weak_topics: 'Weak topics',
    scheduled_review: 'Scheduled review',
    history_charts: 'History charts',
    ai_insights: 'AI Insights',
    personal_study_plan: 'Personal study plan',
    case_study: 'Case study',
  };
  body.innerHTML = ''
    + '<div style="padding:14px;border-radius:14px;background:' + bg + ';border:1px solid var(--border-light)">'
    + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><span class="tier-badge tier-' + a.plan_id + '" style="cursor:default"><span class="tier-badge-icon" aria-hidden="true">✦</span><span class="tier-badge-text">' + label + '</span></span></div>'
    + '<div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:4px">' + sourceTxt + '</div>'
    + '<div style="font-size:0.85rem;color:var(--text-secondary)">' + (a.expires_at ? 'Expires: ' + expStr : '✓ ' + expStr) + '</div>'
    + (a.daily_quota != null ? '<div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">Daily limit: ' + a.daily_quota + ' questions</div>' : '<div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">Daily limit: ∞</div>')
    + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:0.78rem">'
    +   '<div><div style="color:var(--success);margin-bottom:4px;font-weight:600">✓ Included</div>'
    +     featOk.map(k => '<div style="color:var(--text-secondary)">' + (FEATURE_LABELS[k] || k) + '</div>').join('')
    +   '</div>'
    +   '<div><div style="color:var(--text-muted);margin-bottom:4px;font-weight:600">🔒 Locked</div>'
    +     (featLocked.length ? featLocked.map(k => '<div style="color:var(--text-muted);opacity:0.7">' + (FEATURE_LABELS[k] || k) + '</div>').join('') : '<div style="color:var(--text-muted);opacity:0.5">—</div>')
    +   '</div>'
    + '</div>';
}

function openPromoModal() {
  const m = document.getElementById('promoCodeModal');
  if (!m) return;
  m.classList.remove('hidden');
  document.body.classList.add('promo-modal-open');
  // ── Phase 4.1 event ──
  try { window.cloudSync?.logEvent?.('promo_modal_opened', {}); } catch (_) {}
  const input = document.getElementById('promoCodeInput');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
  const err = document.getElementById('promoCodeError'); if (err) err.textContent = '';
  const ok  = document.getElementById('promoCodeSuccess'); if (ok)  ok.textContent = '';
  const cur = document.getElementById('promoCurrentPlan');
  if (cur) {
    const a = (window.cloudSync && window.cloudSync.getCachedAccess) ? window.cloudSync.getCachedAccess() : null;
    if (a && a.plan_id) {
      const label = TIER_LABELS[a.plan_id] || a.plan_id;
      cur.textContent = a.expires_at
        ? ('Current plan: ' + label + ' (until ' + new Date(a.expires_at).toLocaleDateString() + ')')
        : ('Current plan: ' + label);
    } else {
      cur.textContent = '';
    }
  }
}

function closePromoModal() {
  const m = document.getElementById('promoCodeModal');
  if (m) m.classList.add('hidden');
  document.body.classList.remove('promo-modal-open');
}

async function handlePromoSubmit(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const input = document.getElementById('promoCodeInput');
  const submit = document.getElementById('promoCodeSubmit');
  const errEl = document.getElementById('promoCodeError');
  const okEl = document.getElementById('promoCodeSuccess');
  if (!input || !submit) return;
  errEl.textContent = ''; okEl.textContent = '';
  const code = (input.value || '').trim();
  if (!code) { errEl.textContent = PROMO_ERROR_MESSAGES.invalid_code; return; }
  submit.disabled = true;
  try {
    const res = await window.cloudSync.redeemPromoCode(code);
    if (res && res.ok) {
      const planLabel = TIER_LABELS[res.plan_id] || res.plan_id;
      const expStr = res.expires_at ? new Date(res.expires_at).toLocaleDateString() : '';
      okEl.textContent = 'Activated — ' + planLabel + (expStr ? (' until ' + expStr) : '');
      // ── Phase 4.1 event: success ──
      try {
        window.cloudSync?.logEvent?.('promo_redeem_attempt', {
          ok: true,
          plan_id: res.plan_id || null,
          code_len: code.length,
        });
      } catch (_) {}
      try {
        const fresh = await window.cloudSync.loadAccess(true);
        renderTierBadge(fresh);
        if (typeof updateLockedModeCards === 'function') updateLockedModeCards();
        if (typeof updateLockedSidebarItems === 'function') updateLockedSidebarItems();
      } catch (e) { /* badge will refresh on next load */ }
      setTimeout(closePromoModal, 1600);
    }
  } catch (e) {
    const domain = (e && e.details && e.details.code) || 'internal';
    errEl.textContent = PROMO_ERROR_MESSAGES[domain] || PROMO_ERROR_MESSAGES.internal;
    // ── Phase 4.1 event: failure ──
    try {
      window.cloudSync?.logEvent?.('promo_redeem_attempt', {
        ok: false,
        reason: domain,
        code_len: code.length,
      });
    } catch (_) {}
  } finally {
    submit.disabled = false;
  }
}

// ── Plans modal (Step 1A.3.b) ────────────────────────────────
// Listed via cloudSync.listPlans() — public, returns only display fields.
async function openPlansModal() {
  const m = document.getElementById('plansModal');
  if (!m) return;
  closePromoModal();
  m.classList.remove('hidden');
  document.body.classList.add('promo-modal-open');
  // ── Phase 4.1 event ──
  try { window.cloudSync?.logEvent?.('plans_modal_opened', {}); } catch (_) {}
  const grid = document.getElementById('plansGrid');
  const note = document.getElementById('plansCurrentNote');
  const cur  = (window.cloudSync && window.cloudSync.getCachedAccess) ? window.cloudSync.getCachedAccess() : null;
  if (note) {
    if (cur && cur.plan_id) {
      const label = TIER_LABELS[cur.plan_id] || cur.plan_id;
      note.textContent = cur.expires_at
        ? ('Your current plan: ' + label + ' (until ' + new Date(cur.expires_at).toLocaleDateString() + ')')
        : ('Your current plan: ' + label);
    } else { note.textContent = ''; }
  }
  if (grid) grid.innerHTML = '<p class="plans-loading">Loading…</p>';
  try {
    const plans = await window.cloudSync.listPlans();
    if (!grid) return;
    if (!plans || !plans.length) { grid.innerHTML = '<p class="plans-loading">No plans available.</p>'; return; }
    const curId = cur && cur.plan_id;
    grid.innerHTML = renderPlansGrouped(plans, curId);
    // Wire accordion toggle
    grid.querySelectorAll('.plan-group-header').forEach(h => {
      h.addEventListener('click', () => {
        const group = h.closest('.plan-group');
        if (group) group.classList.toggle('is-open');
      });
    });
  } catch (e) {
    console.warn('listPlans failed', e);
    if (grid) grid.innerHTML = '<p class="plans-loading">Couldn\'t load plans. Try again later.</p>';
  }
}

// Extract base tier from a plan_id. Mirrors the backend getTier() helper —
// `bronze_dp900` -> `'bronze'`. Single-tier ids (`free`, `gold`) return unchanged.
function _getPlanTier(planId) {
  if (!planId || typeof planId !== 'string') return 'free';
  const idx = planId.indexOf('_');
  return idx > 0 ? planId.slice(0, idx) : planId;
}

// Pretty short labels for per-exam plan variants.
const _EXAM_SHORT_LABEL = {
  'PL-300': 'PL-300',
  'DP-900': 'DP-900',
  'AI-900': 'AI-900',
  'MO-200': 'MO-200',
  'IT-Specialist-Python': 'Python',
};

// Renders the plans grid: free / gold / platinum as single cards, bronze /
// silver as expandable accordions when there are multiple per-exam variants.
function renderPlansGrouped(plans, currentId) {
  // Group plans by base tier, preserving sort_order within each group.
  const groups = {};
  plans.forEach(p => {
    const tier = _getPlanTier(p.plan_id);
    if (!groups[tier]) groups[tier] = [];
    groups[tier].push(p);
  });
  Object.values(groups).forEach(arr => arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)));
  // Render in canonical tier order. Diamond hidden (internal).
  const order = ['free', 'bronze', 'silver', 'gold', 'platinum'];
  return order
    .filter(tier => groups[tier] && groups[tier].length)
    .map(tier => {
      const variants = groups[tier];
      // Single variant (free / gold / platinum / orphan bronze) — flat card.
      if (variants.length === 1) return renderPlanCard(variants[0], currentId);
      // Multiple variants (bronze ×5 / silver ×5) — accordion group.
      return renderPlanGroup(tier, variants, currentId);
    })
    .join('');
}

function renderPlanCard(plan, currentId) {
  const d = plan.display || {};
  const isCurrent = plan.plan_id === currentId;
  const tier = _getPlanTier(plan.plan_id);
  const badge = d.badge ? '<span class="plan-card-badge">' + escapeHtml(d.badge) + '</span>' : '';
  const currentTag = isCurrent ? '<span class="plan-card-current-tag">Current</span>' : '';
  const bullets = Array.isArray(d.feature_bullets)
    ? d.feature_bullets.map(b => '<li>' + escapeHtml(b) + '</li>').join('')
    : '';
  return ''
    + '<div class="plan-card tier-' + escapeHtml(tier) + (isCurrent ? ' is-current' : '') + '">'
    + badge + currentTag
    + '<div class="plan-card-title">' + escapeHtml(d.title || plan.plan_id) + '</div>'
    + '<div class="plan-card-subtitle">' + escapeHtml(d.subtitle || '') + '</div>'
    + '<div class="plan-card-price">' + escapeHtml(d.price_label || '') + '</div>'
    + (bullets ? '<ul class="plan-card-bullets">' + bullets + '</ul>' : '')
    + '</div>';
}

// Renders an accordion-style group for tiers with multiple per-exam variants.
// Header shows tier name + price (from first variant). Body lists mini-cards
// per exam with a "current" highlight + activate button per variant.
function renderPlanGroup(tier, variants, currentId) {
  const first = variants[0] || {};
  const d = first.display || {};
  const hasCurrent = variants.some(v => v.plan_id === currentId);
  // Title: strip exam suffix from the first variant's title to get tier title.
  // e.g. "Bronze · DP-900" -> "Bronze". Falls back to capitalized tier name.
  const tierTitle = (d.title || '').split('·')[0].trim() || (tier.charAt(0).toUpperCase() + tier.slice(1));
  const price = d.price_label || '';
  const subtitle = d.subtitle || '';
  // Features bullets — strip the exam line (we already group by exam below).
  const bullets = Array.isArray(d.feature_bullets)
    ? d.feature_bullets.filter(b => !/exam/i.test(b)).slice(0, 4)
        .map(b => '<li>' + escapeHtml(b) + '</li>').join('')
    : '';
  const miniCards = variants.map(v => {
    const code = (v.allowed_exam_codes && v.allowed_exam_codes[0]) || '?';
    const label = _EXAM_SHORT_LABEL[code] || code;
    const isCurr = v.plan_id === currentId;
    return ''
      + '<div class="plan-variant-mini' + (isCurr ? ' is-current' : '') + '" data-plan-id="' + escapeHtml(v.plan_id) + '">'
      + '<div class="plan-variant-mini-exam">' + escapeHtml(label) + '</div>'
      + (isCurr ? '<div class="plan-variant-mini-current">Active</div>' : '')
      + '</div>';
  }).join('');
  return ''
    + '<div class="plan-group tier-' + escapeHtml(tier) + (hasCurrent ? ' is-current' : '') + (hasCurrent ? ' is-open' : '') + '">'
    + '<button type="button" class="plan-group-header">'
    +   '<div class="plan-group-header-left">'
    +     '<div class="plan-card-title">' + escapeHtml(tierTitle) + '</div>'
    +     '<div class="plan-card-subtitle">' + escapeHtml(subtitle) + '</div>'
    +   '</div>'
    +   '<div class="plan-group-header-right">'
    +     '<div class="plan-card-price">' + escapeHtml(price) + '</div>'
    +     '<div class="plan-group-chevron" aria-hidden="true">▾</div>'
    +   '</div>'
    + '</button>'
    + '<div class="plan-group-body">'
    +   '<div class="plan-group-bullets-row">'
    +     (bullets ? '<ul class="plan-card-bullets">' + bullets + '</ul>' : '')
    +   '</div>'
    +   '<div class="plan-group-variants-label">Pick your exam:</div>'
    +   '<div class="plan-variants-grid">' + miniCards + '</div>'
    + '</div>'
    + '</div>';
}

function closePlansModal() {
  const m = document.getElementById('plansModal');
  if (m) m.classList.add('hidden');
  if (!document.getElementById('promoCodeModal') || document.getElementById('promoCodeModal').classList.contains('hidden')) {
    document.body.classList.remove('promo-modal-open');
  }
}

// Toggles `.is-locked` on mode-cards whose required feature isn't accessible.
// Called after access loads + after redeem.
function updateLockedModeCards() {
  const cs = window.cloudSync;
  document.querySelectorAll('.mode-card[data-mode]').forEach(card => {
    const mode = card.dataset.mode;
    if (mode !== 'mock_exam') return;   // only mock is gated in 1A
    const locked = !(cs && typeof cs.canAccess === 'function' && cs.canAccess('mock_exam'));
    card.classList.toggle('is-locked', locked);
  });
}

// Step 2.1 — gates sidebar items that have data-feature. Only adds the
// .is-locked class; click interception is on the sidebar's existing
// delegated handler (we patch each handler to short-circuit when locked).
function updateLockedSidebarItems() {
  const cs = window.cloudSync;
  const access = (cs && cs.getCachedAccess && cs.getCachedAccess()) || null;
  const mode = access && access.effective_mode || 'off';
  // 'off' = kill switch → no locks. 'warn' = soft hint (still clickable
  // and functional). 'enforce' = full lock + redirect to plans.
  document.querySelectorAll('.s2-sidebar-item[data-feature]').forEach(el => {
    const feat = el.dataset.feature;
    const has = cs && typeof cs.canAccess === 'function' && cs.canAccess(feat);
    if (mode === 'off' || has) {
      el.classList.remove('is-locked', 'is-soft-locked');
      el.title = '';
      return;
    }
    el.classList.toggle('is-soft-locked', mode === 'warn');
    el.classList.toggle('is-locked', mode === 'enforce');
    el.title = mode === 'enforce'
      ? 'Requires upgrade. Click to view plans.'
      : 'Будет ограничено в платной версии.';
  });
}

// Click guard for locked sidebar items — opens plans modal in enforce.
function maybeBlockLockedSidebarClick(ev) {
  const btn = ev.target.closest('.s2-sidebar-item.is-locked');
  if (!btn) return false;
  ev.preventDefault();
  ev.stopPropagation();
  // ── Phase 4.1 event ──
  try {
    const cs = window.cloudSync;
    const access = (cs && cs.getCachedAccess && cs.getCachedAccess()) || null;
    cs?.logEvent?.('locked_clicked', {
      feature: btn.dataset.feature || null,
      current_plan: access && (access.plan_id || access.tier) || null,
      surface: 'sidebar',
    });
  } catch (_) {}
  if (typeof openPlansModal === 'function') openPlansModal();
  return true;
}

// ── App version mismatch toast (Step 1A.3.b) ─────────────────
// Local APP_VERSION is the version of the static bundle the user has.
// If access.app_version_min > APP_VERSION → show soft toast.
const APP_VERSION = '1.21.0';
window.APP_VERSION = APP_VERSION;

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
function maybeShowVersionToast(access) {
  if (!access || !access.app_version_min) return;
  if (cmpSemver(access.app_version_min, APP_VERSION) <= 0) return;
  const t = document.getElementById('versionToast');
  if (!t || t.dataset.dismissed === '1') return;
  t.classList.remove('hidden');
  // ── Phase 4.1 event: surfaced (fires only once per page load, since the
  // toast won't re-show until reload). ──
  if (!t.dataset.eventLogged) {
    t.dataset.eventLogged = '1';
    try {
      window.cloudSync?.logEvent?.('app_version_warning_shown', {
        installed: APP_VERSION,
        min_required: access.app_version_min,
      });
    } catch (_) {}
  }
}

document.addEventListener('DOMContentLoaded', function () {
  // Promo modal wiring
  const badge = document.getElementById('tierBadgeBtn');
  if (badge) badge.addEventListener('click', openPromoModal);
  const closeBtn = document.getElementById('promoCodeCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closePromoModal);
  const form = document.getElementById('promoCodeForm');
  if (form) form.addEventListener('submit', handlePromoSubmit);
  const promoBackdrop = document.getElementById('promoCodeModal');
  if (promoBackdrop) promoBackdrop.addEventListener('click', function (e) {
    if (e.target === promoBackdrop) closePromoModal();
  });
  const toPlansBtn = document.getElementById('promoToPlansBtn');
  if (toPlansBtn) toPlansBtn.addEventListener('click', openPlansModal);

  // Plans modal wiring
  const plansClose = document.getElementById('plansCloseBtn');
  if (plansClose) plansClose.addEventListener('click', closePlansModal);
  const plansBackdrop = document.getElementById('plansModal');
  if (plansBackdrop) plansBackdrop.addEventListener('click', function (e) {
    if (e.target === plansBackdrop) closePlansModal();
  });
  const plansToPromoBtn = document.getElementById('plansToPromoBtn');
  if (plansToPromoBtn) plansToPromoBtn.addEventListener('click', function () {
    closePlansModal(); openPromoModal();
  });

  // Esc closes whichever modal is open
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    const plans = document.getElementById('plansModal');
    if (plans && !plans.classList.contains('hidden')) { closePlansModal(); return; }
    const promo = document.getElementById('promoCodeModal');
    if (promo && !promo.classList.contains('hidden')) closePromoModal();
  });

  // Version toast wiring
  const vReload = document.getElementById('versionToastReloadBtn');
  if (vReload) vReload.addEventListener('click', function () { location.reload(); });
  const vClose = document.getElementById('versionToastCloseBtn');
  if (vClose) vClose.addEventListener('click', function () {
    const t = document.getElementById('versionToast');
    if (t) { t.classList.add('hidden'); t.dataset.dismissed = '1'; }
  });

  // Step 2.1 — block clicks on locked sidebar items in capture phase
  // so the sidebar's delegated bubbling handlers don't open the screen.
  document.addEventListener('click', function (ev) {
    if (typeof maybeBlockLockedSidebarClick === 'function') {
      maybeBlockLockedSidebarClick(ev);
    }
  }, true);

  // Phase 2.2 — profile subscription buttons.
  const subPlansBtn = document.getElementById('profileSubscriptionPlansBtn');
  if (subPlansBtn) subPlansBtn.addEventListener('click', function () {
    if (typeof openPlansModal === 'function') openPlansModal();
  });
  const subPromoBtn = document.getElementById('profileSubscriptionPromoBtn');
  if (subPromoBtn) subPromoBtn.addEventListener('click', function () {
    if (typeof openPromoModal === 'function') openPromoModal();
  });
});

// ── Persistent body-root sidebar ─────────────────────────────
// Mounted once on the body; visible whenever the user is signed in.
// Routes nav clicks to the right open*() function and keeps its active
// item in sync with whichever screen is currently shown.
function setAppSidebarVisible(on) {
  document.body.classList.toggle('has-app-sidebar', !!on);
  var el = document.getElementById('appSidebar');
  if (el) el.classList.toggle('hidden', !on);
  if (on) {
    bindAppSidebar();
    updateAppSidebarActive();
    applyStoredSidebarState();
  }
}

// ── Collapsible sidebar state ────────────────────────────────
// Persistent user preference lives in SIDEBAR_COLLAPSED_KEY. A transient
// snapshot of the pre-exam state lives in SIDEBAR_BEFORE_EXAM_KEY: it is
// written when the user enters quiz mode, restored on exit, and cleared
// whenever the user takes a manual action (so manual overrides during the
// exam are respected after it ends).
var SIDEBAR_COLLAPSED_KEY = 'mscp_sidebar_collapsed';
var SIDEBAR_BEFORE_EXAM_KEY = 'mscp_sidebar_before_exam';
var IS_MOBILE_QUERY = '(max-width: 768px)';
var lastSidebarScreenName = null;

function isMobileViewport() {
  return window.matchMedia(IS_MOBILE_QUERY).matches;
}

function isSidebarCollapsedStored() {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
}

function setSidebarCollapsed(collapsed, opts) {
  opts = opts || {};
  var body = document.body;
  if (isMobileViewport()) {
    // On mobile, "collapsed" = drawer closed; "expanded" = drawer open.
    body.classList.toggle('sidebar-open', !collapsed);
  } else {
    body.classList.toggle('sidebar-collapsed', !!collapsed);
  }
  if (opts.persist !== false) {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(!!collapsed));
      // User took explicit action — invalidate any pending exam snapshot
      // so the previous state isn't restored over their new choice.
      localStorage.removeItem(SIDEBAR_BEFORE_EXAM_KEY);
    } catch (_) {}
  }
  var collapseBtn = document.getElementById('sidebarCollapseBtn');
  var expandBtn = document.getElementById('sidebarExpandBtn');
  if (collapseBtn) collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  if (expandBtn) expandBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function applyStoredSidebarState() {
  // Mobile drawer convention: always start closed; ignore the desktop preference.
  if (isMobileViewport()) {
    document.body.classList.remove('sidebar-open');
    return;
  }
  setSidebarCollapsed(isSidebarCollapsedStored(), { persist: false });
}

function enterExamMode() {
  if (isMobileViewport()) {
    document.body.classList.remove('sidebar-open');
    return;
  }
  try {
    var wasCollapsed = document.body.classList.contains('sidebar-collapsed');
    localStorage.setItem(SIDEBAR_BEFORE_EXAM_KEY, String(wasCollapsed));
  } catch (_) {}
  setSidebarCollapsed(true, { persist: false });
}

function exitExamMode() {
  if (isMobileViewport()) return;
  var before;
  try { before = localStorage.getItem(SIDEBAR_BEFORE_EXAM_KEY); } catch (_) { before = null; }
  if (before === null) return; // user took manual control during exam
  setSidebarCollapsed(before === 'true', { persist: false });
  try { localStorage.removeItem(SIDEBAR_BEFORE_EXAM_KEY); } catch (_) {}
}

// Called from showScreen() — fires enter/exit only on real screen
// transitions, not on every re-render. Without this guard a re-entry
// into the quiz screen (e.g. session restart) would overwrite the
// BEFORE_EXAM snapshot with the now-collapsed state.
function handleSidebarForScreenChange(name) {
  var wasQuiz = lastSidebarScreenName === 'quiz';
  var isQuiz = name === 'quiz';
  if (!wasQuiz && isQuiz) enterExamMode();
  if (wasQuiz && !isQuiz) exitExamMode();
  lastSidebarScreenName = name;
}

function bindAppSidebar() {
  var sidebar = document.getElementById('appSidebar');
  if (sidebar && sidebar.dataset.bound !== '1') {
    sidebar.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.s2-sidebar-item');
      if (!btn) return;
      var key = btn.getAttribute('data-nav');
      if (!key) return;
      // Close whichever aux screen is currently open before navigating.
      var weak   = $('weakQApp');     if (weak   && weak.style.display   !== 'none') weak.style.display   = 'none';
      var topics = $('topicsApp');    if (topics && topics.style.display !== 'none') topics.style.display = 'none';
      var stats  = $('statsV2App');   if (stats  && stats.style.display  !== 'none') stats.style.display  = 'none';
      var admin  = $('adminApp');     if (admin  && admin.style.display  !== 'none') admin.style.display  = 'none';
      var refs   = $('referencesApp');if (refs   && refs.style.display   !== 'none') refs.style.display   = 'none';
      var prof   = $('profileApp');   if (prof   && prof.style.display   !== 'none') prof.style.display   = 'none';
      var hk     = $('hotkeysApp');   if (hk     && hk.style.display     !== 'none') hk.style.display     = 'none';
      var fav    = $('favoritesApp'); if (fav    && fav.style.display    !== 'none') fav.style.display    = 'none';
      if (key === 'home') {
        if (typeof window.goHome === 'function') { window.goHome(); updateAppSidebarActive(); return; }
        document.querySelector('.app:not([id])').style.display = 'flex';
        updateAppSidebarActive();
        return;
      }
      if (key === 'logout' && window.cloudSync) { window.cloudSync.logout(); return; }
      if (key === 'stats'      && typeof openStatsV2         === 'function') { openStatsV2();         return; }
      if (key === 'weak'       && typeof openWeakQDashboard  === 'function') { openWeakQDashboard();  return; }
      if (key === 'favorites'  && typeof openFavoritesDashboard === 'function') { openFavoritesDashboard(); updateAppSidebarActive(); return; }
      if (key === 'topics'     && typeof openTopicsDashboard === 'function') { openTopicsDashboard(); return; }
      if (key === 'statsV1'    && typeof openAdminDashboard  === 'function') { openAdminDashboard();  updateAppSidebarActive(); return; }
      if (key === 'references' && typeof openReferences      === 'function') { openReferences();      updateAppSidebarActive(); return; }
      if (key === 'hotkeys'    && typeof openHotkeys         === 'function') { openHotkeys();         updateAppSidebarActive(); return; }
      if (key === 'profile'    && typeof openProfileScreen   === 'function') { openProfileScreen();   updateAppSidebarActive(); return; }
    });
    sidebar.dataset.bound = '1';
  }

  // Wire collapse / expand controls (idempotent via data-bound).
  var collapseBtn = document.getElementById('sidebarCollapseBtn');
  if (collapseBtn && collapseBtn.dataset.bound !== '1') {
    collapseBtn.addEventListener('click', function() { setSidebarCollapsed(true); });
    collapseBtn.dataset.bound = '1';
  }
  var expandBtn = document.getElementById('sidebarExpandBtn');
  if (expandBtn && expandBtn.dataset.bound !== '1') {
    expandBtn.addEventListener('click', function() { setSidebarCollapsed(false); });
    expandBtn.dataset.bound = '1';
  }

  // Mobile drawer: backdrop tap closes drawer.
  if (!document.body.dataset.sidebarBackdropBound) {
    document.addEventListener('click', function(e) {
      if (!isMobileViewport()) return;
      if (!document.body.classList.contains('sidebar-open')) return;
      var sb = document.getElementById('appSidebar');
      var eb = document.getElementById('sidebarExpandBtn');
      if (sb && sb.contains(e.target)) return;
      if (eb && eb.contains(e.target)) return;
      document.body.classList.remove('sidebar-open');
    });
    document.body.dataset.sidebarBackdropBound = '1';
  }

  // Resize: switch between desktop/mobile cleanly so a stale class
  // from the previous mode doesn't bleed into the new layout.
  if (!document.body.dataset.sidebarResizeBound) {
    window.addEventListener('resize', function() {
      if (isMobileViewport()) {
        document.body.classList.remove('sidebar-collapsed');
      } else {
        document.body.classList.remove('sidebar-open');
        applyStoredSidebarState();
      }
    });
    document.body.dataset.sidebarResizeBound = '1';
  }
}

function updateAppSidebarActive() {
  var sidebar = document.getElementById('appSidebar');
  if (!sidebar) return;
  var current = 'home';
  if ($('statsV2App')    && $('statsV2App').style.display    !== 'none') current = 'stats';
  else if ($('weakQApp')      && $('weakQApp').style.display      !== 'none') current = 'weak';
  else if ($('topicsApp')     && $('topicsApp').style.display     !== 'none') current = 'topics';
  else if ($('adminApp')      && $('adminApp').style.display      !== 'none') current = 'statsV1';
  else if ($('referencesApp') && $('referencesApp').style.display !== 'none') current = 'references';
  else if ($('hotkeysApp')    && $('hotkeysApp').style.display    !== 'none') current = 'hotkeys';
  else if ($('profileApp')    && $('profileApp').style.display    !== 'none') current = 'profile';
  sidebar.querySelectorAll('.s2-sidebar-item').forEach(function(btn) {
    var on = btn.getAttribute('data-nav') === current;
    btn.classList.toggle('is-active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

function openHotkeys() {
  _hideAllAuxScreens('hotkeysApp');
  var el = $('hotkeysApp'); if (el) el.style.display = 'flex';
  document.querySelector('.app:not([id])').style.display = 'none';
  if (typeof updateAppSidebarActive === 'function') updateAppSidebarActive();
}
function closeHotkeys() {
  var el = $('hotkeysApp'); if (el) el.style.display = 'none';
  document.querySelector('.app:not([id])').style.display = 'flex';
  if (typeof updateAppSidebarActive === 'function') updateAppSidebarActive();
}

// Sidebar router for Topics dashboard — mirrors the other two.
function initTopicsSidebar() {
  var sidebar = $('topicsSidebar');
  if (!sidebar || sidebar.dataset.bound === '1') return;
  sidebar.addEventListener('click', function(ev) {
    var btn = ev.target.closest('.s2-sidebar-item');
    if (!btn) return;
    var key = btn.getAttribute('data-nav');
    if (!key) return;
    if (key === 'topics') return;  // already here
    var topicsApp = $('topicsApp'); if (topicsApp) topicsApp.style.display = 'none';
    if (key === 'home') {
      if (typeof window.goHome === 'function') window.goHome();
      else document.querySelector('.app:not([id])').style.display = 'flex';
      return;
    }
    if (key === 'stats' && typeof openStatsV2        === 'function') { openStatsV2();        return; }
    if (key === 'weak'  && typeof openWeakQDashboard === 'function') { openWeakQDashboard(); return; }
    if (key === 'favorites' && typeof openFavoritesDashboard === 'function') { openFavoritesDashboard(); return; }
  });
  sidebar.dataset.bound = '1';
}

// ── Home v2 — desktop-first dashboard preview ─────────────────────
var H2_MODES = [
  { mode: 'practice',   icon: '📝', name: 'Практика',     desc: 'Все разделы или один по выбору. 5–50 вопросов.', meta: '10 вопр.' },
  { mode: 'weak',       icon: '⚠️', name: 'Слабые темы',  desc: 'Повторение по разделам и истории ваших ошибок.', meta: 'auto' },
  { mode: 'case_study', icon: '📂', name: 'Кейс-стади',  desc: 'Разбор реальных сценариев и сложных вопросов.', meta: '' },
  { mode: 'smart',      icon: '🎯', name: 'Умный обзор',  desc: 'Интервальное повторение на основе вашего прогресса.', meta: 'SMART' },
  { mode: 'blitz',      icon: '⚡', name: 'Блиц',         desc: 'Быстрая серия — без таймеров и кейсов.', meta: '' },
  { mode: 'flashcards', icon: '🃏', name: 'Карточки',     desc: 'Активный MCQ-пул по секциям, без режима теста.', meta: '' },
];

function openHomeV2() {
  document.querySelector('.app:not([id])').style.display = 'none';
  _hideAllAuxScreens('homeV2App');
  var el = $('homeV2App'); if (el) el.style.display = 'flex';
  initHomeV2Controls();
  renderHomeV2();
}
function closeHomeV2() { var el = $('homeV2App'); if (el) el.style.display = 'none'; document.querySelector('.app:not([id])').style.display = 'flex'; _restoreMainHeader(); }

function initHomeV2Controls() {
  var tabs = document.querySelectorAll('#homeV2App .h2-side-tab');
  tabs.forEach(function(btn) {
    if (btn.dataset.bound === '1') return;
    btn.addEventListener('click', function() {
      var t = btn.dataset.h2tab;
      tabs.forEach(function(b) { b.classList.toggle('is-active', b === btn); });
      if (t === 'stats') { closeHomeV2(); openAdminDashboard(); }
      else if (t === 'courses') { closeHomeV2(); goHome(); }
      // 'dashboard' keeps current view.
    });
    btn.dataset.bound = '1';
  });
  var newExamBtn = $('h2NewExamBtn');
  if (newExamBtn && newExamBtn.dataset.bound !== '1') {
    newExamBtn.addEventListener('click', function() { closeHomeV2(); goHome(); });
    newExamBtn.dataset.bound = '1';
  }
  var helpBtn = $('h2HelpBtn');
  if (helpBtn && helpBtn.dataset.bound !== '1') {
    helpBtn.addEventListener('click', function() { closeHomeV2(); var refBtn = $('referencesBtn'); if (refBtn) refBtn.click(); });
    helpBtn.dataset.bound = '1';
  }
  var logoutBtn = $('h2LogoutBtn');
  if (logoutBtn && logoutBtn.dataset.bound !== '1') {
    logoutBtn.addEventListener('click', function() { var lb = $('logoutBtn'); if (lb) lb.click(); });
    logoutBtn.dataset.bound = '1';
  }
  var planBtn = $('h2PlanBtn');
  if (planBtn && planBtn.dataset.bound !== '1') {
    planBtn.addEventListener('click', function() { closeHomeV2(); openAdminDashboard(); });
    planBtn.dataset.bound = '1';
  }
  var resumeBtn = $('h2ResumeBtn');
  if (resumeBtn && resumeBtn.dataset.bound !== '1') {
    resumeBtn.addEventListener('click', function() { closeHomeV2(); retrySession(); });
    resumeBtn.dataset.bound = '1';
  }
  var revOpenBtn = $('h2ReviewOpenBtn');
  if (revOpenBtn && revOpenBtn.dataset.bound !== '1') {
    revOpenBtn.addEventListener('click', function() { S.mode = 'leitner'; closeHomeV2(); goHome(); });
    revOpenBtn.dataset.bound = '1';
  }
  var revPracBtn = $('h2ReviewPracticeBtn');
  if (revPracBtn && revPracBtn.dataset.bound !== '1') {
    revPracBtn.addEventListener('click', function() { S.mode = 'leitner'; closeHomeV2(); startQuiz(); });
    revPracBtn.dataset.bound = '1';
  }
}

function renderHomeV2() {
  var profiles = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES) ? EXAM_PROFILES : {};
  var codes = getDisplayedExamCodes(Object.keys(profiles));
  if (codes.length && codes.indexOf(S.exam) < 0) S.exam = codes[0];
  var exam = S.exam || codes[0] || 'PL-300';
  var store = loadStore();
  var today = new Date().toISOString().slice(0, 10);

  // Sidebar — Stitch-styled nav links + exam list
  var prof = profiles[exam] || {};
  setText('h2SideExamSub', prof.name ? (exam + ' · ' + prof.name) : exam);
  var sideNav = $('h2SideNav');
  if (sideNav) {
    var navItems = [
      { key: 'dashboard', label: 'Dashboard', active: true, iconPath: '<path d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      { key: 'courses',   label: 'Courses', iconPath: '<path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      { key: 'stats',     label: 'Stats', iconPath: '<path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      { key: 'topics',    label: 'Statistics by topic', iconPath: '<path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      { key: 'weak',      label: 'My weak questions', iconPath: '<path d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      { key: 'insights',  label: 'Study Insights', iconPath: '<path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      { key: 'favorites', label: 'Favorites', iconPath: '<path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      { key: 'profile',   label: 'Profile', iconPath: '<path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
    ];
    var topLinks = navItems.map(function(n) {
      var cls = n.active
        ? 'flex items-center space-x-3 px-3 py-2.5 rounded-lg bg-white/5 text-stitch-purple font-medium text-sm'
        : 'flex items-center space-x-3 px-3 py-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-all text-sm';
      return '<a href="#" class="' + cls + '" data-h2nav="' + n.key + '">'
        + '<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">' + n.iconPath + '</svg>'
        + '<span>' + n.label + '</span></a>';
    }).join('');
    var examItems = codes.map(function(c) {
      var on = c === exam;
      var cls = on
        ? 'flex items-center space-x-3 px-3 py-2.5 rounded-lg bg-white/5 text-stitch-purple font-medium text-sm w-full text-left'
        : 'flex items-center space-x-3 px-3 py-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-all text-sm w-full text-left';
      return '<button type="button" class="' + cls + '" data-exam="' + escapeHtml(c) + '">'
        + '<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 14l9-5-9-5-9 5 9 5zm0 0l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>'
        + '<span>' + escapeHtml(c) + '</span></button>';
    }).join('');
    sideNav.innerHTML = topLinks
      + '<div class="my-3"><div class="h-px bg-stitch-border"></div><p class="mt-3 px-3 text-[10px] font-bold text-slate-500 tracking-widest uppercase">Экзамены</p></div>'
      + examItems;
    sideNav.querySelectorAll('button[data-exam]').forEach(function(btn) {
      btn.addEventListener('click', function() { S.exam = btn.dataset.exam; renderHomeV2(); });
    });
    sideNav.querySelectorAll('a[data-h2nav]').forEach(function(a) {
      a.addEventListener('click', function(ev) {
        ev.preventDefault();
        var k = a.dataset.h2nav;
        if (k === 'stats') { closeHomeV2(); openAdminDashboard(); }
        else if (k === 'courses') { closeHomeV2(); goHome(); }
        else if (k === 'insights') { closeHomeV2(); openAdminDashboard(); }
        else if (k === 'topics') { closeHomeV2(); openTopicsDashboard(); }
        else if (k === 'weak') { closeHomeV2(); openWeakQDashboard(); }
        else if (k === 'favorites') { closeHomeV2(); var fb = $('favoritesBtn'); if (fb) fb.click(); }
        else if (k === 'profile') { closeHomeV2(); var pb = $('profileBtn'); if (pb) pb.click(); }
      });
    });
  }

  // Today count (per-exam if available, else global)
  var perExam = (store.dailyStatsByExam && store.dailyStatsByExam[exam]) || {};
  var todayCount = perExam[today] || 0;
  setText('h2TodayCount', String(todayCount));
  setText('h2Streak', String(calcUserStreak(store.dailyStats || {})));

  // Daily plan chip — global across all exams, mirrors the lift-strip
  // chip on the older Home. Updates color class based on progress.
  var h2Chip = $('h2DailyPlanChip');
  if (h2Chip) {
    var h2Progress = Metrics.getTodayProgress(store, userProfile);
    var h2TodayGlobal = h2Progress.answered;
    var h2PlanTarget = h2Progress.goal;
    setText('h2DailyPlanProgress', String(h2TodayGlobal));
    setText('h2DailyPlanTarget', String(h2PlanTarget));
    var h2Pct = h2Progress.pct / 100;
    h2Chip.classList.toggle('is-hit', h2Pct >= 1);
    h2Chip.classList.toggle('is-mid', h2Pct >= 0.5 && h2Pct < 1);
    h2Chip.classList.toggle('is-low', h2Pct < 0.5);
    h2Chip.setAttribute('title',
      'Daily plan: ' + h2TodayGlobal + ' of ' + h2PlanTarget + ' (' + h2Progress.pct + '%)');
  }

  // Exam pills (Stitch-styled)
  var examPills = $('h2ExamPills');
  if (examPills) {
    examPills.innerHTML = codes.slice(0, 6).map(function(c) {
      var on = c === exam;
      var cls = on
        ? 'px-5 py-2 rounded-full bg-stitch-purple/20 border border-stitch-purple text-stitch-purple font-semibold text-xs transition-all'
        : 'px-5 py-2 rounded-full bg-stitch-surface border border-stitch-border text-slate-400 font-semibold text-xs hover:border-slate-600 transition-all';
      return '<button type="button" class="' + cls + '" data-exam="' + escapeHtml(c) + '">' + escapeHtml(c) + '</button>';
    }).join('');
    examPills.querySelectorAll('button[data-exam]').forEach(function(btn) {
      btn.addEventListener('click', function() { S.exam = btn.dataset.exam; renderHomeV2(); });
    });
  }

  // Language pills (Stitch-styled, smaller)
  var langPills = $('h2LangPills');
  if (langPills) {
    var langs = (typeof getAvailableLanguages === 'function') ? getAvailableLanguages() : [];
    var LABELS = { all: 'All', ru: 'RU', en: 'EN' };
    var langButtons = [{ value: 'all', label: LABELS.all }].concat(langs.map(function(l) { return { value: l, label: LABELS[l] || l.toUpperCase() }; }));
    var cur = S.langFilter || 'all';
    langPills.innerHTML = langButtons.map(function(b) {
      var on = b.value === cur;
      var cls = on
        ? 'px-3 py-1.5 rounded-lg bg-stitch-purple/20 border border-stitch-purple text-stitch-purple font-semibold text-xs'
        : 'px-3 py-1.5 rounded-lg bg-stitch-surface border border-stitch-border text-slate-300 font-semibold text-xs hover:border-slate-600 transition-all';
      return '<button type="button" class="' + cls + '" data-lang="' + escapeHtml(b.value) + '">' + escapeHtml(b.label) + '</button>';
    }).join('');
    langPills.querySelectorAll('button[data-lang]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        S.langFilter = btn.dataset.lang;
        if (typeof saveLangFilter === 'function') { try { saveLangFilter(S.langFilter); } catch(_){} }
        renderHomeV2();
      });
    });
  }

  // Section name
  setText('h2SectionName', prof.name || exam);

  // Mode tiles — Stitch glass-card style with SVG icons
  var modesWrap = $('h2Modes');
  if (modesWrap) {
    var MODE_DEF = {
      practice:   { name: 'Practice',       desc: 'Все разделы или один по выбору. 5–50 вопросов.', badge: 'LIVE', badgeColor: 'success', iconColor: 'stitch-purple', svgPath: '<path d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      weak:       { name: 'Weak Topics',    desc: 'Повторение по разделам и истории ваших ошибок.', badge: 'HOT', badgeColor: 'danger', iconColor: 'stitch-danger', svgPath: '<path d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      case_study: { name: 'Case Study',     desc: 'Разбор реальных сценариев и сложных вопросов.', iconColor: 'blue-400', svgPath: '<path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      smart:      { name: 'Smart Review',   desc: 'Интервальное повторение на основе вашего прогресса.', badge: 'AI', badgeColor: 'stitch-purple', iconColor: 'stitch-purple', svgPath: '<path d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      blitz:      { name: 'Blitz',          desc: 'Быстрая серия — без таймеров и кейсов.', iconColor: 'slate-300', svgPath: '<path d="M13 10V3L4 14h7v7l9-11h-7z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
      flashcards: { name: 'Flashcards',     desc: 'Активный MCQ-пул по секциям.', iconColor: 'stitch-warning', svgPath: '<path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>' },
    };
    modesWrap.innerHTML = H2_MODES.map(function(m) {
      var def = MODE_DEF[m.mode] || { name: m.name, desc: m.desc, iconColor: 'stitch-purple', svgPath: '' };
      var badge = def.badge
        ? '<div class="absolute top-4 right-4"><span class="bg-' + def.badgeColor + '/10 text-' + def.badgeColor + ' text-[10px] font-bold px-2 py-0.5 rounded border border-' + def.badgeColor + '/20">' + def.badge + '</span></div>'
        : '';
      return '<div data-mode="' + escapeHtml(m.mode) + '" class="glass-card rounded-2xl p-6 relative group cursor-pointer hover:border-stitch-purple/40 transition-all">'
        + badge
        + '<div class="w-10 h-10 bg-stitch-surface border border-stitch-border rounded-lg flex items-center justify-center mb-6">'
        + '<svg class="h-5 w-5 text-' + def.iconColor + '" fill="none" stroke="currentColor" viewBox="0 0 24 24">' + def.svgPath + '</svg>'
        + '</div>'
        + '<h4 class="text-white font-bold mb-2">' + escapeHtml(def.name) + '</h4>'
        + '<p class="text-sm text-slate-400 leading-relaxed">' + escapeHtml(def.desc) + '</p>'
        + '</div>';
    }).join('');
    modesWrap.querySelectorAll('[data-mode]').forEach(function(card) {
      card.addEventListener('click', function() {
        var mode = card.dataset.mode;
        S.mode = mode;
        if (mode === 'case_study' || mode === 'flashcards') { closeHomeV2(); goHome(); return; }
        closeHomeV2();
        try { startQuiz(); } catch (_) { goHome(); }
      });
    });
  }

  // Activity heatmap — 7 colored squares (Stitch style)
  var bars = $('h2ActBars');
  if (bars) {
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(); d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    var dayMap = (store.dailyStatsByExam && store.dailyStatsByExam[exam]) ? store.dailyStatsByExam[exam] : (store.dailyStats || {});
    var corrMap = (store.dailyCorrectByExam && store.dailyCorrectByExam[exam]) ? store.dailyCorrectByExam[exam] : (store.dailyCorrect || {});
    var maxCnt = Math.max(1, days.reduce(function(m, d) { return Math.max(m, dayMap[d] || 0); }, 0));
    var DOW = ['ВС','ПН','ВТ','СР','ЧТ','ПТ','СБ'];
    var todayStr = new Date().toISOString().slice(0, 10);
    bars.innerHTML = days.map(function(d) {
      var cnt = dayMap[d] || 0;
      var cor = corrMap[d] || 0;
      var intensity = maxCnt > 0 ? cnt / maxCnt : 0;
      var bg;
      if (cnt === 0) bg = 'bg-stitch-surface border border-stitch-border';
      else if (intensity < 0.34) bg = 'bg-stitch-purple/30 border border-stitch-border';
      else if (intensity < 0.67) bg = 'bg-stitch-purple/60 border border-stitch-purple/30';
      else bg = 'bg-stitch-purple-light border border-white/20';
      var ring = d === todayStr ? ' ring-2 ring-stitch-purple/40 ring-offset-2 ring-offset-stitch-bg' : '';
      var dow = DOW[new Date(d).getDay()];
      var pct = cnt > 0 ? Math.round(cor / cnt * 100) + '%' : '—';
      var lblColor = d === todayStr ? 'text-white' : 'text-slate-500';
      return '<div class="flex flex-col items-center space-y-2" title="' + d + ': ' + cnt + ' вопросов · ' + pct + ' точность">'
        + '<div class="w-10 h-10 ' + bg + ' rounded-lg' + ring + '"></div>'
        + '<span class="text-[10px] ' + lblColor + ' font-bold uppercase">' + dow.charAt(0) + '</span>'
        + '</div>';
    }).join('');
  }

  // Continue card (resume in-progress)
  var contPanel = $('h2ContinuePanel');
  if (contPanel) {
    var ls = S.lastSession;
    if (ls && ls.questionKeys && ls.exam) {
      contPanel.style.display = '';
      setText('h2ContinueTitle', ls.exam + ' · ' + (ls.mode || 'practice'));
      setText('h2ContinueSub', 'Прогресс сохранён · ' + (ls.questionKeys.length || 0) + ' вопросов');
    } else {
      contPanel.style.display = 'none';
    }
  }

  // Overview stats + donut rings (Stitch style)
  try {
    var stats = (typeof getExamUserStats === 'function') ? getExamUserStats({ sectionStats: store.sectionStats || {} }, exam) : { total: 0, correct: 0, accuracy: 0 };
    var pool = (typeof getPracticeQuestionPool === 'function') ? getPracticeQuestionPool(exam).length : 0;
    var coverage = pool > 0 ? Math.round(stats.total / pool * 100) : 0;
    setText('h2StatPool', String(pool));
    setText('h2StatAttempts', String(stats.total || 0));
    setText('h2StatAccuracy', (stats.accuracy || 0) + '%');
    setText('h2StatCoverage', coverage + '%');
    // Donut ring offsets: dasharray=125.6 (2πr where r=20). offset = 125.6 * (1 - pct/100)
    var accRing = document.getElementById('h2AccuracyRing');
    if (accRing) accRing.setAttribute('stroke-dashoffset', String(125.6 * (1 - Math.min(100, stats.accuracy || 0) / 100).toFixed(2)));
    var covRing = document.getElementById('h2CoverageRing');
    if (covRing) covRing.setAttribute('stroke-dashoffset', String(125.6 * (1 - Math.min(100, coverage) / 100).toFixed(2)));
  } catch (_) {}

  // Learning plan / readiness (with score bar)
  try {
    var eng = window.readinessEngine;
    if (eng && typeof eng.getReadinessBreakdown === 'function') {
      var br = eng.getReadinessBreakdown(exam) || {};
      var overall = Math.round(Number(br.overall) || 0);
      setText('h2PlanScore', String(overall));
      var scoreBar = $('h2PlanScoreBar');
      if (scoreBar) scoreBar.style.width = overall + '%';
      var badge = $('h2PlanBadge');
      if (badge) {
        var ready = overall >= 75, mid = overall >= 50 && overall < 75;
        badge.textContent = ready ? 'READY' : (mid ? 'SOON' : 'NOT READY');
        var tone = ready ? 'stitch-success' : (mid ? 'stitch-warning' : 'stitch-danger');
        badge.className = 'ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold bg-' + tone + '/10 text-' + tone + ' border border-' + tone + '/20';
      }
      var sections = Array.isArray(br.sections) ? br.sections.slice() : [];
      sections.sort(function(a, b) { return (a.score || 0) - (b.score || 0); });
      var prio = sections.find(function(s) { return (s.score || 0) < 60; });
      var prioEl = $('h2PlanPriority');
      if (prioEl) {
        if (prio) { prioEl.style.display = ''; prioEl.textContent = 'Top priority: ' + (prio.label || prio.key) + ' (' + Math.round(prio.score || 0) + '%)'; }
        else { prioEl.style.display = 'none'; prioEl.textContent = ''; }
      }
      var secWrap = $('h2PlanSections');
      if (secWrap) {
        secWrap.innerHTML = sections.slice(0, 4).map(function(s) {
          var pct = Math.round(s.score || 0);
          var iconColor = pct < 40 ? 'stitch-danger' : (pct < 65 ? 'stitch-warning' : 'stitch-success');
          var icon = pct < 65
            ? '<path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>'
            : '<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>';
          return '<div class="p-4 rounded-xl border border-stitch-border bg-stitch-surface/30 flex items-center space-x-3 group cursor-pointer hover:bg-stitch-surface transition-all">'
            + '<div class="text-' + iconColor + '"><svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">' + icon + '</svg></div>'
            + '<div class="flex-1 min-w-0">'
            + '<div class="flex justify-between text-sm"><span class="font-medium text-slate-200 truncate">' + escapeHtml(s.label || s.key || '') + '</span><span class="font-mono text-slate-400 ml-2">' + pct + '%</span></div>'
            + '<div class="h-1 mt-2 w-full bg-slate-800 rounded-full overflow-hidden"><div class="h-full bg-gradient-to-r from-stitch-purple to-blue-400 rounded-full" style="width:' + pct + '%"></div></div>'
            + '</div></div>';
        }).join('');
      }
    }
  } catch (_) {}

  // Card review (Leitner due)
  try {
    var due = (typeof getLeitnerStats === 'function') ? (getLeitnerStats(exam).due || 0) : 0;
    var revPanel = $('h2ReviewPanel');
    var revSub = $('h2ReviewSub');
    var revCount = $('h2ReviewCount');
    if (revPanel) {
      if (due > 0) {
        revPanel.style.display = '';
        if (revSub) { revSub.style.display = ''; revSub.textContent = 'У вас ' + due + ' просроченных карточек. Не теряйте темп!'; }
        if (revCount) revCount.textContent = String(due);
      } else {
        revPanel.style.display = 'none';
        if (revSub) revSub.style.display = 'none';
      }
    }
  } catch (_) {}
}

function initStatsV2Tabs() {
  var wrap = $('s2Tabs'); if (!wrap) return;
  var profiles = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES) ? EXAM_PROFILES : {};
  var codes = getDisplayedExamCodes(Object.keys(profiles));
  if (!codes.length) return;
  if (codes.indexOf(statsV2Exam) < 0) statsV2Exam = codes[0] || 'PL-300';
  wrap.innerHTML = codes.map(function(c) {
    var on = c === statsV2Exam ? ' is-active' : '';
    var sel = c === statsV2Exam ? 'true' : 'false';
    return '<button class="s2-tab' + on + '" role="tab" aria-selected="' + sel + '" data-exam="' + escapeHtml(c) + '">' + escapeHtml(c) + '</button>';
  }).join('');
  if (wrap.dataset.bound !== '1') {
    wrap.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.s2-tab'); if (!btn) return;
      var exam = btn.dataset.exam; if (!exam || exam === statsV2Exam) return;
      statsV2Exam = exam;
      S.exam = exam;  // propagate to Weak/Topics next time they open
      wrap.querySelectorAll('.s2-tab').forEach(function(b) {
        var active = b.dataset.exam === statsV2Exam;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderStatsV2();
    });
    wrap.dataset.bound = '1';
  }
  var scopeWrap = $('s2ScopeToggle');
  if (scopeWrap && scopeWrap.dataset.bound !== '1') {
    scopeWrap.querySelectorAll('.s2-scope-btn').forEach(function(b) {
      var on = b.dataset.scope === statsV2Scope;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    scopeWrap.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.s2-scope-btn'); if (!btn) return;
      var sc = btn.dataset.scope; if (!sc || sc === statsV2Scope) return;
      statsV2Scope = sc;
      scopeWrap.querySelectorAll('.s2-scope-btn').forEach(function(b) {
        var on = b.dataset.scope === statsV2Scope;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      renderStatsV2();
    });
    scopeWrap.dataset.bound = '1';
  }
}

function renderStatsV2() {
  var exam = statsV2Exam;
  var users = adminUsers || [];
  // Find "me" first — total/correct from sectionStats for this exam,
  // session count, and recent total-answered for delta stub.
  var myStore = (function(){ try { return loadStore(); } catch { return {}; } })();
  // "Me" Attempts/Accuracy now read from dailyStatsByExam (immediate writes,
  // doesn't lose data on unfinished sessions). Cohort users still go through
  // getExamUserStats / sectionStats since that's all their cloud doc carries
  // until they push fresh dailyStatsByExam via saveAnalytics.
  var meStats = (typeof Metrics !== 'undefined' && Metrics.getOverallAttempts)
    ? Metrics.getOverallAttempts(myStore, exam)
    : getExamUserStats({ sectionStats: myStore.sectionStats || {} }, exam);

  // KPI: Users (cohort), Answers (mine on this exam), Success% (mine), Practice time (mine, est. 30s/q)
  var withData = users.filter(function(u) {
    var s = getExamUserStats(u, exam); return s.total > 0;
  });
  var totalUsers = withData.length || (meStats.total > 0 ? 1 : 0);
  var myAnswered = meStats.total;
  var mySuccess = meStats.accuracy;
  // Practice time — measured from dailyTimeMs via Metrics SSoT.
  // Was heuristic `answered × 30s` which overestimated (~30.2h vs real 26h).
  var practiceData = (typeof Metrics !== 'undefined' && Metrics.getTotalPracticeMs)
    ? Metrics.getTotalPracticeMs(myStore, exam)
    : { hours: 0, minutes: 0 };
  var practiceLabel = practiceData.hours >= 1
    ? practiceData.hours + 'h'
    : Math.max(0, Math.round(practiceData.minutes)) + 'm';

  // Cohort aggregates — average accuracy across users with data, plus sum
  // of answered questions. Used when the page-level scope toggle is set
  // to 'all', so the user sees the toggle taking effect on the top KPI
  // strip (Accuracy + Answers), not only on the four trend charts below.
  var isAll = statsV2Scope === 'all';
  var cohortAvgAcc = withData.length
    ? Math.round(withData.reduce(function(s, u){ return s + (getExamUserStats(u, exam).accuracy || 0); }, 0) / withData.length)
    : 0;
  var cohortAnswered = withData.reduce(function(s, u){ return s + (getExamUserStats(u, exam).total || 0); }, 0);

  renderS2TodayKpi(exam, myStore);
  setText('s2Kpi2Label', isAll ? 'Cohort answers' : 'Answers');
  setText('s2KpiAnswers', (isAll ? cohortAnswered : myAnswered).toLocaleString());
  setText('s2KpiSuccess', (isAll ? cohortAvgAcc : mySuccess) + '%');
  setText('s2KpiTime', practiceLabel);
  // Label switches with scope so the value's meaning is unambiguous.
  // Tooltip stays informative for the cohort case too.
  var s2KpiSuccessLabelEl = document.querySelector('.s2-kpi-label[data-kpi="success"]');
  if (s2KpiSuccessLabelEl) {
    s2KpiSuccessLabelEl.textContent = isAll ? 'Cohort accuracy' : 'My accuracy (all-time)';
    s2KpiSuccessLabelEl.setAttribute('title', isAll
      ? 'Среднее значение accuracy по всем пользователям с данными по этому экзамену.'
      : 'Доля правильных ответов за всё время по выбранному экзамену = correct / answered. Δ внизу сравнивает аккуратность последних 7 дней с предыдущими 7 днями.');
  }

  // Deltas — Accuracy delta now compares last-7d accuracy vs prior-7d
  // accuracy using dailyCorrect/dailyStats (same data the trend charts
  // read). Previously this card showed a delta from readinessHistory
  // which is a different metric (overall readiness %, not accuracy) —
  // led to "Accuracy 64% / -3%" being unclear (the -3% wasn't about
  // accuracy at all).
  var accDeltas = computeAccuracyWindowDeltas(myStore, exam);
  setDelta('s2DeltaSuccess', accDeltas.last7, accDeltas.prev7, '%');
  var s2AccDeltaEl = $('s2DeltaSuccess');
  if (s2AccDeltaEl) {
    var fmtAcc = function(acc, total, correct) {
      return acc != null
        ? acc + '% (' + correct + '/' + total + ')'
        : (total > 0 ? correct + '/' + total : 'нет ответов');
    };
    s2AccDeltaEl.title =
      'Последние 7д: ' + fmtAcc(accDeltas.last7, accDeltas.last7Total, accDeltas.last7Correct) +
      ' · Пред. 7д: ' + fmtAcc(accDeltas.prev7, accDeltas.prev7Total, accDeltas.prev7Correct);
  }
  setDelta('s2DeltaAnswers', null, null, '');
  setText('s2DeltaTime', '');

  // Coverage card (6-я) — same calc as Detailed Statistics, shared helper.
  var cov = computeCoverage(myStore, exam);
  setText('s2KpiCoverage', cov.pct == null ? '—' : cov.pct + '%');
  var covPts = _coverageDaySeries(myStore, exam, cov.pool);
  drawSpark('s2SparkCoverage', covPts, true);
  var covVals = covPts.filter(function(p) { return p.y != null; });
  var s2CovEl = $('s2DeltaCoverage');
  if (covVals.length >= 2) {
    var lastCov = covVals[covVals.length - 1].y;
    var weekAgoCov = covVals[Math.max(0, covVals.length - 8)].y;
    setDelta('s2DeltaCoverage', lastCov, weekAgoCov, '%');
    if (s2CovEl) s2CovEl.title = 'Сейчас: ' + lastCov + '% · ~7д назад: ' + weekAgoCov + '% (охват пула)';
  } else {
    setDelta('s2DeltaCoverage', null, null, '');
    if (s2CovEl) s2CovEl.title = 'Недостаточно данных для сравнения';
  }

  // Mastery — leitner box buckets for this exam
  renderS2Mastery(exam, myStore);

  // Focus areas — section-level accuracy for this exam
  renderS2Focus(exam, myStore);

  // Leaderboard — sorted by accuracy (≥10 answers)
  renderS2Leaderboard(exam, users);

  // Smart additions
  var rdHist = loadReadinessHistory();
  var examHist = rdHist[exam] || {};
  var keys = Object.keys(examHist);
  renderS2Sparklines(examHist, keys, myStore);
  renderS2ReadinessKpi(exam, examHist);
  renderS2TodayStrip(exam, myStore);
  renderS2TopWeak(exam, myStore);

  // 2×2 trend grid above the leaderboard — reuses the unified
  // renderActivityCharts pipeline. Scope toggle ('me' | 'all') flips
  // between the user's own series and the cohort-averaged series. No
  // timeId since v2's grid has only 4 charts (Activity / Accuracy /
  // Readiness / Pass probability); no titleId/noteId since card
  // headers carry the labels directly.
  renderActivityCharts({
    range: 14,
    scope: statsV2Scope,
    isFiltered: true,
    examFilter: exam,
    users: users,
    currentUser: currentUser,
    readinessExam: exam,
    ids: {
      barId: 's2ActivityChart',
      accuracyId: 's2AccuracyChart',
      readinessId: 's2ReadinessChart',
      passId: 's2PassChart',
    },
    slots: v2Slots,
  });
}

// Render mini SVG sparklines into the .s2-kpi-spark slots. Pulls from
// readinessHistory for accuracy-flavour KPIs and from a daily-roll-up of
// sectionStats for activity counts. Falls back to the dashed empty state.
function renderS2Sparklines(examHist, keys, store) {
  // Build maps for sparklines:
  //   - successSeries: 14 last days of overall accuracy from readinessHistory
  //   - answersSeries: 14 last days of cumulative-answers proxy (from same hist)
  //   - timeSeries: same shape (proxy: answers count × 30s)
  //   - usersSeries: not personal — leave empty for now (no good source)
  var successPts = readinessSeries(examHist, keys, 14, 'overall');
  var answersPts = synthSeries(store, 14);  // daily delta of total answers
  var timePts = answersPts.map(function(p){ return { x: p.x, y: p.y * 30 / 60 }; }); // minutes/day
  drawSpark('s2SparkSuccess', successPts, true);
  drawSpark('s2SparkAnswers', answersPts, false);
  drawSpark('s2SparkTime', timePts, false);
  drawSpark('s2SparkToday', answersPts, false);
}

function readinessSeries(map, keys, days, field) {
  if (!keys || !keys.length) return [];
  var today = new Date(); today.setUTCHours(0,0,0,0);
  var out = [];
  for (var i = days - 1; i >= 0; i--) {
    var d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
    var k = d.toISOString().slice(0, 10);
    var v = map[k];
    var n = (v && (v[field] != null ? v[field] : v)) || null;
    out.push({ x: days - 1 - i, y: n != null && !isNaN(n) ? Number(n) : null });
  }
  return out;
}

// Synthesize daily-answer-count series from store.questionStats lastSeen.
// Returns 14 points, each = number of question answer events on that day.
function synthSeries(store, days) {
  var qs = (store && store.questionStats) || {};
  var bucket = {};  // dateKey → count
  Object.values(qs).forEach(function(s){
    if (!s || typeof s !== 'object') return;
    var lastSeen = s.lastSeen;
    if (!lastSeen) return;
    var d = new Date(lastSeen); if (isNaN(d)) return;
    d.setUTCHours(0,0,0,0);
    var k = d.toISOString().slice(0,10);
    bucket[k] = (bucket[k] || 0) + 1;
  });
  var today = new Date(); today.setUTCHours(0,0,0,0);
  var out = [];
  for (var i = days - 1; i >= 0; i--) {
    var d2 = new Date(today); d2.setUTCDate(today.getUTCDate() - i);
    var key = d2.toISOString().slice(0, 10);
    out.push({ x: days - 1 - i, y: bucket[key] || 0 });
  }
  return out;
}

function dailyHasActivitySeries(store, days) {
  var qs = (store && store.questionStats) || {};
  var bucket = {};
  Object.values(qs).forEach(function(s){
    if (!s || typeof s !== 'object' || !s.lastSeen) return;
    var d = new Date(s.lastSeen); if (isNaN(d)) return;
    d.setUTCHours(0,0,0,0);
    bucket[d.toISOString().slice(0,10)] = 1;
  });
  var today = new Date(); today.setUTCHours(0,0,0,0);
  var out = [];
  for (var i = days - 1; i >= 0; i--) {
    var d2 = new Date(today); d2.setUTCDate(today.getUTCDate() - i);
    out.push({ x: days - 1 - i, y: bucket[d2.toISOString().slice(0,10)] || 0 });
  }
  return out;
}

function drawSpark(slotId, pts, isPercent) {
  var slot = $(slotId); if (!slot) return;
  var realPts = pts.filter(function(p){ return p.y != null && !isNaN(p.y); });
  if (realPts.length < 2) {
    slot.innerHTML = '<span class="s2-kpi-spark-empty">14d trend</span>';
    return;
  }
  var ys = realPts.map(function(p){ return p.y; });
  var minY = Math.min.apply(null, ys);
  var maxY = Math.max.apply(null, ys);
  var span = maxY - minY || 1;
  // Direction: compare last-3 avg vs first-3 avg
  var firstAvg = avgN(realPts, 0, 3);
  var lastAvg = avgN(realPts, realPts.length - 3, 3);
  var dir = lastAvg > firstAvg + (isPercent ? 1 : 0.5) ? 'is-up'
          : lastAvg < firstAvg - (isPercent ? 1 : 0.5) ? 'is-down'
          : 'is-flat';
  slot.classList.remove('is-up','is-down','is-flat');
  slot.classList.add(dir);
  // Build SVG path with x in 0..(maxX) and y in [4..28] (32px tall)
  var maxX = pts.length - 1;
  var W = 100, H = 32, padTop = 4, padBot = 2;
  function xAt(i){ return (i / maxX) * W; }
  function yAt(v){ return H - padBot - ((v - minY) / span) * (H - padTop - padBot); }
  // Use full pts array (incl. nulls) but skip null segments by breaking path
  var d = '';
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    if (p.y == null || isNaN(p.y)) continue;
    if (!d) d = 'M' + xAt(p.x).toFixed(1) + ',' + yAt(p.y).toFixed(1);
    else d += ' L' + xAt(p.x).toFixed(1) + ',' + yAt(p.y).toFixed(1);
  }
  // Fill area path: same line, then close to bottom-right and bottom-left
  var firstReal = pts.find(function(p){ return p.y != null && !isNaN(p.y); });
  var lastReal = pts.slice().reverse().find(function(p){ return p.y != null && !isNaN(p.y); });
  var fill = d + ' L' + xAt(lastReal.x).toFixed(1) + ',' + H + ' L' + xAt(firstReal.x).toFixed(1) + ',' + H + ' Z';
  slot.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">'
    + '<path class="s2-kpi-spark-fill" d="' + fill + '"/>'
    + '<path class="s2-kpi-spark-line" d="' + d + '"/>'
    + '</svg>';
}

function avgN(pts, start, n) {
  var s = 0, c = 0;
  for (var i = start; i < start + n && i < pts.length && i >= 0; i++) {
    if (pts[i] && pts[i].y != null && !isNaN(pts[i].y)) { s += pts[i].y; c++; }
  }
  return c ? s / c : 0;
}

function renderS2TodayKpi(exam, store) {
  var elAns = $('s2KpiTodayAnswers'); var elAcc = $('s2KpiTodayAcc');
  if (!elAns) return;
  var todayKey = new Date().toISOString().slice(0,10);
  var answered = (store && store.dailyStatsByExam && store.dailyStatsByExam[exam] && store.dailyStatsByExam[exam][todayKey]) || 0;
  var correct = (store && store.dailyCorrectByExam && store.dailyCorrectByExam[exam] && store.dailyCorrectByExam[exam][todayKey]) || 0;
  var acc = answered ? Math.round(correct/answered*100) : null;
  elAns.textContent = answered ? answered.toLocaleString() : '0';
  if (elAcc) {
    elAcc.textContent = acc == null ? '—' : (acc + '%');
    elAcc.classList.remove('is-up','is-flat','is-down');
    if (acc == null) elAcc.classList.add('is-flat');
    else if (acc >= 70) elAcc.classList.add('is-up');
    else if (acc >= 40) elAcc.classList.add('is-flat');
    else elAcc.classList.add('is-down');
  }
}

function renderS2ReadinessKpi(exam, examHist) {
  var el = $('s2KpiReadiness'); var sub = $('s2KpiReadinessSub');
  if (!el) return;
  var overall = null;
  var margin = 0;
  var method = 'wilson';
  var confidence = null;
  try {
    if (window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function') {
      var br = window.readinessEngine.getReadinessBreakdown(exam) || {};
      if (typeof br.overall === 'number') overall = Math.round(br.overall);
      var resolved = resolveReadinessMargin(exam, br.overallMargin);
      margin = resolved.margin;
      method = resolved.method;
      confidence = br.confidence || null;
    }
  } catch (_) {}
  if (overall == null) {
    el.textContent = '—';
  } else if (margin > 0) {
    el.innerHTML = String(overall) + '<span class="s2-kpi-margin"> ± ' + margin + '</span>';
    el.setAttribute('title', '95% confidence interval: ' + Math.max(0, overall - margin) + '–' + Math.min(100, overall + margin)
      + '\nMethod: ' + (method === 'bootstrap' ? 'Bootstrap (500 resamples, cached 24h)' : 'Wilson 95%')
      + (confidence ? '\nData confidence: ' + confidence : ''));
  } else {
    el.textContent = String(overall);
  }
  if (sub) sub.textContent = '/100' + (confidence === 'low' && overall != null ? ' · low confidence' : '');
  // Sparkline — reuse 14d readinessHistory series
  try {
    var pts = readinessSeries(examHist || {}, Object.keys(examHist || {}), 14, 'overall');
    drawSpark('s2SparkReadiness', pts, true);
  } catch (_) {}
}

function renderS2StreakKpi(store) {
  var el = $('s2KpiStreak'); var sub = $('s2KpiStreakSub');
  if (!el) return;
  var qs = (store && store.questionStats) || {};
  // Build set of YYYY-MM-DD with any activity
  var days = new Set();
  Object.values(qs).forEach(function(s){
    if (!s || !s.lastSeen) return;
    var d = new Date(s.lastSeen); if (isNaN(d)) return;
    d.setUTCHours(0,0,0,0);
    days.add(d.toISOString().slice(0,10));
  });
  // Walk back from today counting consecutive days
  var today = new Date(); today.setUTCHours(0,0,0,0);
  var streak = 0;
  for (var i = 0; i < 365; i++) {
    var d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
    var k = d.toISOString().slice(0,10);
    if (days.has(k)) streak++;
    else if (i === 0) continue;  // grace: today not yet practiced doesn't break streak
    else break;
  }
  el.textContent = streak;
  if (sub) sub.textContent = streak === 1 ? 'day' : 'days';
}

function renderS2TodayStrip(exam, store) {
  var strip = $('s2TodayStrip'); if (!strip) return;
  var qs = (store && store.questionStats) || {};
  var today = new Date(); today.setUTCHours(0,0,0,0);
  var todayKey = today.toISOString().slice(0,10);
  var totalToday = 0, correctToday = 0;
  Object.values(qs).forEach(function(s){
    if (!s || !s.lastSeen) return;
    if (exam && s.exam && s.exam !== exam) return;
    var d = new Date(s.lastSeen); if (isNaN(d)) return;
    d.setUTCHours(0,0,0,0);
    if (d.toISOString().slice(0,10) !== todayKey) return;
    totalToday += 1;
    // questionStats stores `correct` (count of correct attempts), `total` (count of all attempts).
    // Use correct/total to weight today's contribution.
    if (s.total && s.correct != null) {
      var ratio = (s.correct / s.total);
      correctToday += ratio;
    }
  });
  if (totalToday < 1) {
    strip.className = 's2-today-strip is-empty';
    strip.innerHTML = '';
    return;
  }
  var accToday = totalToday ? Math.round(correctToday / totalToday * 100) : 0;
  // Compare vs user's overall accuracy on this exam
  var meStats = getExamUserStats({ sectionStats: store.sectionStats || {} }, exam);
  var deltaVsAvg = meStats.accuracy != null && meStats.total >= 10 ? (accToday - meStats.accuracy) : null;
  var deltaTxt = '';
  if (deltaVsAvg != null) {
    var sign = deltaVsAvg > 0 ? '▲ +' : deltaVsAvg < 0 ? '▼ ' : '— ';
    var cls = deltaVsAvg > 0 ? 'is-up' : deltaVsAvg < 0 ? 'is-down' : 'is-flat';
    deltaTxt = '<span class="s2-kpi-delta ' + cls + '">' + sign + Math.abs(deltaVsAvg) + '% vs avg</span>';
  }
  strip.className = 's2-today-strip';
  strip.innerHTML = '<span class="s2-today-label">Сегодня</span>'
    + '<span class="s2-today-stat"><span class="s2-today-num">' + totalToday + '</span><span class="s2-today-cap">answered</span></span>'
    + '<span class="s2-today-sep"></span>'
    + '<span class="s2-today-stat"><span class="s2-today-num">' + accToday + '%</span><span class="s2-today-cap">accuracy</span></span>'
    + (deltaTxt ? '<span class="s2-today-sep"></span>' + deltaTxt : '');
}

function renderS2TopWeak(exam, store) {
  var el = $('s2WeakCallout'); if (!el) return;
  var ss = (store && store.sectionStats) || {};
  var prefix = exam + '__';
  var rows = [];
  Object.entries(ss).forEach(function(entry){
    var key = entry[0], v = entry[1];
    if (!v || typeof v !== 'object') return;
    if (key.indexOf(prefix) !== 0) return;
    var sectionKey = key.slice(prefix.length);
    var label = v.label || (typeof getSectionLabel === 'function' ? getSectionLabel(exam, sectionKey) : sectionKey);
    var total = Number(v.total) || 0; var correct = Number(v.correct) || 0;
    if (total < 5) return;
    var acc = Math.round(correct / total * 100);
    if (acc >= 60) return;  // not weak enough to highlight
    rows.push({ label: label, sectionKey: sectionKey, accuracy: acc, total: total });
  });
  if (!rows.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  rows.sort(function(a, b){ return a.accuracy - b.accuracy; });
  var w = rows[0];
  el.style.display = 'flex';
  el.innerHTML = '<span class="s2-weak-callout-icon" aria-hidden="true">🎯</span>'
    + '<div class="s2-weak-callout-body">'
    +   '<p class="s2-weak-callout-title">Weakest area: ' + escapeHtml(w.label) + ' — ' + w.accuracy + '%</p>'
    +   '<p class="s2-weak-callout-sub">' + w.total + ' answers across this section. Practice more to lift your overall accuracy.</p>'
    + '</div>'
    + '<button class="s2-weak-callout-cta" type="button" data-section="' + escapeHtml(w.sectionKey) + '">Drill this</button>';
  // Wire CTA — close stats and let user pick the topic on home (best-effort).
  var btn = el.querySelector('.s2-weak-callout-cta');
  if (btn) {
    btn.onclick = function() {
      closeStatsV2();
      // Best-effort: scroll to section domain panel on home; deeper integration TBD.
      var anchor = $('domainSection') || $('topicSelectorWrap');
      if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
}

// Accuracy delta over two trailing 7-day windows from the per-exam daily
// stats (same source the trend charts read). Returns { last7, prev7 } as
// percentages or null when a window has zero answered. Falls back to
// global dailyCorrect/dailyStats when per-exam maps are empty (legacy data
// predates per-exam tracking).
function computeAccuracyWindowDeltas(store, exam) {
  var empty = { last7: null, prev7: null, last7Total: 0, last7Correct: 0, prev7Total: 0, prev7Correct: 0 };
  if (!store) return empty;
  var byExamStats = (store.dailyStatsByExam && store.dailyStatsByExam[exam]) || null;
  var byExamCorrect = (store.dailyCorrectByExam && store.dailyCorrectByExam[exam]) || null;
  var statsMap, correctMap;
  if (byExamStats && Object.keys(byExamStats).length) {
    statsMap = byExamStats;
    correctMap = byExamCorrect || {};
  } else {
    statsMap = store.dailyStats || {};
    correctMap = store.dailyCorrect || {};
  }
  var today = new Date(); today.setUTCHours(0,0,0,0);
  function windowAccuracy(fromAgo, toAgo) {
    var total = 0, correct = 0;
    for (var i = fromAgo; i < toAgo; i++) {
      var d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
      var k = d.toISOString().slice(0, 10);
      total += statsMap[k] || 0;
      correct += correctMap[k] || 0;
    }
    return { total: total, correct: correct, acc: total > 0 ? Math.round((correct / total) * 1000) / 10 : null };
  }
  var last = windowAccuracy(0, 7);
  var prev = windowAccuracy(7, 14);
  return {
    last7: last.acc, prev7: prev.acc,
    last7Total: last.total, last7Correct: last.correct,
    prev7Total: prev.total, prev7Correct: prev.correct,
  };
}

function avgWindow(map, keys, fromAgo, toAgo) {
  if (!keys.length) return null;
  var today = new Date(); today.setUTCHours(0,0,0,0);
  var cutoff1 = new Date(today); cutoff1.setUTCDate(today.getUTCDate() - fromAgo);
  var cutoff2 = new Date(today); cutoff2.setUTCDate(today.getUTCDate() - toAgo);
  var sum = 0, n = 0;
  keys.forEach(function(k) {
    var d = new Date(k); if (isNaN(d)) return;
    if (d <= cutoff1 && d > cutoff2) {
      var v = Number(map[k] && (map[k].overall != null ? map[k].overall : map[k]));
      if (!isNaN(v)) { sum += v; n += 1; }
    }
  });
  return n > 0 ? sum / n : null;
}
function setText(id, v) { var el = $(id); if (el) el.textContent = v; }
function setDelta(id, a, b, suffix) {
  var el = $(id); if (!el) return;
  if (a == null || b == null) { el.textContent = ''; el.className = 's2-kpi-delta is-flat'; return; }
  var d = Math.round((a - b) * 10) / 10;
  if (d > 0) { el.className = 's2-kpi-delta is-up'; el.textContent = '▲ +' + d + suffix; }
  else if (d < 0) { el.className = 's2-kpi-delta is-down'; el.textContent = '▼ ' + d + suffix; }
  else { el.className = 's2-kpi-delta is-flat'; el.textContent = '— 0' + suffix; }
}

function renderS2Mastery(exam, store) {
  var body = $('s2MasteryBody'); if (!body) return;
  var leitner = (store && store.leitner) || {};
  var qs = (store && store.questionStats) || {};
  var buckets = [0,0,0,0,0]; var totalSeen = 0;
  Object.entries(leitner).forEach(function(entry) {
    var qkey = entry[0], info = entry[1];
    if (!info || typeof info !== 'object') return;
    var qInfo = qs[qkey];
    var qExam = (qInfo && qInfo.exam) || info.exam;
    if (qExam && qExam !== exam) return;
    var box = Number(info.box) || 0;
    if (box >= 1 && box <= 5) { buckets[box-1] += 1; totalSeen += 1; }
  });
  if (totalSeen < 1) {
    body.innerHTML = '<div class="s2-empty">No mastery data yet for ' + escapeHtml(exam) + '. Answer some questions to populate.</div>';
    return;
  }
  var mastered = buckets[3] + buckets[4];
  var pct = totalSeen ? Math.round(mastered / totalSeen * 100) : 0;
  var max = Math.max.apply(null, buckets) || 1;
  var bars = buckets.map(function(c, i) {
    var h = Math.max(8, Math.round((c / max) * 100));
    var cls = i === 3 ? 'is-mastered' : i === 4 ? 'is-mastered-strong' : '';
    return '<div class="s2-mastery-bar ' + cls + '" style="height:' + h + '%"><span>' + c + '</span></div>';
  }).join('');
  body.innerHTML = ''
    + '<div class="s2-mastery-headline">'
    +   '<span class="s2-mastery-num">' + mastered + ' <small>of ' + totalSeen + '</small></span>'
    +   '<span class="s2-pill s2-pill-success">' + pct + '% Mastered</span>'
    + '</div>'
    + '<p class="s2-help">Where your seen ' + escapeHtml(exam) + ' questions sit on the 1→5 spaced-repetition ladder. Boxes 4-5 = mastered.</p>'
    + '<div class="s2-mastery-chart">' + bars + '</div>'
    + '<div class="s2-mastery-axis"><span>Box 1</span><span>Box 2</span><span>Box 3</span><span>Box 4</span><span>Box 5</span></div>';
}

function renderS2Focus(exam, store) {
  var body = $('s2FocusBody'); var meta = $('s2FocusMeta');
  if (!body) return;
  var ss = (store && store.sectionStats) || {};
  var prefix = exam + '__';

  // Pull recent counts per section from the readiness engine (same
  // saturation/blend that drives the actual accuracy input). Falls back
  // gracefully if engine isn't loaded yet.
  var recentBySection = {};
  var saturation = 100;
  try {
    if (window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function') {
      var br = window.readinessEngine.getReadinessBreakdown(exam) || {};
      var sd = br.sectionDetails || {};
      Object.keys(sd).forEach(function(k) {
        recentBySection[k] = sd[k].accuracyRecentSampleSize || 0;
      });
    }
  } catch (_) {}

  var rows = [];
  Object.entries(ss).forEach(function(entry) {
    var key = entry[0], v = entry[1];
    if (!v || typeof v !== 'object') return;
    if (key.indexOf(prefix) !== 0) return;
    var sectionKey = key.slice(prefix.length);
    var label = v.label || (typeof getSectionLabel === 'function' ? getSectionLabel(exam, sectionKey) : sectionKey);
    var total = Number(v.total) || 0; var correct = Number(v.correct) || 0;
    if (total < 5) return;
    rows.push({
      label: label,
      sectionKey: sectionKey,
      total: total,
      correct: correct,
      accuracy: Math.round(correct/total*100),
      recent: recentBySection[sectionKey] || 0,
      saturation: saturation,
    });
  });
  if (rows.length < 2) {
    body.innerHTML = '<div class="s2-empty">Need ≥5 answers in at least 2 sections of ' + escapeHtml(exam) + '. Keep answering!</div>';
    if (meta) meta.textContent = '';
    return;
  }
  rows.sort(function(a,b){ return b.accuracy - a.accuracy; });
  var avg = Math.round(rows.reduce(function(a,r){return a+r.accuracy*r.total;},0) / rows.reduce(function(a,r){return a+r.total;},0));
  if (meta) meta.textContent = 'Avg: ' + avg + '% • Target: 70%';
  // Two columns
  var col1 = []; var col2 = [];
  rows.forEach(function(r, i) { (i % 2 === 0 ? col1 : col2).push(r); });
  var recentTooltip = 'Сколько разных вопросов из секции ты ответил за последние 14 дней. На ' + saturation
    + '+ свежих accuracy секции полностью переходит на свежий результат (история отбрасывается).';
  function rowHtml(r) {
    var cls = r.accuracy >= 70 ? 'ok' : r.accuracy >= 50 ? 'accent' : 'danger';
    var saturated = r.recent >= r.saturation;
    var recentCls = saturated ? 's2-bar-recent ok' : 's2-bar-recent';
    var recentTxt = saturated
      ? '✓ recent ' + r.recent + '/' + r.saturation
      : 'recent ' + r.recent + '/' + r.saturation;
    return '<div class="s2-bar-row">'
      + '<div class="s2-bar-row-head">'
      +   '<span>' + escapeHtml(r.label) + '</span>'
      +   '<span class="s2-bar-meta">'
      +     '<span class="' + recentCls + '" title="' + escapeHtml(recentTooltip) + '">' + recentTxt + '</span>'
      +     '<span class="s2-bar-pct ' + cls + '">' + r.accuracy + '%</span>'
      +   '</span>'
      + '</div>'
      + '<div class="s2-bar-track"><div class="s2-bar-fill ' + cls + '" style="width:' + r.accuracy + '%"></div></div>'
      + '</div>';
  }
  body.innerHTML = '<div class="s2-focus-grid"><div>' + col1.map(rowHtml).join('') + '</div><div>' + col2.map(rowHtml).join('') + '</div></div>';
}

function renderS2Leaderboard(exam, users) {
  var wrap = $('s2LeaderWrap'); if (!wrap) return;
  // Same readiness cascade as the v1 admin leaderboard (latestReadinessSnapshot):
  // 1) latest cloud snapshot in u.readinessDaily[exam] — recorded once per session
  // 2) for the current user, local readiness history
  // 3) live readinessEngine.getReadinessBreakdown(exam).overall as a final fallback
  // This is the *full* readiness formula (0.55×accuracy + 0.25×mastery +
  // 0.10×(1−recentWrongs) + 0.10×(1−duePressure)), not the per-section weighted
  // accuracy that computeAnalyticsReadiness returns.
  var localHist = (typeof loadReadinessHistory === 'function') ? loadReadinessHistory() : {};
  var meUid = (typeof currentUser !== 'undefined' && currentUser && currentUser.uid) ? currentUser.uid : null;
  function readinessFor(u) {
    var best = null;
    var cloud = u && u.readinessDaily && u.readinessDaily[exam];
    if (cloud) {
      Object.keys(cloud).sort().forEach(function(d) {
        var v = Number(cloud[d]);
        if (!isNaN(v)) best = { date: d, value: v };
      });
    }
    if (u && u.uid && meUid && u.uid === meUid) {
      var local = localHist && localHist[exam];
      if (local) {
        Object.keys(local).sort().forEach(function(d) {
          var v = Number(local[d]);
          if (!isNaN(v) && (!best || d >= best.date)) best = { date: d, value: v };
        });
      }
      if (!best && window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function') {
        try {
          var live = Number(window.readinessEngine.getReadinessBreakdown(exam).overall);
          if (!isNaN(live)) best = { date: new Date().toISOString().slice(0,10), value: live };
        } catch (e) {}
      }
    }
    return best ? best.value : null;
  }
  // Compute live Readiness margin once for the current user — used only on
  // the "is-self" row since we don't have other users' raw per-question
  // data for a Wilson CI on their proportion.
  var myMargin = 0;
  try {
    if (window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function') {
      var meBr = window.readinessEngine.getReadinessBreakdown(exam) || {};
      var resolvedV2 = resolveReadinessMargin(exam, meBr.overallMargin);
      myMargin = resolvedV2.margin;
    }
  } catch (_) {}
  var rows = (users || []).map(function(u) {
    var s = getExamUserStats(u, exam);
    var isMeRow = u.isMe === true || u.isCurrent === true || (typeof S !== 'undefined' && S.uid && u.uid === S.uid);
    return {
      name: u.displayName || u.name || u.email || 'Anonymous',
      uid: u.uid || u.id,
      sessions: u.sessions || 0,
      total: s.total, accuracy: s.accuracy,
      readiness: readinessFor(u),
      margin: isMeRow ? myMargin : 0,
      isMe: isMeRow,
    };
  }).filter(function(r){ return r.total >= 10; });
  if (!rows.length) {
    wrap.innerHTML = '<div class="s2-empty" style="padding:24px;text-align:center">No one has answered ' + escapeHtml(exam) + ' enough times yet (need ≥10 answers).</div>';
    return;
  }
  rows.sort(function(a,b){ return b.accuracy - a.accuracy; });
  var trs = rows.slice(0, 10).map(function(r, i) {
    var rank = String(i+1).padStart(2,'0');
    var rankCls = i === 0 ? ' is-top' : '';
    var avatar = (r.name || '?').charAt(0).toUpperCase();
    var accCls = r.accuracy >= 70 ? 's2-acc-ok' : 's2-acc-warn';
    var readyCls, readyTxt;
    if (r.readiness == null) {
      readyCls = 's2-pill-warn';
      readyTxt = '—';
    } else {
      var rv = Math.round(Number(r.readiness));
      readyCls = rv >= 70 ? 's2-pill-success' : 's2-pill-warn';
      readyTxt = rv + '/100';
      // Wilson CI margin only for the current user (we don't have other
      // users' per-question data, only their daily snapshot).
      if (r.isMe && r.margin > 0) {
        readyTxt += '<span class="s2-pill-margin"> ±' + r.margin + '</span>';
      }
    }
    var trCls = r.isMe ? ' class="is-self"' : '';
    var pillTitle = (r.isMe && r.margin > 0)
      ? ' title="95% CI: ' + Math.max(0, rv - r.margin) + '–' + Math.min(100, rv + r.margin) + '"' : '';
    return '<tr' + trCls + '>'
      + '<td><span class="s2-rank' + rankCls + '">' + rank + '</span></td>'
      + '<td><div class="s2-user"><span class="s2-avatar">' + escapeHtml(avatar) + '</span><span>' + escapeHtml(r.name) + (r.isMe ? ' (You)' : '') + '</span></div></td>'
      + '<td class="t-mono">' + r.sessions + '</td>'
      + '<td class="t-mono">' + r.total.toLocaleString() + '</td>'
      + '<td class="t-right ' + accCls + '">' + r.accuracy + '%</td>'
      + '<td class="t-right"><span class="s2-pill ' + readyCls + '"' + pillTitle + '>' + readyTxt + '</span></td>'
      + '</tr>';
  }).join('');
  wrap.innerHTML = '<table class="s2-table"><thead><tr>'
    + '<th>Rank</th><th>Leader</th><th>Sessions</th><th>Questions</th>'
    + '<th class="t-right">Accuracy</th><th class="t-right">Readiness</th>'
    + '</tr></thead><tbody>' + trs + '</tbody></table>';
}
let adminUsers = [];
let adminExam = (typeof S !== 'undefined' && S && S.exam) ? S.exam : 'PL-300';
let adminChartScope = 'me'; // 'all' | 'me'
let adminChartRange = 14; // 7 | 14 | 30

async function loadAdminData() {
  $('adminSummary').innerHTML='<div style="color:var(--text-muted);grid-column:1/-1">Loading...</div>';
  $('adminLeaderboard').innerHTML='';
  adminUsers = await window.cloudSync.getAllAnalytics();
  if (!adminUsers.length) { $('adminSummary').innerHTML='<div style="color:var(--text-muted);grid-column:1/-1">No data.</div>'; return; }
  initAdminExamSelect();
  initAdminChartScope();
  initAdminChartRange();
  // Capture today's readiness for the active exams so the leaderboard column
  // works for users who haven't finished a session since the snapshot was wired up.
  try {
    const exam = (typeof S !== 'undefined' && S.exam) ? S.exam : 'PL-300';
    saveReadinessSnapshot(exam);
  } catch {}
  // Double rAF — let the just-shown adminApp finish layout before Chart.js
  // measures canvases. Without this, charts on first open render to a
  // 0-sized canvas and only show real data after the user clicks a range/scope
  // tab (which destroys + recreates charts with the now-settled layout).
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  renderAdmin();
}

function initAdminChartRange() {
  const wrap = $('adminChartRange');
  if (!wrap || wrap.dataset.bound === '1') return;
  wrap.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.admin-chart-scope-btn');
    if (!btn) return;
    const next = parseInt(btn.dataset.range, 10);
    if (!next || next === adminChartRange) return;
    adminChartRange = next;
    wrap.querySelectorAll('.admin-chart-scope-btn').forEach(b => {
      const active = parseInt(b.dataset.range, 10) === adminChartRange;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderAdmin();
  });
  wrap.dataset.bound = '1';
}

function initAdminChartScope() {
  const wrap = $('adminChartScope');
  if (!wrap || wrap.dataset.bound === '1') return;
  wrap.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.admin-chart-scope-btn');
    if (!btn) return;
    const next = btn.dataset.scope;
    if (!next || next === adminChartScope) return;
    adminChartScope = next;
    wrap.querySelectorAll('.admin-chart-scope-btn').forEach(b => {
      const active = b.dataset.scope === adminChartScope;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderAdmin();
  });
  wrap.dataset.bound = '1';
}

function initAdminExamSelect() {
  // Tab-style exam slicer — mirrors the Statistics v2 #s2Tabs UI. The
  // legacy <select#adminExamSelect> was replaced by <nav#adminExamTabs>
  // in markup; this function now renders tabs and wires clicks.
  const tabs = $('adminExamTabs');
  if (!tabs) return;
  const profiles = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES) ? EXAM_PROFILES : {};
  const codes = getDisplayedExamCodes(Object.keys(profiles));
  if (!codes.length) return;
  if (codes.indexOf(adminExam) < 0) adminExam = codes[0];
  tabs.innerHTML = codes.map(function(c) {
    var on = c === adminExam ? ' is-active' : '';
    var sel = c === adminExam ? 'true' : 'false';
    return '<button class="s2-tab' + on + '" type="button" role="tab" aria-selected="' + sel + '" data-exam="' + escapeHtml(c) + '">' + escapeHtml(c) + '</button>';
  }).join('');
  if (tabs.dataset.bound !== '1') {
    tabs.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.s2-tab'); if (!btn) return;
      var exam = btn.dataset.exam; if (!exam || exam === adminExam) return;
      adminExam = exam;
      tabs.querySelectorAll('.s2-tab').forEach(function(b) {
        var active = b.dataset.exam === adminExam;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderAdmin();
    });
    tabs.dataset.bound = '1';
  }
}

function getExamUserStats(u, exam) {
  // Delegates to Metrics.getAccuracy — single source of truth (src/metrics.js).
  // Kept as legacy alias because ~10+ call sites still use this name.
  if (typeof Metrics !== 'undefined' && typeof Metrics.getAccuracy === 'function') {
    return Metrics.getAccuracy(u && u.sectionStats, exam);
  }
  // Fallback (should never run — metrics.js loaded before app.js)
  const ss = (u && u.sectionStats) || {};
  const prefix = exam + '__';
  let total = 0, correct = 0;
  Object.keys(ss).forEach(k => {
    if (k.indexOf(prefix) === 0) {
      total += ss[k].total || 0;
      correct += ss[k].correct || 0;
    }
  });
  const accuracy = total > 0 ? Math.round(correct / total * 100) : 0;
  return { total, correct, accuracy };
}

// Cross-user readiness from persisted sectionStats only. Mirrors the accuracy
// component of readiness.js (55%). Honest semantics: if user has zero answers
// or no section has reached the data threshold, score is null (show "—") —
// we never invent a "neutral 50%" out of thin air.
// Returns { score, status, minSection, minSectionKey, totalAnswered, sectionsWithData }
function computeAnalyticsReadiness(u, exam) {
  const profile = (typeof getExamProfile === 'function') ? getExamProfile(exam) : null;
  const weights = (profile && profile.sectionWeights) || {};
  const keys = Object.keys(weights);
  if (!keys.length) return { score: null, status: 'not_ready', minSection: null, minSectionKey: null, totalAnswered: 0, sectionsWithData: 0 };

  const ss = u.sectionStats || {};
  const prefix = exam + '__';
  let weightedScore = 0;
  let usedWeightSum = 0;
  let totalAnswered = 0;
  let sectionsWithData = 0;
  const sectionScores = {};

  keys.forEach(sKey => {
    const w = typeof weights[sKey] === 'number' ? weights[sKey] : 0;
    if (w <= 0) return;
    const s = ss[prefix + sKey] || { correct: 0, total: 0 };
    const total = s.total || 0;
    const correct = s.correct || 0;
    totalAnswered += total;
    if (total < 3) return;
    sectionsWithData += 1;
    const sectionScore = Math.round((correct / total) * 100);
    sectionScores[sKey] = sectionScore;
    weightedScore += sectionScore * w;
    usedWeightSum += w;
  });

  if (sectionsWithData === 0 || usedWeightSum <= 0) {
    return { score: null, status: 'not_ready', minSection: null, minSectionKey: null, totalAnswered, sectionsWithData: 0 };
  }
  const score = Math.round(weightedScore / usedWeightSum);
  const minSectionKey = Object.keys(sectionScores).reduce((a, b) => sectionScores[a] <= sectionScores[b] ? a : b);
  const minSection = sectionScores[minSectionKey];
  const status = (window.readinessEngine && window.readinessEngine.classifyStatus)
    ? window.readinessEngine.classifyStatus(score, minSection)
    : 'not_ready';
  return { score, status, minSection, minSectionKey, totalAnswered, sectionsWithData };
}

function renderAdmin() {
  const isFiltered = adminExam !== 'all';
  // Local store wins for current user — cloud syncs in batches, so local is
  // the freshest source. Other users (cohort) still read from cloud since we
  // can't see their local stores anyway.
  const meUidForStats = currentUser && currentUser.uid;
  let myLocalStore = null;
  try { myLocalStore = (typeof loadStore === 'function') ? loadStore() : null; } catch {}
  const view = adminUsers.map(u => {
    const isMe = meUidForStats && u.uid === meUidForStats;
    if (!isFiltered) {
      if (isMe && myLocalStore) {
        const all = myLocalStore.userStats || {};
        const total = all.total || u.totalAnswered || 0;
        const correct = all.correct || u.totalCorrect || 0;
        return {
          u,
          sessions: Metrics.getSessions(myLocalStore) || u.sessions || 0,
          totalAnswered: total,
          totalCorrect: correct,
          accuracy: total > 0 ? Math.round(correct / total * 100) : (u.accuracy || 0),
          hasData: total > 0,
        };
      }
      return {
        u,
        sessions: u.sessions || 0,
        totalAnswered: u.totalAnswered || 0,
        totalCorrect: u.totalCorrect || 0,
        accuracy: u.accuracy || 0,
        hasData: (u.totalAnswered || 0) > 0,
      };
    }
    if (isMe && myLocalStore) {
      const localExam = getExamUserStats({ sectionStats: myLocalStore.sectionStats || {} }, adminExam);
      if (localExam.total > 0) {
        return {
          u,
          sessions: Metrics.getSessions(myLocalStore) || u.sessions || 0,
          totalAnswered: localExam.total,
          totalCorrect: localExam.correct,
          accuracy: localExam.accuracy,
          hasData: true,
        };
      }
    }
    const s = getExamUserStats(u, adminExam);
    return {
      u, sessions: u.sessions || 0,
      totalAnswered: s.total, totalCorrect: s.correct, accuracy: s.accuracy,
      hasData: s.total > 0,
    };
  }).filter(r => isFiltered ? r.hasData : true);

  const totalUsers = view.length;
  const totalSessions = view.reduce((a,r)=>a+(r.sessions||0),0);
  const totalAnswered = view.reduce((a,r)=>a+(r.totalAnswered||0),0);
  const avgAcc = totalUsers ? Math.round(view.reduce((a,r)=>a+(r.accuracy||0),0)/totalUsers) : 0;
  // Scope-aware top cards. 'me' shows the current user's own counters and
  // accuracy (no cohort mixing). 'all' keeps cohort totals + averaged
  // accuracy, but renamed "Cohort accuracy" so it can't be confused with
  // the per-user "My accuracy" KPI in the row below.
  const isMeScope = adminChartScope === 'me';
  const meUidForCards = currentUser && currentUser.uid;
  const meRowForCards = isMeScope ? view.find(r => r.u && r.u.uid === meUidForCards) : null;
  let cards;
  if (isMeScope) {
    const mySess = meRowForCards ? (meRowForCards.sessions || 0) : 0;
    const myAns  = meRowForCards ? (meRowForCards.totalAnswered || 0) : 0;
    const myAcc  = meRowForCards ? (meRowForCards.accuracy || 0) : 0;
    cards = [
      { label: 'Sessions',    val: mySess,      sparkId: 'admSparkSessions', deltaId: 'admDeltaSessions' },
      { label: 'Answers',     val: myAns,       sparkId: 'admSparkAnswers',  deltaId: 'admDeltaAnswers' },
      { label: 'My accuracy', val: myAcc + '%', sparkId: 'admSparkAcc',      deltaId: 'admDeltaAcc' },
    ];
  } else {
    cards = isFiltered
      ? [
          { label: 'Users',           val: totalUsers,     sparkId: 'admSparkUsers',   deltaId: 'admDeltaUsers' },
          { label: 'Answers',         val: totalAnswered,  sparkId: 'admSparkAnswers', deltaId: 'admDeltaAnswers' },
          { label: 'Cohort accuracy', val: avgAcc + '%',   sparkId: 'admSparkAcc',     deltaId: 'admDeltaAcc' },
        ]
      : [
          { label: 'Users',           val: totalUsers,     sparkId: 'admSparkUsers',    deltaId: 'admDeltaUsers' },
          { label: 'Sessions',        val: totalSessions,  sparkId: 'admSparkSessions', deltaId: 'admDeltaSessions' },
          { label: 'Cohort accuracy', val: avgAcc + '%',   sparkId: 'admSparkAcc',      deltaId: 'admDeltaAcc' },
        ];
  }
  $('adminSummary').innerHTML = cards.map(c =>
    `<div class="s2-kpi">
      <div class="s2-kpi-label">${escapeHtml(c.label)}</div>
      <div class="s2-kpi-row">
        <div class="s2-kpi-val">${c.val}</div>
        <div class="s2-kpi-delta is-flat" id="${c.deltaId}"></div>
      </div>
      <div class="s2-kpi-spark" id="${c.sparkId}"></div>
    </div>`
  ).join('');
  try {
    populateAdminSummarySparks({
      scopeIsMe: isMeScope,
      examFilter: isFiltered ? adminExam : null,
      store: (typeof loadStore === 'function') ? loadStore() : null,
    });
  } catch (e) { console.warn('populateAdminSummarySparks failed', e); }

  const readinessExam = isFiltered ? adminExam : 'PL-300';
  const localHistForLeaderboard = loadReadinessHistory();
  const meUidForLeaderboard = currentUser && currentUser.uid;
  function latestReadinessSnapshot(u) {
    const cloud = u && u.readinessDaily && u.readinessDaily[readinessExam];
    let best = null;
    if (cloud) {
      Object.keys(cloud).sort().forEach(d => { const v = Number(cloud[d]); if (!isNaN(v)) best = { date: d, value: v }; });
    }
    if (u && u.uid === meUidForLeaderboard) {
      const local = localHistForLeaderboard[readinessExam];
      if (local) {
        Object.keys(local).sort().forEach(d => { const v = Number(local[d]); if (!isNaN(v) && (!best || d >= best.date)) best = { date: d, value: v }; });
      }
      // Live fallback for the current user — Study Plan computes this every time
      // we open it, so it's the freshest source if no snapshot has been written.
      if (!best && window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function') {
        try {
          const live = Number(window.readinessEngine.getReadinessBreakdown(readinessExam).overall);
          if (!isNaN(live)) best = { date: new Date().toISOString().slice(0,10), value: live };
        } catch {}
      }
    }
    return best;
  }
  const enrichedView = view.map(r => ({
    ...r,
    readiness: computeAnalyticsReadiness(r.u, readinessExam),
    readinessSnap: latestReadinessSnapshot(r.u),
  }));
  // Wilson CI margin (95% confidence) for the current user only — we
  // don't have per-question raw data for other users. Respects
  // userProfile.useBootstrapCI to switch to bootstrap method.
  let myReadinessMargin = 0;
  try {
    if (window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function') {
      const meBrAdmin = window.readinessEngine.getReadinessBreakdown(readinessExam) || {};
      const resolvedV1 = resolveReadinessMargin(readinessExam, meBrAdmin.overallMargin);
      myReadinessMargin = resolvedV1.margin;
    }
  } catch (_) {}
  const sorted=[...enrichedView].sort((a,b)=>(b.accuracy||0)-(a.accuracy||0));
  const medals=['🥇','🥈','🥉'];
  if (!sorted.length) {
    $('adminLeaderboard').innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted)">No one has answered this exam yet.</div>';
  } else {
    const snapHeader = `Read.<span style="font-size:0.65rem;display:block;font-weight:500;opacity:0.65;letter-spacing:0">${escapeHtml(readinessExam)}</span>`;
    const snapHeaderTitle = 'Full Readiness (latest snapshot): 0.55×accuracy + 0.25×mastery + 0.10×(1−recentWrongs) + 0.10×(1−duePressure). accuracy = last-14d per-question scored from the last 3 attempts (3/3 right = 1.0 "learned", 2/3 = 0.6, 1/3 = 0.4, 0/3 = 0). Blends with all-time, saturates at 100 recent q per section. Recorded once per session.';
    $('adminLeaderboard').innerHTML='<div class="admin-table-wrap"><table style="width:100%;border-collapse:collapse;table-layout:fixed;"><thead><tr style="color:var(--text-muted);text-align:left;border-bottom:1px solid var(--border-light)"><th style="padding:8px 4px;width:32px;">#</th><th style="padding:8px 8px;">Leader</th><th class="hide-on-mobile" style="padding:8px 8px;text-align:center;width:80px;white-space:nowrap;">Sessions</th><th class="hide-on-mobile" style="padding:8px 8px;text-align:center;width:96px;white-space:nowrap;">Questions</th><th style="padding:8px 8px;text-align:center;width:100px;white-space:nowrap;">Accuracy</th><th style="padding:8px 8px;text-align:center;width:96px;white-space:nowrap;line-height:1.1" title="'+escapeHtml(snapHeaderTitle)+'">'+snapHeader+'</th></tr></thead><tbody>'+
      sorted.map((r,i)=>{const u=r.u;const acc=r.accuracy||0;const col=acc>=80?'#22c55e':acc>=60?'#eab308':'#ef4444';const bg=acc>=80?'rgba(34,197,94,0.15)':acc>=60?'rgba(234,179,8,0.15)':'rgba(239,68,68,0.15)';const sCell=r.sessions===null?'—':(r.sessions||0);const snap=r.readinessSnap;const sScore=snap?snap.value:null;const sCol=sScore===null?'var(--text-muted)':sScore>=75?'#22c55e':sScore>=50?'#eab308':'#ef4444';const sBg=sScore===null?'rgba(255,255,255,0.05)':sScore>=75?'rgba(34,197,94,0.15)':sScore>=50?'rgba(234,179,8,0.15)':'rgba(239,68,68,0.15)';const isMeRow = u && u.uid === meUidForLeaderboard; const marginTxt = (isMeRow && myReadinessMargin > 0) ? ('<span style="font-weight:500;opacity:0.7;margin-left:2px">±'+myReadinessMargin+'</span>') : ''; const sText=sScore===null?'—':(sScore+'/100'+marginTxt);const sTitle=sScore===null?'No snapshot — complete at least one session on '+readinessExam:('Snapshot from '+snap.date+': '+sScore+'/100' + (isMeRow && myReadinessMargin > 0 ? ' (95% CI: '+Math.max(0,sScore-myReadinessMargin)+'–'+Math.min(100,sScore+myReadinessMargin)+')' : ''));return`<tr style="border-bottom:1px solid rgba(255,255,255,0.05)"><td style="padding:10px 4px">${medals[i]||(i+1)}</td><td style="padding:10px 8px;overflow:hidden;"><div style="font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(u.displayName||'Anonymous')}</div></td><td class="hide-on-mobile" style="padding:10px 8px;text-align:center;color:var(--text-secondary)">${sCell}</td><td class="hide-on-mobile" style="padding:10px 8px;text-align:center;color:var(--text-secondary)">${r.totalAnswered||0}</td><td style="padding:10px 8px;text-align:center"><span style="background:${bg};color:${col};padding:2px 6px;border-radius:99px;font-weight:700;font-size:0.8rem;">${acc}%</span></td><td style="padding:10px 8px;text-align:center" title="${escapeHtml(sTitle)}"><span style="background:${sBg};color:${sCol};padding:2px 6px;border-radius:99px;font-weight:700;font-size:0.8rem;">${sText}</span></td></tr>`;}).join('')+'</tbody></table></div>';
  }

  const { meRow, chartSource } = renderActivityCharts({
    range: adminChartRange,
    scope: adminChartScope,
    isFiltered,
    examFilter: isFiltered ? adminExam : null,
    users: adminUsers,
    currentUser,
    readinessExam,
    ids: { titleId:'adminChartTitle', noteId:'adminChartNote', barId:'adminActivityChart', timeId:'adminTimeChart', accuracyId:'adminAccuracyChart', readinessId:'adminReadinessChart', passId:'adminPassChart', leitnerBoxId:'adminLeitnerBoxChart', coverageId:'adminCoverageChart' },
    slots: adminSlots,
  });

  renderSessionQualityCards(chartSource, adminChartScope, isFiltered ? adminExam : null);
  renderCohortPercentile(adminUsers, adminChartScope, isFiltered ? adminExam : null);
  renderFocusAreas(isFiltered ? adminExam : null, adminChartScope, adminUsers);
  renderMasteryDistribution(isFiltered ? adminExam : null, adminChartScope, adminUsers);
  renderStudyInsights(isFiltered ? adminExam : null, adminChartScope);
  renderReadinessEta(readinessExam, meRow, adminChartScope, adminUsers);
  renderSpeedAccQuadrant(isFiltered ? adminExam : null, adminChartScope, adminUsers);
  renderHourOfDayStrip(adminChartScope, adminUsers);
  // Wrong-answer patterns now lives on My weak questions (renderWeakQList).
}
function calcUserStreak(ds){let s=0;const t=new Date();t.setUTCHours(0,0,0,0);for(let i=0;i<60;i++){const d=new Date(t);d.setUTCDate(t.getUTCDate()-i);if((ds[d.toISOString().slice(0,10)]||0)>=5)s++;else break;}return s;}

// Walk 14 days backward and emit {x, y} points using a day→value lookup.
// Days with no entry are emitted as null so drawSpark's filter skips them.
function _daySeries(map, days, project) {
  var pts = [];
  var today = new Date(); today.setUTCHours(0,0,0,0);
  for (var i = days - 1; i >= 0; i--) {
    var d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
    var k = d.toISOString().slice(0, 10);
    var raw = map ? map[k] : null;
    var y = project ? project(raw, k) : (raw != null ? Number(raw) : null);
    if (y == null || isNaN(y)) y = null;
    pts.push({ x: days - 1 - i, y: y });
  }
  return pts;
}
function _sumWindow(map, fromAgo, toAgo) {
  if (!map) return 0;
  var today = new Date(); today.setUTCHours(0,0,0,0);
  var sum = 0;
  for (var i = fromAgo; i < toAgo; i++) {
    var d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
    sum += Number(map[d.toISOString().slice(0, 10)]) || 0;
  }
  return sum;
}

// Coverage = unique questions touched / pool size for the given exam.
// Personal metric, derived from local store. Returns {pct, answered, pool, title}.
function computeCoverage(store, examFilter) {
  var answered = 0, pool = 0;
  try {
    var qstats = (store && store.questionStats) || {};
    var examCodes = examFilter
      ? [examFilter]
      : Object.keys((typeof S !== 'undefined' && S.db && S.db.exams) || {});
    examCodes.forEach(function(ec) {
      if (typeof isExamAvailable === 'function' && !isExamAvailable(ec)) return;
      var exPool = (typeof getPracticeQuestionPool === 'function')
        ? (getPracticeQuestionPool(ec) || []) : [];
      pool += exPool.length;
      exPool.forEach(function(q) {
        var key = (typeof getQuestionKey === 'function') ? getQuestionKey(q) : (q && q.id);
        var s = qstats[key];
        if (s && s.total > 0) answered++;
      });
    });
  } catch (_) {}
  var pct = pool > 0 ? Math.round((answered / pool) * 100) : null;
  var title = pool > 0
    ? 'Coverage: ' + answered + ' of ' + pool + ' unique questions answered' + (examFilter ? ' · ' + examFilter : '')
    : 'Coverage';
  return { pct: pct, answered: answered, pool: pool, title: title };
}

// Build a 14-day coverage % series from leitnerSnapshotByDay(ByExam).
// Each snapshot is either a number (total cards in Leitner that day) or
// an object {1: n, 2: n, …} (box bucket counts). Sum across boxes, divide
// by pool size, round to integer %.
function _coverageDaySeries(store, exam, pool) {
  if (!store || !pool) return [];
  var snapMap = (exam && store.leitnerSnapshotByDayByExam && store.leitnerSnapshotByDayByExam[exam])
    || store.leitnerSnapshotByDay
    || {};
  return _daySeries(snapMap, 14, function(snap) {
    if (!snap) return null;
    var seen = 0;
    if (typeof snap === 'number') seen = snap;
    else if (typeof snap === 'object') {
      Object.keys(snap).forEach(function(b) {
        var n = Number(snap[b]); if (!isNaN(n)) seen += n;
      });
    } else return null;
    return Math.round((seen / pool) * 100);
  });
}

// Populates the 3 sparkline+delta slots inside #adminSummary cards (rendered
// by renderAdminSummary). All series come from the local user store (the
// admin summary cards are scope-aware but sparklines are inherently personal
// — cohort-averaged daily series isn't worth the extra cohort sweep).
function populateAdminSummarySparks(opts) {
  if (typeof drawSpark !== 'function' || typeof setDelta !== 'function') return;
  opts = opts || {};
  var store = opts.store || {};
  var exam = opts.examFilter || null;
  var statsMap = (exam && store.dailyStatsByExam && store.dailyStatsByExam[exam]) || store.dailyStats || {};
  var correctMap = (exam && store.dailyCorrectByExam && store.dailyCorrectByExam[exam]) || store.dailyCorrect || {};

  // Answers — daily question count.
  drawSpark('admSparkAnswers', _daySeries(statsMap, 14), false);
  var ans7 = _sumWindow(statsMap, 0, 7);
  var ansPrev7 = _sumWindow(statsMap, 7, 14);
  setDelta('admDeltaAnswers', ans7, ansPrev7, '');
  var admAnsEl = $('admDeltaAnswers');
  if (admAnsEl) admAnsEl.title = 'Последние 7д: ' + ans7 + ' · Пред. 7д: ' + ansPrev7 + ' (ответов в сумме)';

  // Sessions — proxy: active days (≥1 answer = 1). Reuse dailyHasActivitySeries
  // but feed it dailyStatsByExam so it respects the exam filter.
  var sessionPts = _daySeries(statsMap, 14, function(v) { return v > 0 ? 1 : 0; });
  drawSpark('admSparkSessions', sessionPts, false);
  var sess7 = sessionPts.slice(7).reduce(function(a, p) { return a + (p.y || 0); }, 0);
  var sessPrev7 = sessionPts.slice(0, 7).reduce(function(a, p) { return a + (p.y || 0); }, 0);
  setDelta('admDeltaSessions', sess7, sessPrev7, ' d');
  var admSessEl = $('admDeltaSessions');
  if (admSessEl) admSessEl.title = 'Последние 7д: ' + sess7 + 'д активных · Пред. 7д: ' + sessPrev7 + 'д';

  // Accuracy — daily correct/total %.
  var accPts = _daySeries(statsMap, 14, function(total, k) {
    if (!total) return null;
    var c = Number(correctMap[k]) || 0;
    return Math.round((c / total) * 100);
  });
  drawSpark('admSparkAcc', accPts, true);
  if (typeof computeAccuracyWindowDeltas === 'function') {
    var ad = computeAccuracyWindowDeltas(store, exam);
    setDelta('admDeltaAcc', ad.last7, ad.prev7, '%');
    var admAccEl = $('admDeltaAcc');
    if (admAccEl) {
      var fmtAdmAcc = function(acc, total, correct) {
        return acc != null
          ? acc + '% (' + correct + '/' + total + ')'
          : (total > 0 ? correct + '/' + total : 'нет ответов');
      };
      admAccEl.title =
        'Последние 7д: ' + fmtAdmAcc(ad.last7, ad.last7Total, ad.last7Correct) +
        ' · Пред. 7д: ' + fmtAdmAcc(ad.prev7, ad.prev7Total, ad.prev7Correct);
    }
  }

  // Users sparkline (cohort scope, non-filtered) — no daily series available;
  // drawSpark on empty data shows the '14d trend' placeholder, which is fine.
  drawSpark('admSparkUsers', [], false);
  setDelta('admDeltaUsers', null, null, '');
}

// Renders the "Activity over N days" block: bar (Correct/Errors), Time (min),
// Accuracy (%), Readiness (/100). Shared by My-stats v1 (admin) and v3 sandbox.
// `slots` is mutated to track Chart instances (so re-renders can destroy first).
// Returns { meRow, meLocal, chartSource } for downstream callers.
function renderActivityCharts(opts) {
  const { range, scope, isFiltered, examFilter, users, currentUser, readinessExam, ids, slots } = opts;
  const rangeLen = range || 30;
  const days = Array.from({length:rangeLen},(_,i)=>{const d=new Date();d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-((rangeLen-1)-i));return d.toISOString().slice(0,10);});
  // Chart x-axis labels: ISO YYYY-MM-DD → "May-01" (short English month name).
  const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dayLabels = days.map(iso => {
    const p = iso.split('-');
    return _MONTHS[Number(p[1]) - 1] + '-' + p[2];
  });
  const titleEl = ids.titleId ? $(ids.titleId) : null;
  if (titleEl) titleEl.textContent = '📅 Activity over ' + rangeLen + (rangeLen===1?' day':' days');
  const meUid = currentUser && currentUser.uid;
  const meRow = scope === 'me' && meUid ? (users||[]).find(u => u.uid === meUid) : null;
  const meLocal = (scope === 'me' && !meRow) ? loadStore() : null;
  // For scope='me' we always merge local store on top of the cloud row so
  // newly-tracked fields (e.g. dailyAnswersByBox*) that aren't synced yet
  // still drive the per-day charts.
  const meLocalMerge = (scope === 'me') ? loadStore() : null;
  // For "me" scope: prefer local store for daily maps + sectionStats so the
  // numbers match Home V2 / Statistics (both read local directly). Cloud is
  // batched and stale on same-device after the most recent answers — using
  // it here was the cause of "72% vs 71%" discrepancy.
  const localHasData = (m) => m && Object.keys(m || {}).length > 0;
  const preferLocal = (cloudMap, localMap) => localHasData(localMap) ? localMap : (cloudMap || {});
  const chartSource = scope === 'me'
    ? (meRow ? [{
        ...meRow,
        dailyStats: preferLocal(meRow.dailyStats, meLocalMerge && meLocalMerge.dailyStats),
        dailyCorrect: preferLocal(meRow.dailyCorrect, meLocalMerge && meLocalMerge.dailyCorrect),
        dailyTimeMs: preferLocal(meRow.dailyTimeMs, meLocalMerge && meLocalMerge.dailyTimeMs),
        dailyStatsByExam: preferLocal(meRow.dailyStatsByExam, meLocalMerge && meLocalMerge.dailyStatsByExam),
        dailyCorrectByExam: preferLocal(meRow.dailyCorrectByExam, meLocalMerge && meLocalMerge.dailyCorrectByExam),
        dailyTimeMsByExam: preferLocal(meRow.dailyTimeMsByExam, meLocalMerge && meLocalMerge.dailyTimeMsByExam),
        sectionStats: preferLocal(meRow.sectionStats, meLocalMerge && meLocalMerge.sectionStats),
        leitnerSnapshotByDay: (meRow.leitnerSnapshotByDay && Object.keys(meRow.leitnerSnapshotByDay).length)
          ? meRow.leitnerSnapshotByDay
          : ((meLocalMerge && meLocalMerge.leitnerSnapshotByDay) || {}),
        leitnerSnapshotByDayByExam: (meRow.leitnerSnapshotByDayByExam && Object.keys(meRow.leitnerSnapshotByDayByExam).length)
          ? meRow.leitnerSnapshotByDayByExam
          : ((meLocalMerge && meLocalMerge.leitnerSnapshotByDayByExam) || {}),
      }] : (meLocal ? [{
        dailyStats: meLocal.dailyStats || {},
        dailyCorrect: meLocal.dailyCorrect || {},
        dailyTimeMs: meLocal.dailyTimeMs || {},
        dailyStatsByExam: meLocal.dailyStatsByExam || {},
        dailyCorrectByExam: meLocal.dailyCorrectByExam || {},
        dailyTimeMsByExam: meLocal.dailyTimeMsByExam || {},
        leitnerSnapshotByDay: meLocal.leitnerSnapshotByDay || {},
        leitnerSnapshotByDayByExam: meLocal.leitnerSnapshotByDayByExam || {},
        sessions: Metrics.getSessions(meLocal)
      }] : []))
    : (users || []);
  // When an exam tab is selected, read from per-exam daily maps; otherwise use globals.
  const pickDailyMap = (u, fieldGlobal, fieldByExam) => {
    if (examFilter) {
      const byExam = u[fieldByExam] || {};
      return byExam[examFilter] || {};
    }
    return u[fieldGlobal] || {};
  };
  const actCorrect = days.map(day=>chartSource.reduce((s,u)=>s+(pickDailyMap(u,'dailyCorrect','dailyCorrectByExam')[day]||0),0));
  const actWrong = days.map(day=>chartSource.reduce((s,u)=>s+(pickDailyMap(u,'dailyStats','dailyStatsByExam')[day]||0)-(pickDailyMap(u,'dailyCorrect','dailyCorrectByExam')[day]||0),0));
  const actAnswers = days.map((_,i)=>(actCorrect[i]||0)+(actWrong[i]||0));
  const actTimeMs = days.map(day=>chartSource.reduce((s,u)=>s+(pickDailyMap(u,'dailyTimeMs','dailyTimeMsByExam')[day]||0),0));
  const actTimeMin = actTimeMs.map(ms=>ms>0?Math.round(ms/6000)/10:null);
  // Detect "old data" case: per-exam mode chosen but no per-exam answers in range while global has some — means data predates per-exam tracking.
  let hasOldUntaggedData = false;
  if (examFilter) {
    const perExamTotal = actAnswers.reduce((a,b)=>a+b,0);
    const globalTotal = days.reduce((acc,day)=>acc+chartSource.reduce((s,u)=>s+((u.dailyStats||{})[day]||0),0),0);
    hasOldUntaggedData = perExamTotal === 0 && globalTotal > 0;
  }
  const note = ids.noteId ? $(ids.noteId) : null;
  if (note) {
    const noteParts = [];
    if (scope === 'me') {
      if (meRow) noteParts.push('Chart based on your answers (' + escapeHtml(meRow.displayName || meRow.email || 'you') + ').');
      else if (meLocal) noteParts.push('Chart based on your answers (local data).');
      else noteParts.push('No data for your profile.');
    }
    if (hasOldUntaggedData) noteParts.push('Per-exam history starts when you next answer in this exam.');
    note.textContent = noteParts.join(' ');
  }
  // Vertical gradient helper for bar/line fills. Mirrors the look of the
  // Mastery Distribution bars (richer top, fading bottom). Returns a Chart.js
  // scriptable that resolves to a CanvasGradient once chartArea exists.
  const mkVGrad = (top, bot, fallback) => (c) => {
    const a = c.chart.chartArea; if (!a) return fallback;
    const g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
    g.addColorStop(0, top); g.addColorStop(1, bot);
    return g;
  };
  if (slots.bar) { slots.bar.destroy(); slots.bar=null; }
  if (slots.accuracy) { slots.accuracy.destroy(); slots.accuracy=null; }
  if (slots.readiness) { slots.readiness.destroy(); slots.readiness=null; }
  if (slots.time) { slots.time.destroy(); slots.time=null; }
  if (slots.pass) { slots.pass.destroy(); slots.pass=null; }
  if (slots.leitnerBox) { slots.leitnerBox.destroy(); slots.leitnerBox=null; }
  if (slots.coverage) { slots.coverage.destroy(); slots.coverage=null; }
  // Belt-and-braces — also destroy any chart Chart.js still owns on each
  // canvas. Stats v2 reopens the same canvases multiple times per session
  // and a stale Chart instance on s2PassChart was leaking before this.
  Object.values(ids || {}).forEach(function(id) {
    if (!id) return;
    var c = document.getElementById(id);
    if (c && typeof Chart !== 'undefined' && Chart.getChart) {
      var existing = Chart.getChart(c);
      if (existing) existing.destroy();
    }
  });
  // Greedy left-to-right collision skip: at 60/90-day ranges bars are narrow
  // enough that adjacent labels (total count + accuracy %) overlap. Mirrors
  // the algorithm in linePointLabelsPlugin below — measure the widest of the
  // two stacked labels per bar, drop the bar's labels if they would crash
  // into the previously-drawn ones.
  const pctLabelsPlugin = {
    id: 'pctLabels',
    // Priority-based reservation (last + first first, then middles).
    // Each bar carries a 2-line label (total above pct). The shared
    // label width = max(total, pct). Greedy + GAP avoids horizontal
    // crashes; vertical stacking is fixed at -4 / -16 from bar top.
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const cMeta = chart.getDatasetMeta(0);
      const wMeta = chart.getDatasetMeta(1);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const GAP = 8;
      const candidates = [];
      const n = chart.data.labels.length;
      chart.data.labels.forEach((_, i) => {
        const c = actCorrect[i] || 0;
        const w = actWrong[i] || 0;
        const t = c + w;
        if (!t) return;
        const pct = Math.round(c / t * 100);
        const bar = wMeta.data[i] || cMeta.data[i];
        if (!bar) return;
        ctx.font = '500 10px system-ui,sans-serif';
        const wTotal = ctx.measureText(String(t)).width;
        ctx.font = '600 10px system-ui,sans-serif';
        const wPct = ctx.measureText(pct + '%').width;
        const labelW = Math.max(wTotal, wPct);
        const topY = Math.min(cMeta.data[i]?.y ?? Infinity, wMeta.data[i]?.y ?? Infinity);
        candidates.push({
          i, x: bar.x, topY, total: t, pct, w: labelW,
          left: bar.x - labelW / 2, right: bar.x + labelW / 2,
          priority: i === n - 1 ? 3 : (i === 0 ? 2 : 1),
        });
      });
      const reserved = [];
      const order = candidates.slice().sort((a, b) => b.priority - a.priority || a.i - b.i);
      for (const c of order) {
        const collides = reserved.some(r =>
          !(c.right + GAP < r.left || c.left - GAP > r.right)
        );
        if (!collides) reserved.push(c);
      }
      reserved.sort((a, b) => a.x - b.x);
      for (const c of reserved) {
        ctx.font = '500 10px system-ui,sans-serif';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(String(c.total), c.x, c.topY - 4);
        ctx.font = '600 10px system-ui,sans-serif';
        ctx.fillStyle = c.pct >= 70 ? '#22c55e' : c.pct >= 40 ? '#eab308' : '#ef4444';
        ctx.fillText(c.pct + '%', c.x, c.topY - 16);
      }
      ctx.restore();
    },
  };
  const barCanvas = ids.barId ? document.getElementById(ids.barId) : null;
  if (barCanvas) {
    slots.bar = new Chart(barCanvas.getContext('2d'),{type:'bar',data:{labels:dayLabels,datasets:[{label:'Correct',data:actCorrect,backgroundColor:mkVGrad('#818cf8','#4338ca','rgba(99,102,241,0.7)'),borderRadius:{topLeft:4,topRight:4}},{label:'Errors',data:actWrong,backgroundColor:mkVGrad('#fb7185','#be123c','rgba(244,63,94,0.5)'),borderRadius:{topLeft:4,topRight:4}}]},options:{responsive:true,maintainAspectRatio:false,layout:{padding:{top:36}},plugins:{legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:10},boxWidth:10,padding:8}}}, scales:{x:{stacked:true,ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{stacked:true,ticks:{color:'#94a3b8',font:{size:10}},grid:{color:'rgba(255,255,255,0.05)'}}}},plugins:[pctLabelsPlugin]});
  }
  const accPct = days.map((_,i)=>{const c=actCorrect[i]||0;const w=actWrong[i]||0;const t=c+w;return t>0?Math.round(c/t*100):null;});
  const accColors = accPct.map(p=>p===null?'rgba(148,163,184,0.4)':p>=70?'#22c55e':p>=40?'#eab308':'#ef4444');
  // Point labels with collision-avoidance: skip a label if it would overlap
  // the previous drawn label (greedy left-to-right). Used by accuracy /
  // readiness / pass / time line charts so wider ranges (30/60/90 d) stay
  // legible instead of mashing digits together.
  const linePointLabelsPlugin = (suffix) => ({
    id: 'linePointLabels_' + suffix,
    // Priority-based reservation: first + last + middle (in order),
    // skipping any candidate that would overlap an already-reserved
    // label. Matches the coverage chart so the last label can't sit
    // on top of nearby middle labels.
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = '600 10px system-ui,sans-serif';
      const GAP = 8;
      const data = chart.data.datasets[0].data;
      const colors = chart.data.datasets[0].pointBackgroundColor || [];
      const candidates = [];
      meta.data.forEach((pt, i) => {
        const v = data[i];
        if (v === null || v === undefined) return;
        const text = v + suffix;
        const w = ctx.measureText(text).width;
        const isLast = i === meta.data.length - 1;
        const isFirst = i === 0;
        candidates.push({
          i, x: pt.x, y: pt.y, text, w,
          left: pt.x - w / 2, right: pt.x + w / 2,
          color: colors[i] || '#94a3b8',
          priority: isLast ? 3 : (isFirst ? 2 : 1),
        });
      });
      const reserved = [];
      const order = candidates.slice().sort((a, b) => b.priority - a.priority || a.i - b.i);
      for (const c of order) {
        const collides = reserved.some(r =>
          !(c.right + GAP < r.left || c.left - GAP > r.right)
        );
        if (!collides) reserved.push(c);
      }
      reserved.sort((a, b) => a.x - b.x);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (const c of reserved) {
        ctx.fillStyle = c.color;
        ctx.fillText(c.text, c.x, c.y - 8);
      }
      ctx.restore();
    },
  });
  const timeCanvas = ids.timeId ? document.getElementById(ids.timeId) : null;
  if (timeCanvas) {
    const formatMs=(ms)=>{const tot=Math.round(ms/1000);const m=Math.floor(tot/60);const s=tot%60;return m>0?(m+' min '+s+' sec'):(s+' sec');};
    const timeColors=actTimeMin.map(v=>v===null?'rgba(148,163,184,0.4)':'rgba(56,189,248,0.85)');
    slots.time = new Chart(timeCanvas.getContext('2d'),{
      type:'line',
      data:{labels:dayLabels,datasets:[{label:'Time (min)',data:actTimeMin,borderColor:'rgba(56,189,248,0.85)',backgroundColor:mkVGrad('rgba(56,189,248,0.45)','rgba(56,189,248,0.02)','rgba(56,189,248,0.12)'),borderWidth:2,fill:true,tension:0.3,spanGaps:true,pointRadius:5,pointHoverRadius:7,pointBackgroundColor:timeColors,pointBorderColor:'rgba(15,23,42,0.9)',pointBorderWidth:2}]},
      plugins:[linePointLabelsPlugin('m')],
      options:{
        responsive:true,maintainAspectRatio:false,layout:{padding:{top:18}},
        plugins:{
          legend:{display:false},
          tooltip:{backgroundColor:'rgba(15,23,42,0.95)',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,padding:10,titleColor:'#e2e8f0',bodyColor:'#cbd5e1',displayColors:false,
            callbacks:{
              title:(items)=>days[items[0].dataIndex],
              label:(item)=>{const i=item.dataIndex;const ms=actTimeMs[i]||0;const ans=actAnswers[i]||0;if(!ms) return ans>0?'Time not recorded':'No answers';const lines=['Total: '+formatMs(ms)];if(ans>0){const avg=ms/ans/1000;lines.push('Avg per question: '+(avg<10?avg.toFixed(1):Math.round(avg))+' sec');}return lines;}
            }
          }
        },
        scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{min:0,ticks:{color:'#94a3b8',font:{size:10},callback:(v)=>v+'m'},grid:{color:'rgba(255,255,255,0.05)'}}}
      }
    });
  }
  const accCanvas = ids.accuracyId ? document.getElementById(ids.accuracyId) : null;
  if (accCanvas) {
    slots.accuracy = new Chart(accCanvas.getContext('2d'),{
      type:'line',
      data:{labels:dayLabels,datasets:[{label:'Accuracy',data:accPct,borderColor:'rgba(129,140,248,0.85)',backgroundColor:mkVGrad('rgba(129,140,248,0.45)','rgba(129,140,248,0.02)','rgba(129,140,248,0.12)'),borderWidth:2,fill:true,tension:0.3,spanGaps:true,pointRadius:5,pointHoverRadius:7,pointBackgroundColor:accColors,pointBorderColor:'rgba(15,23,42,0.9)',pointBorderWidth:2}]},
      plugins:[linePointLabelsPlugin('%')],
      options:{
        responsive:true,maintainAspectRatio:false,layout:{padding:{top:18}},
        plugins:{
          legend:{display:false},
          tooltip:{backgroundColor:'rgba(15,23,42,0.95)',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,padding:10,titleColor:'#e2e8f0',bodyColor:'#cbd5e1',displayColors:false,
            callbacks:{
              title:(items)=>{const i=items[0].dataIndex;return days[i];},
              label:(item)=>{const i=item.dataIndex;const c=actCorrect[i]||0;const w=actWrong[i]||0;const t=c+w;if(!t)return 'No answers';const pct=Math.round(c/t*100);return ['Accuracy: '+pct+'%','Answers: '+t+' (✓ '+c+' / ✗ '+w+')'];}
            }
          }
        },
        scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{min:0,max:100,ticks:{color:'#94a3b8',font:{size:10},callback:(v)=>v+'%',stepSize:25},grid:{color:'rgba(255,255,255,0.05)'}}}
      }
    });
  }
  const rdCanvas = ids.readinessId ? document.getElementById(ids.readinessId) : null;
  if (rdCanvas) {
    const localHist = loadReadinessHistory();
    const rdSeries = days.map(day => {
      if (scope === 'me') {
        const fromCloud = meRow && meRow.readinessDaily && meRow.readinessDaily[readinessExam] && meRow.readinessDaily[readinessExam][day];
        const fromLocal = localHist[readinessExam] && localHist[readinessExam][day];
        const v = fromCloud != null ? fromCloud : (fromLocal != null ? fromLocal : null);
        return v == null ? null : Number(v);
      }
      const vals = (users || [])
        .map(u => u.readinessDaily && u.readinessDaily[readinessExam] && u.readinessDaily[readinessExam][day])
        .filter(v => v != null && !isNaN(v))
        .map(Number);
      if (!vals.length) return null;
      return Math.round(vals.reduce((a,b)=>a+b,0) / vals.length);
    });
    const rdColors = rdSeries.map(p => p===null?'rgba(148,163,184,0.4)':p>=75?'#22c55e':p>=50?'#eab308':'#ef4444');
    slots.readiness = new Chart(rdCanvas.getContext('2d'), {
      type:'line',
      data:{labels:dayLabels,datasets:[{label:'Readiness',data:rdSeries,borderColor:'rgba(167,139,250,0.85)',backgroundColor:mkVGrad('rgba(167,139,250,0.45)','rgba(167,139,250,0.02)','rgba(167,139,250,0.12)'),borderWidth:2,fill:true,tension:0.3,spanGaps:true,pointRadius:5,pointHoverRadius:7,pointBackgroundColor:rdColors,pointBorderColor:'rgba(15,23,42,0.9)',pointBorderWidth:2}]},
      plugins:[linePointLabelsPlugin('')],
      options:{
        responsive:true,maintainAspectRatio:false,layout:{padding:{top:18}},
        plugins:{
          legend:{display:false},
          tooltip:{backgroundColor:'rgba(15,23,42,0.95)',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,padding:10,titleColor:'#e2e8f0',bodyColor:'#cbd5e1',displayColors:false,
            callbacks:{
              title:(items)=>days[items[0].dataIndex],
              label:(item)=>{const v=item.parsed.y;return v==null?'No snapshot':('Readiness: '+v+'/100');}
            }
          }
        },
        scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{min:0,max:100,ticks:{color:'#94a3b8',font:{size:10},callback:(v)=>v,stepSize:25},grid:{color:'rgba(255,255,255,0.05)'}}}
      }
    });
    // Pass-probability chart — reuses the just-built readiness series so it
    // shares dates, gaps, and cohort-vs-me filtering. Mapped through the
    // logistic in readinessEngine.passProbability(R).
    const passCanvas = ids.passId ? document.getElementById(ids.passId) : null;
    const passFn = window.readinessEngine && window.readinessEngine.passProbability;
    if (passCanvas && typeof passFn === 'function') {
      const passSeries = rdSeries.map(r => r == null ? null : Math.round(passFn(r) * 100));
      const passColors = passSeries.map(p => p === null ? 'rgba(148,163,184,0.4)' : p >= 70 ? '#22c55e' : p >= 40 ? '#eab308' : '#ef4444');
      slots.pass = new Chart(passCanvas.getContext('2d'), {
        type:'line',
        data:{labels:dayLabels,datasets:[{label:'Pass probability',data:passSeries,borderColor:'rgba(244,114,182,0.85)',backgroundColor:mkVGrad('rgba(244,114,182,0.45)','rgba(244,114,182,0.02)','rgba(244,114,182,0.12)'),borderWidth:2,fill:true,tension:0.3,spanGaps:true,pointRadius:5,pointHoverRadius:7,pointBackgroundColor:passColors,pointBorderColor:'rgba(15,23,42,0.9)',pointBorderWidth:2}]},
        plugins:[linePointLabelsPlugin('%')],
        options:{
          responsive:true,maintainAspectRatio:false,layout:{padding:{top:18}},
          plugins:{
            legend:{display:false},
            tooltip:{backgroundColor:'rgba(15,23,42,0.95)',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,padding:10,titleColor:'#e2e8f0',bodyColor:'#cbd5e1',displayColors:false,
              callbacks:{
                title:(items)=>days[items[0].dataIndex],
                label:(item)=>{const v=item.parsed.y;return v==null?'No snapshot':('Pass chance: '+v+'%');}
              }
            }
          },
          scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},y:{min:0,max:100,ticks:{color:'#94a3b8',font:{size:10},callback:(v)=>v+'%',stepSize:25},grid:{color:'rgba(255,255,255,0.05)'}}}
        }
      });
    }
  }
  // Per-day Leitner box distribution snapshot — same shape as the Mastery
  // Distribution panel, but a history. Snapshot recorded on each load and
  // after every updateLeitner; past days that weren't recorded stay empty.
  const leitnerBoxCanvas = ids.leitnerBoxId ? document.getElementById(ids.leitnerBoxId) : null;
  if (leitnerBoxCanvas) {
    const pickBox = (u, day) => {
      if (examFilter) return ((u.leitnerSnapshotByDayByExam || {})[examFilter] || {})[day] || {};
      return (u.leitnerSnapshotByDay || {})[day] || {};
    };
    // For 'all' scope we average across users with a snapshot for that day;
    // otherwise summing would inflate the apparent ladder size.
    const aggregateForDay = (day, box) => {
      if (scope === 'me') {
        return chartSource.reduce((s,u) => {
          const m = pickBox(u, day);
          return s + (m[box] || m[String(box)] || 0);
        }, 0);
      }
      const vals = chartSource
        .map(u => { const m = pickBox(u, day); return m[box] || m[String(box)] || 0; })
        .filter(v => v > 0);
      if (!vals.length) return 0;
      return Math.round(vals.reduce((a,b)=>a+b,0) / vals.length);
    };
    const boxSeries = [1,2,3,4,5].map(b => days.map(day => aggregateForDay(day, b)));
    const boxColors = ['#ef4444','#f97316','#eab308','#84cc16','#22c55e'];
    const boxLabels = [
      'Box 1 — fresh / failed',
      'Box 2 — +3 d',
      'Box 3 — +7 d',
      'Box 4 — +14 d',
      'Box 5 — mastered',
    ];
    const leitnerBoxLabelsPlugin = {
      id: 'leitnerBoxLabels',
      // Priority-based reservation for top-total labels (last + first
      // + middles in order, no overlap). Per-segment labels keep their
      // self-guard via segH >= 12.
      afterDatasetsDraw(chart) {
        const ctx = chart.ctx;
        const metas = [0,1,2,3,4].map(i => chart.getDatasetMeta(i));
        const n = (chart.data.labels || []).length;
        ctx.save();
        ctx.textAlign = 'center';
        // First pass: draw per-segment labels (they don't collide with
        // each other — they're stacked vertically per bar) and collect
        // top-total candidates.
        const candidates = [];
        for (let i = 0; i < n; i++) {
          let total = 0;
          let mastered = 0;
          let box1 = 0;
          let topY = Infinity;
          let topBar = null;
          for (let d = 0; d < 5; d++) {
            const v = (chart.data.datasets[d].data[i] || 0);
            total += v;
            if (d === 0) box1 = v;            // Box 1 — fresh/failed
            if (d >= 3) mastered += v;        // Box 4 + Box 5 → mastered
            const bar = metas[d] && metas[d].data && metas[d].data[i];
            if (!bar || v <= 0) continue;
            if (bar.y < topY) { topY = bar.y; topBar = bar; }
            const segH = Math.abs(bar.base - bar.y);
            if (segH >= 12) {
              ctx.font = '600 9px system-ui,sans-serif';
              ctx.fillStyle = 'rgba(15,23,42,0.92)';
              ctx.textBaseline = 'middle';
              ctx.fillText(String(v), bar.x, (bar.y + bar.base) / 2);
            }
          }
          if (total > 0 && topBar) {
            ctx.font = '600 10px system-ui,sans-serif';
            const labelW = ctx.measureText(String(total)).width;
            candidates.push({
              i, x: topBar.x, topY, total, w: labelW,
              masteryPct: Math.round(mastered / total * 100),
              box1Pct: Math.round(box1 / total * 100),
              left: topBar.x - labelW / 2, right: topBar.x + labelW / 2,
              priority: i === n - 1 ? 3 : (i === 0 ? 2 : 1),
            });
          }
        }
        // Second pass: reserve high-priority candidates first.
        const GAP = 8;
        const reserved = [];
        const order = candidates.slice().sort((a, b) => b.priority - a.priority || a.i - b.i);
        for (const c of order) {
          const collides = reserved.some(r =>
            !(c.right + GAP < r.left || c.left - GAP > r.right)
          );
          if (!collides) reserved.push(c);
        }
        ctx.font = '600 10px system-ui,sans-serif';
        ctx.fillStyle = '#cbd5e1';
        ctx.textBaseline = 'bottom';
        for (const c of reserved) {
          ctx.fillText(String(c.total), c.x, c.topY - 4);
        }
        // Third pass: mastery % + Box 1 % above the total. Format "43% / 10%"
        // — mastery (boxes 4+5) in green, Box 1 (fresh/failed) in red.
        // Same mastery formula as Statistics page "% MASTERED" card.
        ctx.font = '500 9px system-ui,sans-serif';
        ctx.textBaseline = 'bottom';
        const SEP = ' / ';
        for (const c of reserved) {
          const mStr = c.masteryPct + '%';
          const b1Str = c.box1Pct + '%';
          const wM = ctx.measureText(mStr).width;
          const wS = ctx.measureText(SEP).width;
          const wB = ctx.measureText(b1Str).width;
          const wTotal = wM + wS + wB;
          const startX = c.x - wTotal / 2;
          const y = c.topY - 4 - 12;
          ctx.textAlign = 'left';
          ctx.fillStyle = 'rgba(134, 239, 172, 0.85)';
          ctx.fillText(mStr, startX, y);
          ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
          ctx.fillText(SEP, startX + wM, y);
          ctx.fillStyle = 'rgba(248, 113, 113, 0.85)';
          ctx.fillText(b1Str, startX + wM + wS, y);
        }
        ctx.restore();
      },
    };
    slots.leitnerBox = new Chart(leitnerBoxCanvas.getContext('2d'), {
      type:'bar',
      data:{
        labels:dayLabels,
        datasets: boxSeries.map((data,i) => ({
          label: boxLabels[i],
          data,
          backgroundColor: boxColors[i],
          borderRadius: i===4 ? {topLeft:4,topRight:4} : 0,
          stack:'boxes',
        })),
      },
      plugins:[leitnerBoxLabelsPlugin],
      options:{
        responsive:true, maintainAspectRatio:false,
        layout:{ padding:{ top:32 } },
        plugins:{
          legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:10},boxWidth:10,padding:8}},
          tooltip:{
            backgroundColor:'rgba(15,23,42,0.95)',borderColor:'rgba(255,255,255,0.1)',borderWidth:1,
            padding:10,titleColor:'#e2e8f0',bodyColor:'#cbd5e1',
            callbacks:{
              title:(items)=>days[items[0].dataIndex],
              footer:(items)=>{const tot=items.reduce((a,b)=>a+(b.parsed.y||0),0);return tot?'Total: '+tot:'';},
            },
          },
        },
        scales:{
          x:{stacked:true,ticks:{color:'#94a3b8',font:{size:10}},grid:{display:false}},
          y:{stacked:true,beginAtZero:true,ticks:{color:'#94a3b8',font:{size:10},precision:0},grid:{color:'rgba(255,255,255,0.05)'}},
        },
      },
    });
  }
  // Cumulative "Questions seen" + coverage % vs the exam pool.
  // Primary source: leitnerSnapshotByDay totals (sum of boxes 1-5 = unique qids
  // ever answered up to that day) — accurate where present.
  // Backfill: for days without a snapshot, count questionStats[qid] with
  // lastSeen <= day_end. Underestimates old days (spaced-repetition revisits
  // push lastSeen forward) but gives a monotonic curve. Snapshot wins when
  // both are available; cumulative count is clamped non-decreasing.
  const coverageCanvas = ids.coverageId ? document.getElementById(ids.coverageId) : null;
  if (coverageCanvas) {
    const sumBoxes = (m) => (m[1]||m['1']||0)+(m[2]||m['2']||0)+(m[3]||m['3']||0)+(m[4]||m['4']||0)+(m[5]||m['5']||0);
    const pickSnaps = (u) => examFilter
      ? ((u.leitnerSnapshotByDayByExam || {})[examFilter] || {})
      : (u.leitnerSnapshotByDay || {});
    // Backfill source — only meaningful for 'me' scope (per-user state).
    let qsForBackfill = null;
    if (scope === 'me') {
      try {
        const localStore = loadStore();
        qsForBackfill = (localStore && localStore.questionStats) || null;
      } catch (_) {}
    }
    const backfillForDay = (dayISO) => {
      if (!qsForBackfill) return 0;
      const dayEnd = new Date(dayISO + 'T23:59:59.999').getTime();
      if (isNaN(dayEnd)) return 0;
      let count = 0;
      Object.values(qsForBackfill).forEach(s => {
        if (!s || typeof s !== 'object') return;
        if (!s.lastSeen || s.lastSeen > dayEnd) return;
        if (!(s.total > 0)) return;
        if (examFilter && s.exam !== examFilter) return;
        count++;
      });
      return count;
    };
    // Seed: latest snapshot total strictly before the range starts, OR the
    // backfill estimate for the day before the range — whichever is bigger.
    const seedPerUser = (chartSource || []).map(u => {
      const snaps = pickSnaps(u);
      const before = Object.keys(snaps).filter(d => d < days[0]).sort();
      if (!before.length) return 0;
      return sumBoxes(snaps[before[before.length - 1]] || {});
    });
    let aggregateSeed = scope === 'me'
      ? seedPerUser.reduce((a,b)=>a+b, 0)
      : (function(){ const v = seedPerUser.filter(x => x > 0); return v.length ? Math.round(v.reduce((a,b)=>a+b,0)/v.length) : 0; })();
    if (qsForBackfill && days.length) {
      const dayBefore = new Date(days[0] + 'T00:00:00Z');
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      const bfSeed = backfillForDay(dayBefore.toISOString().slice(0, 10));
      if (bfSeed > aggregateSeed) aggregateSeed = bfSeed;
    }
    const rawTotals = days.map(day => {
      const perUser = (chartSource || []).map(u => sumBoxes(pickSnaps(u)[day] || {}));
      if (scope === 'me') return perUser.reduce((a,b)=>a+b, 0);
      const v = perUser.filter(x => x > 0);
      if (!v.length) return 0;
      return Math.round(v.reduce((a,b)=>a+b,0) / v.length);
    });
    // Per-day pick: snapshot wins when present (matches Mastery distribution
    // exactly). Backfill is a fallback ONLY for days without a snapshot.
    // questionStats overcounts (anything clicked) vs Leitner (only scheduled-
    // review questions), so cap backfill at the latest snapshot value —
    // cumulative seen can never exceed today's Leitner total. Monotonic
    // clamp keeps the curve non-decreasing across mixed-source days.
    let latestSnapshot = aggregateSeed;
    for (let i = rawTotals.length - 1; i >= 0; i--) {
      if (rawTotals[i] > 0) { latestSnapshot = rawTotals[i]; break; }
    }
    const cap = latestSnapshot > 0 ? latestSnapshot : Infinity;
    let lastVal = Math.min(aggregateSeed, cap);
    const seenSeries = rawTotals.map((v, i) => {
      const dayVal = v > 0 ? v : Math.min(backfillForDay(days[i]), cap);
      const best = Math.max(dayVal, lastVal);
      lastVal = best;
      return best;
    });
    // Exam total pool (denominator). examFilter = single exam; otherwise sum across all available exams.
    let examTotal = 0;
    if (typeof S !== 'undefined' && S && S.db && S.db.exams) {
      const keys = examFilter ? [examFilter] : Object.keys(S.db.exams);
      keys.forEach(code => { try { examTotal += getAllExamQuestions(code).length; } catch (_) {} });
    }
    const coverageSeries = seenSeries.map(v => examTotal > 0 ? Math.round(v / examTotal * 1000) / 10 : 0);
    // Inline labels above the cumulative line — show value only on points
    // where the count actually grew, plus first + last, so the curve isn't
    // cluttered when forward-fill repeats values across idle days.
    //
    // Algorithm: priority-based reservation, NOT greedy left-to-right.
    // Last label has highest priority (it's "today" — most actionable),
    // then first (start of range), then change-points in time order.
    // Each is added only if it doesn't overlap any already-reserved slot.
    // This prevents the previous bug where the always-drawn last label
    // sat on top of nearby change-points (visible as "853 87187(7)" mash
    // at the right edge of long ranges).
    const coverageLabelsPlugin = {
      id: 'coverageLabels',
      afterDatasetsDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data || !meta.data.length) return;
        const data = chart.data.datasets[0].data || [];
        const ctx = chart.ctx;
        ctx.save();
        ctx.font = '600 10px system-ui,sans-serif';
        const GAP = 8;
        // Step 1: gather candidates (change-points + first/last only).
        const candidates = [];
        for (let i = 0; i < meta.data.length; i++) {
          const v = data[i];
          if (v == null) continue;
          const prev = i > 0 ? data[i - 1] : null;
          const isLast = i === meta.data.length - 1;
          const isFirst = i === 0;
          if (!isFirst && !isLast && prev != null && v === prev) continue;
          const point = meta.data[i];
          if (!point) continue;
          const text = String(v);
          const w = ctx.measureText(text).width;
          candidates.push({
            i, v, x: point.x, y: point.y, text, w,
            left: point.x - w / 2, right: point.x + w / 2,
            priority: isLast ? 3 : (isFirst ? 2 : 1),
          });
        }
        // Step 2: reserve highest-priority candidates that don't collide.
        const reserved = [];
        const order = candidates.slice().sort((a, b) => b.priority - a.priority || a.i - b.i);
        for (const c of order) {
          const collides = reserved.some(r =>
            !(c.right + GAP < r.left || c.left - GAP > r.right)
          );
          if (!collides) reserved.push(c);
        }
        // Step 3: draw in time order so visual stacking is natural.
        reserved.sort((a, b) => a.x - b.x);
        ctx.fillStyle = '#e2e8f0';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        for (const c of reserved) {
          ctx.fillText(c.text, c.x, c.y - 6);
        }
        // Step 4: day-over-day delta labels above the value (dim, smaller).
        // Shows "+N" for days where the cumulative count grew from yesterday.
        ctx.font = '500 9px system-ui,sans-serif';
        ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
        for (const c of reserved) {
          if (c.i === 0) continue;
          const prev = data[c.i - 1];
          if (prev == null) continue;
          const delta = c.v - prev;
          if (delta <= 0) continue;
          ctx.fillText('+' + delta, c.x, c.y - 6 - 12);
        }
        ctx.restore();
      },
    };
    slots.coverage = new Chart(coverageCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: dayLabels,
        datasets: [
          {
            label: 'Questions seen (cumulative)',
            data: seenSeries,
            borderColor: '#06b6d4',
            backgroundColor: 'rgba(6, 182, 212, 0.18)',
            yAxisID: 'y',
            tension: 0.3,
            fill: true,
            pointRadius: 2,
            pointHoverRadius: 4,
            borderWidth: 2,
          },
          {
            label: 'Coverage % of ' + (examTotal || '?'),
            data: coverageSeries,
            borderColor: '#a855f7',
            backgroundColor: 'rgba(168, 85, 247, 0)',
            yAxisID: 'y1',
            tension: 0.3,
            borderDash: [4, 4],
            pointRadius: 0,
            borderWidth: 2,
            fill: false,
          },
        ],
      },
      plugins: [coverageLabelsPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 18 } },
        plugins: {
          legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 10, padding: 8 } },
          tooltip: {
            backgroundColor: 'rgba(15,23,42,0.95)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
            padding: 10, titleColor: '#e2e8f0', bodyColor: '#cbd5e1',
            callbacks: {
              title: (items) => days[items[0].dataIndex],
              label: (ctx) => {
                if (ctx.dataset.yAxisID === 'y1') return ' Coverage: ' + ctx.parsed.y + '%';
                const denom = examTotal > 0 ? (' / ' + examTotal) : '';
                return ' Seen: ' + ctx.parsed.y + denom;
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } },
          y: {
            position: 'left', beginAtZero: true,
            ticks: { color: '#06b6d4', font: { size: 10 }, precision: 0 },
            grid: { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: 'Questions', color: '#06b6d4', font: { size: 10 } },
          },
          y1: {
            position: 'right', beginAtZero: true, max: 100,
            ticks: { color: '#a855f7', font: { size: 10 }, callback: (v) => v + '%' },
            grid: { display: false },
            title: { display: true, text: 'Coverage %', color: '#a855f7', font: { size: 10 } },
          },
        },
      },
    });
  }
  return { meRow, meLocal, chartSource };
}

// ── Phase 1 analytics widgets ─────────────────────────────────

function renderSessionQualityCards(source, scope, examFilter) {
  const el = $('adminSessionQuality');
  if (!el) return;
  let totalSessions = 0, totalAnswered = 0, totalTimeMs = 0;
  let crossExamAnswered = 0;
  source.forEach(u => {
    totalSessions += u.sessions || 0;
    if (examFilter) {
      const dsByExam = (u.dailyStatsByExam && u.dailyStatsByExam[examFilter]) || {};
      Object.values(dsByExam).forEach(v => { totalAnswered += Number(v) || 0; });
      const dtByExam = (u.dailyTimeMsByExam && u.dailyTimeMsByExam[examFilter]) || {};
      Object.values(dtByExam).forEach(v => { totalTimeMs += Number(v) || 0; });
      // For exam-filtered view we don't have per-exam session counts in the
      // store, so estimate sessions proportionally to the exam's share of
      // total answers. Track cross-exam total so we can compute the ratio
      // once the loop is done.
      const ds = u.dailyStats || {};
      Object.values(ds).forEach(v => { crossExamAnswered += Number(v) || 0; });
    } else {
      const ds = u.dailyStats || {};
      Object.values(ds).forEach(v => { totalAnswered += Number(v) || 0; });
      const dt = u.dailyTimeMs || {};
      Object.values(dt).forEach(v => { totalTimeMs += Number(v) || 0; });
    }
  });
  // Scale sessions to the exam's share of answers (best-effort estimate —
  // store has no per-exam session field).
  if (examFilter && crossExamAnswered > 0 && totalSessions > 0) {
    totalSessions = Math.max(1, Math.round(totalSessions * (totalAnswered / crossExamAnswered)));
  } else if (examFilter && crossExamAnswered === 0) {
    totalSessions = 0;
  }
  if (!totalSessions && !totalTimeMs) { el.innerHTML = ''; return; }
  const avgQ = totalSessions ? Math.round(totalAnswered / totalSessions) : '—';
  // Avg time / question: total time across all attempts ÷ total
  // questions answered. Easier to compare to your gut sense ("am I
  // taking too long per question?") than a session-average that mixes
  // short Daily-question dips with full Mock exams.
  const avgSecPerQ = totalAnswered && totalTimeMs
    ? Math.round((totalTimeMs / totalAnswered) / 1000)
    : null;
  const formatAvgQTime = (sec) => {
    if (sec === null) return '—';
    if (sec >= 60) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    return sec + 's';
  };
  const totalHours = totalTimeMs ? (Math.round(totalTimeMs / 360000) / 10) : 0;
  const scopeNote = (scope === 'me' ? 'you' : 'all users') + (examFilter ? ' · ' + examFilter : '');
  // Coverage = unique questions touched / pool size. Personal metric.
  // Shared helper — same calc is reused on Statistics v2's Coverage card.
  const _localStoreCov = (typeof loadStore === 'function') ? loadStore() : null;
  const cov = computeCoverage(_localStoreCov, examFilter);
  const covPct = cov.pct;
  const covPool = cov.pool;
  const covVal = covPct === null ? '—' : (covPct + '%');
  const covTitle = cov.title;
  // Dropped 'Avg Q / session' — duplicated info with the seconds-per-
  // question card and the latter is what the user actually asks: "am I
  // taking too long per question?". Keep secs-per-q + total-practice.
  const cards = [
    { label: 'Avg time / question', val: formatAvgQTime(avgSecPerQ), sub: scopeNote, sparkId: 'admSparkAvgTime',  deltaId: 'admDeltaAvgTime' },
    { label: 'Total practice',      val: totalHours + 'h',           sub: scopeNote, sparkId: 'admSparkPractice', deltaId: 'admDeltaPractice' },
    { label: 'Coverage',            val: covVal,                     sub: scopeNote, sparkId: 'admSparkCoverage', deltaId: 'admDeltaCoverage', titleOverride: covTitle },
  ];
  el.innerHTML = cards.map(c => {
    const titleText = c.titleOverride || (c.label + ' (' + c.sub + ')');
    return `<div class="s2-kpi" title="${escapeHtml(titleText)}">
      <div class="s2-kpi-label">${escapeHtml(c.label)}</div>
      <div class="s2-kpi-row">
        <div class="s2-kpi-val">${c.val}</div>
        <div class="s2-kpi-delta is-flat" id="${c.deltaId}"></div>
      </div>
      <div class="s2-kpi-spark" id="${c.sparkId}"></div>
    </div>`;
  }).join('');
  try {
    populateSessionQualitySparks({
      examFilter: examFilter || null,
      store: (typeof loadStore === 'function') ? loadStore() : null,
      covPool: covPool,
    });
  } catch (e) { console.warn('populateSessionQualitySparks failed', e); }
}

// Populates Avg time / Total practice / Coverage spark+delta slots.
// Uses the same 14d window pattern as populateAdminSummarySparks.
function populateSessionQualitySparks(opts) {
  if (typeof drawSpark !== 'function' || typeof setDelta !== 'function') return;
  opts = opts || {};
  var store = opts.store || {};
  var exam = opts.examFilter || null;
  var covPool = Number(opts.covPool) || 0;
  var tMap = (exam && store.dailyTimeMsByExam && store.dailyTimeMsByExam[exam]) || store.dailyTimeMs || {};
  var sMap = (exam && store.dailyStatsByExam && store.dailyStatsByExam[exam]) || store.dailyStats || {};

  // Avg time / question — daily sec/Q.
  var avgPts = _daySeries(sMap, 14, function(total, k) {
    if (!total) return null;
    var ms = Number(tMap[k]) || 0;
    if (!ms) return null;
    return Math.round(ms / total / 1000);
  });
  drawSpark('admSparkAvgTime', avgPts, false);
  function _avgSecPerQ(fromAgo, toAgo) {
    var msSum = _sumWindow(tMap, fromAgo, toAgo);
    var qSum = _sumWindow(sMap, fromAgo, toAgo);
    if (!qSum || !msSum) return null;
    return Math.round(msSum / qSum / 1000);
  }
  var t7 = _avgSecPerQ(0, 7);
  var tPrev7 = _avgSecPerQ(7, 14);
  // Intentional swap: less seconds = faster = good → ▲ +Ns.
  setDelta('admDeltaAvgTime', tPrev7, t7, 's');

  // Total practice — daily minutes.
  var practicePts = _daySeries(tMap, 14, function(ms) {
    if (!ms) return null;
    return Math.round(Number(ms) / 60000);
  });
  drawSpark('admSparkPractice', practicePts, false);
  var min7 = Math.round(_sumWindow(tMap, 0, 7) / 60000);
  var minPrev7 = Math.round(_sumWindow(tMap, 7, 14) / 60000);
  setDelta('admDeltaPractice', min7, minPrev7, 'm');

  // Coverage — daily snapshot from leitnerSnapshotByDay(ByExam). Same
  // calc reused on Statistics v2 via _coverageDaySeries.
  var covPts = _coverageDaySeries(store, exam, covPool);
  drawSpark('admSparkCoverage', covPts, true);
  var covVals = covPts.filter(function(p) { return p.y != null; });
  if (covVals.length >= 2) {
    var lastCov = covVals[covVals.length - 1].y;
    var weekAgoCov = covVals[Math.max(0, covVals.length - 8)].y;
    setDelta('admDeltaCoverage', lastCov, weekAgoCov, '%');
  } else {
    setDelta('admDeltaCoverage', null, null, '');
  }
}

function renderCohortPercentile(allUsers, scope, examFilter) {
  const el = $('adminCohortBanner');
  if (!el) return;
  el.innerHTML = '';
  if (scope !== 'all') return;
  if (!currentUser || !currentUser.uid) return;
  const me = allUsers.find(u => u.uid === currentUser.uid);
  if (!me) return;
  const peers = allUsers.map(u => {
    if (examFilter) {
      const s = getExamUserStats(u, examFilter);
      return { uid: u.uid, accuracy: s.accuracy || 0, total: s.total || 0 };
    }
    return { uid: u.uid, accuracy: u.accuracy || 0, total: u.totalAnswered || 0 };
  }).filter(p => p.total >= 10);
  if (peers.length < 2) return;
  const myRow = peers.find(p => p.uid === currentUser.uid);
  if (!myRow) return;
  const sorted = [...peers].sort((a, b) => b.accuracy - a.accuracy);
  const rank = sorted.findIndex(p => p.uid === currentUser.uid) + 1;
  const pct = Math.round((1 - (rank - 1) / sorted.length) * 100);
  const tier = pct >= 75 ? 'top' : pct >= 50 ? 'upper' : pct >= 25 ? 'lower' : 'bottom';
  const color = pct >= 75 ? '#22c55e' : pct >= 50 ? '#eab308' : '#ef4444';
  const bg = pct >= 75 ? 'rgba(34,197,94,0.12)' : pct >= 50 ? 'rgba(234,179,8,0.12)' : 'rgba(239,68,68,0.12)';
  const examLabel = examFilter ? (' on ' + escapeHtml(examFilter)) : '';
  el.innerHTML = `<div style="background:${bg};border:1px solid ${color}33;border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <div style="font-size:1.6rem">📊</div>
    <div style="flex:1;min-width:200px">
      <div style="font-weight:700;color:${color};font-size:0.95rem">Top ${100 - pct + 1}% — ${tier} tier</div>
      <div style="font-size:0.78rem;color:var(--text-muted)">Your accuracy ${myRow.accuracy}%${examLabel}, rank ${rank} of ${sorted.length} (≥10 answers)</div>
    </div>
  </div>`;
}

function renderFocusAreas(examFilter, scope, allUsers) {
  const panel = $('adminFocusPanel');
  const el = $('adminFocus');
  if (!panel || !el) return;
  const titleEl = panel.querySelector('.section-label');
  const isAll = scope === 'all';
  const merged = {};
  const sources = isAll
    ? (allUsers || []).map(u => u.sectionStats || {})
    : [loadStore().sectionStats || {}];
  sources.forEach(stats => {
    Object.entries(stats).forEach(([key, v]) => {
      if (!v || typeof v !== 'object') return;
      if (!merged[key]) merged[key] = { label: v.label || '', total: 0, correct: 0 };
      merged[key].total += Number(v.total) || 0;
      merged[key].correct += Number(v.correct) || 0;
      if (!merged[key].label && v.label) merged[key].label = v.label;
    });
  });
  const minSamples = isAll ? 20 : 5;
  const rows = Object.entries(merged).map(([key, v]) => {
    const sep = key.indexOf('__');
    const exam = sep >= 0 ? key.slice(0, sep) : '';
    const sectionKey = sep >= 0 ? key.slice(sep + 2) : key;
    return {
      key, exam, sectionKey,
      label: v.label || (typeof getSectionLabel === 'function' ? getSectionLabel(exam, sectionKey) : sectionKey),
      total: v.total || 0,
      correct: v.correct || 0,
      accuracy: v.total > 0 ? Math.round((v.correct / v.total) * 100) : 0,
    };
  }).filter(r => r.total >= minSamples && (!examFilter || r.exam === examFilter));
  if (titleEl) titleEl.textContent = isAll
    ? '🎯 Focus areas — cohort weakest sections (all users)'
    : '🎯 Focus areas — your weakest sections';
  if (rows.length < 2) { panel.style.display = 'none'; return; }
  rows.sort((a, b) => a.accuracy - b.accuracy);
  panel.style.display = '';
  el.innerHTML = rows.map(r => {
    const col = r.accuracy >= 70 ? '#22c55e' : r.accuracy >= 40 ? '#eab308' : '#ef4444';
    const bg = r.accuracy >= 70 ? 'rgba(34,197,94,0.15)' : r.accuracy >= 40 ? 'rgba(234,179,8,0.15)' : 'rgba(239,68,68,0.15)';
    const examTag = examFilter ? '' : ` <span style="color:var(--text-muted);font-size:0.7rem;margin-left:6px">${escapeHtml(r.exam)}</span>`;
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);margin-bottom:8px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.label)}${examTag}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">${r.correct}/${r.total} correct</div>
      </div>
      <div style="width:120px;height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden">
        <div style="width:${r.accuracy}%;height:100%;background:${col}"></div>
      </div>
      <span style="background:${bg};color:${col};padding:2px 8px;border-radius:99px;font-weight:700;font-size:0.78rem;min-width:48px;text-align:center">${r.accuracy}%</span>
    </div>`;
  }).join('') + `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:8px">Sections with ≥${minSamples} ${isAll ? 'cohort answers' : 'answers'}, sorted by lowest accuracy.${isAll ? ' Indicates where the group struggles most — useful for spotting hard topics.' : ' Drill these to lift overall readiness.'}</div>`;
}

function renderMasteryDistribution(examFilter, scope, allUsers) {
  const panel = $('adminMasteryPanel');
  const el = $('adminMastery');
  const sub = $('adminMasterySubtitle');
  const titleEl = panel ? panel.querySelector('.section-label') : null;
  if (!panel || !el) return;
  const isAll = scope === 'all';
  const buckets = [0, 0, 0, 0, 0];
  let totalSeen = 0;
  if (isAll) {
    (allUsers || []).forEach(u => {
      const lt = u.leitner || {};
      Object.entries(lt).forEach(([qkey, info]) => {
        if (!info || typeof info !== 'object') return;
        if (examFilter && info.exam && info.exam !== examFilter) return;
        const box = Number(info.box) || 0;
        if (box >= 1 && box <= 5) { buckets[box - 1] += 1; totalSeen += 1; }
      });
    });
  } else {
    const store = loadStore();
    const leitner = store.leitner || {};
    const qs = store.questionStats || {};
    Object.entries(leitner).forEach(([qkey, info]) => {
      if (!info || typeof info !== 'object') return;
      if (examFilter) {
        const qInfo = qs[qkey];
        const exam = (qInfo && qInfo.exam) || info.exam;
        if (exam !== examFilter) return;
      }
      const box = Number(info.box) || 0;
      if (box >= 1 && box <= 5) { buckets[box - 1] += 1; totalSeen += 1; }
    });
  }
  if (titleEl) titleEl.textContent = isAll ? '🧠 Mastery distribution (all users)' : '🧠 Mastery distribution';
  if (totalSeen < 3) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  if (sub) sub.textContent = isAll
    ? `Cohort total — questions across all users on the 1→5 spaced-repetition ladder${examFilter ? ' (' + examFilter + ')' : ' (all exams)'}.`
    : `Where your seen questions sit on the 1→5 spaced-repetition ladder${examFilter ? ' (' + examFilter + ')' : ' (all exams)'}.`;
  const max = Math.max(...buckets, 1);
  const labels = ['1 — review tomorrow', '2 — +3 days', '3 — +7 days', '4 — +14 days', '5 — mastered (+30 d)'];
  const colors = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];
  const bars = buckets.map((cnt, i) => {
    const w = Math.round((cnt / max) * 100);
    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <div style="width:160px;font-size:0.82rem;color:var(--text-secondary)">Box ${escapeHtml(labels[i])}</div>
      <div style="flex:1;height:22px;background:rgba(255,255,255,0.05);border-radius:6px;overflow:hidden"><div style="width:${w}%;height:100%;background:${colors[i]};opacity:0.9"></div></div>
      <div style="width:48px;text-align:right;font-weight:700;color:var(--text-primary);font-size:0.9rem">${cnt}</div>
    </div>`;
  }).join('');
  const masteredPct = totalSeen ? Math.round((buckets[3] + buckets[4]) / totalSeen * 100) : 0;
  const cohortNote = isAll ? ' across all users' : '';
  el.innerHTML = bars +
    `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:10px">${buckets[3] + buckets[4]} of ${totalSeen} questions in boxes 4-5${cohortNote} (<strong style="color:var(--text-primary)">${masteredPct}%</strong> on path to mastery).</div>`;
}

function renderStudyInsights(examFilter, scope, ids) {
  const panelId = (ids && ids.panelId) || 'adminStudyInsightsPanel';
  const bodyId = (ids && ids.bodyId) || 'adminStudyInsights';
  const panel = $(panelId);
  const el = $(bodyId);
  if (!panel || !el) return;
  // Only meaningful in personal scope — cohort numbers don't translate to personal advice.
  if (scope === 'all') { panel.style.display = 'none'; return; }

  const stats = getLeitnerStats(examFilter || null);
  if (!stats || stats.total < 3) { panel.style.display = 'none'; return; }

  const due = stats.due || 0;
  const total = stats.total || 0;
  const b1 = stats[1] || 0, b2 = stats[2] || 0, b3 = stats[3] || 0, b4 = stats[4] || 0, b5 = stats[5] || 0;
  const masteredPct = total ? Math.round(((b4 + b5) / total) * 100) : 0;
  const duePct = total ? Math.round((due / total) * 100) : 0;

  let currentReadiness = null;
  let breakdown = null;
  try {
    if (window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function' && examFilter) {
      breakdown = window.readinessEngine.getReadinessBreakdown(examFilter);
      currentReadiness = Math.round(Number(breakdown.overall) || 0);
    }
  } catch (_) {}

  // Term-level diagnostic: split 100 points into the 4 formula contributions.
  // Helps user see WHERE specifically points are missing (e.g. mastery vs accuracy).
  function buildTermDiagnostic(br, current) {
    if (!br || !br.factors) return '';
    var f = br.factors;
    var terms = [
      { name: 'Accuracy',       weight: 0.55, value: f.accuracy || 0,                   hint: 'правильность по последним 3 ответам на вопрос (14d окно)' },
      { name: 'Mastery',        weight: 0.25, value: f.mastery || 0,                    hint: 'средний Leitner Box / 5 — растёт только при возврате к карточке через интервал' },
      { name: 'Recent right',   weight: 0.10, value: 1 - (f.recentWrongDensity || 0),  hint: 'доля «не-ошибок» за последние 14 дней' },
      { name: 'Due close-out',  weight: 0.10, value: 1 - (f.duePressure || 0),         hint: 'доля закрытых (не просроченных) Leitner-карточек' },
    ];
    var rows = terms.map(function(t) {
      var earned = Math.round(t.weight * t.value * 100);
      var max = Math.round(t.weight * 100);
      var gap = max - earned;
      var gapColor = gap >= 10 ? '#ef4444' : gap >= 3 ? '#eab308' : '#94a3b8';
      var gapTxt = gap > 0 ? '−' + gap : '0';
      var pct = max > 0 ? Math.max(0, Math.min(100, Math.round(earned / max * 100))) : 0;
      var redOverlay = gap >= 8
        ? '<div style="position:absolute;top:0;left:' + pct + '%;right:0;height:100%;background:rgba(239,68,68,0.20)"></div>'
        : '';
      return '<div style="margin-bottom:14px">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">' +
          '<span style="font-weight:600;color:var(--text-secondary)">' + t.name +
            ' <span style="color:var(--text-muted);font-size:0.72rem;font-weight:500">' + Math.round(t.weight*100) + '%</span>' +
          '</span>' +
          '<span style="font-variant-numeric:tabular-nums;color:var(--text-primary);white-space:nowrap">' +
            '<strong>' + earned + '</strong><span style="color:var(--text-muted)"> / ' + max + '</span>' +
            '<span style="margin-left:10px;color:' + gapColor + ';font-weight:700">' + gapTxt + '</span>' +
          '</span>' +
        '</div>' +
        '<div style="margin-top:6px;height:6px;border-radius:999px;background:rgba(255,255,255,0.06);overflow:hidden;position:relative">' +
          '<div style="width:' + pct + '%;height:100%;background:linear-gradient(90deg,#06b6d4,#6366f1);border-radius:999px"></div>' +
          redOverlay +
        '</div>' +
        '<div style="margin-top:4px;font-size:0.72rem;color:var(--text-muted);opacity:0.85;line-height:1.4">' + t.hint + '</div>' +
      '</div>';
    }).join('');
    // Biggest leverage = term with max gap
    var sorted = terms.map(function(t) {
      return { name: t.name, gap: Math.round(t.weight * 100) - Math.round(t.weight * t.value * 100) };
    }).sort(function(a,b) { return b.gap - a.gap; });
    var leverHint = '';
    var top = sorted[0];
    if (top.gap >= 5) {
      var leverMap = {
        'Accuracy': 'правильно решать недавние вопросы (за 14 дней) — особенно те, где у тебя были ошибки.',
        'Mastery': 'закрывать просроченные Leitner-карточки и возвращаться к старым через интервалы.',
        'Recent right': 'снизить долю ошибок за 14 дней — внимательнее на текущих сессиях.',
        'Due close-out': 'разгрести очередь просроченных карточек.',
      };
      leverHint = '<div style="margin-top:6px;font-size:0.78rem;color:var(--text-secondary)">⚡ Самый большой leverage: <strong style="color:#fbbf24">' + top.name + '</strong> (−' + top.gap + ' баллов). Чтобы расти — ' + (leverMap[top.name] || '') + '</div>';
    }
    return '<div style="font-weight:600;color:var(--text-primary);margin:14px 0 8px">Куда уходят твои ' + (100 - current) + ' баллов</div>' +
      '<div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:10px">Из 100 баллов ты заработал ' + current + '. Разбивка по 4 термам формулы:</div>' +
      rows +
      leverHint;
  }

  // Section-level: which sections drag overall down most (weighted gap).
  function buildSectionDiagnostic(br) {
    if (!br || !br.sectionDetails) return '';
    var profile = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES && EXAM_PROFILES[examFilter]) || null;
    var weights = (profile && profile.sectionWeights) || {};
    var sd = br.sectionDetails;
    var allRows = Object.keys(sd).map(function(k) {
      var d = sd[k];
      var w = typeof weights[k] === 'number' ? weights[k] : 0;
      if (!w || !d.hasData) return null;
      var weightedMax = Math.round(w * 100);
      var weightedEarned = Math.round((d.score / 100) * w * 100);
      var gap = weightedMax - weightedEarned;
      return { label: d.label || k, sectionKey: k, score: d.score, weight: w, weightedMax: weightedMax, weightedEarned: weightedEarned, gap: gap };
    }).filter(Boolean).sort(function(a,b) { return b.gap - a.gap; });
    if (!allRows.length) return '';
    function renderRow(r) {
      // Severity by gap value: red >=8, yellow >=3, gray <3.
      var gapColor = r.gap >= 8 ? '#ef4444' : r.gap >= 3 ? '#eab308' : '#94a3b8';
      var pct = r.weightedMax > 0 ? Math.max(0, Math.min(100, Math.round(r.weightedEarned / r.weightedMax * 100))) : 0;
      var redOverlay = r.gap >= 8
        ? '<div style="position:absolute;top:0;left:' + pct + '%;right:0;height:100%;background:rgba(239,68,68,0.20)"></div>'
        : '';
      return '<div style="margin-bottom:12px">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px">' +
          '<span style="font-weight:600;color:var(--text-secondary)">' + escapeHtml(r.label) +
            ' <span style="color:var(--text-muted);font-size:0.72rem;font-weight:500">· ' + r.score + '/100, вес ' + (r.weight*100).toFixed(1).replace(/\.0$/, '') + '%</span>' +
          '</span>' +
          '<span style="font-variant-numeric:tabular-nums;color:var(--text-primary);white-space:nowrap">' +
            '<strong>' + r.weightedEarned + '</strong><span style="color:var(--text-muted)"> / ' + r.weightedMax + '</span>' +
            '<span style="margin-left:10px;color:' + gapColor + ';font-weight:700">−' + r.gap + '</span>' +
          '</span>' +
        '</div>' +
        '<div style="margin-top:6px;height:6px;border-radius:999px;background:rgba(255,255,255,0.06);overflow:hidden;position:relative">' +
          '<div style="width:' + pct + '%;height:100%;background:linear-gradient(90deg,#06b6d4,#6366f1);border-radius:999px"></div>' +
          redOverlay +
        '</div>' +
      '</div>';
    }
    var html = allRows.map(renderRow).join('');
    return '<div style="font-weight:600;color:var(--text-primary);margin:14px 0 8px">Какие секции тянут вниз сильнее всего</div>' +
      html +
      '<div style="color:var(--text-muted);font-size:0.72rem;margin-top:2px">Отсортировано по вкладу в Readiness — берись с верхней. Красная заливка справа в баре = критичный gap (≥8).</div>';
  }

  // "What-if" projections: estimate readiness gain for 3 concrete actions.
  // The math is intentionally rough — the goal is to make the user choose
  // the highest-leverage action, not to give a precise forecast.
  function buildProjectionBlock(br, current, dueCount, totalCount) {
    if (!br || !br.factors || current == null) return '';
    var f = br.factors;
    var levers = [];

    // Lever 1: close all overdue Leitner cards correctly.
    //   - duePressure goes to 0 (direct gain).
    //   - Each correctly-closed card advances Box by 1 → mastery delta
    //     ≈ (dueCount / totalSeen) * (1 box step / 5 max).
    if (dueCount > 0 && totalCount > 0) {
      var dueGainPts = 0.10 * (f.duePressure || 0) * 100;
      var masteryDelta = Math.min(1 - (f.mastery || 0), (dueCount / totalCount) * 0.2);
      var masteryGainPts = 0.25 * masteryDelta * 100;
      var totalGain = dueGainPts + masteryGainPts;
      levers.push({
        action: 'due',
        label: 'Закрыть все просроченные Leitner-карточки (' + dueCount + ' шт.) — отвечать правильно',
        hint: 'Снимает due pressure (−10% веса до нуля) и продвигает каждую карточку на +1 Box (+mastery).',
        gain: totalGain,
      });
    }

    // Lever 2: bring recent accuracy to 80%.
    //   Skipped if already at/above 80% — no leverage to show.
    var targetAcc = 0.80;
    var curAcc = f.accuracy || 0;
    if (curAcc < targetAcc) {
      levers.push({
        action: 'accuracy',
        label: 'Поднять recent accuracy до 80% (сейчас ' + Math.round(curAcc * 100) + '%)',
        hint: 'Самый «жирный» терм формулы — 55% веса. Решать осознанно в Practice/Smart Review, возвращаться к вопросам с ошибками.',
        gain: 0.55 * (targetAcc - curAcc) * 100,
      });
    }

    // Lever 3: push average Box to ~3 (mastery factor 0.6).
    var targetMastery = 0.60;
    var curMastery = f.mastery || 0;
    if (curMastery < targetMastery) {
      levers.push({
        action: 'mastery',
        label: 'Прокачать средний Box до 3 (mastery ' + Math.round(curMastery * 100) + '% → 60%)',
        hint: 'Возвращаться к карточкам, когда они становятся due. Только успешный возврат через интервал двигает Box.',
        gain: 0.25 * (targetMastery - curMastery) * 100,
      });
    }

    levers = levers.filter(function(l) { return l.gain > 0.5; }).sort(function(a, b) { return b.gain - a.gain; });
    if (!levers.length) return '';

    var canAct = !!examFilter;
    var html = levers.map(function(l, idx) {
      var projected = Math.min(100, current + Math.round(l.gain));
      var rank = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
      var borderColor = idx === 0 ? '#fbbf24' : '#6366f1';
      var disabledAttr = canAct ? '' : ' disabled';
      var titleAttr = canAct ? '' : ' title="Выбери экзамен в верхнем фильтре"';
      return '<button type="button" class="si-cta"' + disabledAttr + titleAttr +
        ' data-study-action="' + escapeHtml(l.action || '') + '"' +
        ' data-exam="' + escapeHtml(examFilter || '') + '"' +
        ' style="--si-border:' + borderColor + ';display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px;width:100%;text-align:left;font:inherit;color:inherit;padding:10px 12px;background:rgba(99,102,241,0.06);border:none;border-left:3px solid ' + borderColor + ';border-radius:6px;margin-bottom:8px;cursor:' + (canAct ? 'pointer' : 'not-allowed') + ';' + (canAct ? '' : 'opacity:0.55;') + '">' +
        '<span style="min-width:0">' +
          '<span style="display:block;font-weight:600;color:var(--text-primary);font-size:0.84rem">' + rank + ' ' + escapeHtml(l.label) + '</span>' +
          '<span style="display:block;font-size:0.74rem;color:var(--text-muted);margin:4px 0 6px">' + escapeHtml(l.hint) + '</span>' +
          '<span style="display:block;font-size:0.82rem;color:var(--text-secondary)">Прогноз: Readiness <strong style="color:var(--text-primary)">' + current + ' → ' + projected + '</strong> <span style="color:#22c55e;font-weight:700;margin-left:6px">+' + Math.round(l.gain) + '</span></span>' +
        '</span>' +
        '<span aria-hidden="true" class="si-cta-chev" style="font-size:1.5rem;line-height:1;color:var(--text-muted);padding-right:4px">›</span>' +
      '</button>';
    }).join('');

    return '<div style="font-weight:600;color:var(--text-primary);margin:14px 0 8px">🚀 Прогноз: что даст наибольший прирост</div>' +
      '<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:8px">Грубые оценки — реальный прирост зависит от того, насколько <em>правильно</em> ты ответишь. Клик — запустить сфокусированную тренировку.</div>' +
      html;
  }

  // Tactical accuracy-target block — answers "how many correct do I need for
  // +1 / +5 readiness points?" Math: ΔReadiness ≈ 55 × Δaccuracy (accuracy is
  // 55% of the score formula). For M new questions with correctness P:
  //   M = D·N / [55·(P − curAcc) − D]
  // where N is the recent-14d sample size and D is the target ΔReadiness.
  function buildAccuracyTargetBlock(br, current) {
    if (!br || !br.factors || current == null) return '';
    var f = br.factors;
    var curAcc = typeof f.accuracy === 'number' ? f.accuracy : 0;
    var N = f.accuracyRecentSampleSize || 0;
    if (N < 10) return ''; // мало данных
    var correctCount = Math.round(curAcc * N);

    // Compute questions needed for given target ΔReadiness D at correctness P.
    function questionsNeeded(D, P) {
      var denom = 55 * (P - curAcc) - D;
      if (denom <= 0) return null; // below break-even
      var m = (D * N) / denom;
      if (!isFinite(m) || m <= 0) return null;
      return Math.ceil(m);
    }

    var targets = [{ d: 1, label: '+1 пункт' }];
    if (current < 95) targets.push({ d: 5, label: '+5 пунктов' });

    var rates = [
      { p: 1.00, emoji: '🎯', label: '100% (без ошибок)' },
      { p: 0.90, emoji: '🔥', label: '90% (9 из 10)' },
      { p: 0.80, emoji: '⚖️', label: '80% (4 из 5)' },
      { p: 0.75, emoji: '🐢', label: '75% (3 из 4)' },
    ];

    // Cap displayed value at 1000+ — anything beyond is "P barely above
    // break-even" and the 1/x growth makes the exact number both useless
    // and misleading (e.g. 19984 questions to gain 5 points really means
    // "this rate doesn't work, raise your accuracy first").
    var BIG_CAP = 1000;
    function fmtM(m) {
      if (m === null) return '<span style="color:#ef4444">🚫 ниже break-even</span>';
      if (m > BIG_CAP) return '<span style="color:#f97316" title="P едва над break-even — фактически нужно поднять accuracy">' + BIG_CAP + '+</span>';
      return '<strong>' + m + '</strong>';
    }

    var html = targets.map(function(t) {
      var rows = rates.map(function(r) {
        var m = questionsNeeded(t.d, r.p);
        var label = r.emoji + ' ' + r.label;
        var unitNeeded = (m !== null && m <= BIG_CAP);
        var unit = '';
        if (unitNeeded) {
          unit = ' вопрос' + (m === 1 ? '' : (m % 10 >= 2 && m % 10 <= 4 && (m % 100 < 12 || m % 100 > 14) ? 'а' : 'ов'));
        } else if (m !== null) {
          unit = ' вопросов';
        }
        var value = fmtM(m) + unit;
        return '<div style="color:var(--text-secondary)">' + label + '</div>' +
          '<div style="text-align:right;color:var(--text-primary);font-variant-numeric:tabular-nums;white-space:nowrap">' + value + '</div>';
      }).join('');
      var newReadiness = Math.min(100, current + t.d);
      return '<div style="margin-bottom:12px">' +
        '<div style="font-weight:600;color:var(--text-primary);font-size:0.84rem;margin-bottom:6px">' +
          escapeHtml(t.label) + ' (' + current + ' → ' + newReadiness + ')' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr auto;column-gap:16px;row-gap:6px;font-size:0.82rem;align-items:baseline">' + rows + '</div>' +
      '</div>';
    }).join('');

    var breakEven = Math.ceil((curAcc + 1/55) * 100); // P_min для +1 пункт
    var stateLine = 'Recent accuracy: <strong>' + Math.round(curAcc * 100) + '%</strong> (' + correctCount + ' / ' + N + ' за 14 дней). Break-even для роста: <strong>≥ ' + breakEven + '%</strong>.';

    return '<div style="font-weight:600;color:var(--text-primary);margin:14px 0 8px">📈 Сколько правильных нужно для следующих пунктов</div>' +
      '<div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:10px">' + stateLine + '</div>' +
      html +
      '<div style="color:var(--text-muted);font-size:0.72rem">Расчёт по accuracy-терму (55% веса формулы). Mastery и due pressure двигают Readiness отдельно — см. выше «🚀 Прогноз».</div>';
  }

  const termDiagnosticHtml = currentReadiness != null ? buildTermDiagnostic(breakdown, currentReadiness) : '';
  const sectionDiagnosticHtml = currentReadiness != null ? buildSectionDiagnostic(breakdown) : '';
  const projectionHtml = currentReadiness != null ? buildProjectionBlock(breakdown, currentReadiness, due, total) : '';
  const accuracyTargetHtml = currentReadiness != null ? buildAccuracyTargetBlock(breakdown, currentReadiness) : '';

  // Pick the biggest bottleneck box (excluding fully-mastered Box 5)
  const boxCounts = [
    { box: 1, count: b1, label: 'Box 1', interval: 'через 1 день' },
    { box: 2, count: b2, label: 'Box 2', interval: 'через 3 дня' },
    { box: 3, count: b3, label: 'Box 3', interval: 'через 7 дней' },
    { box: 4, count: b4, label: 'Box 4', interval: 'через 14 дней' }
  ];
  const bottleneck = boxCounts.slice().sort((a, b) => b.count - a.count)[0];

  panel.style.display = '';
  const headerLine = currentReadiness !== null
    ? `Текущий Readiness: <strong style="color:var(--text-primary)">${currentReadiness}/100</strong>${examFilter ? ' (' + examFilter + ')' : ''}.`
    : `Сводка по вашим карточкам${examFilter ? ' (' + examFilter + ')' : ''}.`;

  el.innerHTML = `
    <div style="font-size:0.82rem;color:var(--text-secondary);line-height:1.55">
      <div style="margin-bottom:12px;color:var(--text-muted);font-size:0.78rem">${headerLine}</div>

      <details>
        <summary style="cursor:pointer;font-weight:600;color:var(--text-primary);margin-bottom:10px;padding:6px 0">Как считается Readiness</summary>
        <div style="padding:8px 4px 12px;border-left:2px solid rgba(255,255,255,0.08);margin:0 0 12px 8px;padding-left:14px">
          <div style="margin-bottom:8px">Формула per-section score (0–100):</div>
          <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.75rem;background:rgba(255,255,255,0.04);padding:8px 10px;border-radius:6px;margin-bottom:10px;overflow-x:auto;white-space:nowrap">score = 0.55 × accuracy + 0.25 × mastery + 0.10 × (1 − recentWrong) + 0.10 × (1 − duePressure)</div>
          <ul style="margin:0;padding-left:18px;color:var(--text-muted);font-size:0.78rem">
            <li><strong style="color:var(--text-secondary)">Accuracy (55%)</strong> — точность по вопросам за последние <strong>14 дней</strong>, на уровне <strong>каждого отдельного вопроса</strong>. Для каждого вопроса смотрим **последние 3 ответа** и считаем «уверенность что знаешь»:<br><code>[T,T,T] → 1.0</code> (выучил), <code>[T,T]=0.75</code>, <code>[T]=0.67</code> (один правильный — может быть случайно), <code>[F,T,T]=0.60</code>, <code>[F]=0.33</code>, <code>[F,F,F]=0</code>. Старая история (>14 дней назад или 4-й-ответ-назад) больше не учитывается. Чтобы затереть плохую историю по вопросу — нужно <strong>3 правильных ответа подряд</strong>. Blend между recent и all-time <em>непрерывный</em>: на 100+ свежих вопросов в секции all-time полностью отбрасывается.</li>
            <li><strong style="color:var(--text-secondary)">Mastery (25%)</strong> — средний уровень Leitner-карточек по шкале 1→5. Box двигается <em>только когда карточка стала due</em> (после интервала 1/3/7/14 дней). Ранние правильные ответы (например, попался тот же вопрос в Practice через 5 минут) НЕ двигают Box — это защита от «грайнда» в одной сессии. Неверный ответ сбрасывает Box в 1 в любой момент.</li>
            <li><strong style="color:var(--text-secondary)">Recent wrong (10%)</strong> — доля ошибок за последние 14 дней.</li>
            <li><strong style="color:var(--text-secondary)">Due pressure (10%)</strong> — доля просроченных Leitner-карточек.</li>
          </ul>
        </div>
      </details>

      ${termDiagnosticHtml}
      ${sectionDiagnosticHtml}
      ${projectionHtml}
      ${accuracyTargetHtml}

      <div style="font-weight:600;color:var(--text-primary);margin:14px 0 8px">Что делать прямо сейчас</div>
      <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px">
        ${due > 0 ? `<li><strong style="color:#ef4444">Закройте «Review ${due}»</strong> — у вас <strong>${due}</strong> просроченных карточек (${duePct}% от всех виденных). Это лечит due pressure и одновременно растит mastery: каждая правильно отвеченная просроченная карточка → продвигается на следующий уровень. Двойной выхлоп с одного действия.</li>` : `<li>✅ Просроченных карточек нет — due pressure на нуле. Хорошая работа.</li>`}
        ${bottleneck && bottleneck.count >= 30 ? `<li><strong style="color:var(--text-primary)">Выбейте ${bottleneck.label} (${bottleneck.count} шт.)</strong> — это ваша главная пробка. Карточки залипли там, потому что вы их видели один раз правильно, но не вернулись ${bottleneck.interval}, чтобы перевести в следующий бокс. Вернитесь и переведите их вверх.</li>` : ''}
        <li><strong style="color:var(--text-primary)">Пробивайте лестницу Box 1 → 2 → 3 → 4 → 5</strong> через интервалы 1 / 3 / 7 / 14 / 30 дней. Это spaced repetition в действии. Сейчас на пути к mastery: <strong>${masteredPct}%</strong> (Box 4–5: ${b4 + b5} из ${total}).</li>
        <li><strong style="color:var(--text-primary)">Покрывайте все секции экзамена</strong> — если в какой-то секции меньше 3 ответов, она тянет общий Readiness вниз нулём. Смотрите Focus areas / Statistics by topic, чтобы понять что закрыть.</li>
      </ol>

      <div style="margin-top:16px;padding:12px 14px;background:rgba(99,102,241,0.10);border:1px solid rgba(99,102,241,0.25);border-radius:10px;font-size:0.82rem">
        <strong style="color:#a5b4fc">💡 Главный инсайт.</strong> Readiness — это не «как ты сдал тест сегодня», а «насколько твоя память закрепила материал на интервалах». Один день 80% точности на новых вопросах не двигает mastery, потому что Leitner повышает уровень только при <em>успешном возврате через интервал</em>. Если много отвечаешь на новые вопросы и не возвращаешься — карточки накапливаются в Box 1–2 и там застревают.
      </div>
    </div>`;

  if (!document.getElementById('si-cta-styles')) {
    var siStyle = document.createElement('style');
    siStyle.id = 'si-cta-styles';
    siStyle.textContent = '.si-cta{transition:background 0.15s ease, transform 0.15s ease;}'
      + '.si-cta:hover:not(:disabled){background:rgba(99,102,241,0.16) !important;transform:translateX(2px);}'
      + '.si-cta:hover:not(:disabled) .si-cta-chev{color:var(--text-primary) !important;}'
      + '.si-cta:active:not(:disabled){transform:translateX(2px) scale(0.995);}'
      + '.si-cta:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px;}';
    document.head.appendChild(siStyle);
  }

  if (el.dataset.ctaBound !== '1') {
    el.addEventListener('click', function(ev) {
      var btn = ev.target.closest('button.si-cta');
      if (!btn || btn.disabled) return;
      var action = btn.dataset.studyAction;
      var exam = btn.dataset.exam || '';
      if (!exam) return;
      try {
        if (action === 'accuracy') {
          S.exam = exam;
          if (typeof startWeakSession === 'function') startWeakSession();
        } else if (action === 'due' || action === 'mastery') {
          if (typeof getSmartReviewQuestions !== 'function' || typeof startPreparedSession !== 'function') return;
          var qs = getSmartReviewQuestions(exam, S.practiceQuestionCount);
          if (!qs || !qs.length) { alert('Нет вопросов для Smart Review.'); return; }
          S.exam = exam;
          startPreparedSession(qs, {
            exam: exam, mode: 'smart', section: 'all',
            sectionQuestionCount: S.sectionQuestionCount,
            sectionTimerMinutes: 0,
            practiceQuestionCount: S.practiceQuestionCount,
            mockNum: null, csLabel: null, source: 'study_insights'
          });
        }
      } catch (e) { console.warn('study_insights CTA failed', e); }
    });
    el.dataset.ctaBound = '1';
  }
}

function renderReadinessEta(exam, meRow, scope, allUsers, options) {
  // Optional second-target rendering — same widget on the home screen
  // (panelId='homeReadinessEtaPanel', elId='homeReadinessEta'). Without
  // options, behaves exactly like the legacy admin-only call.
  const panelId = (options && options.panelId) || 'adminReadinessEtaPanel';
  const elId = (options && options.elId) || 'adminReadinessEta';
  const panel = $(panelId);
  const el = $(elId);
  const titleEl = panel ? panel.querySelector('.section-label') : null;
  if (!panel || !el || !exam) return;
  const isAll = scope === 'all';
  let merged = {};
  if (isAll) {
    const buckets = {};
    (allUsers || []).forEach(u => {
      const h = u.readinessDaily && u.readinessDaily[exam];
      if (!h) return;
      Object.entries(h).forEach(([d, v]) => {
        const num = Number(v);
        if (isNaN(num)) return;
        if (!buckets[d]) buckets[d] = { sum: 0, n: 0 };
        buckets[d].sum += num;
        buckets[d].n += 1;
      });
    });
    Object.entries(buckets).forEach(([d, b]) => { merged[d] = b.sum / b.n; });
  } else {
    const localHist = loadReadinessHistory();
    const cloudHist = (meRow && meRow.readinessDaily && meRow.readinessDaily[exam]) || {};
    const local = localHist[exam] || {};
    Object.assign(merged, cloudHist, local);
  }
  if (titleEl) titleEl.textContent = isAll
    ? `⏳ Readiness ETA — cohort average (${exam})`
    : `⏳ Readiness ETA — your trajectory (${exam})`;
  const points = Object.keys(merged).sort().map(d => ({ d, v: Number(merged[d]) })).filter(p => !isNaN(p.v));
  if (points.length < 3) { panel.style.display = 'none'; return; }
  const last = points[points.length - 1];
  const current = Math.round(last.v);
  const subjLabel = isAll ? 'Cohort average' : 'You';
  // CI margin — only for personal scope; cohort average has no single
  // raw-history source to bootstrap from.
  let etaMargin = 0;
  let etaMethod = 'wilson';
  if (!isAll) {
    try {
      if (window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function') {
        const brEta = window.readinessEngine.getReadinessBreakdown(exam) || {};
        const resolvedEta = resolveReadinessMargin(exam, brEta.overallMargin);
        etaMargin = resolvedEta.margin;
        etaMethod = resolvedEta.method;
      }
    } catch (_) {}
  }
  const marginSuffix = etaMargin > 0 ? ` ± ${etaMargin}` : '';
  // Wrap "(current ± margin)/100" so the slash unambiguously belongs to
  // the "/100" denominator, not to the margin. Without parens "67 ± 2/100"
  // visually reads like "67 plus or minus 2/100" = misleading.
  const currentDisplay = etaMargin > 0
    ? `(${current}${marginSuffix})/100`
    : `${current}/100`;
  const marginTitle = etaMargin > 0
    ? ` title="95% CI: ${Math.max(0, current - etaMargin)}–${Math.min(100, current + etaMargin)} · method: ${etaMethod}"`
    : '';
  panel.style.display = '';
  if (current >= 80) {
    el.innerHTML = `<div style="background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.25);border-radius:12px;padding:14px 16px">
      <div style="font-weight:700;color:#22c55e;font-size:1rem"${marginTitle}>🎉 ${subjLabel} at ${currentDisplay} — exam-ready</div>
      <div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">Maintain accuracy with regular review sessions.</div>
    </div>`;
    return;
  }
  // Linear regression on the window of recent snapshots. Window is defined
  // in *calendar days* (default 14, easy-flip to 30 later), not in snapshot
  // count — so a user returning after a pause doesn't get their slope
  // dragged down by old low-readiness points sitting before the gap.
  // Fallback: if fewer than 3 snapshots fall in the window, take the last 3
  // unconditionally so OLS is defined.
  const READINESS_WINDOW_DAYS = 14;
  const baseDay = (s) => Math.floor(new Date(s + 'T00:00:00Z').getTime() / 86400000);
  const todayDayAbs = Math.floor(Date.now() / 86400000);
  const cutoffDayAbs = todayDayAbs - READINESS_WINDOW_DAYS;
  let win = points.filter(p => baseDay(p.d) >= cutoffDayAbs);
  if (win.length < 3) win = points.slice(-3);
  const x0 = baseDay(win[0].d);
  const xs = win.map(p => baseDay(p.d) - x0);
  const ys = win.map(p => p.v);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const sumXX = xs.reduce((a, b) => a + b * b, 0);
  const denom = n * sumXX - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / n;
  const lastX = baseDay(last.d) - x0;
  const todayX = todayDayAbs - x0;
  const startX = Math.max(lastX, todayX);
  const winDays = baseDay(win[win.length - 1].d) - baseDay(win[0].d) + 1;
  // Build the accuracy-breakdown hint (only meaningful for scope='me' —
  // for 'all' the per-user blend mix doesn't average cleanly). Pulls
  // straight from the engine so we never desync from the actual formula.
  let accuracyHint = '';
  if (!isAll && window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function') {
    try {
      const f = (window.readinessEngine.getReadinessBreakdown(exam) || {}).factors || {};
      if (f.accuracyRecent != null || f.accuracyAllTime != null) {
        const mixPct = Math.round((f.accuracyRecentWeight || 0) * 100);
        // All four windows are computed from per-exam daily counters so the
        // counts stay monotonic (7d ≤ 14d ≤ 30d ≤ all-time). Earlier we mixed
        // dailyStats (every answer) with sectionStats (only section-backed) —
        // 14d sample was a subset and looked smaller than 7d. Now uniform.
        const parts = [];
        try {
          const store = loadStore();
          const totByDay = (store.dailyStatsByExam && store.dailyStatsByExam[exam]) || {};
          const corByDay = (store.dailyCorrectByExam && store.dailyCorrectByExam[exam]) || {};
          const today = new Date(); today.setUTCHours(0,0,0,0);
          let sumTot7 = 0, sumCor7 = 0;
          let sumTot14 = 0, sumCor14 = 0;
          let sumTot30 = 0, sumCor30 = 0;
          for (let i = 0; i < 30; i++) {
            const d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
            const k = d.toISOString().slice(0, 10);
            const t = totByDay[k] || 0;
            const c = corByDay[k] || 0;
            if (i < 7)  { sumTot7  += t; sumCor7  += c; }
            if (i < 14) { sumTot14 += t; sumCor14 += c; }
            sumTot30 += t;
            sumCor30 += c;
          }
          let sumTotAll = 0, sumCorAll = 0;
          Object.keys(totByDay).forEach(k => { sumTotAll += Number(totByDay[k]) || 0; });
          Object.keys(corByDay).forEach(k => { sumCorAll += Number(corByDay[k]) || 0; });
          const fmt = (cor, tot) => Math.round((cor / tot) * 100) + '%';
          if (sumTot7  > 0) parts.push(`recent 7d ${fmt(sumCor7,  sumTot7)} (${sumTot7} q)`);
          if (sumTot14 > 0) parts.push(`recent 14d ${fmt(sumCor14, sumTot14)} (${sumTot14} q)`);
          if (sumTot30 > 0) parts.push(`recent 30d ${fmt(sumCor30, sumTot30)} (${sumTot30} q)`);
          if (sumTotAll > 0) parts.push(`all-time ${fmt(sumCorAll, sumTotAll)} (${sumTotAll} q)`);
        } catch (_) {}
        parts.push(`mix ${mixPct}% recent`);
        accuracyHint = 'Accuracy: ' + parts.join(' · ');
      }
    } catch (_) {}
  }
  const accuracyHintHtml = accuracyHint
    ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:6px;opacity:0.8" title="As the recent sample grows from 2 to 30 questions in a section, recent's weight ramps from 0 to 100%. Below 2 recent — pure all-time; if all-time has <10 total — recent carries alone.">${escapeHtml(accuracyHint)}</div>`
    : '';
  if (slope < -0.05) {
    const downMsg = isAll
      ? "Cohort readiness is trending down. Check whether new sections are pulling the average."
      : "Твой readiness падает. Скорее всего, недавно добавились сложные разделы или копятся повторные ошибки — открой Weak topics и Smart Review.";
    el.innerHTML = `<div style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);border-radius:12px;padding:14px 16px">
      <div style="font-weight:700;color:#f59e0b;font-size:1rem"${marginTitle}>⚠️ Current pace: ${currentDisplay}, trend down (${slope.toFixed(2)} pts/day)</div>
      <div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">${downMsg}</div>
      ${accuracyHintHtml}
    </div>`;
    return;
  }
  if (slope <= 0.05) {
    const flatMsg = isAll
      ? "At this rate the cohort won't reach 80% — group is plateauing."
      : "At this rate you won't hit 80%. Try harder sections, more practice volume, or fix repeat mistakes.";
    el.innerHTML = `<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:12px;padding:14px 16px">
      <div style="font-weight:700;color:#ef4444;font-size:1rem"${marginTitle}>📉 Current pace: ${currentDisplay}, trend flat (≤0.05 pts/day)</div>
      <div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">${flatMsg}</div>
      ${accuracyHintHtml}
    </div>`;
    return;
  }
  const daysToTarget = Math.ceil((80 - current) / slope);
  const eta = new Date((x0 + startX + daysToTarget) * 86400000);
  // Human-readable "04 July 2026" instead of "2026-07-04".
  const etaStr = eta.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const projAnchor = Math.max(lastX, todayX);
  const projected30 = Math.min(100, Math.max(0, Math.round(intercept + slope * (projAnchor + 30))));
  const headline = isAll
    ? `⏳ At current cohort pace, average hits 80/100 by ~${etaStr}`
    : `⏳ At current pace, you hit 80/100 by ~${etaStr}`;
  el.innerHTML = `<div style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.25);border-radius:12px;padding:14px 16px">
    <div style="font-weight:700;color:#818cf8;font-size:1rem">${headline}</div>
    <div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px"${marginTitle}>Now: ${currentDisplay} · Trend: +${slope.toFixed(2)} pts/day · 30-day projection: ~${projected30}/100 · Window: last ${n} snapshots over ${winDays}d on ${escapeHtml(exam)}${isAll ? ' (averaged across users)' : ''}</div>
    ${accuracyHintHtml}
  </div>`;
}
let adminSpeedAccChart = null;

// Readiness budget by section — replaces the old Speed × Accuracy quadrant.
// Each row = one section, bar width proportional to that section's weight
// in the exam, internally split into 4 segments (accuracy / mastery /
// recent-right / due-right) so the user sees WHERE points come from and
// WHERE the gap is. Ties directly to the formula
//   score = 0.55*acc + 0.25*mas + 0.10*(1-recentWrong) + 0.10*(1-due).
function renderSpeedAccQuadrant(examFilter, scope, allUsers) {
  const panel = $('adminSpeedAccPanel');
  const sub = $('adminSpeedAccSubtitle');
  const titleEl = panel ? panel.querySelector('.section-label') : null;
  if (!panel) return;
  const isAll = scope === 'all';

  // Cohort scope is unsupported for this view (would require running the
  // engine for every user). Just show a friendly note in that case.
  if (isAll) {
    if (titleEl) titleEl.textContent = '🎯 Readiness budget by section';
    if (sub) sub.textContent = 'Available only in personal scope (Just me).';
    panel.innerHTML = '<div class="section-label">🎯 Readiness budget by section</div><div style="padding:14px;color:var(--text-muted);font-size:0.82rem">Этот разбор работает в режиме «Just me» — он показывает, как твои баллы складываются по 4 термам формулы.</div>';
    panel.style.display = '';
    return;
  }

  if (!examFilter) { panel.style.display = 'none'; return; }
  const eng = window.readinessEngine;
  if (!eng || typeof eng.getReadinessBreakdown !== 'function') { panel.style.display = 'none'; return; }
  let br;
  try { br = eng.getReadinessBreakdown(examFilter); } catch (_) { panel.style.display = 'none'; return; }
  if (!br || !br.sectionDetails) { panel.style.display = 'none'; return; }
  const profile = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES && EXAM_PROFILES[examFilter]) || null;
  const weights = (profile && profile.sectionWeights) || {};
  const sd = br.sectionDetails;

  const rows = Object.keys(sd).map(k => {
    const d = sd[k];
    const w = typeof weights[k] === 'number' ? weights[k] : 0;
    if (!w) return null;
    const maxPts = w * 100;
    const accPts = 0.55 * (d.accuracy || 0) * w * 100;
    const masPts = 0.25 * (d.mastery || 0) * w * 100;
    const recPts = 0.10 * (1 - (d.recentWrongDensity || 0)) * w * 100;
    const duePts = 0.10 * (1 - (d.duePressure || 0)) * w * 100;
    const earned = accPts + masPts + recPts + duePts;
    const gap = Math.max(0, maxPts - earned);
    return {
      key: k,
      label: d.label || k,
      weight: w,
      maxPts: maxPts,
      earned: earned,
      hasData: !!d.hasData,
      score: d.score,
      segments: [
        { name: 'Accuracy',     val: accPts, color: 'linear-gradient(180deg,#6366f1,#4338ca)' },
        { name: 'Mastery',      val: masPts, color: 'linear-gradient(180deg,#a855f7,#7e22ce)' },
        { name: 'Recent right', val: recPts, color: 'linear-gradient(180deg,#22d3ee,#0891b2)' },
        { name: 'Due close',    val: duePts, color: 'linear-gradient(180deg,#34d399,#059669)' },
      ],
      gap: gap,
    };
  }).filter(Boolean).sort((a, b) => b.weight - a.weight);

  if (!rows.length) { panel.style.display = 'none'; return; }

  // Normalize bar width: longest weight maps to 100% of the available track.
  const maxWeight = Math.max.apply(null, rows.map(r => r.weight));
  const totalEarned = rows.reduce((s, r) => s + r.earned, 0);
  const totalMax = rows.reduce((s, r) => s + r.maxPts, 0);

  if (titleEl) titleEl.textContent = '🎯 Readiness budget by section';
  if (sub) sub.textContent = 'Each row = how much each section contributes to your overall Readiness, broken down by the 4 formula terms. Width of the bar reflects section weight in the exam.';

  const barRowsHtml = rows.map(r => {
    const widthPct = r.maxPts > 0 ? (r.maxPts / (maxWeight * 100)) * 100 : 0;
    const segs = r.segments.map(s => {
      const pctOfBar = r.maxPts > 0 ? (s.val / r.maxPts) * 100 : 0;
      return `<div title="${s.name}: ${s.val.toFixed(1)} pts" style="height:100%;background:${s.color};width:${pctOfBar}%"></div>`;
    }).join('');
    return `
      <div class="rb-row" style="display:grid;grid-template-columns:160px 1fr 110px;align-items:center;gap:12px;padding:6px 0">
        <div style="color:var(--text-secondary);font-size:0.82rem;font-weight:600">${escapeHtml(r.label)}</div>
        <div style="position:relative;height:22px;background:rgba(148,163,184,0.08);border-radius:5px;overflow:hidden">
          <div style="position:absolute;inset:0;width:${widthPct}%;display:flex">${segs}</div>
        </div>
        <div style="text-align:right;font-variant-numeric:tabular-nums;font-size:0.82rem;color:var(--text-primary)">
          <strong>${r.earned.toFixed(1)}</strong> <span style="color:var(--text-muted)">/ ${r.maxPts.toFixed(0)} pts</span>
        </div>
      </div>`;
  }).join('');

  const legendHtml = `
    <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:0.72rem;color:var(--text-muted);margin:10px 0 6px">
      <span><span style="display:inline-block;width:10px;height:10px;background:linear-gradient(180deg,#6366f1,#4338ca);border-radius:2px;vertical-align:-1px;margin-right:5px"></span>Accuracy (55%)</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:linear-gradient(180deg,#a855f7,#7e22ce);border-radius:2px;vertical-align:-1px;margin-right:5px"></span>Mastery (25%)</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:linear-gradient(180deg,#22d3ee,#0891b2);border-radius:2px;vertical-align:-1px;margin-right:5px"></span>Recent right (10%)</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:linear-gradient(180deg,#34d399,#059669);border-radius:2px;vertical-align:-1px;margin-right:5px"></span>Due close (10%)</span>
    </div>`;

  panel.style.display = '';
  panel.innerHTML = `
    <div class="section-label">🎯 Readiness budget by section</div>
    <div id="adminSpeedAccSubtitle" style="font-size:0.72rem;color:var(--text-muted);margin:0 0 10px">${escapeHtml(sub ? sub.textContent : 'Each row = section contribution to Readiness.')}</div>
    ${legendHtml}
    <div style="display:flex;flex-direction:column;gap:2px">${barRowsHtml}</div>
    <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;font-size:0.78rem">
      <span style="color:var(--text-muted)">Total earned</span>
      <span style="color:var(--text-primary);font-weight:700">${Math.round(totalEarned * 10)} / ${Math.round(totalMax * 10)} pts</span>
    </div>`;
}

function renderHourOfDayStrip(scope, allUsers) {
  const panel = $('adminHourPanel');
  const el = $('adminHourStrip');
  const sub = $('adminHourSubtitle');
  const titleEl = panel ? panel.querySelector('.section-label') : null;
  if (!panel || !el) return;
  const isAll = scope === 'all';
  const buckets = Array.from({ length: 24 }, () => ({ total: 0, correct: 0 }));
  const sources = isAll
    ? (allUsers || []).map(u => u.hourStats || {})
    : [loadStore().hourStats || {}];
  sources.forEach(hs => {
    Object.entries(hs).forEach(([h, v]) => {
      const i = Number(h);
      if (!Number.isInteger(i) || i < 0 || i > 23) return;
      buckets[i].total += Number(v.total) || 0;
      buckets[i].correct += Number(v.correct) || 0;
    });
  });
  const grand = buckets.reduce((a, b) => a + b.total, 0);
  if (titleEl) titleEl.textContent = isAll
    ? '🕘 Accuracy by hour of day (all users)'
    : '🕘 Accuracy by hour of day';
  if (grand < 10) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  if (sub) sub.textContent = isAll
    ? `${grand} answers across all users, bucketed by user-local hour. Useful for spotting times when the cohort performs best.`
    : `${grand} answers bucketed by your local hour. Use this to schedule your study sessions when you're most accurate.`;
  const maxTotal = Math.max(...buckets.map(b => b.total), 1);
  const cells = buckets.map((b, i) => {
    const pct = b.total > 0 ? Math.round(b.correct / b.total * 100) : null;
    const intensity = b.total / maxTotal;
    let bg, color;
    if (b.total === 0) { bg = 'rgba(255,255,255,0.04)'; color = 'var(--text-muted)'; }
    else if (pct >= 70) { bg = `rgba(34,197,94,${0.15 + intensity * 0.55})`; color = '#22c55e'; }
    else if (pct >= 40) { bg = `rgba(234,179,8,${0.15 + intensity * 0.55})`; color = '#eab308'; }
    else { bg = `rgba(239,68,68,${0.15 + intensity * 0.55})`; color = '#ef4444'; }
    const tip = b.total > 0
      ? `${i.toString().padStart(2,'0')}:00 — ${pct}% on ${b.total} answers`
      : `${i.toString().padStart(2,'0')}:00 — no data`;
    return `<div title="${escapeHtml(tip)}" style="aspect-ratio:1/1;background:${bg};border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:0.65rem;color:${color};font-weight:700;min-width:0;padding:2px">
      <div>${i}</div>
      ${b.total > 0 ? `<div style="font-size:0.55rem;opacity:0.7">${pct}%</div>` : ''}
    </div>`;
  }).join('');
  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(24,1fr);gap:3px">${cells}</div>
    <div style="display:flex;justify-content:space-between;font-size:0.65rem;color:var(--text-muted);margin-top:6px">
      <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
    </div>`;
}

let wpExpanded = false;
function renderWrongPicks(examFilter) {
  // Panel was moved from My Statistics v1 to My weak questions. Try the
  // new IDs first; fall back to the admin pair so any legacy host still
  // works.
  const panel = $('weakPicksPanel') || $('adminPicksPanel');
  const el = $('weakPicks') || $('adminPicks');
  if (!panel || !el) return;
  const store = loadStore();
  const qs = store.questionStats || {};
  const rows = Object.entries(qs).map(([key, v]) => {
    if (!v || !v.picks || typeof v.picks !== 'object') return null;
    if (examFilter && v.exam !== examFilter) return null;
    const total = v.total || 0;
    const correct = v.correct || 0;
    const wrong = total - correct;
    if (wrong < 2) return null;
    const picks = Object.entries(v.picks).map(([k, n]) => ({ k, n: Number(n) || 0 }))
      .sort((a, b) => b.n - a.n);
    if (!picks.length) return null;
    const top = picks[0];
    if (top.n < 2) return null;
    return {
      key, exam: v.exam, title: v.title || key, sectionLabel: v.sectionLabel || '',
      total, correct, wrong, topPick: top.k, topPickCount: top.n,
      stickiness: Math.round((top.n / total) * 100),
    };
  }).filter(Boolean);
  if (rows.length < 1) { panel.style.display = 'none'; return; }
  rows.sort((a, b) => (b.stickiness * b.wrong) - (a.stickiness * a.wrong));
  const total = rows.length;
  const visible = wpExpanded ? rows : rows.slice(0, 5);
  panel.style.display = '';
  const rowsHtml = visible.map(r => {
    const examTag = examFilter ? '' : ` <span style="color:var(--text-muted);font-size:0.7rem;margin-left:6px">${escapeHtml(r.exam || '')}</span>`;
    const sec = r.sectionLabel ? `<span style="color:var(--text-muted);font-size:0.7rem">${escapeHtml(r.sectionLabel)}</span> · ` : '';
    const titleText = String(r.title || '').slice(0, 110);
    return `<div class="wrong-pattern-row" data-wp-key="${escapeHtml(r.key)}" data-wp-exam="${escapeHtml(r.exam || '')}" style="padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);margin-bottom:8px;cursor:pointer">
      <div style="font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(titleText)}${examTag}</div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:3px">${sec}${r.correct}/${r.total} correct · picked option <strong style="color:#ef4444">${escapeHtml(r.topPick)}</strong> ${r.topPickCount} times (${r.stickiness}% of attempts)</div>
    </div>`;
  }).join('');
  const toggleHtml = total > 5
    ? `<button type="button" class="wp-show-all" style="background:none;border:none;color:var(--accent-primary);cursor:pointer;font-size:0.78rem;font-weight:600;padding:4px 0;margin-top:4px">${wpExpanded ? `Show top 5 ↑` : `Show all (${total}) ↓`}</button>`
    : '';
  el.innerHTML = rowsHtml + toggleHtml + `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:8px">Sorted by stickiness × wrong-count. If you keep picking the same option, the question is testing a specific misconception — read the explanation carefully next time.</div>`;
  el.querySelectorAll('.wrong-pattern-row').forEach(function(row) {
    row.addEventListener('click', function() {
      openQuestionPreviewByKey(
        row.getAttribute('data-wp-exam') || S.exam,
        row.getAttribute('data-wp-key')
      );
    });
  });
  const toggleBtn = el.querySelector('.wp-show-all');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      wpExpanded = !wpExpanded;
      renderWrongPicks(examFilter);
    });
  }
}

// --- Blitz Mode Swipe Logic ---
document.addEventListener('DOMContentLoaded', () => {
  const qCard = document.querySelector('.question-card');
  if(!qCard) return;
  
  let startX = 0;
  let currentX = 0;
  let isDragging = false;
  
  // Add indicators
  qCard.insertAdjacentHTML('beforeend', '<div class="swipe-indicator left">Don\'t know</div><div class="swipe-indicator right">Know</div>');

  const handleDragStart = (e) => {
    if ((S.mode !== 'blitz' && S.mode !== 'flashcard') || qCard.classList.contains('answered')) return;
    if (S.mode === 'flashcard' && !S.flashRevealed) return;
    startX = e.type.includes('mouse') ? e.pageX : e.touches[0].clientX;
    isDragging = true;
    qCard.classList.add('dragging');
    qCard.classList.add('dragging-active');
  };

  const handleDragMove = (e) => {
    if (!isDragging) return;
    if (e.cancelable) e.preventDefault();
    const x = e.type.includes('mouse') ? e.pageX : e.touches[0].clientX;
    currentX = x - startX;
    const rotate = currentX * 0.05;
    qCard.style.transform = `translateX(${currentX}px) rotate(${rotate}deg)`;
    
    const opacity = Math.min(Math.abs(currentX) / 100, 1);
    const leftInd = qCard.querySelector('.swipe-indicator.left');
    const rightInd = qCard.querySelector('.swipe-indicator.right');
    if (currentX > 0) {
      if(rightInd) rightInd.style.opacity = opacity;
      if(leftInd) leftInd.style.opacity = 0;
    } else {
      if(leftInd) leftInd.style.opacity = opacity;
      if(rightInd) rightInd.style.opacity = 0;
    }
  };

  const handleDragEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    qCard.classList.remove('dragging');
    qCard.classList.remove('dragging-active');
    
    const leftInd = qCard.querySelector('.swipe-indicator.left');
    const rightInd = qCard.querySelector('.swipe-indicator.right');
    
    if (Math.abs(currentX) > 100) {
      const isKnown = currentX > 0;
      qCard.style.transform = `translateX(${currentX > 0 ? 1000 : -1000}px) rotate(${currentX * 0.1}deg)`;
      qCard.style.opacity = '0';
      qCard.classList.add('answered');
      
      setTimeout(() => {
        const q = S.questions[S.idx];
        const isCorrect = isKnown;
        // Blitz / flashcard swipe is self-reported (swipe right = "I know")
        // and does NOT contribute to Attempts / Accuracy / Readiness — those
        // are reserved for MCQ-graded answers via recordAnswer. Only mastery
        // (spaced repetition schedule) is touched.
        if(typeof updateMastery === 'function') updateMastery(q, isCorrect);
        if (isCorrect) S.correct++;
        else S.sessionWrongQuestions.push(getQuestionKey(q));
        if(typeof updateGlobalStats === 'function') updateGlobalStats();
        
        S.idx++;
        qCard.style.transform = '';
        qCard.style.opacity = '1';
        if(leftInd) leftInd.style.opacity = 0;
        if(rightInd) rightInd.style.opacity = 0;
        if(S.idx >= S.questions.length) {
          if(typeof finishQuiz === 'function') finishQuiz();
        } else {
          if(typeof renderQuestion === 'function') renderQuestion();
        }
      }, 300);
    } else {
      qCard.style.transform = '';
      if(leftInd) leftInd.style.opacity = 0;
      if(rightInd) rightInd.style.opacity = 0;
    }
    currentX = 0;
  };

  qCard.addEventListener('mousedown', handleDragStart);
  qCard.addEventListener('touchstart', handleDragStart, {passive: true});
  window.addEventListener('mousemove', handleDragMove);
  qCard.addEventListener('touchmove', handleDragMove, {passive: false});
  window.addEventListener('mouseup', handleDragEnd);
  window.addEventListener('touchend', handleDragEnd);
});



// ══ Weak Questions Screen ══════════════════════════════════
function getTopWeakQuestions(limit) {
  limit = limit || 10;
  var statsMap = getQuestionStatsMap();
  return Object.entries(statsMap)
    .filter(function(e) { return (e[1].total || 0) >= 3; })
    .map(function(e) {
      var s = e[1];
      var accuracy = s.total > 0 ? Math.round((s.correct / s.total) * 100) : 100;
      return Object.assign({ key: e[0], accuracy: accuracy }, s);
    })
    .sort(function(a, b) { return a.accuracy - b.accuracy || (b.wrongStreak || 0) - (a.wrongStreak || 0); })
    .slice(0, limit);
}

// Persistent set of question keys the user has explicitly dismissed from
// the weak list ("I know this one, stop nagging"). Stored as JSON array
// in localStorage; the dashboard filters them out before rendering.
var WEAK_RESOLVED_KEY = 'eq_weak_resolved_v1';
function loadWeakResolved() {
  try {
    var raw = localStorage.getItem(WEAK_RESOLVED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (_) { return new Set(); }
}
function saveWeakResolved(set) {
  try { localStorage.setItem(WEAK_RESOLVED_KEY, JSON.stringify(Array.from(set))); }
  catch (_) {}
}
function markWeakResolved(key) {
  var s = loadWeakResolved(); s.add(key); saveWeakResolved(s);
}
function unmarkWeakResolved(key) {
  var s = loadWeakResolved(); s.delete(key); saveWeakResolved(s);
}

// All questions matching the "weak" criteria (accuracy < 70%, attempts >= 3,
// not in the resolved set). Each entry is enriched with section_key /
// section_label / version / language / exam from the live DB so we can
// group + filter without extra lookups.
var WEAK_ACCURACY_THRESHOLD = 80;
function getWeakQuestions(filters) {
  filters = filters || {};
  var statsMap = getQuestionStatsMap();
  var resolved = loadWeakResolved();
  var leitnerMap = (loadStore() || {}).leitner || {};
  var qByKey = {};
  if (S.db) {
    Object.keys(S.db.exams || {}).forEach(function(exam) {
      (S.db.exams[exam].questions || []).forEach(function(q) {
        qByKey[getQuestionKey(q)] = { exam: exam, q: q };
      });
    });
  }
  var out = [];
  Object.keys(statsMap).forEach(function(k) {
    var isResolved = resolved.has(k);
    if (isResolved && !filters.includeResolved) return;
    var s = statsMap[k];
    var total = s.total || 0;
    var acc = total > 0 ? Math.round((s.correct / total) * 100) : 100;
    var leitnerEntry = leitnerMap[k];
    var box = (leitnerEntry && Number(leitnerEntry.box)) || 0;
    // Box 1 = the SRS scheduler just demoted this card (last answer wrong),
    // so the question is weak right now regardless of historical accuracy.
    // For boxes 2-5 (and never-practiced box 0) keep the strict filter:
    // need at least 3 attempts AND historical accuracy below the threshold.
    if (box !== 1) {
      if (total < 3) return;
      if (acc >= WEAK_ACCURACY_THRESHOLD) return;
    }
    var ref = qByKey[k];
    if (!ref) return; // question removed from DB
    var q = ref.q;
    if (filters.exam && ref.exam !== filters.exam) return;
    if (filters.version && filters.version !== 'all' && (q.version || 'gen1') !== filters.version) return;
    if (filters.lang && filters.lang !== 'all' && (q.language || 'ru') !== filters.lang) return;
    if (filters.section && filters.section !== 'all' && (q.section_key || 'unknown') !== filters.section) return;
    if (filters.accuracyBucket && filters.accuracyBucket !== 'all') {
      var ab = WEAK_ACCURACY_BUCKETS[filters.accuracyBucket];
      if (ab && (acc < ab.min || acc >= ab.max)) return;
    }
    if (filters.box && filters.box !== 'all') {
      // box filter is a numeric box (1..5). box 0 == never practiced; excluded
      // whenever a specific box is requested.
      if (box !== Number(filters.box)) return;
    }
    out.push({
      key: k,
      exam: ref.exam,
      examCode: q.exam_code || ref.exam,
      questionId: q.id || k,
      seq: (typeof q.seq === 'number' && q.seq > 0) ? q.seq : null,
      accuracy: acc,
      total: total,
      correct: s.correct || 0,
      wrongStreak: s.wrongStreak || 0,
      title: q.title || s.title || k,
      domain: q.domain || s.domain || '',
      sectionKey: q.section_key || 'unknown',
      sectionLabel: q.section_label || q.section_key || 'Unknown',
      version: q.version || 'gen1',
      language: q.language || 'ru',
      lesson: q.lesson || '',
      box: box,
      isResolved: isResolved,
    });
  });
  // Active questions first (sorted by worst), then resolved at the end.
  out.sort(function(a, b) {
    if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1;
    return a.accuracy - b.accuracy || b.wrongStreak - a.wrongStreak;
  });
  return out;
}

// Per-screen filter state (independent of the home filters so the user
// can explore weak questions without losing their main practice setup).
var weakFilterState = { version: 'all', lang: 'all', exam: 'all', section: 'all', accuracyBucket: 'all', box: 'all', showHidden: false };

// Half-open intervals — upper bound is exclusive, so a question with
// accuracy=20 falls into "20-39", not "0-19". 80 is the WEAK threshold,
// so the last bucket stops at 80.
var WEAK_ACCURACY_BUCKETS = {
  'lt20':  { min: 0,  max: 20, label: '🔴 0–19%' },
  'lt40':  { min: 20, max: 40, label: '🟠 20–39%' },
  'lt50':  { min: 40, max: 50, label: '🟡 40–49%' },
  'lt60':  { min: 50, max: 60, label: '🟡 50–59%' },
  'lt70':  { min: 60, max: 70, label: '🟢 60–69%' },
  'lt80':  { min: 70, max: 80, label: '🟢 70–79%' },
};

function openWeakQDashboard() {
  document.querySelector('.app:not([id])').style.display = 'none';
  _hideAllAuxScreens('weakQApp');
  $('weakQApp').style.display = 'flex';
  initWeakQSidebar();
  if (typeof updateAppSidebarActive === 'function') updateAppSidebarActive();
  // Seed from home filters on first open of the session.
  weakFilterState.version = S.versionFilter || 'all';
  weakFilterState.lang = S.langFilter || 'all';
  weakFilterState.exam = S.exam || 'all';
  weakFilterState.section = 'all';
  renderSharedExamTabs($('weakGlobalExamTabs'), S.exam, setSharedExam);
  renderWeakQFilters();
  renderWeakQList();
}

function renderWeakQFilters() {
  if (!S.db) return;
  // Versions present anywhere in the DB.
  var versions = new Set(['all']);
  var languages = new Set(['all']);
  Object.values(S.db.exams || {}).forEach(function(ex) {
    (ex.questions || []).forEach(function(q) {
      versions.add(q.version || 'gen1');
      languages.add(q.language || 'ru');
    });
  });
  var langPanel = $('weakLanguagePills');
  var verPanel = $('weakVersionPills');
  function pill(value, label, active) {
    return '<button type="button" class="version-pill' + (active ? ' is-active' : '') +
      '" data-val="' + escapeHtml(value) + '">' + escapeHtml(label) + '</button>';
  }
  if (langPanel) {
    langPanel.innerHTML = Array.from(languages).map(function(v) {
      var label = v === 'all' ? 'All languages' : (v === 'en' ? '🇬🇧 English' : v === 'ru' ? '🇷🇺 Russian' : v);
      return pill(v, label, v === weakFilterState.lang);
    }).join('');
    langPanel.querySelectorAll('button[data-val]').forEach(function(b) {
      b.addEventListener('click', function() {
        weakFilterState.lang = b.getAttribute('data-val');
        renderWeakQFilters();
        renderWeakQList();
      });
    });
  }
  if (verPanel) {
    verPanel.innerHTML = Array.from(versions).map(function(v) {
      var label = v === 'all' ? 'All versions' : v;
      return pill(v, label, v === weakFilterState.version);
    }).join('');
    verPanel.querySelectorAll('button[data-val]').forEach(function(b) {
      b.addEventListener('click', function() {
        weakFilterState.version = b.getAttribute('data-val');
        renderWeakQFilters();
        renderWeakQList();
      });
    });
  }
  // Exam pills — list only exams that actually have weak questions plus
  // "All exams". Selecting an exam scopes both the list AND the retry button.
  var examPanel = $('weakExamPills');
  if (examPanel) {
    var examKeys = Object.keys(S.db.exams || {}).filter(function(code) {
      return typeof isExamAvailable === 'function' ? isExamAvailable(code) : true;
    });
    var examPills = ['all'].concat(examKeys);
    examPanel.innerHTML = examPills.map(function(v) {
      var label = v === 'all' ? 'All exams' : v;
      return pill(v, label, v === weakFilterState.exam);
    }).join('');
    examPanel.querySelectorAll('button[data-val]').forEach(function(b) {
      b.addEventListener('click', function() {
        weakFilterState.exam = b.getAttribute('data-val');
        renderWeakQFilters();
        renderWeakQList();
      });
    });
  }
  // Section pills — render per section_key that has weak questions in the
  // current (exam/version/lang) filter combo. Section pills DO NOT depend
  // on the accuracy bucket, but accuracy pills below DO depend on section,
  // so this block must run first.
  var secPanel = $('weakSectionPills');
  if (secPanel) {
    var secBaseFilters = {
      exam: weakFilterState.exam && weakFilterState.exam !== 'all' ? weakFilterState.exam : null,
      version: weakFilterState.version,
      lang: weakFilterState.lang,
      includeResolved: !!weakFilterState.showHidden,
    };
    var secItems = getWeakQuestions(secBaseFilters);
    var secMap = {};
    secItems.forEach(function(it) {
      var sk = it.sectionKey || 'unknown';
      if (!secMap[sk]) secMap[sk] = { label: it.sectionLabel || sk, count: 0 };
      secMap[sk].count++;
    });
    var sortedSections = Object.keys(secMap).sort(function(a, b) {
      return secMap[b].count - secMap[a].count;
    });
    var secPills = [{ key: 'all', label: 'All sections (' + secItems.length + ')' }]
      .concat(sortedSections.map(function(k) {
        return { key: k, label: secMap[k].label + ' (' + secMap[k].count + ')' };
      }));
    secPanel.innerHTML = secPills.map(function(p) {
      return pill(p.key, p.label, p.key === weakFilterState.section);
    }).join('');
    secPanel.querySelectorAll('button[data-val]').forEach(function(b) {
      b.addEventListener('click', function() {
        weakFilterState.section = b.getAttribute('data-val');
        renderWeakQFilters();
        renderWeakQList();
      });
    });
  }
  // Accuracy bucket pills. Counts are computed against the OTHER filters
  // (exam/version/lang/section) so each pill's badge reflects what the user
  // will actually see when they pick it.
  var accPanel = $('weakAccuracyPills');
  if (accPanel) {
    var baseFilters = {
      exam: weakFilterState.exam && weakFilterState.exam !== 'all' ? weakFilterState.exam : null,
      version: weakFilterState.version,
      lang: weakFilterState.lang,
      section: weakFilterState.section,
      includeResolved: !!weakFilterState.showHidden,
    };
    var allItems = getWeakQuestions(baseFilters);
    var counts = { all: allItems.length };
    Object.keys(WEAK_ACCURACY_BUCKETS).forEach(function(bk) { counts[bk] = 0; });
    allItems.forEach(function(it) {
      Object.keys(WEAK_ACCURACY_BUCKETS).forEach(function(bk) {
        var b = WEAK_ACCURACY_BUCKETS[bk];
        if (it.accuracy >= b.min && it.accuracy < b.max) counts[bk]++;
      });
    });
    var accPills = [{ key: 'all', label: 'All' }]
      .concat(Object.keys(WEAK_ACCURACY_BUCKETS).map(function(k) { return { key: k, label: WEAK_ACCURACY_BUCKETS[k].label }; }));
    accPanel.innerHTML = accPills.map(function(p) {
      var lbl = p.label + ' (' + counts[p.key] + ')';
      return pill(p.key, lbl, p.key === weakFilterState.accuracyBucket);
    }).join('');
    accPanel.querySelectorAll('button[data-val]').forEach(function(b) {
      b.addEventListener('click', function() {
        weakFilterState.accuracyBucket = b.getAttribute('data-val');
        renderWeakQFilters();
        renderWeakQList();
      });
    });
  }
  // Leitner box pills — counts respect every other filter (exam/version/
  // lang/section/accuracy). Questions never practiced (box 0) only show up
  // under "All"; specific box pills exclude them by design.
  var boxPanel = $('weakBoxPills');
  if (boxPanel) {
    var boxBaseFilters = {
      exam: weakFilterState.exam && weakFilterState.exam !== 'all' ? weakFilterState.exam : null,
      version: weakFilterState.version,
      lang: weakFilterState.lang,
      section: weakFilterState.section,
      accuracyBucket: weakFilterState.accuracyBucket,
      includeResolved: !!weakFilterState.showHidden,
    };
    var boxItems = getWeakQuestions(boxBaseFilters);
    var boxCounts = { all: boxItems.length, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    boxItems.forEach(function(it) {
      if (it.box >= 1 && it.box <= 5) boxCounts[it.box]++;
    });
    var boxPills = [
      { key: 'all', label: 'All' },
      { key: '1',   label: '📦 Box 1' },
      { key: '2',   label: '📦 Box 2' },
      { key: '3',   label: '📦 Box 3' },
      { key: '4',   label: '📦 Box 4' },
      { key: '5',   label: '📦 Box 5' },
    ];
    boxPanel.innerHTML = boxPills.map(function(p) {
      var lbl = p.label + ' (' + (boxCounts[p.key] || 0) + ')';
      return pill(p.key, lbl, p.key === weakFilterState.box);
    }).join('');
    boxPanel.querySelectorAll('button[data-val]').forEach(function(b) {
      b.addEventListener('click', function() {
        weakFilterState.box = b.getAttribute('data-val');
        renderWeakQFilters();
        renderWeakQList();
      });
    });
  }
  // "Show hidden questions" toggle — counts how many keys live in the
  // resolved set so the user can see how much they've dismissed before
  // deciding to surface them.
  var toggle = $('weakShowHiddenToggle');
  var hiddenCountEl = $('weakHiddenCount');
  if (toggle && hiddenCountEl) {
    toggle.checked = !!weakFilterState.showHidden;
    hiddenCountEl.textContent = String(loadWeakResolved().size);
    toggle.onchange = function() {
      weakFilterState.showHidden = !!toggle.checked;
      renderWeakQList();
    };
  }
}

function closeWeakQDashboard() {
  $('weakQApp').style.display = 'none';
  document.querySelector('.app:not([id])').style.display = 'flex';
  _restoreMainHeader();
}

// Aux screens are separate <div class="app" id="...">, each rendering its
// own page header with a Back button. The body-root #mainHeader is hidden
// while any aux is open (otherwise its dropdown would land on top of the
// aux page-header strip), then restored on close.
var AUX_APP_IDS = [
  'weakQApp', 'topicsApp', 'favoritesApp', 'allQuestionsApp',
  'adminApp', 'statsV2App', 'homeV2App', 'profileApp', 'referencesApp',
  'hotkeysApp'
];
function _hideAllAuxScreens(except) {
  AUX_APP_IDS.forEach(function(id) {
    if (id === except) return;
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  var hdr = document.getElementById('mainHeader');
  if (hdr) hdr.classList.toggle('hidden', !!except);
}
function _restoreMainHeader() {
  var hdr = document.getElementById('mainHeader');
  if (hdr) hdr.classList.remove('hidden');
}

// Open clicked question image in a fullscreen lightbox. Click anywhere or
// press Escape to close. Reused for any q-image throughout the app.
function openImageLightbox(src, alt) {
  if (!src) return;
  // If a lightbox is already open, replace its content instead of stacking
  var existing = document.querySelector('.q-lightbox');
  if (existing) existing.remove();

  var lb = document.createElement('div');
  lb.className = 'q-lightbox';
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-label', 'Image preview');

  var img = document.createElement('img');
  img.src = src;
  img.alt = alt || '';
  img.addEventListener('click', function(e) { e.stopPropagation(); });

  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'q-lightbox-close';
  closeBtn.setAttribute('aria-label', 'Close image preview');
  closeBtn.textContent = '×';

  lb.appendChild(closeBtn);
  lb.appendChild(img);
  document.body.appendChild(lb);

  function close() {
    lb.remove();
    document.removeEventListener('keydown', escHandler);
  }
  function escHandler(e) {
    if (e.key === 'Escape') close();
  }
  lb.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', escHandler);
}

function openReferences() {
  document.querySelector('.app:not([id])').style.display = 'none';
  _hideAllAuxScreens('referencesApp');
  $('referencesApp').style.display = 'flex';
  var content = $('referencesApp').querySelector('.references-content');
  if (content) content.scrollTop = 0;
  initReferencesToc();
  if (typeof updateAppSidebarActive === 'function') updateAppSidebarActive();
}

function closeReferences() {
  $('referencesApp').style.display = 'none';
  document.querySelector('.app:not([id])').style.display = 'flex';
  _restoreMainHeader();
}

// Wire TOC clicks to smooth-scroll within the content panel and observe
// section visibility to highlight the active TOC entry. Idempotent — safe
// to call every time the page opens.
var referencesTocInited = false;
function initReferencesToc() {
  if (referencesTocInited) return;
  referencesTocInited = true;
  var content = $('referencesApp').querySelector('.references-content');
  var tocLinks = Array.from(document.querySelectorAll('#referencesToc a[data-toc]'));
  if (!content || tocLinks.length === 0) return;

  // Click → smooth-scroll target into view. Uses scrollIntoView so it works
  // regardless of which ancestor is the actual scroll container (after we
  // hoisted the main header out of .app, body became the scroller in some
  // layouts). scroll-margin-top on heading elements compensates for the
  // sticky header so headings don't end up hidden beneath it.
  tocLinks.forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      var hash = a.getAttribute('href') || '';
      if (!hash.startsWith('#')) return;
      var target = document.getElementById(hash.slice(1));
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Highlight active section via IntersectionObserver
  var sectionIds = tocLinks
    .map(function(a) { return (a.getAttribute('href') || '').slice(1); })
    .filter(Boolean);
  var sections = sectionIds
    .map(function(id) { return document.getElementById(id); })
    .filter(Boolean);
  if (sections.length === 0) return;

  var setActive = function(id) {
    tocLinks.forEach(function(a) {
      a.classList.toggle('active', a.getAttribute('href') === '#' + id);
    });
  };
  var io = new IntersectionObserver(function(entries) {
    var visible = entries.filter(function(e) { return e.isIntersecting; });
    if (visible.length === 0) return;
    visible.sort(function(a, b) { return a.target.offsetTop - b.target.offsetTop; });
    setActive(visible[0].target.id);
  }, { root: content, rootMargin: '0px 0px -65% 0px', threshold: 0 });
  sections.forEach(function(s) { io.observe(s); });
}

// Toggles the admin-tools section inside My Profile. Called both during
// initial home wiring AND from the auth callback after isPremium is set,
// because timing of those two events can vary.
function syncAdminToolsVisibility() {
  var adminTools = $('profileAdminTools');
  if (adminTools) {
    if (isPremium) adminTools.classList.remove('hidden');
    else adminTools.classList.add('hidden');
  }
  // Question feedback entry moved into the Profile → Admin tools block;
  // its visibility piggybacks on #profileAdminTools (toggled above).
}

// Cached Chart.js instances for the weak-questions screen — destroyed on
// every render to free up canvas/data; otherwise Chart.js leaks listeners.
var weakSectionChartInstance = null;
var weakSeverityChartInstance = null;

function renderWeakCharts(items) {
  var wrap = $('weakChartsWrap');
  if (!wrap) return;
  if (weakSectionChartInstance) { weakSectionChartInstance.destroy(); weakSectionChartInstance = null; }
  if (weakSeverityChartInstance) { weakSeverityChartInstance.destroy(); weakSeverityChartInstance = null; }
  if (!items || !items.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'grid';

  // 1) Weak-question count by section + avg error rate per section.
  //    Top 8 sections shown; rest collapsed.
  var bySection = {};
  items.forEach(function(it) {
    var label = it.sectionLabel || it.sectionKey || 'Unknown';
    if (!bySection[label]) bySection[label] = { count: 0, accSum: 0 };
    bySection[label].count += 1;
    bySection[label].accSum += (typeof it.accuracy === 'number' ? it.accuracy : 0);
  });
  var secEntries = Object.keys(bySection).map(function(k) {
    var s = bySection[k];
    var avgAcc = s.count ? Math.round(s.accSum / s.count) : 0;
    return { label: k, count: s.count, errPct: 100 - avgAcc };
  }).sort(function(a, b) { return b.count - a.count; });
  var secTop = secEntries.slice(0, 8);
  var secLabels = secTop.map(function(e) { return e.label; });
  var secValues = secTop.map(function(e) { return e.count; });
  var secErrs = secTop.map(function(e) { return e.errPct; });

  var secCanvas = document.getElementById('weakSectionChart');
  if (secCanvas && typeof Chart !== 'undefined') {
    var weakSectionLabelsPlugin = {
      id: 'weakSectionLabels',
      afterDatasetsDraw: function(chart) {
        var meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data) return;
        var ctx = chart.ctx;
        ctx.save();
        ctx.font = '600 10px ui-monospace,SFMono-Regular,Menlo,monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        meta.data.forEach(function(bar, i) {
          if (!bar) return;
          var n = secValues[i];
          var err = secErrs[i];
          if (n == null) return;
          var label = n + ' · ' + err + '% err';
          var x = bar.x + 6;
          var y = bar.y;
          ctx.fillStyle = '#fca5a5';
          ctx.fillText(label, x, y);
        });
        ctx.restore();
      },
    };

    weakSectionChartInstance = new Chart(secCanvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: secLabels,
        datasets: [{
          label: 'Weak Qs',
          data: secValues,
          backgroundColor: 'rgba(239,68,68,0.55)',
          borderColor: 'rgba(239,68,68,0.9)',
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { right: 80 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                var i = ctx.dataIndex;
                return secValues[i] + ' weak Qs · ' + secErrs[i] + '% avg error';
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#94a3b8', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#cbd5e1', font: { size: 11 } }, grid: { display: false } },
        },
      },
      plugins: [weakSectionLabelsPlugin],
    });
  }

  // 2) Severity distribution: critical (<30%), hard (30-49%), borderline (50-69%).
  var sev = { critical: 0, hard: 0, borderline: 0 };
  items.forEach(function(it) {
    if (it.accuracy < 30)      sev.critical++;
    else if (it.accuracy < 50) sev.hard++;
    else                       sev.borderline++;
  });
  var sevCanvas = document.getElementById('weakSeverityChart');
  if (sevCanvas && typeof Chart !== 'undefined') {
    weakSeverityChartInstance = new Chart(sevCanvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['🔥 Critical (<30%)', '⚠️ Hard (30–49%)', '📉 Borderline (50–69%)'],
        datasets: [{
          data: [sev.critical, sev.hard, sev.borderline],
          backgroundColor: ['rgba(239,68,68,0.85)', 'rgba(234,179,8,0.85)', 'rgba(99,102,241,0.85)'],
          borderColor: 'rgba(15,23,42,1)',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#cbd5e1', font: { size: 11 }, padding: 10, boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                var total = ctx.dataset.data.reduce(function(a, b) { return a + b; }, 0);
                var pct = total ? Math.round((ctx.parsed / total) * 100) : 0;
                return ctx.label + ': ' + ctx.parsed + ' (' + pct + '%)';
              },
            },
          },
        },
        cutout: '55%',
      },
    });
  }
}

function renderWeakQList() {
  var filters = {
    // 'all' on the screen means "no exam filter" — pass null to getWeakQuestions
    // so it returns weak questions across every exam.
    exam: weakFilterState.exam && weakFilterState.exam !== 'all' ? weakFilterState.exam : null,
    version: weakFilterState.version,
    lang: weakFilterState.lang,
    section: weakFilterState.section,
    accuracyBucket: weakFilterState.accuracyBucket,
    box: weakFilterState.box,
    includeResolved: !!weakFilterState.showHidden,
  };
  var items = getWeakQuestions(filters);
  var list = $('weakQList');
  var startBtn = $('weakQStartBtn');
  var summary = $('weakQSummary');

  // Stats reflect ACTIVE weak questions only (resolved ones are hidden by
  // default). Avg accuracy is computed over the active subset.
  var activeItems = items.filter(function(i) { return !i.isResolved; });
  var totalTracked = Object.values(getQuestionStatsMap()).filter(function(s) { return (s.total || 0) >= 3; }).length;
  var avgAccuracy = activeItems.length ? Math.round(activeItems.reduce(function(a, i) { return a + i.accuracy; }, 0) / activeItems.length) : 0;
  summary.innerHTML = [
    { label: 'Tracked', val: totalTracked },
    { label: 'Weak in filter', val: activeItems.length },
    { label: 'Avg. accuracy', val: activeItems.length ? avgAccuracy + '%' : '—' }
  ].map(function(c) { return '<div class="stat-card"><div class="stat-val">' + c.val + '</div><div class="stat-label">' + c.label + '</div></div>'; }).join('');

  if (!items.length) {
    list.innerHTML = '<div class="home-panel" style="padding:32px;text-align:center;color:var(--text-muted)">'
      + '<div style="font-size:2.5rem;margin-bottom:12px">🎉</div>'
      + '<div style="font-weight:600;margin-bottom:6px">No weak questions in this filter.</div>'
      + '<div style="font-size:0.85rem">Try a different version/language, or keep practicing — questions you got wrong recently (Box 1) or with accuracy below ' + WEAK_ACCURACY_THRESHOLD + '% (after 3+ attempts) will show up here.</div>'
      + '</div>';
    startBtn.disabled = true;
    startBtn.textContent = '🔁 Retry these questions';
    renderWeakCharts(activeItems);
    return;
  }
  renderWeakCharts(activeItems);

  // Group by section_key.
  var groups = {};
  items.forEach(function(it) {
    var k = it.sectionKey;
    if (!groups[k]) groups[k] = { label: it.sectionLabel, items: [] };
    groups[k].items.push(it);
  });
  var groupOrder = Object.keys(groups).sort(function(a, b) {
    // Worst-accuracy section first
    var aAvg = groups[a].items.reduce(function(s, i) { return s + i.accuracy; }, 0) / groups[a].items.length;
    var bAvg = groups[b].items.reduce(function(s, i) { return s + i.accuracy; }, 0) / groups[b].items.length;
    return aAvg - bAvg;
  });

  list.innerHTML = groupOrder.map(function(sk) {
    var g = groups[sk];
    var sectionAvg = Math.round(g.items.reduce(function(s, i) { return s + i.accuracy; }, 0) / g.items.length);
    var rowsHtml = g.items.map(function(item, i) {
      var accColor = item.accuracy >= 70 ? '#22c55e' : item.accuracy >= 50 ? '#eab308' : '#ef4444';
      var accBg = item.accuracy >= 70 ? 'rgba(34,197,94,0.12)' : item.accuracy >= 50 ? 'rgba(234,179,8,0.12)' : 'rgba(239,68,68,0.12)';
      var streakBadge = (item.wrongStreak || 0) > 1 ? '<span style="font-size:0.7rem;background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 6px;border-radius:99px;margin-left:6px">🔴 ' + item.wrongStreak + ' in a row</span>' : '';
      var versionBadge = '<span style="font-size:0.65rem;background:rgba(99,102,241,0.15);color:#a5b4fc;padding:2px 6px;border-radius:99px;margin-left:6px;text-transform:uppercase">' + escapeHtml(item.version) + '</span>';
      var idPrefix = (typeof EXAM_SHORT_PREFIX !== 'undefined' && EXAM_SHORT_PREFIX[item.examCode]) || '';
      var idDisplay = item.seq ? ('#' + item.seq) : (item.questionId || '');
      var idCopy = (item.seq && idPrefix) ? (idPrefix + '_' + item.seq) : (item.questionId || idDisplay);
      var idBadge = idDisplay
        ? '<button type="button" class="weak-row-id-badge" data-copy-id="' + escapeHtml(idCopy) + '" title="Click to copy: ' + escapeHtml(idCopy) + '" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.65rem;background:rgba(255,255,255,0.05);color:var(--text-muted);border:1px solid var(--border-light);padding:2px 7px;border-radius:99px;margin-left:6px;cursor:pointer;font-weight:600">' + escapeHtml(idDisplay) + '</button>'
        : '';
      var hiddenBadge = item.isResolved ? '<span style="font-size:0.65rem;background:rgba(255,255,255,0.08);color:var(--text-muted);padding:2px 6px;border-radius:99px;margin-left:6px;text-transform:uppercase">hidden</span>' : '';
      var titleText = item.title || item.domain || item.key;
      var qExam = item.exam || S.exam || '';
      var rowClass = 'weak-row' + (item.isResolved ? ' is-resolved' : '');
      var actionBtn = item.isResolved
        ? '<button class="weak-row-resolve weak-row-restore" data-restore-key="' + escapeHtml(item.key) + '" title="Restore (return to active list)" aria-label="Restore">↻</button>'
        : '<button class="weak-row-resolve" data-resolve-key="' + escapeHtml(item.key) + '" title="Mark as resolved (hide from this list)" aria-label="Mark resolved">✓</button>';
      return '<div class="' + rowClass + '" data-weak-key="' + escapeHtml(item.key) + '" data-weak-exam="' + escapeHtml(qExam) + '">'
        + '<div class="weak-row-num">' + (i + 1) + '</div>'
        + '<div class="weak-row-meta"><div class="weak-row-title">' + escapeHtml(titleText) + '</div>'
        + '<div class="weak-row-sub">' + (item.total || 0) + '× seen' + streakBadge + idBadge + versionBadge + hiddenBadge + '</div></div>'
        + '<div class="weak-row-acc" style="background:' + accBg + ';color:' + accColor + '">' + item.accuracy + '%</div>'
        + actionBtn
        + '</div>';
    }).join('');
    return '<div class="weak-group home-panel is-collapsed" style="padding:0;overflow:hidden">'
      + '<button type="button" class="weak-group-head" aria-expanded="false">'
      + '<span class="weak-group-caret" aria-hidden="true">▸</span>'
      + '<span class="weak-group-title">' + escapeHtml(g.label) + '</span>'
      + '<span class="weak-group-meta">' + g.items.length + ' weak · ' + sectionAvg + '% avg</span>'
      + '</button>'
      + '<div class="weak-group-rows">' + rowsHtml + '</div>'
      + '</div>';
  }).join('');

  // Section header toggle — collapse/expand the rows under each section.
  list.querySelectorAll('.weak-group').forEach(function(group) {
    var head = group.querySelector('.weak-group-head');
    if (!head) return;
    head.addEventListener('click', function() {
      var willOpen = group.classList.contains('is-collapsed');
      group.classList.toggle('is-collapsed', !willOpen);
      head.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
  });

  // Row click → preview question modal. The resolve button stops propagation.
  list.querySelectorAll('.weak-row').forEach(function(row) {
    row.addEventListener('click', function(e) {
      if (e.target.closest('.weak-row-resolve') || e.target.closest('.weak-row-id-badge')) return;
      openQuestionPreviewByKey(row.getAttribute('data-weak-exam') || S.exam, row.getAttribute('data-weak-key'));
    });
  });
  list.querySelectorAll('.weak-row-id-badge').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var copyVal = btn.getAttribute('data-copy-id') || btn.textContent;
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(copyVal).then(function() {
        var orig = btn.style.background;
        btn.style.background = 'var(--accent, #06b6d4)';
        btn.style.color = '#000';
        setTimeout(function() { btn.style.background = orig; btn.style.color = ''; }, 800);
      }).catch(function() {});
    });
  });
  list.querySelectorAll('.weak-row-resolve').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var resolveK = btn.getAttribute('data-resolve-key');
      var restoreK = btn.getAttribute('data-restore-key');
      if (resolveK) markWeakResolved(resolveK);
      else if (restoreK) unmarkWeakResolved(restoreK);
      else return;
      // Re-render filter row too so the "Show hidden (N)" counter updates.
      renderWeakQFilters();
      renderWeakQList();
    });
  });

  // Retry only acts on ACTIVE (non-resolved) questions — even when "Show
  // hidden" is on, we don't drag resolved cards back into a session unless
  // the user explicitly restores them first.
  startBtn.disabled = activeItems.length === 0;
  startBtn.textContent = '🔁 Retry all (' + activeItems.length + ' filtered)';
  startBtn.onclick = function() {
    var byExam = {};
    activeItems.forEach(function(i) { (byExam[i.exam] = byExam[i.exam] || []).push(i.key); });
    var examCodes = Object.keys(byExam);
    if (!examCodes.length) return;
    var targetExam;
    if (weakFilterState.exam !== 'all') {
      targetExam = weakFilterState.exam;
    } else if (examCodes.length === 1) {
      targetExam = examCodes[0];
    } else {
      // Pick exam with the most weak questions; tell the user.
      examCodes.sort(function(a, b) { return byExam[b].length - byExam[a].length; });
      targetExam = examCodes[0];
      var rest = examCodes.slice(1).map(function(c) { return byExam[c].length + ' in ' + c; }).join(', ');
      if (!confirm('Retry will run for ' + targetExam + ' (' + byExam[targetExam].length + ' questions). ' +
                   'Other weak questions stay in the list (' + rest + '). Continue?')) return;
    }
    var keys = byExam[targetExam];
    var qs = restoreQuestionsByKeys(targetExam, keys);
    if (!qs.length) { alert('Could not find questions in ' + targetExam + '.'); return; }
    S.exam = targetExam;
    closeWeakQDashboard();
    startPreparedSession(qs, { exam: targetExam, mode: 'smart', section: 'all',
      sectionQuestionCount: S.sectionQuestionCount, sectionTimerMinutes: 0,
      practiceQuestionCount: S.practiceQuestionCount, mockNum: null, csLabel: null, source: 'weak_questions' });
  };

  // Wrong-answer patterns panel — surfaced on this page (moved from
  // My Statistics v1). Filtered to the currently-active exam.
  if (typeof renderWrongPicks === 'function') {
    const examForPicks = (weakFilterState.exam && weakFilterState.exam !== 'all')
      ? weakFilterState.exam
      : null;
    try { renderWrongPicks(examForPicks); } catch (_) {}
  }
}

// ══ Streak Reminder Banner ═════════════════════════════════
function maybeShowStreakBanner() {
  if (sessionStorage.getItem('streakBannerShown')) return;
  var store = loadStore();
  var dailyStats = store.dailyStats || {};
  var today = new Date().toISOString().split('T')[0];
  var todayCount = dailyStats[today] || 0;
  if (todayCount >= 5) return;
  var streak = 0;
  var d = new Date(); d.setUTCHours(0,0,0,0);
  for (var i = 1; i <= 60; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    var ds = d.toISOString().split('T')[0];
    if ((dailyStats[ds] || 0) >= 5) { streak++; } else { break; }
  }
  if (streak === 0) {
    // Streak broken — clear milestone-fired marker so the next run-up can
    // re-emit events at the same thresholds.
    try { localStorage.removeItem('eq_streak_milestone_fired_v1'); } catch (_) {}
    return;
  }
  // ── Phase 4.1 event: streak milestone — fire once per threshold per run.
  // Thresholds 3/7/14/30 days. Stored marker = highest threshold already
  // emitted, so re-runs of the same banner don't duplicate. ──
  try {
    const thresholds = [3, 7, 14, 30];
    const fired = parseInt(localStorage.getItem('eq_streak_milestone_fired_v1') || '0', 10) || 0;
    const reached = thresholds.filter(t => streak >= t && t > fired);
    if (reached.length) {
      const highest = reached[reached.length - 1];
      localStorage.setItem('eq_streak_milestone_fired_v1', String(highest));
      window.cloudSync?.logEvent?.('streak_milestone', {
        days: streak,
        threshold: highest,
      });
    }
  } catch (_) {}
  sessionStorage.setItem('streakBannerShown', '1');
  var remaining = Math.max(0, 5 - todayCount);
  var daysWord = streak === 1 ? 'day' : 'days';
  var banner = document.createElement('div');
  banner.id = 'streakBanner';
  banner.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;padding:12px 20px;border-radius:14px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);z-index:9999;max-width:340px;width:calc(100% - 32px)';
  banner.innerHTML = '<div style="font-size:1.5rem">🔥</div>'
    + '<div style="flex:1"><div style="font-weight:700;font-size:0.9rem">Streak: ' + streak + ' ' + daysWord + '!</div>'
    + '<div style="font-size:0.78rem;opacity:0.9">' + remaining + ' more questions today to keep it</div></div>'
    + '<button onclick="document.getElementById(\'streakBanner\').remove()" style="background:rgba(255,255,255,0.2);border:none;color:#fff;border-radius:8px;padding:4px 8px;cursor:pointer;font-size:0.8rem">✕</button>';
  document.body.appendChild(banner);
  setTimeout(function() { var b = document.getElementById('streakBanner'); if (b) b.remove(); }, 8000);
}

// ══ Topics-by-exam dashboard ═══════════════════════════════
// Filter state for the topics page. Mirrors WEAK_ACCURACY_BUCKETS values:
// 'all' | 'lt20' | 'lt40' | 'lt50' | 'lt60' | 'lt70' | 'lt80'.
var topicsAccuracyBucket = 'all';
// Leitner box filter: 'all' | '1' | '2' | '3' | '4' | '5'. Specific box
// excludes questions never put on the ladder (box 0).
var topicsBoxFilter = 'all';

function openTopicsDashboard() {
  document.querySelector('.app:not([id])').style.display = 'none';
  _hideAllAuxScreens('topicsApp');
  $('topicsApp').style.display = 'flex';
  initTopicsSidebar();
  if (typeof updateAppSidebarActive === 'function') updateAppSidebarActive();
  initTopicsExamSelect();
  initTopicsStartControls();
  renderTopicsLangPanel();
  renderTopicsVersionPanel();
  // Seed Topics' own select from S.exam so the shared tabs and the inline select agree.
  var topicsSel = $('topicsExamSelect');
  if (topicsSel && S.exam) {
    var has = Array.prototype.some.call(topicsSel.options, function(o) { return o.value === S.exam; });
    if (has) topicsSel.value = S.exam;
  }
  renderSharedExamTabs($('topicsGlobalExamTabs'), S.exam, setSharedExam);
  renderTopicsList($('topicsExamSelect').value);
}

function renderTopicsLangPanel() {
  var panel = $('topicsLangPanel');
  var pills = $('topicsLangPills');
  if (!panel || !pills) return;
  var langs = (typeof getAvailableLanguages === 'function') ? getAvailableLanguages() : [];
  if (langs.length < 2) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  var current = S.langFilter || 'all';
  var LABELS = { all: 'All languages', ru: '🇷🇺 Russian', en: '🇬🇧 English' };
  var buttons = [{ value: 'all', label: LABELS.all }].concat(
    langs.map(function(v) { return { value: v, label: LABELS[v] || v }; })
  );
  pills.innerHTML = buttons.map(function(b) {
    var active = b.value === current ? ' is-active' : '';
    return '<button type="button" class="version-pill' + active + '" data-lang="' + escapeHtml(b.value) + '">' + escapeHtml(b.label) + '</button>';
  }).join('');
  pills.querySelectorAll('button[data-lang]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var next = btn.getAttribute('data-lang');
      if (!next || next === S.langFilter) return;
      S.langFilter = next;
      saveLangFilter(next);
      pills.querySelectorAll('button[data-lang]').forEach(function(b) {
        b.classList.toggle('is-active', b.getAttribute('data-lang') === next);
      });
      renderTopicsList($('topicsExamSelect').value);
    });
  });
}

// Build the per-question accuracy distribution for the active filters and
// render pill buttons. Each pill's count = number of *questions* whose
// accuracy falls in that bucket. The "All" pill counts the full pool
// (every question available under the active version/language filters,
// regardless of whether the user has answered it).
function getTopicsBucketPool(examCode, qStats, versionFilter, langFilter, lessonFilter, bucketKey) {
  var pool = [];
  var dbExam = (S.db && S.db.exams && S.db.exams[examCode]) || null;
  if (!dbExam || !Array.isArray(dbExam.questions)) return pool;
  var bucket = bucketKey && bucketKey !== 'all' ? WEAK_ACCURACY_BUCKETS[bucketKey] : null;
  dbExam.questions.forEach(function(q) {
    if (!q || !q.id) return;
    if (versionFilter !== 'all' && (q.version || 'gen1') !== versionFilter) return;
    if (langFilter !== 'all' && (q.language || 'ru') !== langFilter) return;
    if (lessonFilter && lessonFilter !== 'all' && String(q.lesson || '') !== String(lessonFilter)) return;
    if (!bucket) { pool.push(q); return; }
    var entry = qStats && qStats[q.id];
    var total = entry ? (entry.total || 0) : 0;
    if (total <= 0) return;
    var acc = Math.round(((entry.correct || 0) / total) * 100);
    if (acc >= bucket.min && acc < bucket.max) pool.push(q);
  });
  return pool;
}

function renderTopicsAccuracyPills(examCode, qStats, versionFilter, langFilter, lessonFilter) {
  var panel = $('topicsAccuracyPills');
  if (!panel) return;
  var counts = { all: getTopicsBucketPool(examCode, qStats, versionFilter, langFilter, lessonFilter, 'all').length };
  Object.keys(WEAK_ACCURACY_BUCKETS).forEach(function(bk) {
    counts[bk] = getTopicsBucketPool(examCode, qStats, versionFilter, langFilter, lessonFilter, bk).length;
  });
  var pills = [{ key: 'all', label: 'All' }]
    .concat(Object.keys(WEAK_ACCURACY_BUCKETS).map(function(k) { return { key: k, label: WEAK_ACCURACY_BUCKETS[k].label }; }));
  panel.innerHTML = pills.map(function(p) {
    var lbl = p.label + ' (' + (counts[p.key] || 0) + ')';
    var active = p.key === topicsAccuracyBucket ? ' is-active' : '';
    return '<button type="button" class="version-pill' + active + '" data-bucket="' + escapeHtml(p.key) + '">' + escapeHtml(lbl) + '</button>';
  }).join('');
  panel.querySelectorAll('button[data-bucket]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var next = btn.getAttribute('data-bucket');
      if (!next || next === topicsAccuracyBucket) return;
      topicsAccuracyBucket = next;
      renderTopicsList($('topicsExamSelect').value);
    });
  });
}

// Build box-count map for the active filter context (excluding box itself).
// Returns {all: N, '1': n1, '2': n2, ...}. Box 0 (never on the ladder) does
// not get its own pill — those questions only show under "All".
function getTopicsBoxCounts(examCode, qStats, versionFilter, langFilter, lessonFilter, bucketKey) {
  var counts = { all: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  var dbExam = (S.db && S.db.exams && S.db.exams[examCode]) || null;
  if (!dbExam || !Array.isArray(dbExam.questions)) return counts;
  var leitnerMap = (loadStore() || {}).leitner || {};
  var bucket = bucketKey && bucketKey !== 'all' ? WEAK_ACCURACY_BUCKETS[bucketKey] : null;
  dbExam.questions.forEach(function(q) {
    if (!q || !q.id) return;
    if (versionFilter !== 'all' && (q.version || 'gen1') !== versionFilter) return;
    if (langFilter !== 'all' && (q.language || 'ru') !== langFilter) return;
    if (lessonFilter && lessonFilter !== 'all' && String(q.lesson || '') !== String(lessonFilter)) return;
    if (bucket) {
      var entry = qStats && qStats[q.id];
      var t = entry ? (entry.total || 0) : 0;
      if (t <= 0) return;
      var a = Math.round(((entry.correct || 0) / t) * 100);
      if (a < bucket.min || a >= bucket.max) return;
    }
    counts.all++;
    var le = leitnerMap[q.id];
    var box = (le && Number(le.box)) || 0;
    if (box >= 1 && box <= 5) counts[box]++;
  });
  return counts;
}

function renderTopicsBoxPills(examCode, qStats, versionFilter, langFilter, lessonFilter) {
  var panel = $('topicsBoxPills');
  if (!panel) return;
  var counts = getTopicsBoxCounts(examCode, qStats, versionFilter, langFilter, lessonFilter, topicsAccuracyBucket);
  var pills = [
    { key: 'all', label: 'All' },
    { key: '1',   label: '📦 Box 1' },
    { key: '2',   label: '📦 Box 2' },
    { key: '3',   label: '📦 Box 3' },
    { key: '4',   label: '📦 Box 4' },
    { key: '5',   label: '📦 Box 5' },
  ];
  panel.innerHTML = pills.map(function(p) {
    var lbl = p.label + ' (' + (counts[p.key] || 0) + ')';
    var active = p.key === topicsBoxFilter ? ' is-active' : '';
    return '<button type="button" class="version-pill' + active + '" data-box="' + escapeHtml(p.key) + '">' + escapeHtml(lbl) + '</button>';
  }).join('');
  panel.querySelectorAll('button[data-box]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var next = btn.getAttribute('data-box');
      if (!next || next === topicsBoxFilter) return;
      topicsBoxFilter = next;
      renderTopicsList($('topicsExamSelect').value);
    });
  });
}

function renderTopicsVersionPanel() {
  var panel = $('topicsVersionPanel');
  var pills = $('topicsVersionPills');
  if (!panel || !pills) return;
  var versions = (typeof getAvailableVersions === 'function') ? getAvailableVersions() : [];
  if (versions.length < 2) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  var current = S.versionFilter || 'all';
  var buttons = [{ value: 'all', label: 'All versions' }].concat(
    versions.map(function(v) { return { value: v, label: v }; })
  );
  pills.innerHTML = buttons.map(function(b) {
    var active = b.value === current ? ' is-active' : '';
    return '<button type="button" class="version-pill' + active + '" data-version="' + escapeHtml(b.value) + '">' + escapeHtml(b.label) + '</button>';
  }).join('');
  pills.querySelectorAll('button[data-version]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var next = btn.getAttribute('data-version');
      if (!next || next === S.versionFilter) return;
      S.versionFilter = next;
      saveVersionFilter(next);
      pills.querySelectorAll('button[data-version]').forEach(function(b) {
        b.classList.toggle('is-active', b.getAttribute('data-version') === next);
      });
      renderTopicsList($('topicsExamSelect').value);
    });
  });
}

function closeTopicsDashboard() {
  $('topicsApp').style.display = 'none';
  document.querySelector('.app:not([id])').style.display = 'flex';
  _restoreMainHeader();
}

function initTopicsExamSelect() {
  var sel = $('topicsExamSelect');
  if (!sel) return;
  // Re-populate on every call (not idempotent on dataset.populated) so the
  // dropdown updates when the user toggles Visible Exams in Profile.
  var profiles = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES) ? EXAM_PROFILES : {};
  var codes = getDisplayedExamCodes(Object.keys(profiles));
  sel.innerHTML = codes.map(function(code) {
    return '<option value="' + code + '" style="color:#0f172a;background:#fff">' + escapeHtml(code) + '</option>';
  }).join('');
  var preferred = (S && S.exam && codes.indexOf(S.exam) >= 0) ? S.exam : (codes[0] || 'PL-300');
  sel.value = preferred;
  if (sel.dataset.populated !== '1') {
    sel.addEventListener('change', function() { renderTopicsList(sel.value); });
    sel.dataset.populated = '1';
  }
}

function renderTopicsList(examCode) {
  var list = $('topicsList');
  var summary = $('topicsSummary');
  if (!list || !summary || !examCode) return;
  var profile = (typeof getExamProfile === 'function') ? getExamProfile(examCode) : null;
  var weights = (profile && profile.sectionWeights) || {};
  var labels = (profile && profile.sectionLabels) || {};
  var prefix = examCode + '__';
  var versionFilter = S.versionFilter || 'all';

  var langFilter = S.langFilter || 'all';
  var lessonFilter = topicsTestLesson || 'all';
  var bucketKey = topicsAccuracyBucket && topicsAccuracyBucket !== 'all' ? topicsAccuracyBucket : null;
  var bucket = bucketKey ? WEAK_ACCURACY_BUCKETS[bucketKey] : null;
  var qStats = getQuestionStatsMap();
  var leitnerMap = (loadStore() || {}).leitner || {};
  var boxFilter = topicsBoxFilter && topicsBoxFilter !== 'all' ? Number(topicsBoxFilter) : null;
  // Pool size + unique answered count derive from the live DB filtered by
  // every active control: version, language, lesson, accuracy bucket, and
  // Leitner box. When any non-'all' filter is set, KPIs + section rows
  // recompute against the surviving subset.
  var dbExam = (S.db && S.db.exams && S.db.exams[examCode]) || null;
  var qById = {};
  var poolBySection = {};
  Object.keys(weights).forEach(function(sKey) { poolBySection[sKey] = 0; });
  if (dbExam && Array.isArray(dbExam.questions)) {
    dbExam.questions.forEach(function(q) {
      if (!q || !q.id) return;
      if (versionFilter !== 'all' && (q.version || 'gen1') !== versionFilter) return;
      if (langFilter !== 'all' && (q.language || 'ru') !== langFilter) return;
      if (lessonFilter !== 'all' && String(q.lesson || '') !== String(lessonFilter)) return;
      if (bucket) {
        var e = qStats[q.id];
        var t = e ? (e.total || 0) : 0;
        if (t <= 0) return;
        var a = Math.round(((e.correct || 0) / t) * 100);
        if (a < bucket.min || a >= bucket.max) return;
      }
      if (boxFilter) {
        var le = leitnerMap[q.id];
        var bx = (le && Number(le.box)) || 0;
        if (bx !== boxFilter) return;
      }
      qById[q.id] = q;
      var sKey = q.section_key;
      if (sKey && poolBySection.hasOwnProperty(sKey)) poolBySection[sKey] += 1;
    });
  }

  var sectionAgg; // {sKey: {total, correct, answeredUnique}}
  sectionAgg = {};
  Object.keys(weights).forEach(function(sKey) { sectionAgg[sKey] = { total: 0, correct: 0, answeredUnique: 0 }; });

  if (versionFilter === 'all' && langFilter === 'all' && lessonFilter === 'all' && !bucket && !boxFilter) {
    // Fast path: precomputed sectionStats for total/correct attempts
    var stats = (loadStore().sectionStats) || {};
    Object.keys(weights).forEach(function(sKey) {
      var s = stats[prefix + sKey] || { correct: 0, total: 0 };
      sectionAgg[sKey].total = s.total || 0;
      sectionAgg[sKey].correct = s.correct || 0;
    });
    // answeredUnique still needs per-question scan
    Object.keys(qStats).forEach(function(qid) {
      var entry = qStats[qid];
      if (!entry || (entry.total || 0) <= 0) return;
      if (entry.exam && entry.exam !== examCode) return;
      var q = qById[qid];
      if (!q) return;
      var sKey = q.section_key;
      if (sKey && sectionAgg[sKey]) sectionAgg[sKey].answeredUnique += 1;
    });
  } else {
    // Recompute everything from questionStats — limited to questions that
    // survived the bucket/version/language filters above (qById is already filtered).
    Object.keys(qStats).forEach(function(qid) {
      var entry = qStats[qid];
      if (!entry || (entry.exam && entry.exam !== examCode)) return;
      var q = qById[qid];
      if (!q) return;
      var sKey = q.section_key;
      if (!sKey || !sectionAgg[sKey]) return;
      sectionAgg[sKey].total += entry.total || 0;
      sectionAgg[sKey].correct += entry.correct || 0;
      if ((entry.total || 0) > 0) sectionAgg[sKey].answeredUnique += 1;
    });
  }

  var wilson = (window.readinessEngine && window.readinessEngine.wilsonCI) || null;
  // Pull per-section Readiness scores from the engine once. These are
  // computed across the full unfiltered history of the section (engine
  // doesn't know about active version/lesson/bucket filters), so the
  // tooltip notes "unfiltered" — same number across views.
  var sectionScoreMap = {};
  if (window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function') {
    try {
      var rbForRows = window.readinessEngine.getReadinessBreakdown(examCode) || {};
      var sd = rbForRows.sectionDetails || {};
      Object.keys(sd).forEach(function(k) {
        sectionScoreMap[k] = {
          score: typeof sd[k].score === 'number' ? sd[k].score : null,
          margin: typeof sd[k].scoreMargin === 'number' ? sd[k].scoreMargin : 0,
          hasData: !!sd[k].hasData,
        };
      });
    } catch (e) {}
  }
  var rows = Object.keys(weights).map(function(sKey) {
    var s = sectionAgg[sKey] || { correct: 0, total: 0, answeredUnique: 0 };
    var total = s.total || 0;
    var correct = s.correct || 0;
    var wrong = Math.max(0, total - correct);
    var pct = total > 0 ? Math.round(correct / total * 100) : null;
    var pctMargin = null;
    if (total > 0 && wilson) {
      var ci = wilson(correct, total);
      pctMargin = Math.round(ci.margin * 100);
    }
    var rd = sectionScoreMap[sKey] || { score: null, margin: 0, hasData: false };
    return {
      key: sKey,
      label: labels[sKey] || sKey,
      total: total,
      correct: correct,
      wrong: wrong,
      answeredUnique: s.answeredUnique || 0,
      pool: poolBySection[sKey] || 0,
      pct: pct,
      pctMargin: pctMargin,
      readiness: rd.hasData ? rd.score : null,
      readinessMargin: rd.margin || 0,
    };
  });

  var totalQ = rows.reduce(function(a, r) { return a + r.total; }, 0);
  var totalCorrect = rows.reduce(function(a, r) { return a + r.correct; }, 0);
  var avg = totalQ > 0 ? Math.round(totalCorrect / totalQ * 100) : null;
  // Wilson 95% CI on the aggregate accuracy across all topic rows.
  // Same wilsonCI util used by per-section badges below — consistency
  // matters so the eye doesn't have to translate two different formulas.
  var avgMargin = null;
  if (avg !== null && totalQ > 0 && wilson) {
    avgMargin = Math.round(wilson(totalCorrect, totalQ).margin * 100);
  }
  var readinessVal = null;
  var readinessMargin = 0;
  var readinessMethod = 'wilson';
  if (window.readinessEngine && typeof window.readinessEngine.getReadinessBreakdown === 'function') {
    try {
      var rb = window.readinessEngine.getReadinessBreakdown(examCode);
      if (rb && typeof rb.overall === 'number' && !isNaN(rb.overall)) readinessVal = rb.overall;
      var resolvedT = (typeof resolveReadinessMargin === 'function')
        ? resolveReadinessMargin(examCode, rb && rb.overallMargin)
        : { margin: Number(rb && rb.overallMargin) || 0, method: 'wilson' };
      readinessMargin = resolvedT.margin;
      readinessMethod = resolvedT.method;
    } catch (e) {}
  }
  var totalPool = rows.reduce(function(a, r) { return a + (r.pool || 0); }, 0);
  var totalAnsweredUnique = rows.reduce(function(a, r) { return a + (r.answeredUnique || 0); }, 0);
  var coverageOverall = totalPool > 0 ? Math.round((totalAnsweredUnique / totalPool) * 100) : null;
  var marginSpan = function(text) {
    return ' <span style="font-size:0.62em;font-weight:500;opacity:0.65">' + text + '</span>';
  };
  var accVal = avg === null
    ? '—'
    : avg + '%' + (avgMargin !== null && avgMargin > 0 ? marginSpan('±' + avgMargin + '%') : '');
  var readVal = readinessVal === null
    ? '—'
    : readinessVal + '/100' + (readinessMargin > 0 ? marginSpan('±' + readinessMargin) : '');
  summary.innerHTML = [
    { label: 'Topics', val: rows.length },
    { label: 'Questions', val: totalPool },
    { label: 'Answers', val: totalQ },
    { label: 'Accuracy', val: accVal },
    { label: 'Coverage', val: coverageOverall === null ? '—' : coverageOverall + '%' },
    { label: 'Readiness', val: readVal }
  ].map(function(c) {
    return '<div class="stat-card"><div class="stat-val">' + c.val + '</div><div class="stat-label">' + c.label + '</div></div>';
  }).join('');

  // Worst-first: sections with data first, sorted by accuracy asc; then no-data sections
  rows.sort(function(a, b) {
    if (a.total === 0 && b.total === 0) return 0;
    if (a.total === 0) return 1;
    if (b.total === 0) return -1;
    return (a.pct || 0) - (b.pct || 0);
  });

  // Accuracy pills count QUESTIONS in each bucket given the active
  // version/language/lesson filters. They drive the bucket filter used by
  // both the section list (KPIs+rows recompute) and Start-test pool.
  renderTopicsAccuracyPills(examCode, qStats, versionFilter, langFilter, lessonFilter);
  renderTopicsBoxPills(examCode, qStats, versionFilter, langFilter, lessonFilter);

  if (!rows.length) {
    list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)">No topics for this exam.</div>';
    return;
  }

  var headerStyle = 'font-size:0.66rem;font-weight:700;color:var(--text-muted);letter-spacing:0.08em;text-transform:uppercase;text-align:center;flex-shrink:0';
  var header = '<div style="border-bottom:1px solid var(--border-light);padding:10px 16px;display:flex;align-items:center;gap:12px;background:rgba(255,255,255,0.015)">'
    + '<div style="width:28px;flex-shrink:0"></div>'
    + '<div style="flex:1;min-width:0;' + headerStyle + ';text-align:left">Topic</div>'
    + '<div style="width:64px;' + headerStyle + '">Coverage</div>'
    + '<div style="width:64px;' + headerStyle + '">Readiness</div>'
    + '<div style="width:64px;' + headerStyle + '">Accuracy</div>'
    + '</div>';

  var body = rows.map(function(r, i) {
    var border = i < rows.length - 1 ? 'border-bottom:1px solid var(--border-light);' : '';
    var badgeBase = 'padding:4px 10px;border-radius:99px;font-weight:700;font-size:0.82rem;flex-shrink:0;width:64px;text-align:center;box-sizing:border-box';

    var pctBadge;
    if (r.pct === null) {
      pctBadge = '<div style="' + badgeBase + ';background:rgba(255,255,255,0.05);color:var(--text-muted);font-weight:600;font-size:0.72rem">no data</div>';
    } else {
      var col = r.pct >= 70 ? '#22c55e' : r.pct >= 50 ? '#eab308' : '#ef4444';
      var bg = r.pct >= 70 ? 'rgba(34,197,94,0.12)' : r.pct >= 50 ? 'rgba(234,179,8,0.12)' : 'rgba(239,68,68,0.12)';
      var pctInner = r.pct + '%';
      var pctTitle = '';
      if (r.pctMargin !== null && r.pctMargin > 0) {
        pctInner = '<div style="font-size:0.82rem;font-weight:700;line-height:1.05">' + r.pct + '%</div>'
          + '<div style="font-size:0.58rem;font-weight:500;opacity:0.78;line-height:1;margin-top:1px">±' + r.pctMargin + '%</div>';
        pctTitle = ' title="95% confidence interval: ' + Math.max(0, r.pct - r.pctMargin) + '%–' + Math.min(100, r.pct + r.pctMargin) + '% (n=' + r.total + ')"';
      }
      pctBadge = '<div' + pctTitle + ' style="' + badgeBase + ';background:' + bg + ';color:' + col + ';display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3px 8px">' + pctInner + '</div>';
    }

    var coverage = r.pool > 0 ? Math.round((r.answeredUnique / r.pool) * 100) : null;
    var covBadge;
    if (coverage === null) {
      covBadge = '<div style="' + badgeBase + ';background:rgba(255,255,255,0.05);color:var(--text-muted);font-weight:600;font-size:0.72rem">—</div>';
    } else {
      var covC = coverage >= 50 ? '#22c55e' : coverage >= 20 ? '#eab308' : '#ef4444';
      var covB = coverage >= 50 ? 'rgba(34,197,94,0.12)' : coverage >= 20 ? 'rgba(234,179,8,0.12)' : 'rgba(239,68,68,0.12)';
      covBadge = '<div title="Покрытие: уникально пройдено ' + r.answeredUnique + ' из ' + r.pool + ' вопросов" '
        + 'style="' + badgeBase + ';background:' + covB + ';color:' + covC + '">'
        + coverage + '%</div>';
    }

    // Per-section Readiness badge (unfiltered — full-history score from
    // readinessEngine). Color tint matches STATUS_RULES thresholds
    // (≥75 green, ≥50 amber, <50 red).
    var rBadge;
    if (r.readiness === null) {
      rBadge = '<div style="' + badgeBase + ';background:rgba(255,255,255,0.05);color:var(--text-muted);font-weight:600;font-size:0.72rem">no data</div>';
    } else {
      var rCol = r.readiness >= 75 ? '#22c55e' : r.readiness >= 50 ? '#eab308' : '#ef4444';
      var rBg = r.readiness >= 75 ? 'rgba(34,197,94,0.12)' : r.readiness >= 50 ? 'rgba(234,179,8,0.12)' : 'rgba(239,68,68,0.12)';
      var rInner = String(r.readiness);
      var rTitle = ' title="Section Readiness ' + r.readiness + '/100 (unfiltered, full-history)"';
      if (r.readinessMargin > 0) {
        rInner = '<div style="font-size:0.82rem;font-weight:700;line-height:1.05">' + r.readiness + '</div>'
          + '<div style="font-size:0.58rem;font-weight:500;opacity:0.78;line-height:1;margin-top:1px">±' + r.readinessMargin + '</div>';
        rTitle = ' title="Section Readiness ' + r.readiness + '/100 ± ' + r.readinessMargin + ' (unfiltered, full-history; 95% CI)"';
      }
      rBadge = '<div' + rTitle + ' style="' + badgeBase + ';background:' + rBg + ';color:' + rCol + ';display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3px 8px">' + rInner + '</div>';
    }

    var canStart = (r.pool || 0) > 0;
    var rowAttrs = canStart
      ? ' class="topics-row" data-topic-key="' + escapeHtml(r.key) + '" role="button" tabindex="0" title="Click to start a test in this topic (respects current Accuracy filter)"'
      : ' class="topics-row is-empty"';
    return '<div' + rowAttrs + ' style="' + border + 'padding:14px 16px;display:flex;align-items:center;gap:12px' + (canStart ? ';cursor:pointer' : '') + '">'
      + '<div style="width:28px;height:28px;border-radius:50%;background:var(--bg-card);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;color:var(--text-muted);flex-shrink:0">' + (i + 1) + '</div>'
      + '<div style="flex:1;min-width:0">'
      + '<div style="font-size:0.9rem;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(r.label) + '</div>'
      + '<div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">Answered: ' + r.answeredUnique + '/' + r.pool + ' · Attempts: ' + r.total + ' · Errors: ' + r.wrong + '</div>'
      + '</div>'
      + covBadge
      + rBadge
      + pctBadge
      + '</div>';
  }).join('');

  list.innerHTML = header + body;
  // Row click → start a test scoped to that topic + the active Accuracy bucket.
  list.querySelectorAll('[data-topic-key]').forEach(function(row) {
    function go() { startTopicsQuickTest(examCode, row.getAttribute('data-topic-key')); }
    row.addEventListener('click', go);
    row.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
    });
  });
  renderTopicsStartPanel(examCode);
}

// ── Quick-start test panel on Statistics-by-topic screen ──
var topicsTestCount = 10;
var topicsTestLesson = 'all';

function initTopicsStartControls() {
  var countSel = $('topicsCountPicker');
  if (countSel && countSel.dataset.bound !== '1') {
    countSel.value = String(topicsTestCount);
    countSel.addEventListener('change', function() {
      topicsTestCount = Number(countSel.value) || 10;
    });
    countSel.dataset.bound = '1';
  }
  var lessonSel = $('topicsLessonPicker');
  if (lessonSel && lessonSel.dataset.bound !== '1') {
    lessonSel.addEventListener('change', function() {
      topicsTestLesson = lessonSel.value || 'all';
      renderTopicsList($('topicsExamSelect').value);
    });
    lessonSel.dataset.bound = '1';
  }
  var btn = $('topicsStartBtn');
  if (btn && btn.dataset.bound !== '1') {
    btn.addEventListener('click', function() { startTopicsQuickTest($('topicsExamSelect').value); });
    btn.dataset.bound = '1';
  }
}

function renderTopicsStartPanel(examCode) {
  if (!examCode) return;
  var cell = $('topicsLessonCell');
  var sel = $('topicsLessonPicker');
  if (cell && sel) {
    var lessons = getAvailableLessons(examCode);
    if (!lessons.length) {
      cell.classList.add('hidden');
      topicsTestLesson = 'all';
    } else {
      cell.classList.remove('hidden');
      var effective = topicsTestLesson !== 'all' && lessons.indexOf(String(topicsTestLesson)) < 0 ? 'all' : topicsTestLesson;
      topicsTestLesson = effective;
      sel.innerHTML = '<option value="all">All lessons</option>' +
        lessons.map(function(l) { return '<option value="' + escapeHtml(l) + '">' + escapeHtml(formatLessonCoord(S.versionFilter, l)) + '</option>'; }).join('');
      sel.value = effective;
    }
  }
  // Enable/disable Start based on pool availability (respects S.versionFilter, S.langFilter, lesson, accuracy bucket)
  var btn = $('topicsStartBtn');
  if (btn) {
    var pool = getTopicsTestPool(examCode);
    btn.disabled = pool.length === 0;
    var bucketLabel = topicsAccuracyBucket !== 'all' && WEAK_ACCURACY_BUCKETS[topicsAccuracyBucket]
      ? ' · ' + WEAK_ACCURACY_BUCKETS[topicsAccuracyBucket].label
      : '';
    var boxLabel = topicsBoxFilter !== 'all' ? ' · 📦 Box ' + topicsBoxFilter : '';
    btn.textContent = '▶ Start test (' + pool.length + bucketLabel + boxLabel + ')';
  }
}

// Combine practice-pool filtering (version/language/lesson) with the
// accuracy-bucket filter chosen on the Topics page. The bucket reads
// per-question stats and keeps only questions whose accuracy is in
// [min, max). "All" returns the unfiltered practice pool. Optional
// sectionKey narrows the pool to a specific topic row.
function getTopicsTestPool(examCode, sectionKey) {
  if (!examCode) return [];
  var savedExam = S.exam;
  var savedLesson = S.lessonFilter;
  S.exam = examCode;
  S.lessonFilter = topicsTestLesson;
  var basePool = [];
  try { basePool = getPracticeQuestionPool(examCode) || []; } catch (_) { basePool = []; }
  S.exam = savedExam;
  S.lessonFilter = savedLesson;
  if (sectionKey) basePool = basePool.filter(function(q) { return q && q.section_key === sectionKey; });
  // Leitner box filter — applied before accuracy so the bucket guard below
  // operates on the already-narrowed pool.
  if (topicsBoxFilter && topicsBoxFilter !== 'all') {
    var leitnerMap = (loadStore() || {}).leitner || {};
    var wantBox = Number(topicsBoxFilter);
    basePool = basePool.filter(function(q) {
      if (!q || !q.id) return false;
      var le = leitnerMap[q.id];
      var box = (le && Number(le.box)) || 0;
      return box === wantBox;
    });
  }
  if (!topicsAccuracyBucket || topicsAccuracyBucket === 'all') return basePool;
  var bucket = WEAK_ACCURACY_BUCKETS[topicsAccuracyBucket];
  if (!bucket) return basePool;
  var qStats = getQuestionStatsMap();
  return basePool.filter(function(q) {
    if (!q || !q.id) return false;
    var entry = qStats[q.id];
    var total = entry ? (entry.total || 0) : 0;
    if (total <= 0) return false;
    var acc = Math.round(((entry.correct || 0) / total) * 100);
    return acc >= bucket.min && acc < bucket.max;
  });
}

function startTopicsQuickTest(examCode, sectionKey) {
  if (!examCode) return;
  S.exam = examCode;
  S.lessonFilter = topicsTestLesson;
  if (typeof saveLessonFilter === 'function') { try { saveLessonFilter(topicsTestLesson); } catch (_) {} }
  var pool = getTopicsTestPool(examCode, sectionKey);
  if (!pool.length) {
    var msg = sectionKey
      ? 'Нет вопросов в этой теме под выбранные фильтры (accuracy: ' + (topicsAccuracyBucket === 'all' ? 'all' : (WEAK_ACCURACY_BUCKETS[topicsAccuracyBucket] && WEAK_ACCURACY_BUCKETS[topicsAccuracyBucket].label)) + ').'
      : 'Нет вопросов под выбранные фильтры.';
    alert(msg);
    return;
  }
  var qs = shuffle(pool).slice(0, topicsTestCount);
  closeTopicsDashboard();
  startPreparedSession(qs, {
    exam: examCode,
    mode: 'practice',
    section: sectionKey || 'all',
    sectionQuestionCount: qs.length,
    sectionTimerMinutes: 0,
    practiceQuestionCount: topicsTestCount,
    mockNum: null,
    csLabel: null,
    source: sectionKey ? 'topics_row' : 'topics_quick'
  });
}

// ══ Favorites Screen ═══════════════════════════════════════
// Module-local: which exam tab is currently active on the Favorites screen.
// Seeded from S.exam on first open; persists for the session.
var favoritesExam = 'PL-300';

function openFavoritesDashboard() {
  document.querySelector('.app:not([id])').style.display = 'none';
  _hideAllAuxScreens('favoritesApp');
  $('favoritesApp').style.display = 'flex';
  initFavoritesExamTabs();
  renderFavoritesList(favoritesExam);
}

function closeFavoritesDashboard() {
  $('favoritesApp').style.display = 'none';
  document.querySelector('.app:not([id])').style.display = 'flex';
  _restoreMainHeader();
}

function initFavoritesExamTabs() {
  var wrap = $('favoritesExamTabs');
  if (!wrap) return;
  var profiles = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES) ? EXAM_PROFILES : {};
  var codes = getDisplayedExamCodes(Object.keys(profiles));
  if (!codes.length) return;
  if (codes.indexOf(favoritesExam) < 0) {
    favoritesExam = (S && S.exam && profiles[S.exam]) ? S.exam : codes[0];
  }
  wrap.innerHTML = codes.map(function(c) {
    var on = c === favoritesExam ? ' is-active' : '';
    var sel = c === favoritesExam ? 'true' : 'false';
    return '<button class="s2-tab' + on + '" role="tab" aria-selected="' + sel + '" data-exam="' + escapeHtml(c) + '">' + escapeHtml(c) + '</button>';
  }).join('');
  if (wrap.dataset.bound !== '1') {
    wrap.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.s2-tab'); if (!btn) return;
      var ex = btn.dataset.exam; if (!ex || ex === favoritesExam) return;
      favoritesExam = ex;
      wrap.querySelectorAll('.s2-tab').forEach(function(b) {
        var active = b.dataset.exam === favoritesExam;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderFavoritesList(favoritesExam);
    });
    wrap.dataset.bound = '1';
  }
}

function renderFavoritesList(examCode) {
  var list = $('favoritesList');
  var summary = $('favoritesSummary');
  var startBtnTop = $('favoritesStartBtnTop');
  if (!list || !summary || !startBtnTop) return;

  var items = getFavoritesList(examCode);
  var totalAll = Object.keys(getFavoritesMap()).length;
  // Aggregate accuracy across the favorited questions in this exam.
  // questionStats stores per-question (total, correct) — pool them.
  var qStatsMap = (typeof getQuestionStatsMap === 'function') ? getQuestionStatsMap() : {};
  var favCorrect = 0;
  var favTotal = 0;
  items.forEach(function(item) {
    var qid = item && (item.id || (item.q && item.q.id));
    if (!qid) return;
    var st = qStatsMap[qid];
    if (!st) return;
    favCorrect += st.correct || 0;
    favTotal += st.total || 0;
  });
  var favAcc = favTotal > 0 ? Math.round((favCorrect / favTotal) * 100) : null;
  var wilsonFav = (window.readinessEngine && window.readinessEngine.wilsonCI) || null;
  var favMargin = null;
  if (favAcc !== null && wilsonFav) {
    favMargin = Math.round(wilsonFav(favCorrect, favTotal).margin * 100);
  }
  var favMarginSpan = function(text) {
    return ' <span style="font-size:0.62em;font-weight:500;opacity:0.65">' + text + '</span>';
  };
  var favAccVal = favAcc === null
    ? '—'
    : favAcc + '%' + (favMargin !== null && favMargin > 0 ? favMarginSpan('±' + favMargin + '%') : '');
  summary.innerHTML = [
    { label: 'In this exam', val: items.length },
    { label: 'Total favorites', val: totalAll },
    { label: 'Exam', val: examCode || '—' },
    { label: 'Accuracy', val: favAccVal }
  ].map(function(c) { return '<div class="stat-card"><div class="stat-val">' + c.val + '</div><div class="stat-label">' + c.label + '</div></div>'; }).join('');

  if (!items.length) {
    list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)"><div style="font-size:2.5rem;margin-bottom:12px">⭐</div><div style="font-weight:600;margin-bottom:6px">Nothing marked yet</div><div style="font-size:0.85rem">Tap ☆ in the top-right corner of a question card.</div></div>';
    startBtnTop.disabled = true;
    startBtnTop.onclick = null;
    return;
  }

  // Group favorites by section, then render each group as a collapsible
  // panel (same .weak-group structure used on My weak questions).
  var groups = {};
  items.forEach(function(item) {
    var sk = item.sectionKey || 'unknown';
    if (!groups[sk]) groups[sk] = { label: item.sectionLabel || item.domain || sk, items: [] };
    groups[sk].items.push(item);
  });
  var groupOrder = Object.keys(groups).sort(function(a, b) {
    return groups[b].items.length - groups[a].items.length;
  });

  var rowCounter = 0;
  list.innerHTML = groupOrder.map(function(sk) {
    var g = groups[sk];
    var rowsHtml = g.items.map(function(item) {
      rowCounter++;
      var titleText = item.title || item.sectionLabel || item.domain || item.key;
      var date = item.addedAt ? new Date(item.addedAt).toLocaleDateString('ru-RU') : '';
      return '<div data-fav-row="' + escapeHtml(item.key) + '" style="border-bottom:1px solid var(--border-light);padding:14px 16px;display:flex;align-items:center;gap:12px;cursor:pointer">'
        + '<div style="width:28px;height:28px;border-radius:50%;background:var(--bg-card);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;color:var(--text-muted);flex-shrink:0">' + rowCounter + '</div>'
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-size:0.85rem;font-weight:500;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(titleText) + '</div>'
        + '<div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">' + escapeHtml(item.sectionLabel || item.domain || '—') + (date ? ' · added ' + date : '') + '</div></div>'
        + '<button type="button" data-fav-remove="' + escapeHtml(item.key) + '" title="Remove from favorites" style="background:rgba(239,68,68,0.12);color:#ef4444;border:none;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:0.85rem;font-weight:600;flex-shrink:0">✕</button>'
        + '</div>';
    }).join('');
    return '<div class="weak-group home-panel is-collapsed" style="padding:0;overflow:hidden;margin-bottom:10px">'
      + '<button type="button" class="weak-group-head" aria-expanded="false">'
      + '<span class="weak-group-caret" aria-hidden="true">▸</span>'
      + '<span class="weak-group-title">' + escapeHtml(g.label) + '</span>'
      + '<span class="weak-group-meta">⭐ ' + g.items.length + '</span>'
      + '</button>'
      + '<div class="weak-group-rows">' + rowsHtml + '</div>'
      + '</div>';
  }).join('');

  // Section header toggle.
  list.querySelectorAll('.weak-group').forEach(function(group) {
    var head = group.querySelector('.weak-group-head');
    if (!head) return;
    head.addEventListener('click', function() {
      var willOpen = group.classList.contains('is-collapsed');
      group.classList.toggle('is-collapsed', !willOpen);
      head.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
  });

  list.querySelectorAll('button[data-fav-remove]').forEach(function(btn) {
    btn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      var key = btn.getAttribute('data-fav-remove');
      var store = loadStore();
      if (store.favorites && store.favorites[key]) {
        delete store.favorites[key];
        saveStore(store);
      }
      initFavoritesExamTabs();
      renderFavoritesList(examCode);
    });
  });

  list.querySelectorAll('div[data-fav-row]').forEach(function(row) {
    row.addEventListener('click', function() {
      openQuestionPreviewByKey(examCode, row.getAttribute('data-fav-row'));
    });
  });

  var runFavoritesTest = function() {
    var keys = items.map(function(i) { return i.key; });
    var qs = restoreQuestionsByKeys(examCode, keys);
    if (!qs.length) { alert('Could not find questions in the current exam. The database may have been updated.'); return; }
    closeFavoritesDashboard();
    startPreparedSession(qs, {
      exam: examCode,
      mode: 'practice',
      section: 'all',
      sectionQuestionCount: qs.length,
      sectionTimerMinutes: 0,
      practiceQuestionCount: qs.length,
      mockNum: null,
      csLabel: null,
      source: 'favorites'
    });
  };
  startBtnTop.disabled = false;
  startBtnTop.onclick = runFavoritesTest;
}

// ══ Admin "All Questions" review screen ════════════════════════════
// Page-local filter state — independent from S.langFilter / S.versionFilter /
// S.lessonFilter so admin browsing does not disturb the user's home filters.
var AQ = {
  exam: null,
  lang: 'all',
  version: 'all',
  lesson: 'all',
  search: '',
  sort: 'id',
  density: 'compact'  // 'compact' | 'expanded'
};
var AQ_SEARCH_TIMER = null;

function aqGetExamPool(exam) {
  if (!exam || !S.db || !S.db.exams || !S.db.exams[exam]) return [];
  return S.db.exams[exam].questions || [];
}

function aqGetAvailableLanguages(exam) {
  var seen = new Set();
  aqGetExamPool(exam).forEach(function(q) { seen.add(q.language || 'ru'); });
  return Array.from(seen).sort();
}

function aqGetAvailableVersions(exam, lang) {
  var seen = new Set();
  aqGetExamPool(exam).forEach(function(q) {
    if (lang && lang !== 'all' && (q.language || 'ru') !== lang) return;
    seen.add(q.version || 'gen1');
  });
  return Array.from(seen).sort();
}

function aqGetAvailableLessons(exam, lang, version) {
  var seen = new Set();
  aqGetExamPool(exam).forEach(function(q) {
    if (!q.lesson) return;
    if (lang && lang !== 'all' && (q.language || 'ru') !== lang) return;
    if (version && version !== 'all' && (q.version || 'gen1') !== version) return;
    seen.add(String(q.lesson));
  });
  return Array.from(seen).sort(function(a, b) {
    var ai = parseInt(a, 10), bi = parseInt(b, 10);
    if (!Number.isNaN(ai) && !Number.isNaN(bi) && a.indexOf('-') === -1 && b.indexOf('-') === -1) {
      return ai - bi;
    }
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

function openAllQuestionsDashboard() {
  document.querySelector('.app:not([id])').style.display = 'none';
  _hideAllAuxScreens('allQuestionsApp');
  $('allQuestionsApp').style.display = 'flex';
  if (!AQ.exam) {
    var profiles = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES) ? EXAM_PROFILES : {};
    AQ.exam = (S && S.exam && profiles[S.exam]) ? S.exam : (Object.keys(profiles)[0] || 'PL-300');
  }
  var search = $('aqSearchInput');
  if (search && search.value !== AQ.search) search.value = AQ.search;
  var sort = $('aqSortSelect');
  if (sort && sort.value !== AQ.sort) sort.value = AQ.sort;
  renderAQExamPills();
  renderAQLangPills();
  renderAQVersionPills();
  renderAQLessonPicker();
  renderAQDensityPills();
  renderAQList();
}

function closeAllQuestionsDashboard() {
  $('allQuestionsApp').style.display = 'none';
  document.querySelector('.app:not([id])').style.display = 'flex';
  _restoreMainHeader();
}

function renderAQExamPills() {
  var pills = $('aqExamPills');
  if (!pills) return;
  var profiles = (typeof EXAM_PROFILES === 'object' && EXAM_PROFILES) ? EXAM_PROFILES : {};
  // Admin "All Questions" — show every accessible exam, regardless of the
  // user's Visible Exams preference (admin needs to browse the full pool).
  var codes = getDisplayedExamCodes(Object.keys(profiles), { ignoreVisible: true });
  if (codes.length && !profiles[AQ.exam]) AQ.exam = codes[0];
  var current = AQ.exam;
  pills.innerHTML = codes.map(function(code) {
    var active = code === current ? ' is-active' : '';
    return '<button type="button" class="version-pill' + active + '" data-aq-exam="' + escapeHtml(code) + '">' + escapeHtml(code) + '</button>';
  }).join('');
  pills.querySelectorAll('button[data-aq-exam]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var next = btn.getAttribute('data-aq-exam');
      if (!next || next === AQ.exam) return;
      AQ.exam = next;
      // Lesson values are exam-scoped — drop selection on exam change.
      AQ.lesson = 'all';
      renderAQExamPills();
      renderAQLangPills();
      renderAQVersionPills();
      renderAQLessonPicker();
      renderAQList();
    });
  });
}

function renderAQLangPills() {
  var panel = $('aqLangPanel');
  var pills = $('aqLangPills');
  if (!panel || !pills) return;
  var langs = aqGetAvailableLanguages(AQ.exam);
  if (langs.length < 2) {
    panel.classList.add('hidden');
    AQ.lang = 'all';
    return;
  }
  panel.classList.remove('hidden');
  var LABELS = { all: 'All languages', ru: '🇷🇺 Russian', en: '🇬🇧 English' };
  var current = AQ.lang;
  if (current !== 'all' && langs.indexOf(current) === -1) {
    AQ.lang = current = 'all';
  }
  var buttons = [{ value: 'all', label: LABELS.all }].concat(
    langs.map(function(v) { return { value: v, label: LABELS[v] || v }; })
  );
  pills.innerHTML = buttons.map(function(b) {
    var active = b.value === current ? ' is-active' : '';
    return '<button type="button" class="version-pill' + active + '" data-aq-lang="' + escapeHtml(b.value) + '">' + escapeHtml(b.label) + '</button>';
  }).join('');
  pills.querySelectorAll('button[data-aq-lang]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var next = btn.getAttribute('data-aq-lang');
      if (!next || next === AQ.lang) return;
      AQ.lang = next;
      renderAQLangPills();
      renderAQVersionPills();
      renderAQLessonPicker();
      renderAQList();
    });
  });
}

function renderAQVersionPills() {
  var panel = $('aqVersionPanel');
  var pills = $('aqVersionPills');
  if (!panel || !pills) return;
  var versions = aqGetAvailableVersions(AQ.exam, AQ.lang);
  if (versions.length < 2) {
    panel.classList.add('hidden');
    AQ.version = 'all';
    return;
  }
  panel.classList.remove('hidden');
  var current = AQ.version;
  if (current !== 'all' && versions.indexOf(current) === -1) {
    AQ.version = current = 'all';
  }
  var buttons = [{ value: 'all', label: 'All versions' }].concat(
    versions.map(function(v) { return { value: v, label: v }; })
  );
  pills.innerHTML = buttons.map(function(b) {
    var active = b.value === current ? ' is-active' : '';
    return '<button type="button" class="version-pill' + active + '" data-aq-version="' + escapeHtml(b.value) + '">' + escapeHtml(b.label) + '</button>';
  }).join('');
  pills.querySelectorAll('button[data-aq-version]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var next = btn.getAttribute('data-aq-version');
      if (!next || next === AQ.version) return;
      AQ.version = next;
      renderAQVersionPills();
      renderAQLessonPicker();
      renderAQList();
    });
  });
}

function renderAQLessonPicker() {
  var panel = $('aqLessonPanel');
  var sel = $('aqLessonSelect');
  if (!panel || !sel) return;
  var lessons = aqGetAvailableLessons(AQ.exam, AQ.lang, AQ.version);
  if (!lessons.length) {
    panel.classList.add('hidden');
    AQ.lesson = 'all';
    return;
  }
  panel.classList.remove('hidden');
  var current = AQ.lesson;
  if (current !== 'all' && lessons.indexOf(String(current)) === -1) {
    AQ.lesson = current = 'all';
  }
  var OPT_STYLE = ' style="color:#0f172a;background:#fff"';
  sel.innerHTML = '<option value="all"' + OPT_STYLE + '>All lessons</option>' +
    lessons.map(function(l) { return '<option value="' + escapeHtml(l) + '"' + OPT_STYLE + '>' + escapeHtml(formatLessonCoord(AQ.version, l)) + '</option>'; }).join('');
  sel.value = current;
  sel.onchange = function() {
    AQ.lesson = sel.value || 'all';
    renderAQList();
  };
}

function getAllQuestionsFiltered() {
  var pool = aqGetExamPool(AQ.exam);
  var needle = (AQ.search || '').trim().toLowerCase();
  return pool.filter(function(q) {
    if (AQ.lang !== 'all' && (q.language || 'ru') !== AQ.lang) return false;
    if (AQ.version !== 'all' && (q.version || 'gen1') !== AQ.version) return false;
    if (AQ.lesson !== 'all' && String(q.lesson || '') !== AQ.lesson) return false;
    if (needle) {
      var optsText = (q.options || []).map(function(o) { return o && o.text ? o.text : ''; }).join(' ');
      // Include the canonical short ID format (`pl300_3174`) and raw seq so
      // users can search by what the question badge displays — id alone won't
      // match because real ids look like `pl300_real_en3_35`.
      var shortId = '';
      if (typeof q.seq === 'number' && q.seq > 0) {
        var prefix = (typeof EXAM_SHORT_PREFIX !== 'undefined' && EXAM_SHORT_PREFIX[q.exam_code]) || '';
        shortId = (prefix ? prefix + '_' : '') + q.seq;
      }
      var hay = (String(q.id || '') + ' ' + shortId + ' ' + (q.seq || '') + ' ' + (q.prompt || '') + ' ' + (q.explanation || '') + ' ' + optsText).toLowerCase();
      if (hay.indexOf(needle) === -1) return false;
    }
    return true;
  });
}

function renderAQDensityPills() {
  var pills = $('aqDensityPills');
  if (!pills) return;
  var current = AQ.density || 'compact';
  var buttons = [
    { value: 'compact', label: 'Compact' },
    { value: 'expanded', label: 'Expanded' }
  ];
  pills.innerHTML = buttons.map(function(b) {
    var active = b.value === current ? ' is-active' : '';
    return '<button type="button" class="version-pill' + active + '" data-aq-density="' + escapeHtml(b.value) + '">' + escapeHtml(b.label) + '</button>';
  }).join('');
  pills.querySelectorAll('button[data-aq-density]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var next = btn.getAttribute('data-aq-density');
      if (!next || next === AQ.density) return;
      AQ.density = next;
      renderAQDensityPills();
      renderAQList();
    });
  });
}

function aqFormatText(text) {
  // Use the same Markdown/whitespace collapser as the main quiz so that
  // prompts/options/explanations don't show a wall of blank lines from
  // sloppy table-cell extraction.
  if (typeof formatQuestionText === 'function') return formatQuestionText(String(text || ''));
  return escapeHtml(String(text || '')).replace(/\n{2,}/g, '\n').replace(/\n/g, '<br>');
}

function renderAQExpandedBody(q) {
  var parts = [];
  if (q.prompt) {
    parts.push('<div style="font-size:0.92rem;line-height:1.5;color:var(--text-primary);margin-top:10px;word-break:break-word">' + aqFormatText(q.prompt) + '</div>');
  }
  if (typeof hasChoiceOptions === 'function' && hasChoiceOptions(q) && Array.isArray(q.options)) {
    var correctKeys = (typeof getCorrectAnswerKeys === 'function') ? getCorrectAnswerKeys(q) : (q.correct_answers || []);
    var optsHtml = q.options.map(function(opt, idx) {
      var meta = (typeof getOptionMeta === 'function') ? getOptionMeta(opt, idx) : { label: opt.key || String.fromCharCode(65 + idx), text: opt.text || '', answerKey: opt.key || String.fromCharCode(65 + idx) };
      var isCorrect = correctKeys.indexOf(meta.answerKey) !== -1;
      var bg = isCorrect
        ? 'background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.4)'
        : 'background:rgba(148,163,184,0.06);border:1px solid var(--border-light)';
      var color = isCorrect ? '#22c55e' : 'var(--text-primary)';
      var check = isCorrect ? '<span style="margin-left:auto;color:#22c55e;font-weight:700;flex-shrink:0">✓</span>' : '';
      return '<div style="' + bg + ';border-radius:8px;padding:8px 12px;display:flex;align-items:flex-start;gap:10px;margin-top:6px">'
        + '<span style="font-weight:700;min-width:18px;color:' + color + '">' + escapeHtml(meta.label) + '</span>'
        + '<span style="flex:1;color:' + color + ';word-break:break-word">' + aqFormatText(meta.text) + '</span>'
        + check
        + '</div>';
    }).join('');
    parts.push('<div style="margin-top:8px">' + optsHtml + '</div>');
  } else if (q.answer_text) {
    parts.push('<div style="margin-top:10px;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.4);border-radius:8px;padding:8px 12px;color:#22c55e">' + aqFormatText(q.answer_text) + ' ✓</div>');
  }
  if (q.explanation) {
    parts.push('<div style="margin-top:10px;background:rgba(99,102,241,0.08);border-left:3px solid rgba(99,102,241,0.6);padding:8px 12px;border-radius:6px">'
      + '<div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);font-weight:700;margin-bottom:4px">Explanation</div>'
      + '<div style="font-size:0.85rem;line-height:1.5;color:var(--text-primary);word-break:break-word">' + aqFormatText(q.explanation) + '</div>'
      + '</div>');
  }
  if (q.tip) {
    parts.push('<div style="margin-top:8px;background:rgba(234,179,8,0.1);border-left:3px solid rgba(234,179,8,0.6);padding:8px 12px;border-radius:6px">'
      + '<div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);font-weight:700;margin-bottom:4px">💡 Hint</div>'
      + '<div style="font-size:0.85rem;line-height:1.5;color:var(--text-primary);word-break:break-word">' + aqFormatText(q.tip) + '</div>'
      + '</div>');
  }
  // quiz_images is the new field name; images is the legacy fallback
  // (see q.quiz_images comment in the quiz renderer above).
  var aqQuizImgs = Array.isArray(q.quiz_images) ? q.quiz_images
                 : (Array.isArray(q.images) ? q.images : []);
  if (aqQuizImgs.length) {
    // Reuse the quiz-mode collapsible toggle + 2-col grid + lightbox so the
    // admin Expanded view behaves the same way as a real quiz card.
    var figuresHtml = aqQuizImgs.map(function(src, i) {
      return '<figure class="q-image-figure">'
        + '<img class="q-image" loading="lazy" src="' + escapeHtml(src) + '" alt="Question image ' + (i + 1) + '">'
        + '</figure>';
    }).join('');
    parts.push(
      '<div class="aq-images-wrap" style="margin-top:10px">'
        + '<button type="button" class="q-images-toggle" aria-expanded="false">'
          + '<span class="q-images-toggle-label">📷 Show Picture (' + aqQuizImgs.length + ')</span>'
          + '<span class="q-images-toggle-caret" aria-hidden="true">▾</span>'
        + '</button>'
        + '<div class="q-images-grid hidden">' + figuresHtml + '</div>'
      + '</div>'
    );
  }
  var urls = (Array.isArray(q.learn_urls) ? q.learn_urls.filter(function(u) { return u; }) : []).slice(0, 3);
  if (!urls.length && q.learn_url) urls.push(q.learn_url);
  if (urls.length) {
    var urlsHtml = urls.map(function(url, i) {
      var label = urls.length > 1 ? '📚 Microsoft Learn (' + (i + 1) + ') →' : '📚 Microsoft Learn →';
      return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="display:inline-block;margin-right:8px;margin-top:6px;color:#a5b4fc;text-decoration:none;font-size:0.85rem;font-weight:600">' + escapeHtml(label) + '</a>';
    }).join('');
    parts.push('<div style="margin-top:8px">' + urlsHtml + '</div>');
  }
  return parts.join('');
}

function renderAQList() {
  var list = $('aqList');
  var badge = $('aqCountBadge');
  if (!list || !badge) return;
  var totalInExam = aqGetExamPool(AQ.exam).length;
  var filtered = getAllQuestionsFiltered();
  var sorters = {
    id: function(a, b) { return String(a.id).localeCompare(String(b.id)); },
    lesson: function(a, b) {
      var ai = Number(a.lesson || 0), bi = Number(b.lesson || 0);
      return (ai - bi) || String(a.id).localeCompare(String(b.id));
    },
    section: function(a, b) {
      return String(a.section_key || '').localeCompare(String(b.section_key || '')) || String(a.id).localeCompare(String(b.id));
    },
    version: function(a, b) {
      return String(a.version || '').localeCompare(String(b.version || '')) || String(a.id).localeCompare(String(b.id));
    }
  };
  var sortFn = sorters[AQ.sort] || sorters.id;
  filtered = filtered.slice().sort(sortFn);
  badge.textContent = 'showing ' + filtered.length + ' of ' + totalInExam;
  if (!filtered.length) {
    list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)">No questions match the current filters.</div>';
    return;
  }
  var isExpanded = AQ.density === 'expanded';
  list.innerHTML = filtered.map(function(q, i) {
    var border = i < filtered.length - 1 ? 'border-bottom:1px solid var(--border-light);' : '';
    var langCode = (q.language || 'ru').toUpperCase();
    var versionCode = q.version || 'gen1';
    var lessonChip = q.lesson ? '<span style="background:rgba(79,70,229,0.18);color:#a5b4fc;border-radius:6px;padding:1px 6px;font-size:0.7rem;font-weight:700;flex-shrink:0">' + escapeHtml(formatLessonCoord(q.version, q.lesson)) + '</span>' : '';
    var qNum = (q.source_num != null && q.source_num !== '') ? q.source_num : (String(q.id || '').match(/_(\d+)$/) || [])[1];
    var qNumBadge = qNum ? '<span style="background:rgba(34,197,94,0.18);color:#86efac;border-radius:6px;padding:1px 6px;font-size:0.7rem;font-weight:700;flex-shrink:0">Q' + escapeHtml(String(Number(qNum) || qNum)) + '</span>' : '';
    var sectionLabel = q.section_label || q.section_key || '—';
    var idBadge = '<span style="font-family:monospace;font-size:0.72rem;color:var(--text-muted);flex-shrink:0">' + escapeHtml(String(q.id)) + '</span>';
    var versionBadge = '<span style="background:rgba(148,163,184,0.18);color:var(--text-muted);border-radius:6px;padding:1px 6px;font-size:0.7rem;font-weight:700;flex-shrink:0">' + escapeHtml(versionCode) + '</span>';
    var langBadge = '<span style="background:rgba(148,163,184,0.18);color:var(--text-muted);border-radius:6px;padding:1px 6px;font-size:0.7rem;font-weight:700;flex-shrink:0">' + escapeHtml(langCode) + '</span>';
    var sectionBadge = '<span style="font-size:0.72rem;color:var(--text-muted);flex-shrink:0;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(sectionLabel) + '</span>';
    if (isExpanded) {
      return '<div data-aq-row="' + escapeHtml(String(q.id)) + '" style="' + border + 'padding:14px 16px;cursor:pointer">'
        + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
          + idBadge + versionBadge + langBadge + lessonChip + qNumBadge + sectionBadge
        + '</div>'
        + renderAQExpandedBody(q)
        + '</div>';
    }
    var promptPreview = (q.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    return '<div data-aq-row="' + escapeHtml(String(q.id)) + '" style="' + border + 'padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer">'
      + '<span style="font-family:monospace;font-size:0.72rem;color:var(--text-muted);min-width:120px;flex-shrink:0">' + escapeHtml(String(q.id)) + '</span>'
      + versionBadge + langBadge + lessonChip + qNumBadge
      + '<span style="font-size:0.72rem;color:var(--text-muted);flex-shrink:0;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(sectionLabel) + '</span>'
      + '<span style="flex:1;min-width:0;font-size:0.85rem;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(promptPreview) + '</span>'
      + '</div>';
  }).join('');
  var byId = {};
  filtered.forEach(function(q) { byId[String(q.id)] = q; });
  list.querySelectorAll('div[data-aq-row]').forEach(function(row) {
    row.addEventListener('click', function(ev) {
      // Inline image-related interactions (toggle + lightbox) live inside
      // .aq-images-wrap and stop their own propagation; row clicks here
      // only fire on non-image clicks → open the preview overlay.
      if (ev.target.closest('.aq-images-wrap')) return;
      var q = byId[row.getAttribute('data-aq-row')];
      if (q) openQuestionPreview(q);
    });
  });
  // Image toggle (Show / Hide picture) + click-to-lightbox in the Expanded
  // view. Delegated on the whole list so it survives re-renders.
  if (list.dataset.aqImagesBound !== '1') {
    list.addEventListener('click', function(ev) {
      var toggle = ev.target.closest('.q-images-toggle');
      if (toggle) {
        ev.stopPropagation();
        var wrap = toggle.parentNode;
        var grid = wrap && wrap.querySelector('.q-images-grid');
        var labelEl = toggle.querySelector('.q-images-toggle-label');
        if (!grid || !labelEl) return;
        var willOpen = grid.classList.contains('hidden');
        grid.classList.toggle('hidden', !willOpen);
        toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        toggle.classList.toggle('is-open', willOpen);
        var n = grid.querySelectorAll('img.q-image').length;
        labelEl.textContent = (willOpen ? '📷 Hide Picture (' : '📷 Show Picture (') + n + ')';
        return;
      }
      var img = ev.target.closest('.aq-images-wrap img.q-image');
      if (img && typeof openImageLightbox === 'function') {
        ev.stopPropagation();
        openImageLightbox(img.src, img.alt || '');
      }
    });
    list.dataset.aqImagesBound = '1';
  }
}

function openQuestionPreview(q) {
  var overlay = $('questionPreviewOverlay');
  if (!overlay || !q) return;
  refreshIdBadge(q, $('qPreviewIdBadge'));
  refreshVersionBadge(q, $('qPreviewVersionBadge'));
  refreshQuestionStatsBadge(q, $('qPreviewStatsBadge'));
  $('qPreviewMeta').textContent = getQuestionMetaLabel(q);
  $('qPreviewTitle').textContent = q.title || '';
  $('qPreviewPrompt').innerHTML = formatQuestionText(q.prompt || '');
  if (window.Prism) Prism.highlightAllUnder($('qPreviewPrompt'));

  var optsBox = $('qPreviewOptions');
  if (hasChoiceOptions(q)) {
    var correctKeys = getCorrectAnswerKeys(q);
    optsBox.innerHTML = q.options.map(function(opt, idx) {
      var meta = getOptionMeta(opt, idx);
      var isCorrect = correctKeys.indexOf(meta.answerKey) !== -1;
      return '<div class="fav-preview-option' + (isCorrect ? ' is-correct' : '') + '">'
        + '<span class="fav-preview-option-letter">' + escapeHtml(meta.label) + '</span>'
        + '<span class="fav-preview-option-text">' + escapeHtml(meta.text) + '</span>'
        + (isCorrect ? '<span class="fav-preview-option-check">✓</span>' : '')
        + '</div>';
    }).join('');
    optsBox.classList.remove('hidden');
  } else if (q.answer_text || q.details?.answer || q.details?.remember) {
    var ans = q.answer_text || q.details?.answer || q.details?.remember || '';
    optsBox.innerHTML = '<div class="fav-preview-option is-correct"><span class="fav-preview-option-letter">A</span><span class="fav-preview-option-text">' + escapeHtml(ans) + '</span><span class="fav-preview-option-check">✓</span></div>';
    optsBox.classList.remove('hidden');
  } else {
    optsBox.innerHTML = '';
    optsBox.classList.add('hidden');
  }

  var explWrap = $('qPreviewExplanationWrap');
  if (q.explanation) {
    $('qPreviewExplanation').innerHTML = formatQuestionText(q.explanation);
    explWrap.classList.remove('hidden');
  } else {
    explWrap.classList.add('hidden');
  }
  var tipWrap = $('qPreviewTipWrap');
  if (q.tip) {
    $('qPreviewTip').innerHTML = formatQuestionText(q.tip);
    tipWrap.classList.remove('hidden');
  } else {
    tipWrap.classList.add('hidden');
  }

  renderLearnUrls('qPreviewLearnUrlWrap', q);

  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function openQuestionPreviewByKey(examCode, key) {
  var qs = restoreQuestionsByKeys(examCode, [key]);
  if (!qs[0]) {
    alert('Could not find the question — it may have been removed from the database.');
    return;
  }
  openQuestionPreview(qs[0]);
}

function closeQuestionPreview() {
  var overlay = $('questionPreviewOverlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  document.body.style.overflow = '';
}

// ══ Wire-up weak questions button ══════════════════════════
document.addEventListener('DOMContentLoaded', function() {
  var wb = $('weakQBtn');
  if (wb) wb.addEventListener('click', openWeakQDashboard);
  var wc = $('weakQCloseBtn');
  if (wc) wc.addEventListener('click', closeWeakQDashboard);
  var tb = $('topicsBtn');
  if (tb) tb.addEventListener('click', openTopicsDashboard);
  var tc = $('topicsCloseBtn');
  if (tc) tc.addEventListener('click', closeTopicsDashboard);
  var fb = $('favoriteBtn');
  if (fb) fb.addEventListener('click', function() {
    var q = S.questions[S.idx];
    if (!q) return;
    toggleFavoriteQuestion(q);
    refreshFavoriteBtn(q);
  });
  var favOpen = $('favoritesBtn');
  if (favOpen) favOpen.addEventListener('click', openFavoritesDashboard);
  var favClose = $('favoritesCloseBtn');
  if (favClose) favClose.addEventListener('click', closeFavoritesDashboard);
  var aqClose = $('allQuestionsCloseBtn');
  if (aqClose) aqClose.addEventListener('click', closeAllQuestionsDashboard);
  var aqSearch = $('aqSearchInput');
  if (aqSearch) aqSearch.addEventListener('input', function() {
    if (AQ_SEARCH_TIMER) clearTimeout(AQ_SEARCH_TIMER);
    AQ_SEARCH_TIMER = setTimeout(function() {
      AQ.search = aqSearch.value;
      renderAQList();
    }, 150);
  });
  var aqSort = $('aqSortSelect');
  if (aqSort) aqSort.addEventListener('change', function() {
    AQ.sort = aqSort.value || 'id';
    renderAQList();
  });
  var qPreviewClose = $('questionPreviewClose');
  if (qPreviewClose) qPreviewClose.addEventListener('click', closeQuestionPreview);
  var qOverlay = $('questionPreviewOverlay');
  if (qOverlay) qOverlay.addEventListener('click', function(ev) {
    if (ev.target === qOverlay) closeQuestionPreview();
  });
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape') {
      var ov = $('questionPreviewOverlay');
      if (ov && !ov.classList.contains('hidden')) closeQuestionPreview();
    }
  });
});

// ══ Hash router ════════════════════════════════════════════════════
// Maps URL hash → aux-screen opener. Each aux open* helper calls
// _setHash(route) so the address bar reflects the current screen.
// User-driven back/forward triggers `hashchange`, which re-applies the
// hash and opens the matching screen (or returns home).
(function () {
  // Path → open function name. `null` means "home" (close all aux).
  var ROUTES = {
    '/':            null,
    '/favorites':   'openFavoritesDashboard',
    '/weak':        'openWeakQDashboard',
    '/topics':      'openTopicsDashboard',
    '/statsv1':     'openAdminDashboard',
    '/statsv2':     'openStatsV2',
    '/all':         'openAllQuestionsDashboard',
    '/home2':       'openHomeV2',
    '/profile':     'openProfileScreen',
    '/references':  'openReferences',
  };

  // Reverse map: opener fn name → route path. Populated lazily so we
  // can call _routeForOpener after open* functions are defined.
  var REVERSE = null;
  function buildReverse() {
    REVERSE = {};
    Object.keys(ROUTES).forEach(function (p) {
      var fn = ROUTES[p];
      if (fn) REVERSE[fn] = p;
    });
  }

  function _normalizePath(raw) {
    raw = (raw || '').replace(/^#/, '');
    if (!raw) return '/';
    return raw[0] === '/' ? raw : '/' + raw;
  }

  // Replace hash without triggering hashchange (history.replaceState
  // mutates URL silently). Used by open*/close* so internal navigation
  // doesn't recurse.
  function _setHash(route) {
    var target = (route && route !== '/') ? '#' + route : '#/';
    if (location.hash === target) return;
    try { history.pushState(null, '', target); }
    catch (_) { try { location.hash = target; } catch (__) {} }
  }

  function _goHomeRoute() {
    try { if (typeof _hideAllAuxScreens === 'function') _hideAllAuxScreens(); } catch (_) {}
    var main = document.querySelector('.app:not([id])');
    if (main) main.style.display = 'flex';
    try { if (typeof _restoreMainHeader === 'function') _restoreMainHeader(); } catch (_) {}
  }

  function applyHash() {
    var path = _normalizePath(location.hash);
    // Polish flags are managed by the open* functions themselves now —
    // they add their own class and removing happens in close* / goHome.
    var fnName = ROUTES.hasOwnProperty(path) ? ROUTES[path] : undefined;
    if (fnName === null || fnName === undefined) { _goHomeRoute(); return; }
    var fn = window[fnName];
    if (typeof fn === 'function') {
      try { fn(); } catch (e) { console.error('Router open failed:', fnName, e); }
    }
  }

  // Decorate open* helpers so any path into them (button, sidebar, etc.)
  // also updates the address bar.
  function wrapOpener(fnName, route) {
    var orig = window[fnName];
    if (typeof orig !== 'function' || orig.__routed) return;
    var wrapped = function () {
      _setHash(route);
      return orig.apply(this, arguments);
    };
    wrapped.__routed = true;
    window[fnName] = wrapped;
  }

  function bindOpeners() {
    buildReverse();
    Object.keys(REVERSE).forEach(function (fnName) {
      wrapOpener(fnName, REVERSE[fnName]);
    });
  }

  // Intercept close* / back-to-home flows that don't go through open*.
  // We watch _hideAllAuxScreens calls: after any close button resets the
  // aux screen and main app shows, hash should become '/'.
  function bindCloseHooks() {
    ['statsV2CloseBtn','statsV3CloseBtn','adminCloseBtn','homeV2CloseBtn',
     'weakQCloseBtn','topicsCloseBtn','favoritesCloseBtn','allQuestionsCloseBtn',
     'profileCloseBtn','referencesCloseBtn']
      .forEach(function (id) {
        var btn = document.getElementById(id);
        if (!btn || btn.dataset.routeBound === '1') return;
        btn.addEventListener('click', function () { _setHash('/'); });
        btn.dataset.routeBound = '1';
      });
    // #homeBtn intentionally not double-bound here: the primary
    // listener (goHome) already does showScreen('home') + stats
    // refresh. Adding _setHash('/') triggered a race against goHome's
    // own screen swap — under certain hash-route states it bounced
    // the user back to the wrong screen ("not always navigates home"
    // bug). One handler, one responsibility.
  }

  window.addEventListener('hashchange', applyHash);

  // Defer opener wrapping until after app.js has defined all open* fns.
  // DOMContentLoaded fires after the whole script body runs, so they
  // exist on window by then.
  document.addEventListener('DOMContentLoaded', function () {
    bindOpeners();
    bindCloseHooks();
    // On a page reload (F5 / Ctrl+R / Ctrl+Shift+R) always land on Home —
    // don't restore the deep-link route. Reload is a "restart" gesture.
    // We only honor the hash when it's a fresh navigation (e.g. clicking
    // a shared link). Detect via PerformanceNavigationTiming.
    var isReload = false;
    try {
      var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
      isReload = nav ? (nav.type === 'reload') : (performance.navigation && performance.navigation.type === 1);
    } catch (_) {}
    if (isReload && location.hash && _normalizePath(location.hash) !== '/') {
      _setHash('/');
      return;
    }
    // If user landed on a deep link (fresh navigation), open the matching
    // screen once the app is settled. 600ms gives cloudSync.loadQuestions
    // a window; open* helpers themselves no-op gracefully if data isn't ready yet.
    if (location.hash && _normalizePath(location.hash) !== '/') {
      setTimeout(applyHash, 600);
    }
  });
})();
