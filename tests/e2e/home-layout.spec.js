// Visual sanity for the editorial home (post-redesign).
// Verifies that the desktop two-column grid actually engages and that
// lift-strip spans both columns (the v1.19 specificity bug).

const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 1280, height: 900 } });

test.describe('home layout — desktop ≥1100px', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // localhost bypass auto-logs in as { uid: 'dev' }, then loads DB
    // wait until home screen actually renders
    await page.waitForSelector('#screenHome.active', { timeout: 8000 });
    await page.waitForSelector('#liftTodayCount');
  });

  test('home-screen uses display:grid', async ({ page }) => {
    const display = await page.$eval('#screenHome', el => getComputedStyle(el).display);
    expect(display).toBe('grid');
  });

  test('lift-strip spans full width (grid-area: lift)', async ({ page }) => {
    const screen = await page.$eval('#screenHome', el => el.getBoundingClientRect());
    const lift = await page.$eval('#liftStrip', el => el.getBoundingClientRect());
    // Allow for screen padding (left/right 16-20px). Lift should occupy >85% of screen width.
    const ratio = lift.width / screen.width;
    expect(ratio).toBeGreaterThan(0.85);
  });

  test('main and rail sit side-by-side, rail on the right', async ({ page }) => {
    const main = await page.$eval('.home-main', el => el.getBoundingClientRect());
    const rail = await page.$eval('.home-rail', el => el.getBoundingClientRect());
    // rail starts to the right of main
    expect(rail.left).toBeGreaterThan(main.left + main.width - 50);
    // rail width is the configured 380px
    expect(rail.width).toBeGreaterThan(360);
    expect(rail.width).toBeLessThan(420);
  });

  test('stat tickers exist with serif numerics', async ({ page }) => {
    const fontFamily = await page.$eval('#statTotal', el => getComputedStyle(el).fontFamily);
    expect(fontFamily.toLowerCase()).toContain('fraunces');
  });

  test('lift CTA is reachable and labelled', async ({ page }) => {
    const cta = page.locator('#liftCta');
    await expect(cta).toBeVisible();
    const label = await cta.locator('.lift-cta-label').textContent();
    expect(label.trim().length).toBeGreaterThan(0);
  });
});

test.describe('landing isolation (no auth)', () => {
  test('home-screen is hidden when only login screen is active', async ({ page }) => {
    // Bypass localhost auto-login by visiting prod-style URL... actually localhost
    // ALWAYS auto-logs in here, so we simulate "not active" by directly checking
    // the CSS rule via a synthetic DOM probe.
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const result = await page.evaluate(() => {
      // Force #screenHome to not have .active and check display computes to none.
      const home = document.getElementById('screenHome');
      const wasActive = home.classList.contains('active');
      home.classList.remove('active');
      const displayWithoutActive = getComputedStyle(home).display;
      if (wasActive) home.classList.add('active');
      return { displayWithoutActive };
    });
    expect(result.displayWithoutActive).toBe('none');
  });
});

test.describe('home layout — mobile ≤720px', () => {
  test.use({ viewport: { width: 414, height: 800 } });

  test('home-screen falls back to flex column', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('#screenHome.active', { timeout: 8000 });
    const display = await page.$eval('#screenHome', el => getComputedStyle(el).display);
    expect(display).toBe('flex');
  });
});
