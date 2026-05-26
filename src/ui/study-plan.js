// Study Plan card — Step 4. Loaded after recommendation.js and app.js.
// Reads window.readinessEngine + window.recommendationEngine, renders into
// #studyPlanCard, routes clicks into existing app.js mode handlers.
// Does not introduce new modes or storage keys.

(function (global) {
  const STATUS_LABEL = {
    expert_ready: 'Expert ready',
    ready_strong: 'Ready strong',
    ready: 'Ready',
    borderline: 'Borderline',
    developing: 'Developing',
    foundational: 'Foundational',
    not_ready: 'Not ready',
  };

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(k => {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    if (Array.isArray(children)) children.forEach(c => c && node.appendChild(c));
    return node;
  }

  function launchRecommendedAction(action) {
    if (!action || !action.sessionConfig) return;
    const cfg = action.sessionConfig;
    const mode = cfg.mode;
    const exam = (typeof S !== 'undefined' && S.exam) ? S.exam : null;
    if (!exam) return;

    if (mode === 'leitner' && typeof getLeitnerDuePool === 'function' && typeof startPreparedSession === 'function') {
      const pool = getLeitnerDuePool(exam) || [];
      if (!pool.length) return;
      const ordered = (typeof shuffle === 'function') ? shuffle(pool) : pool;
      startPreparedSession(ordered, { exam, mode: 'leitner' });
      return;
    }
    if (mode === 'weak' && typeof startWeakSession === 'function') {
      startWeakSession();
      return;
    }
    if (mode === 'smart' && typeof getSmartReviewQuestions === 'function' && typeof startPreparedSession === 'function') {
      const limit = (typeof S !== 'undefined' && S && Number.isFinite(S.practiceQuestionCount)) ? S.practiceQuestionCount : 40;
      const pool = getSmartReviewQuestions(exam, limit) || [];
      if (!pool.length) return;
      startPreparedSession(pool, { exam, mode: 'smart' });
      return;
    }
    if (mode === 'section') {
      // 'section' is now folded into 'practice' with a section filter.
      S.mode = 'practice';
      if (cfg.section) S.section = cfg.section;
      if (cfg.count) S.practiceQuestionCount = cfg.count;
      if (typeof startQuiz === 'function') startQuiz();
      return;
    }
    if (mode === 'mock') {
      // 'mock' is now folded into 'practice' (all sections by weights).
      S.mode = 'practice';
      S.section = 'all';
      if (cfg.count) S.practiceQuestionCount = cfg.count;
      if (typeof startQuiz === 'function') startQuiz();
      return;
    }
    if (mode === 'case_study') {
      S.mode = 'case_study';
      if (typeof startQuiz === 'function') startQuiz();
      return;
    }
    // practice / fallback
    S.mode = 'practice';
    if (typeof startQuiz === 'function') startQuiz();
  }

  function renderStudyPlan() {
    const root = document.getElementById('studyPlanCard');
    if (!root) return;
    const exam = (typeof S !== 'undefined' && S.exam) ? S.exam : null;
    const rec = global.recommendationEngine;
    const rd = global.readinessEngine;
    if (!exam || !rec || !rd) { root.classList.add('hidden'); return; }

    const breakdown = rd.getReadinessBreakdown(exam);
    const primary = rec.getRecommendedAction(exam);
    const plan = rec.getStudyPlanDraft(exam);
    if (!primary) { root.classList.add('hidden'); return; }

    root.innerHTML = '';
    root.classList.remove('hidden');

    // Header
    const status = breakdown.status || 'not_ready';
    const statusLabel = STATUS_LABEL[status] || status;
    const tooltipFormula = `Full Readiness for ${exam}\n` +
      `Formula: 0.55×accuracy + 0.25×mastery + 0.10×(1−recentWrongs) + 0.10×(1−duePressure)\n` +
      `accuracy = last-14d per-question scored from last 3 attempts (3 right in a row = 1.0 "learned"). Blends with all-time, saturates at 100 recent q per section.\n` +
      `Differs from Accuracy in the header (a simple % correct) — this also accounts for ` +
      `Leitner reviews, recent mistakes, and overdue cards.`;
    const head = el('div', { class: 'sp-head' }, [
      el('div', { class: 'sp-title', text: 'Study Plan' }),
      el('div', { class: 'sp-readiness-wrap', title: tooltipFormula }, [
        el('div', { class: 'sp-readiness-label', text: `Readiness for ${exam}` }),
        el('div', { class: 'sp-readiness-row' }, [
          el('div', { class: 'sp-readiness', text: `${breakdown.overall}/100` }),
          el('span', { class: `sp-status-badge sp-status-${status}`, text: statusLabel }),
        ]),
      ]),
    ]);
    root.appendChild(head);

    // Action item: "fix this first" — weakest section if it's the limiter
    if (breakdown.minSectionKey && (breakdown.sectionDetails || {})[breakdown.minSectionKey]) {
      const w = breakdown.sectionDetails[breakdown.minSectionKey];
      const isBlocker = w.score < 65 || (status !== 'ready' && status !== 'ready_strong' && status !== 'expert_ready');
      if (isBlocker) {
        root.appendChild(el('div', { class: 'sp-fix-first' }, [
          el('span', { class: 'sp-fix-first-label', text: 'Fix first:' }),
          el('strong', { text: ` ${w.label} ${w.score}%` }),
        ]));
      }
    }

    // Meta chips: all sections (sorted lowest→highest, weakest highlighted) + due count
    const meta = el('div', { class: 'sp-meta' });
    const allSections = Object.entries(breakdown.sectionDetails || {})
      .filter(([, d]) => d && d.hasData !== false)
      .sort(([, a], [, b]) => (a.score || 0) - (b.score || 0));
    if (allSections.length) {
      const weakKey = breakdown.minSectionKey;
      allSections.forEach(([k, d]) => {
        const isWeakest = k === weakKey;
        meta.appendChild(el('span', {
          class: 'sp-chip sp-chip-section' + (isWeakest ? ' sp-chip-weakest' : ''),
          text: `${d.label} ${d.score}%`,
        }));
      });
    }
    const dueCount = (plan.signals && plan.signals.leitnerDue) || 0;
    if (dueCount > 0) {
      const dueTooltip = 'Spaced repetition (Leitner): cards whose review interval has elapsed.\n' +
        'Right answers grow the interval (1 → 3 → 7 → 14 → 30 days), wrong answers reset it.\n' +
        'Reviewing on time is what makes the schedule work — overdue cards drift back toward "forgotten".';
      meta.appendChild(el('span', {
        class: 'sp-chip due',
        title: dueTooltip,
        text: `Reviews overdue: ${dueCount}`,
      }));
    }
    if (meta.childNodes.length) root.appendChild(meta);

    // Primary action — possibly paired with a "Practice <weakest>" CTA so the
    // user can drill the limiter section without leaving the card.
    const primaryBlock = el('div', { class: 'sp-primary' }, [
      el('div', { class: 'sp-primary-title', text: primary.title }),
      el('div', { class: 'sp-primary-reason', text: primary.reason || '' }),
      el('button', {
        class: 'result-btn primary',
        text: primary.cta || 'Start',
        onclick: () => launchRecommendedAction(primary),
      }),
    ]);

    let weakBlock = null;
    const weakKey = breakdown.minSectionKey;
    const weakDetail = weakKey && (breakdown.sectionDetails || {})[weakKey];
    const primaryAlreadyTargetsWeak = primary.sessionConfig
      && primary.sessionConfig.mode === 'section'
      && primary.sessionConfig.section === weakKey;
    if (weakDetail && !primaryAlreadyTargetsWeak) {
      const weakAction = {
        sessionConfig: { mode: 'section', section: weakKey },
      };
      weakBlock = el('div', { class: 'sp-primary sp-primary-weak' }, [
        el('div', { class: 'sp-primary-title', text: `Practice ${weakDetail.label}` }),
        el('div', { class: 'sp-primary-reason', text: `Weakest section · ${weakDetail.score}%` }),
        el('button', {
          class: 'result-btn primary',
          text: 'Practice',
          onclick: () => launchRecommendedAction(weakAction),
        }),
      ]);
    }

    if (weakBlock) {
      const row = el('div', { class: 'sp-primary-row' }, [primaryBlock, weakBlock]);
      root.appendChild(row);
    } else {
      root.appendChild(primaryBlock);
    }
  }

  global.renderStudyPlan = renderStudyPlan;
  global.launchRecommendedAction = launchRecommendedAction;
})(typeof window !== 'undefined' ? window : globalThis);
