// Single source of truth for user-facing metrics.
// Constants + pure helper functions. Exposed via window.MetricsConfig + window.Metrics.
//
// Rule: Any metric shown to the user (accuracy, readiness, sessions, coverage, etc.)
// MUST be computed via these helpers. Do not duplicate formulas in render code.
// If you need a new metric — add a helper here and reuse it everywhere.

(function (global) {

  const MetricsConfig = {
    // Readiness scoring (sum of weights = 1.0). See src/engine/readiness.js for full impl.
    READINESS: {
      weights: { accuracy: 0.55, mastery: 0.25, recentWrong: 0.10, duePressure: 0.10 },
      accuracyWindowDays: 14,
      recentWrongWindowDays: 14,
      minAnswersPerSection: 3,
      saturationAnswers: 100,
    },
    // Leitner spaced repetition (intervals in days per box; 1-indexed, [0] unused).
    LEITNER: {
      intervalDays: [null, 1, 3, 7, 14, 30],
      boxCount: 5,
    },
    // Daily streak — day counts when user answered ≥ minAnswersPerDay.
    STREAK: {
      minAnswersPerDay: 5,
    },
    // Default daily plan goal (overridable via userProfile.dailyPlan).
    DAILY_PLAN: {
      defaultGoal: 50,
    },
    // Time tracking — single per-question cap to prevent inflated "idle on tab" times.
    TIME: {
      capPerQuestionMs: 180000, // 3 minutes
    },
    // Readiness status thresholds (overall / min section). Below 'foundational' = 'not_ready'.
    STATUS_THRESHOLDS: {
      expert_ready:  { overall: 90, minSection: 85 },
      ready_strong:  { overall: 85, minSection: 75 },
      ready:         { overall: 75, minSection: 65 },
      borderline:    { overall: 65, minSection: 60 },
      developing:    { overall: 55, minSection: 50 },
      foundational:  { overall: 45, minSection: 40 },
    },
  };

  // ─────────────────────────────────────────────────────────────
  // Accuracy / sessionStats-based metrics
  // ─────────────────────────────────────────────────────────────

  // Sum sectionStats for a given exam (or all when exam=null). Single source.
  // Replaces ad-hoc `correct / total × 100` calls scattered across render code.
  function getAccuracy(sectionStats, exam) {
    if (!sectionStats) return { total: 0, correct: 0, accuracy: 0 };
    const prefix = exam ? exam + '__' : null;
    let total = 0, correct = 0;
    Object.keys(sectionStats).forEach(k => {
      if (prefix && k.indexOf(prefix) !== 0) return;
      const s = sectionStats[k] || {};
      total += s.total || 0;
      correct += s.correct || 0;
    });
    return {
      total,
      correct,
      accuracy: total > 0 ? Math.round(correct / total * 100) : 0,
    };
  }

  // Total attempts/accuracy from dailyStatsByExam — every answer counts,
  // regardless of whether the session finished. This is the canonical
  // source going forward; sectionStats is retained only for per-section
  // breakdowns (which can legitimately undercount on unfinished sessions
  // since per-section data is only meaningful at session granularity).
  function getOverallAttempts(store, exam) {
    if (!store) return { total: 0, correct: 0, accuracy: 0 };
    const dsbe = store.dailyStatsByExam || {};
    const dcbe = store.dailyCorrectByExam || {};
    const examKeys = exam ? [exam] : Object.keys(dsbe);
    let total = 0, correct = 0;
    examKeys.forEach(ec => {
      const sd = dsbe[ec] || {};
      const cd = dcbe[ec] || {};
      Object.values(sd).forEach(v => { total += Number(v) || 0; });
      Object.values(cd).forEach(v => { correct += Number(v) || 0; });
    });
    return {
      total,
      correct,
      accuracy: total > 0 ? Math.round(correct / total * 100) : 0,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Time metrics — measured only, no heuristics
  // ─────────────────────────────────────────────────────────────

  // Total practice time in ms. Reads dailyTimeMsByExam[exam] if exam given,
  // else global dailyTimeMs. Returns ms, hours (1 decimal), minutes (1 decimal).
  function getTotalPracticeMs(store, exam) {
    if (!store) return { ms: 0, hours: 0, minutes: 0 };
    const dt = exam
      ? ((store.dailyTimeMsByExam && store.dailyTimeMsByExam[exam]) || {})
      : (store.dailyTimeMs || {});
    let ms = 0;
    Object.values(dt).forEach(v => { ms += Number(v) || 0; });
    return {
      ms,
      hours: Math.round(ms / 360000) / 10,
      minutes: Math.round(ms / 6000) / 10,
    };
  }

  // Avg time per question (seconds). Returns null when no data.
  function getAvgTimePerQuestionSec(store, exam) {
    if (!store) return null;
    const { ms } = getTotalPracticeMs(store, exam);
    const { total } = getAccuracy(store.sectionStats, exam);
    if (!total || !ms) return null;
    return Math.round((ms / total) / 1000);
  }

  // ─────────────────────────────────────────────────────────────
  // Session / daily / streak metrics
  // ─────────────────────────────────────────────────────────────

  function getSessions(store) {
    return (store && store.sessions) || 0;
  }

  // Daily streak — counts consecutive days back from today where dailyStats[d] ≥ threshold.
  // Today is a grace day: if today is below threshold, it doesn't break the streak (we
  // simply skip today and keep counting yesterday and earlier).
  function getStreak(store) {
    if (!store) return 0;
    const ds = store.dailyStats || {};
    const threshold = MetricsConfig.STREAK.minAnswersPerDay;
    let s = 0;
    const today = new Date().toISOString().slice(0, 10);
    const t = new Date(); t.setUTCHours(0,0,0,0);
    for (let i = 0; i < 60; i++) {
      const d = new Date(t);
      d.setUTCDate(t.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      const count = ds[key] || 0;
      if (count >= threshold) { s++; continue; }
      if (key === today) continue; // grace day
      break;
    }
    return s;
  }

  // Today's answered count vs goal. Reads global dailyStats unless exam given.
  function getTodayProgress(store, profile, exam) {
    if (!store) return { answered: 0, goal: MetricsConfig.DAILY_PLAN.defaultGoal, pct: 0 };
    const today = new Date().toISOString().slice(0, 10);
    const ds = exam
      ? ((store.dailyStatsByExam && store.dailyStatsByExam[exam]) || {})
      : (store.dailyStats || {});
    const answered = ds[today] || 0;
    const goal = (profile && profile.dailyPlan) || MetricsConfig.DAILY_PLAN.defaultGoal;
    return {
      answered,
      goal,
      pct: goal > 0 ? Math.round(answered / goal * 100) : 0,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Coverage — unique answered / pool size
  // ─────────────────────────────────────────────────────────────

  // Requires getPracticeQuestionPool(examCode), isExamAvailable(examCode), getQuestionKey(q)
  // — these live in app.js; passed in to avoid circular dep.
  function getCoverage(store, exam, helpers) {
    helpers = helpers || {};
    const { getPracticeQuestionPool, isExamAvailable, getQuestionKey, allExamCodes } = helpers;
    if (!store || typeof getPracticeQuestionPool !== 'function') {
      return { answered: 0, pool: 0, pct: null };
    }
    const qstats = store.questionStats || {};
    const codes = exam ? [exam] : (allExamCodes || []);
    let answered = 0, pool = 0;
    codes.forEach(ec => {
      if (typeof isExamAvailable === 'function' && !isExamAvailable(ec)) return;
      const p = getPracticeQuestionPool(ec) || [];
      pool += p.length;
      p.forEach(q => {
        const key = (typeof getQuestionKey === 'function') ? getQuestionKey(q) : (q && q.id);
        const s = qstats[key];
        if (s && s.total > 0) answered++;
      });
    });
    return {
      answered,
      pool,
      pct: pool > 0 ? Math.round(answered / pool * 100) : null,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Daily series — for chart rendering
  // ─────────────────────────────────────────────────────────────

  // Read daily field for a specific day. field: 'dailyStats' | 'dailyCorrect' | 'dailyTimeMs'.
  function getDailyCount(store, exam, day, field) {
    if (!store) return 0;
    const map = exam
      ? ((store[field + 'ByExam'] && store[field + 'ByExam'][exam]) || {})
      : (store[field] || {});
    return Number(map[day]) || 0;
  }

  // Expose
  global.MetricsConfig = MetricsConfig;
  global.Metrics = {
    getAccuracy,
    getOverallAttempts,
    getTotalPracticeMs,
    getAvgTimePerQuestionSec,
    getSessions,
    getStreak,
    getTodayProgress,
    getCoverage,
    getDailyCount,
  };

})(typeof window !== 'undefined' ? window : globalThis);
