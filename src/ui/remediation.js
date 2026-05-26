// Remediation card (Step 5). Loaded after readiness.js / app.js.
// Shown only on incorrect MCQ answers, right after the existing explanation.
// Pure rule-based v1, no AI. Reads context the caller passes; falls back to
// computing it from current globals (S.exam, breakdown, questionStats).

(function (global) {
  const REMEMBER_MAX = 220;
  const RECENT_WRONG_HIGH = 0.4;

  function $(id) { return document.getElementById(id); }

  function safeBreakdown(examCode) {
    try {
      const eng = global.readinessEngine;
      return (eng && typeof eng.getReadinessBreakdown === 'function')
        ? eng.getReadinessBreakdown(examCode)
        : null;
    } catch { return null; }
  }

  function shorten(text, max) {
    if (!text) return '';
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const dot = cut.lastIndexOf('. ');
    return (dot > max * 0.5 ? cut.slice(0, dot + 1) : cut.trimEnd() + '…');
  }

  function buildContext(q) {
    const ctx = {
      examCode: q && q.exam_code ? q.exam_code : (typeof S !== 'undefined' ? S.exam : ''),
      sectionKey: q && q.section_key ? q.section_key : '',
      sectionLabel: q && q.section_label ? q.section_label : '',
      isWeakSection: false,
      duePressure: 0,
      recentWrongDensity: 0,
      wrongStreak: 0,
      isLeitnerTracked: false,
    };
    const br = safeBreakdown(ctx.examCode);
    if (br) {
      ctx.isWeakSection = (br.weakestSections || []).includes(ctx.sectionKey);
      const detail = br.sectionDetails && br.sectionDetails[ctx.sectionKey];
      if (detail) {
        if (!ctx.sectionLabel) ctx.sectionLabel = detail.label || ctx.sectionKey;
        ctx.duePressure = detail.duePressure || 0;
        ctx.recentWrongDensity = detail.recentWrongDensity || 0;
      }
    }
    try {
      if (typeof loadStore === 'function' && typeof getQuestionKey === 'function') {
        const store = loadStore();
        const qst = (store.questionStats || {})[getQuestionKey(q)];
        if (qst) ctx.wrongStreak = qst.wrongStreak || 0;
        const rec = (store.leitner || {})[getQuestionKey(q)];
        ctx.isLeitnerTracked = !!rec;
      }
    } catch {}
    return ctx;
  }

  function buildSummary(ctx) {
    if (ctx.wrongStreak >= 2) return 'You missed this question repeatedly — review needed';
    if (ctx.isWeakSection) return 'This section is currently one of your weakest';
    if (ctx.recentWrongDensity >= RECENT_WRONG_HIGH) return 'Recent mistakes in this topic keep repeating';
    return 'Question needs review';
  }

  function buildRemember(q) {
    if (q && q.tip) return shorten(q.tip, REMEMBER_MAX);
    if (q && q.explanation) return shorten(q.explanation, REMEMBER_MAX);
    return 'Re-read the explanation and put the takeaway in one sentence — that locks memory in';
  }

  function buildNextStep(ctx) {
    const parts = [];
    parts.push(ctx.isLeitnerTracked
      ? 'This question will return in Scheduled Review sooner'
      : 'Question will enter Scheduled Review and come back later');
    if (ctx.isWeakSection) parts.push('section stays a priority in Study Plan');
    return parts.join('; ') + '.';
  }

  function buildRemediation(q, contextOverride) {
    const ctx = Object.assign(buildContext(q), contextOverride || {});
    return {
      section: ctx.sectionLabel || ctx.sectionKey || '',
      summary: buildSummary(ctx),
      remember: buildRemember(q),
      nextStep: buildNextStep(ctx),
    };
  }

  function renderRemediationCard(q, contextOverride) {
    const root = $('remediationCard');
    if (!root) return;
    root.classList.add('hidden'); return;
    if (!q) { root.classList.add('hidden'); return; }
    const data = buildRemediation(q, contextOverride);

    root.innerHTML = '';
    if (data.section) {
      const sec = document.createElement('div');
      sec.className = 'rc-section';
      sec.textContent = data.section;
      root.appendChild(sec);
    }
    const summary = document.createElement('div');
    summary.className = 'rc-summary';
    summary.textContent = data.summary;
    root.appendChild(summary);

    const rows = [
      ['What to remember', data.remember],
      ['What next', data.nextStep],
    ];
    rows.forEach(([label, text]) => {
      if (!text) return;
      const row = document.createElement('div');
      row.className = 'rc-row';
      const l = document.createElement('div');
      l.className = 'rc-row-label';
      l.textContent = label;
      const t = document.createElement('div');
      t.className = 'rc-row-text';
      t.textContent = text;
      row.appendChild(l);
      row.appendChild(t);
      root.appendChild(row);
    });

    root.classList.remove('hidden');
  }

  function clearRemediationCard() {
    const root = $('remediationCard');
    if (!root) return;
    root.classList.add('hidden');
    root.innerHTML = '';
  }

  global.renderRemediationCard = renderRemediationCard;
  global.clearRemediationCard = clearRemediationCard;
  global.buildRemediation = buildRemediation;
})(typeof window !== 'undefined' ? window : globalThis);
