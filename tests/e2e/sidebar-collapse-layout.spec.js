// Verify that collapsing the sidebar does NOT shift the main content
// layout to the left or stretch cards to full viewport width.
const { test, expect } = require('@playwright/test');

test('collapse keeps main content in place', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#appSidebar:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(400);

  // Navigate to a dashboard so we can measure a known content card.
  await page.click('[data-nav="stats"]');
  await page.waitForTimeout(700);

  // Sample a clearly-positioned element: the topbar inside the
  // currently-visible Stats v2 page.
  const target = page.locator('#statsV2App .s2-topbar');
  await target.waitFor({ state: 'visible' });
  const before = await target.boundingBox();
  console.log('Before collapse — topbar x/width:', before?.x, before?.width);

  // Click the collapse button (the one inside the sidebar brand row).
  const collapseBtn = page.locator('#sidebarCollapseBtn');
  await collapseBtn.click();
  // Wait for the 200ms slide animation.
  await page.waitForTimeout(350);

  const after = await target.boundingBox();
  console.log('After collapse — topbar x/width:', after?.x, after?.width);

  // The topbar must not have shifted nor changed width.
  if (before && after) {
    const dx = Math.abs(after.x - before.x);
    const dw = Math.abs(after.width - before.width);
    console.log('Δx:', dx, 'Δwidth:', dw);
    expect(dx).toBeLessThan(2);
    expect(dw).toBeLessThan(2);
  }

  // The rail button must now be visible.
  const railBtn = page.locator('.sidebar-rail-btn');
  await expect(railBtn).toBeVisible();
});
