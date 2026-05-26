// Smoke tests — page load, scripts, engine APIs are reachable.
// These do NOT require login: they hit the landing demo + global engine APIs.

const { test, expect } = require('@playwright/test');

test.describe('smoke', () => {
  test('home page loads with no console errors from our scripts', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Ignore third-party noise we don't own
      if (text.includes('firebase')) return;
      if (text.includes('favicon')) return;
      if (text.includes('Password field is not contained in a form')) return;
      errors.push(`console.error: ${text}`);
    });

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    expect(errors, 'no script errors from our code').toEqual([]);
  });

  test('all engine and ui modules expose expected globals', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const globals = await page.evaluate(() => ({
      examProfiles: typeof window.EXAM_PROFILES,
      getExamProfile: typeof window.getExamProfile,
      readinessEngine: typeof window.readinessEngine,
      recommendationEngine: typeof window.recommendationEngine,
      renderStudyPlan: typeof window.renderStudyPlan,
      launchRecommendedAction: typeof window.launchRecommendedAction,
      renderRemediationCard: typeof window.renderRemediationCard,
      clearRemediationCard: typeof window.clearRemediationCard,
      renderExamCoachReport: typeof window.renderExamCoachReport,
      buildCoachReport: typeof window.buildCoachReport,
    }));

    expect(globals.examProfiles).toBe('object');
    expect(globals.getExamProfile).toBe('function');
    expect(globals.readinessEngine).toBe('object');
    expect(globals.recommendationEngine).toBe('object');
    expect(globals.renderStudyPlan).toBe('function');
    expect(globals.launchRecommendedAction).toBe('function');
    expect(globals.renderRemediationCard).toBe('function');
    expect(globals.clearRemediationCard).toBe('function');
    expect(globals.renderExamCoachReport).toBe('function');
    expect(globals.buildCoachReport).toBe('function');
  });

  test('exam profiles cover NARUTO exam with valid weights', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const profiles = await page.evaluate(() => {
      const codes = Object.keys(window.EXAM_PROFILES);
      return codes.map(code => {
        const p = window.EXAM_PROFILES[code];
        const weights = Object.values(p.sectionWeights || {});
        const sum = weights.reduce((a, b) => a + b, 0);
        return {
          code,
          sectionCount: weights.length,
          weightSum: Number(sum.toFixed(3)),
          supportsCaseStudy: p.supportsCaseStudy,
        };
      });
    });

    const codes = profiles.map(p => p.code);
    expect(codes).toContain('NARUTO');
    expect(codes).toContain('BRIDGERTON');
    expect(codes.length).toBe(2);

    for (const p of profiles) {
      expect(p.sectionCount, `${p.code} has section weights`).toBe(3); // easy, medium, hard
      expect(p.weightSum, `${p.code} weights ~ 1`).toBeGreaterThan(0.99);
      expect(p.weightSum, `${p.code} weights ~ 1`).toBeLessThanOrEqual(1.01);
    }
  });

  test('readiness engine returns explainable breakdown for empty store', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const result = await page.evaluate(() => {
      try {
        return window.readinessEngine.getReadinessBreakdown('NARUTO');
      } catch (e) {
        return { __error: String(e) };
      }
    });

    expect(result.__error, 'no exception').toBeUndefined();
    expect(typeof result.overall).toBe('number');
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(100);
    expect(result.sections).toBeDefined();
    expect(Array.isArray(result.weakestSections)).toBe(true);
    expect(result.factors).toMatchObject({
      accuracy: expect.any(Number),
      mastery: expect.any(Number),
      duePressure: expect.any(Number),
    });
    expect(['none', 'low', 'medium', 'high']).toContain(result.confidence);
  });

  test('recommendation engine returns a valid primary action', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const action = await page.evaluate(() => window.recommendationEngine.getRecommendedAction('NARUTO'));

    expect(action).not.toBeNull();
    expect(typeof action.type).toBe('string');
    expect(['leitner', 'section', 'weak', 'smart', 'mock', 'case_study', 'practice']).toContain(action.type);
    expect(typeof action.title).toBe('string');
    expect(action.title.length).toBeGreaterThan(0);
    expect(typeof action.cta).toBe('string');
    expect(action.sessionConfig).toBeDefined();
    expect(action.sessionConfig.mode).toBe(action.type);
  });

  test('study plan draft has retain/learn/perform layers when applicable', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const plan = await page.evaluate(() => window.recommendationEngine.getStudyPlanDraft('NARUTO'));

    expect(plan).toBeDefined();
    expect(plan.examCode).toBe('NARUTO');
    expect(typeof plan.readiness).toBe('number');
    expect(Array.isArray(plan.blocks)).toBe(true);
    expect(plan.blocks.length).toBeGreaterThan(0);
    for (const b of plan.blocks) {
      expect(['retain', 'learn', 'perform']).toContain(b.slot);
      expect(typeof b.title).toBe('string');
    }
  });
});
