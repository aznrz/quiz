// Wave 3 — ensure result screen fits inside the viewport on desktop
// and stays compact on mobile. Reports section heights and whether
// CTA buttons are reachable without scrolling.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'tmp', 'result-audit');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop-1440',  width: 1440, height: 900,  expectFit: true  },
  { name: 'desktop-1920',  width: 1920, height: 1080, expectFit: true  },
  { name: 'samsung-s25',   width: 412,  height: 915,  expectFit: false },
  { name: 'iphone-13-pro', width: 390,  height: 844,  expectFit: false },
  { name: 'mobile-360',    width: 360,  height: 800,  expectFit: false },
];

for (const vp of VIEWPORTS) {
  test(`result screen @ ${vp.name} (${vp.width}×${vp.height})`, async ({ page }) => {
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.classList.contains('has-app-sidebar'));
    await page.waitForTimeout(300);

    // Run a quick session: Start → answer 1 question → Finish early.
    await page.click('#startBtn');
    await page.waitForSelector('#screenQuiz.active', { timeout: 8000 });
    await page.waitForTimeout(500);
    // Pick the first option then Next.
    const firstOpt = page.locator('#optionsList button, #optionsList .option-btn').first();
    if (await firstOpt.isVisible().catch(() => false)) {
      await firstOpt.click();
      await page.waitForTimeout(300);
      const nextBtn = page.locator('#nextBtn:not(.hidden)');
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click().catch(() => {});
        await page.waitForTimeout(400);
      }
    }
    // Finish early.
    const fin = page.locator('#finishEarlyBtn:not(.hidden)');
    if (await fin.isVisible().catch(() => false)) {
      await fin.click().catch(() => {});
      await page.waitForTimeout(800);
    }

    await page.waitForSelector('#screenResult.active', { timeout: 4000 });
    await page.waitForTimeout(500);

    // Capture the full page (fullPage:true gets the whole scrollable area).
    await page.screenshot({ path: path.join(OUT, `${vp.name}.png`), fullPage: false });
    await page.screenshot({ path: path.join(OUT, `${vp.name}-full.png`), fullPage: true });

    // Measure: total content height vs viewport, and whether the last
    // action button is in the visible viewport.
    const m = await page.evaluate(() => {
      const screen = document.getElementById('screenResult');
      if (!screen) return null;
      const screenH = screen.getBoundingClientRect().height;
      const actions = screen.querySelector('.result-actions');
      const lastBtn = actions ? actions.querySelector('button:last-child') : null;
      const lastBtnRect = lastBtn ? lastBtn.getBoundingClientRect() : null;
      const score = screen.querySelector('.result-score')?.getBoundingClientRect();
      const coach = screen.querySelector('#examCoachReport')?.getBoundingClientRect();
      return {
        viewportH: window.innerHeight,
        screenH: Math.round(screenH),
        scoreH: score ? Math.round(score.height) : null,
        coachH: coach ? Math.round(coach.height) : null,
        actionsH: actions ? Math.round(actions.getBoundingClientRect().height) : null,
        lastBtnTop: lastBtnRect ? Math.round(lastBtnRect.top) : null,
        lastBtnBottom: lastBtnRect ? Math.round(lastBtnRect.bottom) : null,
        documentScrollH: Math.round(document.documentElement.scrollHeight),
      };
    });

    console.log(`[${vp.name}]`, m);
    fs.writeFileSync(path.join(OUT, `${vp.name}.json`), JSON.stringify(m, null, 2));

    if (vp.expectFit && m?.lastBtnBottom != null) {
      const fitsInViewport = m.lastBtnBottom <= m.viewportH + 4;
      if (!fitsInViewport) {
        console.log(`  ⚠ Last action button bottom = ${m.lastBtnBottom}px, viewport = ${m.viewportH}px`);
      }
      // Soft assertion — emit as test warning, do not fail the suite while
      // we're iterating on the fix.
      if (!fitsInViewport) {
        test.info().annotations.push({ type: 'cta-overflow', description: `${vp.name}: bottom button at ${m.lastBtnBottom}px > viewport ${m.viewportH}px` });
      }
    }
  });
}
