// Bootstrap CI for Readiness — empirical alternative to the analytical
// Wilson margin in src/engine/readiness.js.
//
// What it does:
//   - Treats user's answered questions as the population of independence
//     atoms (questions, not attempts — attempts on one question are
//     correlated via Leitner reviews).
//   - For each of N iterations, resamples the user's question pool with
//     replacement, sums per-section (correct, total), computes weighted
//     accuracy across sections (same weighting Readiness uses).
//   - SD of these N accuracies × z(0.025)=1.96 × accuracy-weight 0.55
//     × 100 = readiness margin in 0..100 units.
//
// Why bootstrap captures more than Wilson:
//   - Question-level resampling reflects the *discrete* pool: a small
//     pool with mixed accuracies has wider empirical variance than
//     Wilson would predict from a single pooled proportion.
//   - Weight imbalance across sections shows up as variance.
//
// Cache: localStorage, 24h TTL, invalidates if n_unique_questions
// changes by >10% (the user has done meaningful new work).

(function (global) {
  var LS_KEY = 'eq_bootstrap_ci_v1';
  var CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  var INVALIDATE_DELTA_PCT = 0.10;
  var Z_95 = 1.96;
  var ACCURACY_WEIGHT = 0.55;

  function loadCache() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (_) { return {}; }
  }

  function saveCache(map) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(map || {})); } catch (_) {}
  }

  function getCachedMargin(examCode, currentN) {
    var cache = loadCache();
    var hit = cache[examCode];
    if (!hit) return null;
    if (typeof hit.margin !== 'number') return null;
    if (Date.now() - (hit.computedAt || 0) > CACHE_TTL_MS) return null;
    var prevN = hit.n_questions || 0;
    if (prevN > 0 && currentN > 0) {
      var delta = Math.abs(currentN - prevN) / Math.max(prevN, currentN);
      if (delta > INVALIDATE_DELTA_PCT) return null;
    }
    return hit;
  }

  function setCachedMargin(examCode, result) {
    var cache = loadCache();
    cache[examCode] = result;
    saveCache(cache);
  }

  function safeLoadStore() {
    try { return (typeof loadStore === 'function') ? loadStore() : {}; }
    catch (_) { return {}; }
  }

  function safeGetExamQuestions(exam) {
    try {
      if (typeof getAllExamQuestions === 'function') return getAllExamQuestions(exam) || [];
      if (typeof getExamQuestions === 'function') return getExamQuestions(exam) || [];
      return [];
    } catch (_) { return []; }
  }

  function qKey(q) {
    try { return (typeof getQuestionKey === 'function') ? getQuestionKey(q) : (q.id || ''); }
    catch (_) { return q.id || ''; }
  }

  function qSection(q) {
    try { return (typeof getQuestionSectionKey === 'function') ? getQuestionSectionKey(q) : (q.section_key || ''); }
    catch (_) { return q.section_key || ''; }
  }

  // Build the user's answered-questions pool for the exam. Each item:
  //   { correct, total, sectionKey }
  function buildPool(examCode) {
    var store = safeLoadStore();
    var qStats = store.questionStats || {};
    var examQs = safeGetExamQuestions(examCode);
    var pool = [];
    for (var i = 0; i < examQs.length; i++) {
      var q = examQs[i];
      var key = qKey(q);
      var stats = qStats[key];
      if (!stats || !stats.total) continue;
      var sKey = qSection(q);
      if (!sKey) continue;
      pool.push({
        correct: stats.correct || 0,
        total: stats.total || 0,
        sectionKey: sKey,
      });
    }
    return pool;
  }

  // Bootstrap on accuracy. Returns { margin, mean, std, iterations,
  // n_questions, computedAt }. margin is in 0..100 Readiness units
  // (already × 0.55 × 100). If pool too small, returns margin: 0.
  function compute(examCode, iterations) {
    iterations = iterations || 500;
    var profile = (typeof getExamProfile === 'function') ? getExamProfile(examCode) : null;
    var weights = (profile && profile.sectionWeights) || {};
    var pool = buildPool(examCode);
    var nUnique = pool.length;
    var result = {
      margin: 0,
      mean: 0,
      std: 0,
      iterations: iterations,
      n_questions: nUnique,
      computedAt: Date.now(),
    };
    if (nUnique < 5) return result;          // not enough data
    if (!Object.keys(weights).length) return result;

    var samples = new Array(iterations);
    for (var iter = 0; iter < iterations; iter++) {
      // Per-section accumulators
      var sec = {};
      for (var i = 0; i < nUnique; i++) {
        var pick = pool[(Math.random() * nUnique) | 0];
        var s = sec[pick.sectionKey];
        if (!s) { s = { correct: 0, total: 0 }; sec[pick.sectionKey] = s; }
        s.correct += pick.correct;
        s.total += pick.total;
      }
      // Weighted accuracy across sections (same weighting as Readiness)
      var accAgg = 0;
      var wAgg = 0;
      var keys = Object.keys(weights);
      for (var k = 0; k < keys.length; k++) {
        var sk = keys[k];
        var w = Number(weights[sk]) || 0;
        var ss = sec[sk];
        if (ss && ss.total > 0 && w > 0) {
          accAgg += (ss.correct / ss.total) * w;
          wAgg += w;
        }
      }
      samples[iter] = wAgg > 0 ? (accAgg / wAgg) : 0;
    }

    // Mean + SD of resampled accuracies
    var mean = 0;
    for (var j = 0; j < iterations; j++) mean += samples[j];
    mean /= iterations;
    var variance = 0;
    for (var jj = 0; jj < iterations; jj++) {
      var d = samples[jj] - mean;
      variance += d * d;
    }
    variance /= iterations;
    var std = Math.sqrt(variance);

    // Propagate to Readiness units: margin = z × σ_acc × 0.55 × 100
    result.mean = Math.round(mean * 100);
    result.std = std;
    result.margin = Math.round(Z_95 * std * ACCURACY_WEIGHT * 100);
    return result;
  }

  // Cached lookup. Returns the cached result if valid; otherwise
  // computes fresh, saves, returns.
  function bootstrapMargin(examCode, opts) {
    opts = opts || {};
    var pool = buildPool(examCode);
    var currentN = pool.length;
    if (!opts.force) {
      var cached = getCachedMargin(examCode, currentN);
      if (cached) return cached;
    }
    var fresh = compute(examCode, opts.iterations || 500);
    setCachedMargin(examCode, fresh);
    return fresh;
  }

  // Expose on existing readinessEngine if present, otherwise stub.
  if (!global.readinessEngine) global.readinessEngine = {};
  global.readinessEngine.bootstrapMargin = bootstrapMargin;
  global.readinessEngine.bootstrapCompute = compute;
})(typeof window !== 'undefined' ? window : globalThis);
