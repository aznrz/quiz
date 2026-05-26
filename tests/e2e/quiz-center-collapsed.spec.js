// Wave 1+ — verify that when the sidebar is collapsed during a quiz,
// the quiz layout centres relative to the FULL viewport, not the
// (viewport − 240px sidebar) main area.
const { test, expect } = require('@playwright/test');

test('collapsed sidebar centres quiz card on full viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The native confirm("Finish test?…") will fire when we tear down.
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.classList.contains('has-app-sidebar'), { timeout: 10000 });
  await page.waitForTimeout(300);

  // Start a quiz — this auto-collapses the sidebar (existing behaviour).
  await page.click('#startBtn');
  await page.waitForSelector('#screenQuiz.active', { timeout: 8000 });
  await page.waitForTimeout(500);

  // Sanity: sidebar should now be collapsed.
  const isCollapsed = await page.evaluate(() => document.body.classList.contains('sidebar-collapsed'));
  expect(isCollapsed, 'starting quiz should auto-collapse the sidebar').toBe(true);

  // Locate the quiz card (the actual content carrier).
  const card = page.locator('.question-card, #quizCard, .quiz-card').first();
  await card.waitFor({ state: 'visible' });
  const box = await card.boundingBox();
  if (!box) test.fail('quiz card has no bounding box');

  const viewport = page.viewportSize();
  const viewportCentre = viewport.width / 2;
  const cardCentre = box.x + box.width / 2;
  const offsetFromViewportCentre = cardCentre - viewportCentre;

  console.log(`Viewport: ${viewport.width}`);
  console.log(`Quiz card: x=${Math.round(box.x)} width=${Math.round(box.width)} centre=${Math.round(cardCentre)}`);
  console.log(`Viewport centre: ${viewportCentre}`);
  console.log(`Offset from viewport centre: ${Math.round(offsetFromViewportCentre)}px`);

  // Must be centred on viewport, not on main-area. Allow ±10px slack
  // for any scrollbar/padding fudge.
  expect(Math.abs(offsetFromViewportCentre), 'quiz card must be centred to full viewport when collapsed').toBeLessThan(10);
});
