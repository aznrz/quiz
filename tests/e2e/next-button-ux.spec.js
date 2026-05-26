// Diagnostic: how reachable is "Next question" after answering?
// User complaint: had to scroll past explanation/AI insights/remediation
// card to find the inline button. We now ship a small floating FAB +
// ArrowRight/Enter hotkey. This test measures whether those actually
// solve the problem from the user's viewport.

const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 1280, height: 900 } });

async function devLogin(page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const logo = document.querySelector('.login-logo');
    if (logo) logo.click();
  });
  await page.waitForSelector('#screenHome.active', { timeout: 15000 });
  // Wait for the exam pill list to populate (means DB is loaded).
  await page.waitForSelector('#examSelector button[data-exam="PL-300"]', { timeout: 15000 });
}

async function startPracticeQuiz(page) {
  await page.click('#examSelector button[data-exam="PL-300"]');
  // Default mode/section/count are fine for the diagnostic.
  await page.click('#startBtn');
  await page.waitForSelector('#optionsList .option-btn', { timeout: 10000 });
}

async function answerCurrentQuestion(page) {
  // Pick the first option and submit. Works for both single and multi.
  await page.click('#optionsList .option-btn:first-child');
  // Submit if visible (multi-choice). Single-choice auto-submits on click.
  const submit = await page.$('#mcqSubmitBtn:not(.hidden)');
  if (submit) {
    const enabled = await submit.isEnabled();
    if (enabled) await submit.click();
  }
  // Wait for the inline Next button to become visible.
  await page.waitForSelector('#nextBtn.visible', { timeout: 5000 });
}

test.describe('Next-button reachability after answering', () => {
  test('inline Next sits below the fold; FAB is in-viewport without scroll', async ({ page }) => {
    await devLogin(page);
    await startPracticeQuiz(page);
    await answerCurrentQuestion(page);

    const vp = page.viewportSize();
    const inline = await page.$eval('#nextBtn', el => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    });
    const fab = await page.$eval('#floatingNextFab', el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // Walk ancestors to spot a display:none container.
      let hiddenParent = null;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).display === 'none') { hiddenParent = p.id || p.tagName; break; }
      }
      return {
        top: r.top, bottom: r.bottom, right: r.right,
        width: r.width, height: r.height,
        display: cs.display,
        position: cs.position,
        opacity: parseFloat(cs.opacity),
        visibleClass: el.classList.contains('visible'),
        hiddenClass: el.classList.contains('hidden'),
        hiddenParent,
      };
    });

    console.log('\n========== Next-button reachability ==========');
    console.log(`Viewport: ${vp.width}×${vp.height}`);
    console.log(`Inline #nextBtn: top=${inline.top.toFixed(0)}px, bottom=${inline.bottom.toFixed(0)}px`);
    const inlineVisible = inline.top >= 0 && inline.bottom <= vp.height;
    if (!inlineVisible) {
      const scrollNeeded = Math.max(0, inline.bottom - vp.height);
      console.log(`Inline button is BELOW the fold — user has to scroll ~${scrollNeeded.toFixed(0)}px`);
    } else {
      console.log(`Inline button is in-viewport (lucky case).`);
    }
    console.log(`FAB rect: top=${fab.top.toFixed(0)}, right=${fab.right.toFixed(0)}, ${fab.width}×${fab.height}px`);
    console.log(`FAB classes: visible=${fab.visibleClass}, hidden=${fab.hiddenClass}`);
    console.log(`FAB style: display=${fab.display}, position=${fab.position}, opacity=${fab.opacity}`);
    if (fab.hiddenParent) console.log(`FAB hidden by ancestor: ${fab.hiddenParent}`);
    const fabRendered = fab.width > 0 && fab.height > 0;
    const fabInViewport = fabRendered && fab.top >= 0 && fab.bottom <= vp.height && fab.right <= vp.width;
    console.log(`FAB actually rendered (w/h > 0): ${fabRendered ? 'YES' : 'NO ✗'}`);
    console.log(`FAB in-viewport without scroll: ${fabInViewport ? 'YES ✓' : 'NO ✗'}`);
    console.log('===============================================\n');

    expect(fab.visibleClass, 'FAB should be marked visible after answer').toBe(true);
    expect(fab.opacity, 'FAB should be visible (opacity > 0)').toBeGreaterThan(0);
    expect(fabRendered, 'FAB should have non-zero size').toBe(true);
    expect(fabInViewport, 'FAB should be reachable without scrolling').toBe(true);
  });

  test('ArrowRight hotkey advances to the next question', async ({ page }) => {
    await devLogin(page);
    await startPracticeQuiz(page);

    const before = await page.$eval('#qCounter', el => el.textContent.trim());
    await answerCurrentQuestion(page);
    // Press ArrowRight on the body (no input focused).
    await page.evaluate(() => document.body.focus());
    await page.keyboard.press('ArrowRight');
    // The next question's options should re-render — wait for FAB to
    // disappear (cleared at the start of renderQuestion) then reappear
    // after we answer again, OR just check the question counter changed.
    await page.waitForFunction(
      (prev) => {
        const c = document.getElementById('qCounter');
        return c && c.textContent.trim() !== prev;
      },
      before,
      { timeout: 5000 }
    );
    const after = await page.$eval('#qCounter', el => el.textContent.trim());
    console.log(`\nArrowRight: ${before} → ${after}\n`);
    expect(after).not.toBe(before);
  });

  test('typing in reflection box does not trigger ArrowRight advance', async ({ page }) => {
    await devLogin(page);
    await startPracticeQuiz(page);
    await answerCurrentQuestion(page);

    // Reflection textarea only appears after multiple wrong answers; if not
    // visible we can't drive this test path. Use a generic textarea fallback
    // so we still verify the safeguard.
    const ta = await page.$('#reflectionText:not(.hidden)') || await page.$('textarea');
    if (!ta || !(await ta.isVisible().catch(() => false))) {
      console.log('No visible textarea to test reflection-box safeguard — skipping.');
      return;
    }
    await ta.click();
    const before = await page.$eval('#qCounter', el => el.textContent.trim());
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const after = await page.$eval('#qCounter', el => el.textContent.trim());
    expect(after, 'ArrowRight inside textarea should NOT advance').toBe(before);
  });
});
