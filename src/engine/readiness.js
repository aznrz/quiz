// Readiness engine v1 — universal across exams.
// Loaded after exam-profiles.js and app.js. Reads existing globals
// (loadStore, loadMastery, getExamQuestions, getQuestionKey,
// getQuestionSectionKey, getExamProfile). No new storage entities,
// no new modes, no app.js refactor.
//
// Section score (0..100):
//   55% accuracy + 25% mastery + 10% (1 - recentWrongDensity) + 10% (1 - duePressure)
//
// `accuracy` is windowed with continuous blending:
//   recentWeight = clamp01((recentSeen - 2) / (100 - 2))    // 0..1 linear
//   accuracy = recentWeight * accuracyRecent
//            + (1 - recentWeight) * accuracyAllTime
// where accuracyRecent uses per-question latest-state inside a 14-day
// window. The more recent samples in the section, the more they count;
// at 100+ unique recent questions in a section all-time is fully
// dropped. If all-time history is too thin (<10 answers), recent
// carries alone whenever it has any samples.
// Both `accuracy` and `recentWrongDensity` use the same 14-day window
// for consistency — "are you currently practicing well" and "are you
// currently making mistakes" are the same question on the same horizon.
// Exam overall = weighted avg of section scores using profile.sectionWeights.
// Sections without data fall back to neutral prior 50.

(function (global) {
  // Single window for both accuracy and recentWrongDensity (14 days).
  // Kept as separate constants in case we want to diverge later, but
  // currently aligned for "explain the formula in one sentence".
  const ACCURACY_WINDOW_MS = 14 * 86400000;
  const RECENT_WRONG_WINDOW_MS = 14 * 86400000;
  // Sections without enough data score as 0 (not a soft 50). The 50 default
  // was confusing — looked like "half-ready" when it really meant "unknown".
  // 0 is honest: you haven't covered it, so it doesn't count toward readiness.
  const NEUTRAL_PRIOR = 0;
  const MIN_TOTAL_FOR_DATA = 3;
  // Windowed-accuracy blend params (continuous, no cliffs).
  //  - recentWeight = clamp01((recentSeen - MIN_RECENT_FOR_ANY) / (RECENT_SATURATION - MIN_RECENT_FOR_ANY))
  //  - accuracy = recentWeight * accuracyRecent + (1 - recentWeight) * accuracyAllTime
  // Tuning at 14-day window:
  //  - MIN_RECENT_FOR_ANY=2: with <2 recent questions in section, ignore
  //    recent (one lucky/unlucky answer shouldn't swing accuracy).
  //  - RECENT_SATURATION=100: 100+ unique recent questions in a section
  //    over 14 days → pure recent. Calibrated for active users (~10 q
  //    per section per day = ~10 days of practice to saturate). Below
  //    that, old history retains some weight as a stabilizer.
  //  - MIN_ALLTIME_BLEND=10: if all-time total <10, treat all-time as
  //    unreliable and let recent carry alone whenever recentSeen>=1.
  const MIN_RECENT_FOR_ANY = 2;
  const RECENT_SATURATION = 100;
  const MIN_ALLTIME_BLEND = 10;

  // Readiness status thresholds: status requires BOTH overall ≥ Overall AND
  // min(section_with_data) ≥ Floor. Sections without data are excluded from
  // the floor check (so partial coverage doesn't lock everyone at not_ready).
  // Order matters: first match wins (descending bar).
  const STATUS_RULES = [
    { key: 'expert_ready', overall: 90, floor: 85 },
    { key: 'ready_strong', overall: 85, floor: 75 },
    { key: 'ready',        overall: 75, floor: 65 },
    { key: 'borderline',   overall: 65, floor: 60 },
    { key: 'developing',   overall: 55, floor: 50 },
    { key: 'foundational', overall: 45, floor: 40 },
  ];

  function classifyStatus(overall, minSection) {
    for (const r of STATUS_RULES) {
      if (overall >= r.overall && minSection >= r.floor) return r.key;
    }
    return 'not_ready';
  }

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function pct(x) { return Math.round(clamp01(x) * 100); }

  // Wilson score interval for a binomial proportion. Honest "I haven't
  // seen enough samples" signal — returns {low, high, margin, center} in
  // [0, 1]. Default z=1.96 ≈ 95% CI: scientific convention used in A/B
  // tests, medical trials, and research papers.
  // Reference: https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval
  function wilsonCI(correct, total, z) {
    z = (typeof z === 'number') ? z : 1.96;
    if (!total || total <= 0) return { low: 0, high: 1, margin: 0.5, center: 0 };
    var p = correct / total;
    var z2 = z * z;
    var denom = 1 + z2 / total;
    var center = (p + z2 / (2 * total)) / denom;
    var margin = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denom;
    return {
      low: Math.max(0, center - margin),
      high: Math.min(1, center + margin),
      margin: margin,
      center: center,
    };
  }

  function safeLoadStore() {
    try { return (typeof loadStore === 'function') ? loadStore() : {}; }
    catch { return {}; }
  }
  function safeLoadMastery() {
    try { return (typeof loadMastery === 'function') ? loadMastery() : {}; }
    catch { return {}; }
  }
  function safeGetExamQuestions(exam) {
    // Readiness must reflect the exam as a whole, not the active version/lang
    // filter — otherwise the score jumps when the user toggles filters even
    // though their underlying preparedness hasn't changed. Prefer the
    // unfiltered helper, fall back to the filtered one for older builds.
    try {
      if (typeof getAllExamQuestions === 'function') return getAllExamQuestions(exam) || [];
      if (typeof getExamQuestions === 'function') return getExamQuestions(exam) || [];
      return [];
    } catch { return []; }
  }
  function qKey(q) {
    try { return (typeof getQuestionKey === 'function') ? getQuestionKey(q) : (q.id || ''); }
    catch { return q.id || ''; }
  }
  function qSection(q) {
    try { return (typeof getQuestionSectionKey === 'function') ? getQuestionSectionKey(q) : (q.section_key || ''); }
    catch { return q.section_key || ''; }
  }

  // Per-question fractional mastery score in [0, 1]. Reads recentResults
  // ring buffer (last 3 outcomes) maintained by updateQuestionStats.
  //
  // The user's intuition is:
  //  - 1 right alone could be lucky → not yet "learned"
  //  - 2 right is better, but still not certain
  //  - 3 right in a row → really learned, history overridden
  //
  // We map this to a hybrid Bayesian score:
  //  - [T,T,T] → 1.0 (explicit "learned")
  //  - [F,F,F] → 0.0 (explicit "definitely don't know")
  //  - any other combination of 1, 2, or 3 attempts → (correct+1)/(n+2)
  //    Bayesian smoothing so a single lucky/unlucky answer can't read as
  //    100%/0%. Examples: [T]=0.67, [T,T]=0.75, [F,T,T]=0.60.
  //  - empty ring (legacy data before this feature shipped) → falls back
  //    to latest-attempt comparison and assigns 0.67/0.33 (partial credit,
  //    same magnitude as a single-sample Bayesian update).
  function recentMasteryScore(qst) {
    const rr = qst && qst.recentResults;
    if (!Array.isArray(rr) || rr.length === 0) {
      if (!qst) return 0.5;
      const latestCorrect = (qst.lastCorrect || 0) >= (qst.lastWrong || 0);
      return latestCorrect ? 0.67 : 0.33;
    }
    const corrects = rr.filter(Boolean).length;
    const n = rr.length;
    if (n === 3 && corrects === 3) return 1.0;
    if (n === 3 && corrects === 0) return 0.0;
    return (corrects + 1) / (n + 2);
  }

  // Compute per-section factors {accuracy, mastery, duePressure, recentWrongDensity, score, hasData, ...}
  function computeSectionDetails(examCode) {
    const profile = (typeof getExamProfile === 'function')
      ? getExamProfile(examCode)
      : { sectionWeights: {}, sectionLabels: {} };
    const sectionKeys = Object.keys(profile.sectionWeights || {});
    if (!sectionKeys.length) return { details: {}, profile };

    const store = safeLoadStore();
    const sectionStats = store.sectionStats || {};
    const questionStats = store.questionStats || {};
    const leitner = store.leitner || {};
    const mastery = safeLoadMastery();
    const now = Date.now();

    // Index questions by section
    const questions = safeGetExamQuestions(examCode);
    const bySection = {};
    sectionKeys.forEach(s => { bySection[s] = []; });
    questions.forEach(q => {
      const s = qSection(q);
      if (s && bySection[s]) bySection[s].push(q);
    });

    const details = {};
    sectionKeys.forEach(sKey => {
      const statsKey = `${examCode}__${sKey}`;
      const ss = sectionStats[statsKey] || { correct: 0, total: 0 };
      const qs = bySection[sKey] || [];

      const total = ss.total || 0;
      const correct = ss.correct || 0;
      const hasData = total >= MIN_TOTAL_FOR_DATA;

      // Mastery — avg(level/5) over questions seen at least once.
      // Single 14-day window for both windowed-accuracy and
      // recentWrongDensity — see top-of-file rationale.
      // Within the window we sum fractional per-question mastery scores
      // (see recentMasteryScore above) instead of binary 0/1 — so a
      // question with [T,T,T] contributes 1.0 ("learned"), [T,T]=0.75,
      // single [T]=0.67 (lucky-guess discount), etc.
      let mSum = 0, mCount = 0;
      let accRecentSeen = 0, accRecentCorrect = 0;
      let recentSeen = 0, recentWrong = 0;
      qs.forEach(q => {
        const k = qKey(q);
        const lvl = mastery[k];
        if (typeof lvl === 'number') { mSum += lvl / 5; mCount += 1; }
        const qst = questionStats[k];
        if (!qst || !qst.lastSeen) return;
        const age = now - qst.lastSeen;
        const score = recentMasteryScore(qst);
        if (age <= ACCURACY_WINDOW_MS) {
          accRecentSeen += 1;
          accRecentCorrect += score;
        }
        if (age <= RECENT_WRONG_WINDOW_MS) {
          recentSeen += 1;
          recentWrong += (1 - score);
        }
      });
      const masteryAvg = mCount > 0 ? clamp01(mSum / mCount) : 0;
      const recentWrongDensity = recentSeen > 0 ? clamp01(recentWrong / recentSeen) : 0;

      // Windowed accuracy with continuous blending — no cliff at any
      // threshold. The more recent samples you have, the more they count
      // (linear ramp from MIN_RECENT_FOR_ANY to RECENT_SATURATION).
      // If all-time history is too thin to trust (total<MIN_ALLTIME_BLEND),
      // recent carries alone whenever it has at least one sample.
      const accuracyAllTime = total > 0 ? clamp01(correct / total) : null;
      const accuracyRecent = accRecentSeen > 0
        ? clamp01(accRecentCorrect / accRecentSeen)
        : null;
      const allTimeReliable = accuracyAllTime != null && total >= MIN_ALLTIME_BLEND;
      let recentWeight;
      if (accuracyRecent == null) {
        recentWeight = 0;
      } else if (!allTimeReliable) {
        recentWeight = 1;
      } else {
        const denom = Math.max(1, RECENT_SATURATION - MIN_RECENT_FOR_ANY);
        recentWeight = Math.max(0, Math.min(1, (accRecentSeen - MIN_RECENT_FOR_ANY) / denom));
      }
      let accuracy;
      let accuracySource;
      if (accuracyRecent == null && accuracyAllTime == null) {
        accuracy = 0.5;
        accuracySource = 'none';
      } else if (accuracyRecent == null) {
        accuracy = accuracyAllTime;
        accuracySource = 'all-time';
      } else if (accuracyAllTime == null || !allTimeReliable) {
        accuracy = accuracyRecent;
        accuracySource = 'recent';
      } else {
        accuracy = recentWeight * accuracyRecent + (1 - recentWeight) * accuracyAllTime;
        if (recentWeight >= 0.99) accuracySource = 'recent';
        else if (recentWeight <= 0.01) accuracySource = 'all-time';
        else accuracySource = 'blend';
      }

      // Due pressure — fraction of overdue Leitner cards in section
      let due = 0, withRecord = 0;
      qs.forEach(q => {
        const rec = leitner[qKey(q)];
        if (rec) {
          withRecord += 1;
          if (rec.nextReviewAt && rec.nextReviewAt <= now) due += 1;
        }
      });
      const duePressure = withRecord > 0 ? clamp01(due / withRecord) : 0;

      const score = hasData
        ? pct(0.55 * accuracy + 0.25 * masteryAvg + 0.10 * (1 - recentWrongDensity) + 0.10 * (1 - duePressure))
        : NEUTRAL_PRIOR;

      // Wilson CI on the all-time accuracy proportion. We don't use the
      // blended (recent + all-time) figure because Wilson is a binomial-
      // proportion bound — needs a clean (correct, total) pair. The blend
      // is a heuristic mix of two distributions and doesn't have a closed-
      // form CI. All-time is the most data we have for the bound; the
      // displayed margin therefore answers "how confident are we in the
      // accuracy proportion alone", which is the visualization we want.
      const accuracyCI = wilsonCI(correct, total);
      // Convert CI for accuracy → CI for the section score, using the
      // partial derivative wrt accuracy (0.55). Other factors (mastery,
      // recentWrongDensity, duePressure) are point estimates here.
      const sectionMargin = hasData ? Math.round(0.55 * accuracyCI.margin * 100) : 50;
      const scoreLow = hasData ? Math.max(0, score - sectionMargin) : 0;
      const scoreHigh = hasData ? Math.min(100, score + sectionMargin) : 100;

      details[sKey] = {
        score,
        scoreLow,
        scoreHigh,
        scoreMargin: sectionMargin,
        accuracy,
        accuracyAllTime,
        accuracyRecent,
        accuracySource,
        accuracyCI,
        recentWeight,
        accuracyRecentSampleSize: accRecentSeen,
        recentWrongSampleSize: recentSeen,
        mastery: masteryAvg,
        recentWrongDensity,
        duePressure,
        total,
        correct,
        due,
        questionCount: qs.length,
        hasData,
        label: profile.sectionLabels[sKey] || sKey,
      };
    });

    return { details, profile };
  }

  function getSectionReadiness(examCode, sectionKey) {
    const { details } = computeSectionDetails(examCode);
    return details[sectionKey] ? details[sectionKey].score : NEUTRAL_PRIOR;
  }

  function getExamReadiness(examCode) {
    return getReadinessBreakdown(examCode).overall;
  }

  function getReadinessBreakdown(examCode) {
    const { details, profile } = computeSectionDetails(examCode);
    const weights = profile.sectionWeights || {};
    const keys = Object.keys(details);

    if (!keys.length) {
      return {
        overall: 0,
        sections: {},
        weakestSections: [],
        factors: { accuracy: 0, mastery: 0, duePressure: 0 },
        sectionDetails: {},
        confidence: 'none',
      };
    }

    let weightedScore = 0;
    let weightSum = 0;
    let accAgg = 0, masteryAgg = 0, dueAgg = 0, recentWrongAgg = 0;
    let accRecentAgg = 0, accAllTimeAgg = 0;
    let recentWeightAgg = 0;
    let accRecentWeightSum = 0, accAllTimeWeightSum = 0;
    let totalAccRecentSamples = 0, totalAccAllTimeSamples = 0;
    let totalAnswered = 0;
    let sectionsWithData = 0;
    // Accuracy CI bounds rolled up weighted by sectionWeights. Sections
    // without data contribute the maximally-uncertain [0, 1] bound to be
    // honest about coverage gaps (uncovered → don't claim anything about
    // them). This is conservative on purpose: a 50%-coverage user
    // shouldn't see a tight Readiness CI just because the half they did
    // cover is well-sampled.
    let accCILowAgg = 0, accCIHighAgg = 0;
    let totalCorrect = 0, totalAnswersForCI = 0;
    const sections = {};

    keys.forEach(k => {
      const d = details[k];
      const w = typeof weights[k] === 'number' ? weights[k] : 0;
      sections[k] = d.score;
      weightedScore += d.score * w;
      weightSum += w;
      accAgg += d.accuracy * w;
      masteryAgg += d.mastery * w;
      dueAgg += d.duePressure * w;
      recentWrongAgg += d.recentWrongDensity * w;
      if (d.accuracyRecent != null) {
        accRecentAgg += d.accuracyRecent * w;
        accRecentWeightSum += w;
        totalAccRecentSamples += d.accuracyRecentSampleSize || 0;
      }
      if (d.accuracyAllTime != null) {
        accAllTimeAgg += d.accuracyAllTime * w;
        accAllTimeWeightSum += w;
        totalAccAllTimeSamples += d.total || 0;
      }
      recentWeightAgg += (d.recentWeight || 0) * w;
      totalAnswered += d.total;
      if (d.hasData) sectionsWithData += 1;
      var ci = d.accuracyCI || { low: 0, high: 1 };
      accCILowAgg += ci.low * w;
      accCIHighAgg += ci.high * w;
      totalCorrect += d.correct || 0;
      totalAnswersForCI += d.total || 0;
    });

    const overall = weightSum > 0 ? Math.round(weightedScore / weightSum) : NEUTRAL_PRIOR;

    // Overall accuracy CI. Two derivations available, we keep both:
    //  1) per-section weighted (accCILowAgg / weightSum) — reflects the
    //     same weighting Readiness uses, so propagation to overall margin
    //     is consistent with the formula.
    //  2) pooled (Wilson on totalCorrect / totalAnswersForCI) — ignores
    //     section weighting, but tighter when one section dominates.
    // Surface both so callers can pick; UI defaults to (1) for honesty.
    const accuracyCIPooled = wilsonCI(totalCorrect, totalAnswersForCI);
    const accCIWeightedLow = weightSum > 0 ? accCILowAgg / weightSum : 0;
    const accCIWeightedHigh = weightSum > 0 ? accCIHighAgg / weightSum : 1;
    const accCIWeightedMargin = (accCIWeightedHigh - accCIWeightedLow) / 2;
    // Propagate accuracy CI through the readiness formula. Readiness =
    // 0.55*accuracy + 0.25*mastery + 0.10*(1−rwd) + 0.10*(1−dp); margin
    // wrt accuracy is the only term we have CI for. In readiness units
    // (0..100): margin_pp = 0.55 * acc_margin * 100.
    const overallMargin = Math.round(0.55 * accCIWeightedMargin * 100);
    const overallLow = Math.max(0, overall - overallMargin);
    const overallHigh = Math.min(100, overall + overallMargin);

    // Min-section floor: only sections with actual data count. If nothing has
    // data, treat min as 0 so status falls to not_ready.
    const sectionsWithDataKeys = keys.filter(k => details[k].hasData);
    const minSectionScore = sectionsWithDataKeys.length
      ? Math.min(...sectionsWithDataKeys.map(k => details[k].score))
      : 0;
    const minSectionKey = sectionsWithDataKeys.length
      ? sectionsWithDataKeys.reduce((a, b) => details[a].score <= details[b].score ? a : b)
      : null;

    const weakestSections = sectionsWithDataKeys
      .slice()
      .sort((a, b) => details[a].score - details[b].score)
      .slice(0, 3);

    let confidence = 'low';
    if (sectionsWithData >= keys.length * 0.6 && totalAnswered >= 30) confidence = 'medium';
    if (sectionsWithData === keys.length && totalAnswered >= 100) confidence = 'high';

    const status = classifyStatus(overall, minSectionScore);

    return {
      overall,
      overallLow,
      overallHigh,
      overallMargin,
      status,
      minSection: minSectionScore,
      minSectionKey,
      sections,
      weakestSections,
      factors: {
        accuracy: weightSum > 0 ? accAgg / weightSum : 0,
        accuracyRecent: accRecentWeightSum > 0 ? accRecentAgg / accRecentWeightSum : null,
        accuracyAllTime: accAllTimeWeightSum > 0 ? accAllTimeAgg / accAllTimeWeightSum : null,
        accuracyRecentWeight: weightSum > 0 ? recentWeightAgg / weightSum : 0,
        accuracyRecentSampleSize: totalAccRecentSamples,
        accuracyAllTimeSampleSize: totalAccAllTimeSamples,
        accuracyWindowDays: 14,
        accuracyCI: {
          low: accCIWeightedLow,
          high: accCIWeightedHigh,
          margin: accCIWeightedMargin,
        },
        accuracyCIPooled: accuracyCIPooled,
        mastery: weightSum > 0 ? masteryAgg / weightSum : 0,
        duePressure: weightSum > 0 ? dueAgg / weightSum : 0,
        recentWrongDensity: weightSum > 0 ? recentWrongAgg / weightSum : 0,
      },
      sectionDetails: details,
      confidence,
      totalAnswered,
      totalCorrect,
      sectionsWithData,
    };
  }

  // Heuristic logistic mapping from internal readiness 0..100 to estimated
  // PL-300-style pass probability. Calibrated so that R=70 → ~50%, R=78 → ~73%,
  // R=80 (our "exam-ready" cutoff) → ~78%. Floors at 2% / 98% to avoid implying
  // certainty in either direction. Not calibrated against real exam outcomes —
  // re-tune when we collect that.
  function passProbability(readiness) {
    const R_THRESHOLD = 70;
    const STEEPNESS = 8;
    const r = Number(readiness);
    if (!isFinite(r)) return 0;
    const z = (r - R_THRESHOLD) / STEEPNESS;
    const p = 1 / (1 + Math.exp(-z));
    return Math.max(0.02, Math.min(0.98, p));
  }

  global.readinessEngine = {
    getExamReadiness,
    getSectionReadiness,
    getReadinessBreakdown,
    classifyStatus,
    passProbability,
    wilsonCI,
    STATUS_RULES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
