// Collapsible sidebar + auto-collapse in exam mode.
// Localhost auto-logs in as { uid: 'dev' }, so the persistent
// #appSidebar is mounted as soon as DB loads. These tests exercise the
// collapse/expand controls, localStorage persistence, the exam-mode
// auto-collapse hook, and the mobile drawer.

const { test, expect } = require('@playwright/test');

const SIDEBAR_COLLAPSED_KEY = 'mscp_sidebar_collapsed';
const SIDEBAR_BEFORE_EXAM_KEY = 'mscp_sidebar_before_exam';

async function waitForHome(page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('#screenHome.active', { timeout: 8000 });
  // Persistent sidebar attaches a moment after auth resolves.
  await page.waitForFunction(() => document.body.classList.contains('has-app-sidebar'), { timeout: 8000 });
}

async function clearSidebarStorage(page) {
  await page.evaluate(({ k1, k2 }) => {
    localStorage.removeItem(k1);
    localStorage.removeItem(k2);
  }, { k1: SIDEBAR_COLLAPSED_KEY, k2: SIDEBAR_BEFORE_EXAM_KEY });
}

test.describe('sidebar — desktop ≥1100px', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await waitForHome(page);
    await clearSidebarStorage(page);
    await page.reload();
    await page.waitForSelector('#screenHome.active', { timeout: 8000 });
    await page.waitForFunction(() => document.body.classList.contains('has-app-sidebar'));
  });

  test('collapse button is the first element of the brand row', async ({ page }) => {
    const firstChildId = await page.$eval('#appSidebar .s2-sidebar-brand', el => el.firstElementChild?.id || '');
    expect(firstChildId).toBe('sidebarCollapseBtn');
  });

  test('expand rail is hidden when sidebar is expanded', async ({ page }) => {
    const railVisible = await page.$eval('#sidebarExpandBtn', el => getComputedStyle(el).display !== 'none');
    expect(railVisible).toBe(false);
  });

  test('click collapse → body gets sidebar-collapsed, padding-left stays 240, rail appears', async ({ page }) => {
    await page.click('#sidebarCollapseBtn');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(true);
    // Padding-left must stay at 240 so the main content does NOT shift
    // or stretch to ultra-wide. Only the sidebar slides off-screen.
    await expect.poll(
      () => page.evaluate(() => parseInt(getComputedStyle(document.body).paddingLeft, 10)),
      { timeout: 2000 },
    ).toBe(240);
    await expect(page.locator('#sidebarExpandBtn')).toBeVisible();
  });

  test('click expand rail → sidebar returns, rail hides', async ({ page }) => {
    await page.click('#sidebarCollapseBtn');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(true);
    await page.click('#sidebarExpandBtn');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(false);
    const railVisible = await page.$eval('#sidebarExpandBtn', el => getComputedStyle(el).display !== 'none');
    expect(railVisible).toBe(false);
  });

  test('collapsed state persists across reload', async ({ page }) => {
    await page.click('#sidebarCollapseBtn');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('mscp_sidebar_collapsed'))).toBe('true');
    await page.reload();
    await page.waitForSelector('#screenHome.active');
    await page.waitForFunction(() => document.body.classList.contains('has-app-sidebar'));
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(true);
  });

  test('aria-expanded reflects collapsed state', async ({ page }) => {
    expect(await page.getAttribute('#sidebarCollapseBtn', 'aria-expanded')).toBe('true');
    await page.click('#sidebarCollapseBtn');
    await expect.poll(() => page.getAttribute('#sidebarCollapseBtn', 'aria-expanded')).toBe('false');
    expect(await page.getAttribute('#sidebarExpandBtn', 'aria-expanded')).toBe('false');
  });

  test('no horizontal overflow when sidebar is collapsed', async ({ page }) => {
    await page.click('#sidebarCollapseBtn');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(true);
    await page.waitForTimeout(250); // wait out the 200ms transition
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });

  test('manual click clears mscp_sidebar_before_exam', async ({ page }) => {
    // Seed a fake snapshot
    await page.evaluate(() => localStorage.setItem('mscp_sidebar_before_exam', 'false'));
    await page.click('#sidebarCollapseBtn');
    const after = await page.evaluate(() => localStorage.getItem('mscp_sidebar_before_exam'));
    expect(after).toBeNull();
  });
});

test.describe('sidebar — auto-collapse in exam mode', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await waitForHome(page);
    await clearSidebarStorage(page);
    await page.reload();
    await page.waitForSelector('#screenHome.active');
    await page.waitForFunction(() => document.body.classList.contains('has-app-sidebar'));
  });

  test('starting a session auto-collapses the sidebar and saves snapshot', async ({ page }) => {
    // Sanity: sidebar is expanded
    expect(await page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(false);

    // Drive showScreen('quiz') directly through the unified router — the
    // real Start button needs a full session pool; the showScreen hook is
    // what we care about here.
    await page.evaluate(() => window.showScreen && window.showScreen('quiz'));
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(true);
    // BEFORE_EXAM key holds the pre-exam state ("false" = was expanded).
    const before = await page.evaluate(() => localStorage.getItem('mscp_sidebar_before_exam'));
    expect(before).toBe('false');
  });

  test('returning to home restores the pre-exam sidebar state', async ({ page }) => {
    await page.evaluate(() => window.showScreen && window.showScreen('quiz'));
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(true);
    await page.evaluate(() => window.showScreen && window.showScreen('home'));
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(false);
    const before = await page.evaluate(() => localStorage.getItem('mscp_sidebar_before_exam'));
    expect(before).toBeNull();
  });

  test('manual override during quiz survives the exit', async ({ page }) => {
    await page.evaluate(() => window.showScreen && window.showScreen('quiz'));
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(true);
    // User opens the sidebar mid-exam — this should clear BEFORE_EXAM.
    await page.click('#sidebarExpandBtn');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('mscp_sidebar_before_exam'))).toBeNull();
    // Finish quiz → sidebar should STAY open (manual override wins).
    await page.evaluate(() => window.showScreen && window.showScreen('home'));
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-collapsed'))).toBe(false);
  });

  test('repeated showScreen("quiz") does not overwrite snapshot', async ({ page }) => {
    // User starts quiz with sidebar expanded; snapshot saved as "false".
    await page.evaluate(() => window.showScreen && window.showScreen('quiz'));
    expect(await page.evaluate(() => localStorage.getItem('mscp_sidebar_before_exam'))).toBe('false');
    // A re-render that calls showScreen('quiz') again should NOT overwrite the snapshot
    // with the now-collapsed state ("true"). The previous-screen guard prevents it.
    await page.evaluate(() => window.showScreen && window.showScreen('quiz'));
    expect(await page.evaluate(() => localStorage.getItem('mscp_sidebar_before_exam'))).toBe('false');
  });
});

test.describe('sidebar — mobile drawer ≤768px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await waitForHome(page);
    await clearSidebarStorage(page);
    await page.reload();
    await page.waitForSelector('#screenHome.active');
    await page.waitForFunction(() => document.body.classList.contains('has-app-sidebar'));
  });

  test('drawer starts closed; rail button is visible', async ({ page }) => {
    expect(await page.evaluate(() => document.body.classList.contains('sidebar-open'))).toBe(false);
    await expect(page.locator('#sidebarExpandBtn')).toBeVisible();
    const sidebarTransform = await page.$eval('#appSidebar', el => getComputedStyle(el).transform);
    // translateX(-100%) → matrix with negative tx
    expect(sidebarTransform).not.toBe('none');
  });

  test('rail click opens drawer; sidebar transform reset', async ({ page }) => {
    await page.click('#sidebarExpandBtn');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-open'))).toBe(true);
    await expect(page.locator('#sidebarExpandBtn')).toBeHidden();
  });

  test('clicking outside drawer (backdrop) closes it', async ({ page }) => {
    await page.click('#sidebarExpandBtn');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-open'))).toBe(true);
    // Click somewhere unmistakably outside the drawer.
    await page.mouse.click(380, 400);
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-open'))).toBe(false);
  });

  test('no horizontal overflow on mobile in any sidebar state', async ({ page }) => {
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    await page.click('#sidebarExpandBtn');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('sidebar-open'))).toBe(true);
    overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });
});
