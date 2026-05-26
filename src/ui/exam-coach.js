// Exam Coach report (Step 6). Loaded after readiness/recommendation/study-plan.
// Pure rule-based, no AI. Renders into #examCoachReport on the result screen.
//
// Public:
//   window.renderExamCoachReport(sessionSummary)
//   window.clearExamCoachReport()
//   window.buildCoachReport(sessionSummary)  // pure data, no DOM
//
// sessionSummary shape (caller passes from finishQuiz):
//   { examCode, mode, score, total, pct, sectionStats, wrongQuestions }
// where sectionStats = { [sectionKey]: { label, correct, total } }

(function (global) {
  const COACH_ELIGIBLE_MODES = ['mock', 'case_study', 'practice', 'section', 'weak', 'smart', 'leitner'];
  const MIN_QUESTIONS_FOR_COACH = 5;

  function $(id) { return document.getElementById(id); }

  function getVerdict(pct) {
    if (pct >= 80) return { eyebrow: 'Strong result', verdict: 'Good attempt' };
    if (pct >= 65) return { eyebrow: 'Readiness is growing', verdict: 'Readiness is growing' };
    if (pct >= 50) return { eyebrow: 'Need to strengthen the basics', verdict: 'Need to strengthen the basics' };
    return { eyebrow: 'Exam is too early', verdict: 'Exam is too early' };
  }

  function rankSections(sectionStats) {
    return Object.entries(sectionStats || {})
      .map(([key, v]) => ({
        key,
        label: v.label || key,
        correct: v.correct || 0,
        total: v.total || 0,
        pct: v.total > 0 ? Math.round((v.correct / v.total) * 100) : 0,
      }))
      .filter(s => s.total > 0);
  }

  function getMistakePattern(ranked, totalQuestions, wrongCount) {
    const weak = ranked.filter(s => s.total >= 2 && s.pct < 70).sort((a, b) => a.pct - b.pct);
    if (!wrongCount) return null;

    if (weak.length === 1 && weak[0].total >= 2) {
      return `Most mistakes are in section «${weak[0].label}» (${weak[0].pct}%).`;
    }
    if (weak.length >= 3) {
      return 'Mistakes are spread across several sections — needs overall practice.';
    }
    if (weak.length === 2) {
      return `Weak spots: «${weak[0].label}» and «${weak[1].label}».`;
    }
    if (wrongCount / Math.max(1, totalQuestions) >= 0.4) {
      return 'High error rate — needs targeted mistake review.';
    }
    return 'Mistakes are isolated — review them in «Review mistakes» mode.';
  }

  function getReadinessImpact(examCode) {
    const eng = global.readinessEngine;
    if (!eng || typeof eng.getReadinessBreakdown !== 'function') return null;
    const br = eng.getReadinessBreakdown(examCode);
    const weakest = (br.weakestSections || []).slice(0, 1).map(k => {
      const d = (br.sectionDetails || {})[k];
      return d ? d.label : k;
    });
    return {
      overall: br.overall,
      confidence: br.confidence,
      mainRisk: weakest[0] || null,
    };
  }

  function getNextAction(examCode) {
    const rec = global.recommendationEngine;
    if (!rec || typeof rec.getRecommendedAction !== 'function') return null;
    return rec.getRecommendedAction(examCode);
  }

  function buildCoachReport(summary) {
    if (!summary) return null;
    const total = summary.total || 0;
    const pct = summary.pct || 0;
    const wrongCount = (summary.wrongQuestions || []).length;
    const ranked = rankSections(summary.sectionStats);
    const verdict = getVerdict(pct);
    const weakInSession = ranked
      .filter(s => s.total >= 2 && s.pct < 70)
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 3);
    const pattern = getMistakePattern(ranked, total, wrongCount);
    const impact = getReadinessImpact(summary.examCode);
    const next = getNextAction(summary.examCode);

    return {
      examCode: summary.examCode,
      mode: summary.mode,
      pct,
      score: summary.score,
      total,
      eligible: total >= MIN_QUESTIONS_FOR_COACH && COACH_ELIGIBLE_MODES.includes(summary.mode),
      verdict,
      weakInSession,
      mistakePattern: pattern,
      readinessImpact: impact,
      nextAction: next,
    };
  }

  function row(label, text) {
    if (!text) return null;
    const wrap = document.createElement('div');
    wrap.className = 'ec-row';
    const l = document.createElement('div');
    l.className = 'ec-row-label';
    l.textContent = label;
    const t = document.createElement('div');
    t.className = 'ec-row-text';
    t.textContent = text;
    wrap.appendChild(l);
    wrap.appendChild(t);
    return wrap;
  }

  function renderExamCoachReport(summary) {
    const root = $('examCoachReport');
    if (!root) return;
    const report = buildCoachReport(summary);
    if (!report || !report.eligible) {
      root.classList.add('hidden');
      root.innerHTML = '';
      return;
    }

    root.innerHTML = '';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'ec-eyebrow';
    eyebrow.textContent = `Exam Coach · ${report.verdict.eyebrow}`;
    root.appendChild(eyebrow);

    const verdict = document.createElement('div');
    verdict.className = 'ec-verdict';
    verdict.textContent = `${report.verdict.verdict} · ${report.pct}% (${report.score}/${report.total})`;
    root.appendChild(verdict);

    const weakText = report.weakInSession.length
      ? report.weakInSession.map(s => `${s.label} ${s.pct}%`).join(' · ')
      : 'No weak sections detected in this session.';
    const weakRow = row('Weak in session', weakText);
    if (weakRow) root.appendChild(weakRow);

    if (report.mistakePattern) {
      const r = row('Mistake pattern', report.mistakePattern);
      if (r) root.appendChild(r);
    }

    if (report.readinessImpact) {
      const ri = report.readinessImpact;
      const text = ri.mainRisk
        ? `Readiness ${ri.overall}/100 · main risk: «${ri.mainRisk}»`
        : `Readiness ${ri.overall}/100`;
      const r = row('Readiness', text);
      if (r) root.appendChild(r);
    }

    if (report.nextAction) {
      const next = document.createElement('div');
      next.className = 'ec-next';
      const title = document.createElement('div');
      title.className = 'ec-next-title';
      title.textContent = `Next step: ${report.nextAction.title}`;
      next.appendChild(title);
      if (report.nextAction.reason) {
        const reason = document.createElement('div');
        reason.className = 'ec-next-reason';
        reason.textContent = report.nextAction.reason;
        next.appendChild(reason);
      }
      const btn = document.createElement('button');
      btn.className = 'result-btn primary ec-next-btn';
      btn.textContent = report.nextAction.cta || 'Start';
      btn.addEventListener('click', () => {
        if (typeof global.launchRecommendedAction === 'function') {
          global.launchRecommendedAction(report.nextAction);
        }
      });
      next.appendChild(btn);
      root.appendChild(next);
    }

    root.classList.remove('hidden');
  }

  function clearExamCoachReport() {
    const root = $('examCoachReport');
    if (!root) return;
    root.classList.add('hidden');
    root.innerHTML = '';
  }

  global.renderExamCoachReport = renderExamCoachReport;
  global.clearExamCoachReport = clearExamCoachReport;
  global.buildCoachReport = buildCoachReport;
})(typeof window !== 'undefined' ? window : globalThis);
