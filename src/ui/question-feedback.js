// Question Feedback — compact rating + report card shown after Check answer
// in Quiz Mode. Data is written to localStorage now; the payload shape is
// stable so a future cloud backend can ingest the same records.
//
// Public:
//   window.saveQuestionFeedback(payload)
//   window.getQuestionFeedbackStats(question_id)
//   window.getQuestionFeedbackBySession(question_id, session_id)
//   window.renderQuestionFeedback(q, selectedKeys, correct)
//   window.clearQuestionFeedback()
//   window.computeFeedbackNeedsReview(stats)
//   window.computeFeedbackPriorityScore(stats)
//   window.getAllQuestionFeedback() — admin viewer reads all raw payloads

(function (global) {
  const STORAGE_KEY = 'question_feedback_v1';
  const REASONS = {
    too_easy: 'Вопрос лёгкий',
    too_hard: 'Вопрос очень сложный',
    unclear_or_disputed_answers: 'Ответы спорные',
    ai_insights_mismatch: 'AI Insights не соответствует',
    wrong_question: 'Вопрос неверный',
  };
  const PUBLIC_STATS_MIN_RATINGS = 5;

  function $(id) { return document.getElementById(id); }

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function getQuestionFeedbackBySession(question_id, session_id) {
    if (!question_id || !session_id) return null;
    return loadAll().find(f => f.question_id === question_id && f.session_id === session_id) || null;
  }

  function saveQuestionFeedback(payload) {
    if (!payload || !payload.question_id || !payload.session_id) {
      return { ok: false, reason: 'invalid_payload' };
    }
    try {
      const all = loadAll();
      const dup = all.find(f => f.question_id === payload.question_id && f.session_id === payload.session_id);
      if (dup) return { ok: false, reason: 'duplicate' };
      all.push(payload);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      try {
        const cs = global.cloudSync;
        const cu = global.currentUser;
        if (cs && cs.saveQuestionFeedback && cu && cu.uid) {
          cs.saveQuestionFeedback(cu.uid, payload).catch(e => console.warn('feedback cloud sync failed', e));
        }
      } catch (e) { console.warn('feedback cloud sync skipped', e); }
      return { ok: true };
    } catch {
      return { ok: false, reason: 'storage' };
    }
  }

  function getQuestionFeedbackStats(question_id) {
    if (!question_id) return null;
    const all = loadAll().filter(f => f.question_id === question_id);
    const ratings = all.map(f => f.rating).filter(r => Number.isFinite(r));
    const reports = all.filter(f => !!f.selected_reason);
    return {
      average_rating: ratings.length
        ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
        : null,
      total_ratings: ratings.length,
      total_reports: reports.length,
      low_rating_count: ratings.filter(r => r <= 2).length,
      wrong_question_reports: reports.filter(r => r.selected_reason === 'wrong_question').length,
      ai_insights_mismatch_reports: reports.filter(r => r.selected_reason === 'ai_insights_mismatch').length,
      unclear_answers_reports: reports.filter(r => r.selected_reason === 'unclear_or_disputed_answers').length,
      too_hard_reports: reports.filter(r => r.selected_reason === 'too_hard').length,
      too_easy_reports: reports.filter(r => r.selected_reason === 'too_easy').length,
    };
  }

  function computeFeedbackNeedsReview(stats) {
    if (!stats) return false;
    if (stats.wrong_question_reports >= 1) return true;
    if (stats.total_reports >= 3) return true;
    if (stats.low_rating_count >= 1) return true;
    if (stats.average_rating != null && stats.average_rating < 3) return true;
    return false;
  }

  function computeFeedbackPriorityScore(stats) {
    if (!stats) return 0;
    // too_hard / too_easy are weight 1 — difficulty signals worth tracking,
    // but not content bugs on the same level as a wrong answer or AI
    // mismatch, so they shouldn't dominate the review queue.
    return (stats.low_rating_count || 0) * 2
      + (stats.wrong_question_reports || 0) * 3
      + (stats.ai_insights_mismatch_reports || 0) * 2
      + (stats.unclear_answers_reports || 0) * 1
      + (stats.too_hard_reports || 0) * 1
      + (stats.too_easy_reports || 0) * 1;
  }

  function getAppVersion() {
    try {
      const el = document.querySelector('.app-version-badge');
      if (el && el.textContent) return el.textContent.trim().replace(/^v/i, '');
    } catch {}
    return '0.0.0';
  }

  function makeFeedbackId(question_id, session_id) {
    return `${question_id}_${session_id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  // Phase 1: stats are local-only (read from this device's localStorage).
  // Shared-with-everyone stats are deferred to Phase 2 backend. UI labels
  // the line as «Local feedback» so it's not mistaken for global counts.
  function publicStatsLine(stats) {
    if (!stats || stats.total_ratings < PUBLIC_STATS_MIN_RATINGS) {
      return 'More local ratings needed to summarise quality.';
    }
    const ratingsWord = stats.total_ratings === 1 ? 'rating' : 'ratings';
    const reportsWord = stats.total_reports === 1 ? 'report' : 'reports';
    return `Local feedback: ${stats.average_rating.toFixed(1)} / 5 · ${stats.total_ratings} ${ratingsWord} · ${stats.total_reports} ${reportsWord}`;
  }

  function renderPublicStats(question_id) {
    const el = $('qFbPublic');
    if (!el) return;
    const stats = getQuestionFeedbackStats(question_id);
    el.textContent = publicStatsLine(stats);
    el.classList.remove('hidden');
  }

  // ── UI state per render (kept on the root element so it survives) ──

  function getState(root) {
    return root._qfbState || (root._qfbState = { rating: null, reason: null, comment: '' });
  }

  function resetState(root) {
    root._qfbState = { rating: null, reason: null, comment: '' };
  }

  function paintStars(root, value) {
    const stars = root.querySelectorAll('.q-fb-star');
    stars.forEach(btn => {
      const r = parseInt(btn.dataset.rating, 10);
      const on = value != null && r <= value;
      btn.classList.toggle('is-filled', on);
      btn.textContent = on ? '★' : '☆';
    });
  }

  function paintReasons(root, reason) {
    root.querySelectorAll('.q-fb-reason').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.reason === reason);
    });
  }

  function updateCommentVisibility(root) {
    const state = getState(root);
    const wrap = $('qFbCommentWrap');
    if (!wrap) return;
    const shouldShow = state.reason != null || (state.rating != null && state.rating <= 3);
    wrap.classList.toggle('hidden', !shouldShow);
  }

  function setStatus(text, kind) {
    const el = $('qFbStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('is-error', 'is-success', 'is-hint', 'hidden');
    if (!text) {
      el.classList.add('hidden');
      return;
    }
    if (kind) el.classList.add(`is-${kind}`);
  }

  function showSubmittedState(root, q) {
    const stars = root.querySelector('.q-feedback-stars');
    const reasons = root.querySelector('.q-feedback-reasons');
    const commentWrap = $('qFbCommentWrap');
    const actions = root.querySelector('.q-feedback-actions');
    if (stars) stars.style.pointerEvents = 'none';
    if (reasons) reasons.style.display = 'none';
    if (commentWrap) commentWrap.classList.add('hidden');
    if (actions) actions.classList.add('hidden');
    setStatus('Feedback saved. Thank you.', 'success');
    if (q) renderPublicStats(q.id);
  }

  function showAlreadySubmittedState(root, q) {
    const reasons = root.querySelector('.q-feedback-reasons');
    const commentWrap = $('qFbCommentWrap');
    const actions = root.querySelector('.q-feedback-actions');
    const existing = getQuestionFeedbackBySession(q.id, getSessionId());
    if (reasons) reasons.style.display = 'none';
    if (commentWrap) commentWrap.classList.add('hidden');
    if (actions) actions.classList.add('hidden');
    if (existing && Number.isFinite(existing.rating)) paintStars(root, existing.rating);
    const stars = root.querySelector('.q-feedback-stars');
    if (stars) stars.style.pointerEvents = 'none';
    setStatus('Feedback already submitted.', 'hint');
    if (q) renderPublicStats(q.id);
  }

  function getSessionId() {
    try { return (global.S && global.S.sessionId) || null; } catch { return null; }
  }

  function bindControls(root, q, selectedKeys, correct) {
    // Stars — hover preview + click commit
    root.querySelectorAll('.q-fb-star').forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        const r = parseInt(btn.dataset.rating, 10);
        paintStars(root, r);
      });
      btn.addEventListener('click', () => {
        const r = parseInt(btn.dataset.rating, 10);
        const state = getState(root);
        state.rating = state.rating === r ? null : r;
        paintStars(root, state.rating);
        updateCommentVisibility(root);
        if (state.rating != null && state.rating <= 2) {
          setStatus('Please describe what looks wrong.', 'hint');
        } else {
          setStatus('', null);
        }
      });
    });
    const starsWrap = root.querySelector('.q-feedback-stars');
    if (starsWrap) {
      starsWrap.addEventListener('mouseleave', () => {
        const state = getState(root);
        paintStars(root, state.rating);
      });
    }

    // Reasons — toggle single-select
    root.querySelectorAll('.q-fb-reason').forEach(btn => {
      btn.addEventListener('click', () => {
        const state = getState(root);
        const r = btn.dataset.reason;
        state.reason = state.reason === r ? null : r;
        paintReasons(root, state.reason);
        updateCommentVisibility(root);
        setStatus('', null);
      });
    });

    // Comment
    const commentEl = $('qFbComment');
    if (commentEl) {
      commentEl.addEventListener('input', () => {
        getState(root).comment = (commentEl.value || '').slice(0, 500);
      });
    }

    // Submit
    const submitBtn = $('qFbSubmit');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        const state = getState(root);
        if (state.rating == null && !state.reason) {
          setStatus('Please add a rating or choose an issue.', 'error');
          return;
        }
        const session_id = getSessionId() || `nosession_${Date.now()}`;
        const payload = {
          feedback_id: makeFeedbackId(q.id, session_id),
          question_id: q.id,
          question_version: q.version || `${q.id}_v1`,
          exam_code: q.exam_code || (global.S && global.S.exam) || null,
          topic: q.topic || null,
          sub_topic: q.sub_topic || null,
          seq: q.seq || null,
          lesson: q.lesson || null,
          num: q.num || null,
          session_id,
          rating: state.rating,
          selected_reason: state.reason,
          comment: (state.comment || '').trim(),
          user_answer: selectedKeys || [],
          correct_answer: q.correct_answers || [],
          is_correct: !!correct,
          mode: (global.S && global.S.mode) || null,
          timestamp: new Date().toISOString(),
          app_version: getAppVersion(),
        };
        const res = saveQuestionFeedback(payload);
        if (res.ok) {
          showSubmittedState(root, q);
          // ── Phase 4.1 event ──
          try {
            global.cloudSync?.logEvent?.('question_feedback_submitted', {
              rating: state.rating,
              reason: state.reason || null,
              has_comment: !!(state.comment && state.comment.trim()),
              is_correct: !!correct,
              exam: q.exam_code || (global.S && global.S.exam) || null,
            });
          } catch (_) {}
        } else if (res.reason === 'duplicate') {
          showAlreadySubmittedState(root, q);
        } else if (res.reason === 'storage') {
          setStatus('Feedback could not be saved locally.', 'error');
        } else {
          setStatus('Feedback could not be saved.', 'error');
        }
      });
    }
  }

  function renderQuestionFeedback(q, selectedKeys, correct) {
    const root = $('questionFeedback');
    if (!root || !q || !q.id) return;
    root.classList.remove('hidden');
    resetState(root);
    setStatus('', null);

    // Reset visual state for a fresh question
    paintStars(root, null);
    paintReasons(root, null);
    const commentEl = $('qFbComment');
    if (commentEl) commentEl.value = '';
    const commentWrap = $('qFbCommentWrap');
    if (commentWrap) commentWrap.classList.add('hidden');
    const reasonsRow = root.querySelector('.q-feedback-reasons');
    if (reasonsRow) reasonsRow.style.display = '';
    const actions = root.querySelector('.q-feedback-actions');
    if (actions) actions.classList.remove('hidden');
    const starsWrap = root.querySelector('.q-feedback-stars');
    if (starsWrap) starsWrap.style.pointerEvents = '';

    // Bind once per page lifetime — listeners read fresh `q`/state via closure.
    // To handle the new question on each render we tear down by cloning.
    if (!root._qfbBound) {
      root._qfbBound = true;
    } else {
      // Rebind for the new question: replace controls so listeners point at fresh q
      const clone = root.cloneNode(true);
      root.parentNode.replaceChild(clone, root);
      return renderQuestionFeedback(q, selectedKeys, correct);
    }

    bindControls(root, q, selectedKeys, correct);

    // Already submitted in this session? show compact state
    const existing = getQuestionFeedbackBySession(q.id, getSessionId());
    if (existing) {
      showAlreadySubmittedState(root, q);
    } else {
      renderPublicStats(q.id);
    }
  }

  function clearQuestionFeedback() {
    const root = $('questionFeedback');
    if (!root) return;
    root.classList.add('hidden');
    resetState(root);
    setStatus('', null);
    const commentEl = $('qFbComment');
    if (commentEl) commentEl.value = '';
    const commentWrap = $('qFbCommentWrap');
    if (commentWrap) commentWrap.classList.add('hidden');
    const publicEl = $('qFbPublic');
    if (publicEl) publicEl.classList.add('hidden');
  }

  global.saveQuestionFeedback = saveQuestionFeedback;
  global.getQuestionFeedbackStats = getQuestionFeedbackStats;
  global.getQuestionFeedbackBySession = getQuestionFeedbackBySession;
  global.renderQuestionFeedback = renderQuestionFeedback;
  global.clearQuestionFeedback = clearQuestionFeedback;
  global.computeFeedbackNeedsReview = computeFeedbackNeedsReview;
  global.computeFeedbackPriorityScore = computeFeedbackPriorityScore;
  // Raw read for the admin viewer (admin-feedback.html). Returns a copy
  // so callers can sort/filter without touching the stored array.
  global.getAllQuestionFeedback = function () { return loadAll().slice(); };
})(typeof window !== 'undefined' ? window : globalThis);
