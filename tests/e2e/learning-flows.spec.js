// Learning-flow tests — exercise the engines through realistic data shapes
// without depending on Firebase auth. We drive the engines via page.evaluate
// after seeding window.S and the relevant globals (loadStore/loadMastery/etc)
// via override stubs. This keeps the tests independent of login state.
//
// Why not full UI: home Study Plan card needs login + #studyPlanCard becomes
// visible only after selectExam. Stubbing the data layer is faster, more
// stable, and still verifies the recommendation logic the user actually sees.

const { test, expect } = require('@playwright/test');

async function seedFixtures(page, fixture) {
  await page.evaluate((f) => {
    // Stub the data accessors the engines rely on
    window.__origLoadStore = window.loadStore;
    window.__origLoadMastery = window.loadMastery;
    window.__origGetExamQuestions = window.getExamQuestions;
    window.__origGetQuestionKey = window.getQuestionKey;
    window.__origGetQuestionSectionKey = window.getQuestionSectionKey;
    window.__origGetLeitnerDuePool = window.getLeitnerDuePool;
    window.__origGetWeakQuestionPool = window.getWeakQuestionPool;
    window.__origGetSmartReviewQuestions = window.getSmartReviewQuestions;
    window.__origS = window.S;

    window.loadStore = () => f.store;
    window.loadMastery = () => f.mastery || {};
    window.getExamQuestions = () => f.questions || [];
    window.getQuestionKey = (q) => q.id;
    window.getQuestionSectionKey = (q) => q.section_key;
    window.getLeitnerDuePool = () => (f.questions || []).filter(q => {
      const r = (f.store.leitner || {})[q.id];
      return r && r.nextReviewAt <= Date.now();
    });
    window.getWeakQuestionPool = () => f.weakPool || [];
    window.getSmartReviewQuestions = () => f.smartPool || [];

    if (!window.S) window.S = {};
    window.S.exam = f.examCode;
    if (!window.S.db) window.S.db = { exams: {} };
    window.S.db.exams[f.examCode] = { questions: f.questions || [] };
  }, fixture);
}

async function restoreFixtures(page) {
  await page.evaluate(() => {
    if (window.__origLoadStore !== undefined) window.loadStore = window.__origLoadStore;
    if (window.__origLoadMastery !== undefined) window.loadMastery = window.__origLoadMastery;
    if (window.__origGetExamQuestions !== undefined) window.getExamQuestions = window.__origGetExamQuestions;
    if (window.__origGetQuestionKey !== undefined) window.getQuestionKey = window.__origGetQuestionKey;
    if (window.__origGetQuestionSectionKey !== undefined) window.getQuestionSectionKey = window.__origGetQuestionSectionKey;
    if (window.__origGetLeitnerDuePool !== undefined) window.getLeitnerDuePool = window.__origGetLeitnerDuePool;
    if (window.__origGetWeakQuestionPool !== undefined) window.getWeakQuestionPool = window.__origGetWeakQuestionPool;
    if (window.__origGetSmartReviewQuestions !== undefined) window.getSmartReviewQuestions = window.__origGetSmartReviewQuestions;
  });
}

test.describe('learning flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async ({ page }) => {
    await restoreFixtures(page);
  });

  test('overdue Leitner promotes leitner as primary action', async ({ page }) => {
    const due = {};
    const questions = [];
    for (let i = 0; i < 12; i++) {
      due[`q${i}`] = { nextReviewAt: Date.now() - 86400000, box: 1, exam: 'PL-300' };
      questions.push({ id: `q${i}`, exam_code: 'PL-300', section_key: 'prep', question_type: 'mcq_single' });
    }
    await seedFixtures(page, {
      examCode: 'PL-300',
      questions,
      store: { sectionStats: { 'PL-300|prep': { correct: 7, total: 10 } }, questionStats: {}, leitner: due },
    });

    const action = await page.evaluate(() => window.recommendationEngine.getRecommendedAction('PL-300'));
    expect(action.type).toBe('leitner');
    expect(action.layer).toBe('retain');
    expect(action.cta).toMatch(/12/);
  });

  test('weakest section drill is recommended when one section is poor', async ({ page }) => {
    await seedFixtures(page, {
      examCode: 'PL-300',
      questions: [
        { id: 'q1', exam_code: 'PL-300', section_key: 'model', question_type: 'mcq_single' },
      ],
      store: {
        // readiness engine reads sectionStats with `${examCode}__${sectionKey}`
        // — the `|` separator was renamed to `__` after this test was written.
        sectionStats: {
          'PL-300__prep':   { correct: 65, total: 80 },
          'PL-300__model':  { correct: 6,  total: 20 },
          'PL-300__viz':    { correct: 55, total: 75 },
          'PL-300__deploy': { correct: 30, total: 50 },
          'PL-300__ai':     { correct: 8,  total: 15 },
        },
        questionStats: {}, leitner: {},
      },
    });

    const action = await page.evaluate(() => window.recommendationEngine.getRecommendedAction('PL-300'));
    expect(action.type).toBe('section');
    expect(action.sessionConfig.section).toBe('model');
    expect(action.sessionConfig.count).toBeGreaterThan(0);
  });

  test('new user with no data gets practice fallback', async ({ page }) => {
    await seedFixtures(page, {
      examCode: 'PL-300',
      questions: [{ id: 'q1', exam_code: 'PL-300', section_key: 'prep', question_type: 'mcq_single' }],
      store: { sectionStats: {}, questionStats: {}, leitner: {} },
    });

    const action = await page.evaluate(() => window.recommendationEngine.getRecommendedAction('PL-300'));
    expect(action.type).toBe('practice');
    expect(action.layer).toBe('learn');
  });

  test('case_study only for exams that support it', async ({ page }) => {
    // DP-900 explicitly does not support case_study.
    const breakdown = await page.evaluate(() => window.readinessEngine.getReadinessBreakdown('DP-900'));
    expect(breakdown).toBeDefined();
    expect(breakdown.sections).toBeDefined();

    const action = await page.evaluate(() => window.recommendationEngine.getRecommendedAction('DP-900'));
    expect(['leitner', 'section', 'weak', 'smart', 'mock', 'practice']).toContain(action.type);
    expect(action.type).not.toBe('case_study');
  });

  test('coach report verdict matches percentage thresholds', async ({ page }) => {
    // Coach verdicts were translated from RU to EN — see src/ui/exam-coach.js
    // verdictForScore(): "Good attempt" / "Readiness is growing" /
    // "Need to strengthen the basics" / "Exam is too early".
    const cases = [
      { pct: 85, score: 17, total: 20, expect: /Good attempt/i },
      { pct: 70, score: 14, total: 20, expect: /Readiness is growing/i },
      { pct: 55, score: 11, total: 20, expect: /strengthen the basics/i },
      { pct: 30, score: 6,  total: 20, expect: /Exam is too early/i },
    ];

    for (const c of cases) {
      const report = await page.evaluate((cs) => window.buildCoachReport({
        examCode: 'PL-300',
        mode: 'practice',
        score: cs.score,
        total: cs.total,
        pct: cs.pct,
        sectionStats: { prep: { label: 'Data Preparation', correct: cs.score, total: cs.total } },
        wrongQuestions: Array.from({ length: cs.total - cs.score }, (_, i) => 'q' + i),
      }), c);

      expect(report.eligible, `pct=${c.pct} eligible`).toBe(true);
      expect(report.verdict.verdict).toMatch(c.expect);
    }
  });

  test('coach report skipped for sessions below 5 questions', async ({ page }) => {
    const report = await page.evaluate(() => window.buildCoachReport({
      examCode: 'PL-300',
      mode: 'section',
      score: 1, total: 3, pct: 33,
      sectionStats: { model: { label: 'Data Modeling', correct: 1, total: 3 } },
      wrongQuestions: ['q1', 'q2'],
    }));

    expect(report.eligible).toBe(false);
  });

  test('remediation card produces summary, remember, nextStep on incorrect MCQ', async ({ page }) => {
    await seedFixtures(page, {
      examCode: 'PL-300',
      questions: [{ id: 'q1', exam_code: 'PL-300', section_key: 'model', question_type: 'mcq_single' }],
      store: {
        // `__` separator (see weakest-section test for context).
        sectionStats: { 'PL-300__model': { correct: 1, total: 8 } },
        questionStats: { q1: { wrongStreak: 3, total: 4, correct: 1 } },
        leitner: { q1: { box: 1, nextReviewAt: Date.now() - 1 } },
      },
    });

    const data = await page.evaluate(() => window.buildRemediation({
      id: 'q1',
      exam_code: 'PL-300',
      section_key: 'model',
      tip: 'Measures вычисляются во время запроса; calculated columns хранятся построчно.',
    }));

    // Strings translated to EN. With wrongStreak=3 the summary is
    // "You missed this question repeatedly — review needed"; nextStep
    // mentions "Scheduled Review" (Leitner queue).
    expect(data.section).toBeTruthy();
    expect(data.summary).toMatch(/repeatedly|weakest|keep repeating|review needed/i);
    expect(data.remember).toMatch(/Measures/);
    expect(data.nextStep).toMatch(/Scheduled Review/i);
  });
});
