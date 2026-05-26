// Recommendation engine v1 — universal across exams.
// Loaded after readiness.js. Routes the user into existing modes
// (leitner / section / weak / smart / mock / case_study / practice).
// Does NOT start sessions; returns descriptors with sessionConfig that the UI
// translates into existing app.js mode handlers.
//
// Priority (v1, explainable):
//   1. Overdue Leitner / high duePressure → leitner
//   2. Weakest section is poor            → section drill
//   3. Recent wrong density high          → weak / smart
//   4. Readiness ready, mock supported    → mock
//   5. Case study supported & weak there  → case_study
//   6. Default                            → practice

(function (global) {
  const T = {
    LEITNER_DUE_MIN: 5,
    DUE_PRESSURE_HIGH: 0.4,
    SECTION_WEAK_MAX_SCORE: 55,
    WEAK_POOL_MIN: 6,
    RECENT_WRONG_DENSITY_HIGH: 0.4,
    READY_FOR_MOCK_SCORE: 70,
    CASE_STUDY_TRIGGER_SCORE: 65,
    SECTION_DRILL_DEFAULT_COUNT: 10,
    MOCK_DEFAULT_COUNT: 40,
  };

  const LAYER = {
    leitner: 'retain',
    weak: 'retain',
    smart: 'retain',
    section: 'learn',
    case_study: 'perform',
    mock: 'perform',
    practice: 'learn',
  };

  function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

  function getBreakdown(examCode) {
    const eng = global.readinessEngine;
    if (!eng || typeof eng.getReadinessBreakdown !== 'function') {
      return {
        overall: 0, sections: {}, weakestSections: [],
        factors: { accuracy: 0, mastery: 0, duePressure: 0 },
        sectionDetails: {}, confidence: 'none', totalAnswered: 0,
      };
    }
    return eng.getReadinessBreakdown(examCode);
  }

  function leitnerDue(exam) {
    // Use getLeitnerStats so the Study Plan count matches Mastery distribution
    // and Study Insights (both read the raw leitner map by e.exam, no
    // question-type or filter constraints). getLeitnerDuePool stays scoped
    // to the actual session pool (mcq-only, exam-filtered) for starting.
    return safe(() => {
      if (typeof getLeitnerStats === 'function') return (getLeitnerStats(exam) || {}).due || 0;
      if (typeof getLeitnerDuePool === 'function') return (getLeitnerDuePool(exam) || []).length;
      return 0;
    }, 0);
  }

  function weakPoolSize(exam) {
    return safe(() => (typeof getWeakQuestionPool === 'function') ? (getWeakQuestionPool(exam) || []).length : 0, 0);
  }

  function smartPoolSize(exam) {
    return safe(() => {
      if (typeof getSmartReviewQuestions !== 'function') return 0;
      const limit = (typeof S !== 'undefined' && S && Number.isFinite(S.practiceQuestionCount)) ? S.practiceQuestionCount : 40;
      return (getSmartReviewQuestions(exam, limit) || []).length;
    }, 0);
  }

  function caseStudyAvailable(exam) {
    return safe(() => {
      if (typeof S === 'undefined' || !S.db || !S.db.exams || !S.db.exams[exam]) return false;
      return (S.db.exams[exam].questions || []).some(q => q.group_type === 'case_study');
    }, false);
  }

  function mockAvailable(exam) {
    return safe(() => {
      if (typeof S === 'undefined' || !S.db || !S.db.exams || !S.db.exams[exam]) return false;
      return (S.db.exams[exam].questions || []).some(q => q.group_type === 'std_test');
    }, false);
  }

  function buildAction(spec) {
    return Object.assign({ layer: LAYER[spec.type] || 'learn' }, spec);
  }

  // Build all candidate actions ranked by priority. Used by both primary and secondary.
  function buildCandidates(examCode) {
    const profile = (typeof getExamProfile === 'function') ? getExamProfile(examCode) : null;
    const breakdown = getBreakdown(examCode);
    const due = leitnerDue(examCode);
    const weakSize = weakPoolSize(examCode);
    const smartSize = smartPoolSize(examCode);
    const supportsCaseStudy = !!(profile && profile.supportsCaseStudy) && caseStudyAvailable(examCode);
    const supportsMock = !!(profile && profile.supportsMock !== false) && mockAvailable(examCode);
    const recentWrong = breakdown.factors.recentWrongDensity || 0;
    const duePressure = breakdown.factors.duePressure || 0;
    const overall = breakdown.overall || 0;
    const weakestKeys = breakdown.weakestSections || [];
    const details = breakdown.sectionDetails || {};
    const worstKey = weakestKeys[0];
    const worst = worstKey ? details[worstKey] : null;

    const candidates = [];

    // 1. Leitner — overdue or high pressure
    if (due >= T.LEITNER_DUE_MIN || duePressure >= T.DUE_PRESSURE_HIGH) {
      candidates.push(buildAction({
        type: 'leitner',
        title: 'Scheduled review',
        reason: due >= T.LEITNER_DUE_MIN
          ? `${due} cards overdue — don't lose the interval`
          : 'Many cards have piled up for review',
        cta: due ? `Review ${due}` : 'Open review',
        priority: 100,
        sessionConfig: { mode: 'leitner' },
      }));
    }

    // 2. Section drill — weakest section is poor
    if (worst && worst.score <= T.SECTION_WEAK_MAX_SCORE && worst.hasData) {
      candidates.push(buildAction({
        type: 'section',
        title: `Drill «${worst.label}»`,
        reason: `Weakest section — readiness ${worst.score}%`,
        cta: `Start ${T.SECTION_DRILL_DEFAULT_COUNT} questions`,
        priority: 80,
        sessionConfig: {
          mode: 'section',
          section: worstKey,
          count: T.SECTION_DRILL_DEFAULT_COUNT,
        },
      }));
    }

    // 3. Weak / Smart — high recent wrong density
    if (recentWrong >= T.RECENT_WRONG_DENSITY_HIGH && weakSize >= T.WEAK_POOL_MIN) {
      candidates.push(buildAction({
        type: 'weak',
        title: 'Review your mistakes',
        reason: `Recent error rate ${Math.round(recentWrong * 100)}% — review needed`,
        cta: `Review ${weakSize}`,
        priority: 70,
        sessionConfig: { mode: 'weak' },
      }));
    } else if (smartSize >= T.WEAK_POOL_MIN && breakdown.totalAnswered >= 30) {
      candidates.push(buildAction({
        type: 'smart',
        title: 'Smart Review',
        reason: 'Smart selection of weak topics by mastery and history',
        cta: `Review ${smartSize}`,
        priority: 55,
        sessionConfig: { mode: 'smart' },
      }));
    }

    // 4. Full practice — readiness is high enough
    if (overall >= T.READY_FOR_MOCK_SCORE && supportsMock) {
      candidates.push(buildAction({
        type: 'mock',
        title: 'Full practice',
        reason: `Readiness ${overall}% — time to run a simulation by exam weights`,
        cta: `Start ${T.MOCK_DEFAULT_COUNT} questions`,
        priority: 60,
        sessionConfig: { mode: 'mock', count: T.MOCK_DEFAULT_COUNT },
      }));
    }

    // 5. Case study — exam supports it AND case sections are weak (or средняя готовность)
    if (supportsCaseStudy && overall >= T.CASE_STUDY_TRIGGER_SCORE) {
      candidates.push(buildAction({
        type: 'case_study',
        title: 'Tackle a case study',
        reason: 'Practice long scenarios — the real-exam format',
        cta: 'Open case',
        priority: 50,
        sessionConfig: { mode: 'case_study' },
      }));
    }

    // 6. Fallback — practice
    candidates.push(buildAction({
      type: 'practice',
      title: 'Free practice',
      reason: breakdown.totalAnswered < 30
        ? 'Not much data yet — start with regular questions'
        : 'Keep up the pace — a few questions today',
      cta: 'Start session',
      priority: 10,
      sessionConfig: { mode: 'practice' },
    }));

    candidates.sort((a, b) => b.priority - a.priority);
    return { candidates, breakdown, signals: {
      leitnerDue: due,
      duePressure,
      recentWrongDensity: recentWrong,
      weakPoolSize: weakSize,
      smartPoolSize: smartSize,
      overall,
      supportsMock,
      supportsCaseStudy,
      weakestSection: worst ? { key: worstKey, label: worst.label, score: worst.score } : null,
    }};
  }

  function getRecommendedAction(examCode) {
    const { candidates } = buildCandidates(examCode);
    return candidates[0] || null;
  }

  function getSecondaryActions(examCode, limit = 2) {
    const { candidates } = buildCandidates(examCode);
    return candidates.slice(1, 1 + limit);
  }

  // Study plan v1 draft — три блока (retain / learn / perform), пока без расписания
  function getStudyPlanDraft(examCode) {
    const { candidates, breakdown, signals } = buildCandidates(examCode);
    const byLayer = { retain: null, learn: null, perform: null };
    candidates.forEach(c => {
      if (!byLayer[c.layer]) byLayer[c.layer] = c;
    });

    const blocks = [];
    if (byLayer.retain) blocks.push(Object.assign({ slot: 'retain' }, byLayer.retain));
    if (byLayer.learn)  blocks.push(Object.assign({ slot: 'learn'  }, byLayer.learn));
    if (byLayer.perform) blocks.push(Object.assign({ slot: 'perform' }, byLayer.perform));

    return {
      examCode,
      readiness: breakdown.overall,
      confidence: breakdown.confidence,
      weakestSections: breakdown.weakestSections,
      blocks,
      signals,
      generatedAt: Date.now(),
    };
  }

  global.recommendationEngine = {
    getRecommendedAction,
    getSecondaryActions,
    getStudyPlanDraft,
    THRESHOLDS: T,
  };
})(typeof window !== 'undefined' ? window : globalThis);
