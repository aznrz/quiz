// Comprehensive UX audit — runs on dev-mode localhost.
// Tests: Home, Navigation, Exam mode, Readability, multiple viewports.
// Output: tmp/ux-audit/{viewport}/*.png and tmp/ux-audit/report.{json,md}
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const OUT_ROOT = path.join(__dirname, '..', '..', 'tmp', 'ux-audit');
fs.mkdirSync(OUT_ROOT, { recursive: true });

// ── viewport matrix ───────────────────────────────────────────────
const VIEWPORTS = [
  { name: 'desktop-1440',  width: 1440, height: 900,  isMobile: false },
  { name: 'desktop-1920',  width: 1920, height: 1080, isMobile: false },
  { name: 'samsung-s25',   width: 412,  height: 915,  isMobile: true  }, // ~Galaxy S25
  { name: 'iphone-13-pro', width: 390,  height: 844,  isMobile: true  },
  { name: 'mobile-360',    width: 360,  height: 800,  isMobile: true  },
];

// ── shared issue collector ────────────────────────────────────────
const issues = [];
function flag(viewport, category, message, extra = {}) {
  issues.push({ viewport, category, message, ...extra });
  console.log(`  ⚠ [${viewport}] [${category}] ${message}`);
}

// ── helpers ───────────────────────────────────────────────────────
async function bindConsole(page, vp) {
  page.on('pageerror', (err) => flag(vp, 'js-error', `pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Ignore expected Firebase permission errors in dev mode.
    if (/Missing or insufficient permissions/.test(text)) return;
    if (/Failed to load resource.*400/.test(text)) return;
    flag(vp, 'console-error', text);
  });
}

async function gotoHome(page) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.classList.contains('has-app-sidebar'), { timeout: 10000 });
  await page.waitForTimeout(300);
}

async function checkNoHorizontalScroll(page, vp, where) {
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    bodyW: document.body.scrollWidth,
  }));
  if (overflow.scrollW > overflow.clientW + 1 || overflow.bodyW > overflow.clientW + 1) {
    flag(vp, 'horizontal-scroll', `${where}: scrollW=${overflow.scrollW} > clientW=${overflow.clientW}`);
  }
}

async function checkAllButtonsSize(page, vp, where) {
  const tooSmall = await page.$$eval('button:visible, [role="button"]:visible, a.btn:visible', (els, min) => {
    return els.filter(el => {
      if (!el.offsetParent && el.tagName !== 'BODY') return false;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;          // hidden / icon-less artifact
      if (r.width < 20 || r.height < min) return true;
      return false;
    }).slice(0, 12).map(el => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 50) : null,
      text: (el.textContent || '').trim().slice(0, 30),
      h: Math.round(el.getBoundingClientRect().height),
      w: Math.round(el.getBoundingClientRect().width),
    }));
  }, 40).catch(() => []);
  tooSmall.forEach(b =>
    flag(vp, 'small-tap-target', `${where}: ${b.tag}${b.id ? '#' + b.id : ''} "${b.text}" ${b.w}×${b.h}px (<40px)`)
  );
}

async function checkMinFontSize(page, vp, where, min = 14) {
  // Sample body text inside the CURRENTLY VISIBLE screen only. The
  // login screen and other hidden screens stay in DOM but must not
  // count: we filter by checking offsetParent / getBoundingClientRect.
  const small = await page.$$eval(
    'p, span, div, label, li',
    (els, min) => {
      const out = [];
      const seen = new Set();
      const isVisible = (el) => {
        if (!el.offsetParent && el.tagName !== 'BODY') return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        // Inside viewport (off-screen content like sidebar drawer doesn't count).
        if (r.bottom < 0 || r.top > window.innerHeight) return false;
        if (r.right < 0 || r.left > window.innerWidth) return false;
        return true;
      };
      for (const el of els) {
        // Only leaf-ish text nodes — skip wrappers.
        const hasOnlyText = el.childNodes.length === 1 && el.firstChild?.nodeType === 3;
        if (!hasOnlyText) continue;
        const txt = el.textContent.trim();
        if (!txt || txt.length < 6) continue;
        if (!isVisible(el)) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs >= min) continue;
        const key = txt.slice(0, 40) + '|' + fs;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text: txt.slice(0, 50), fontSize: fs, tag: el.tagName.toLowerCase() });
        if (out.length >= 8) break;
      }
      return out;
    },
    min,
  ).catch(() => []);
  small.forEach(s =>
    flag(vp, 'small-font', `${where}: "${s.text}" — ${s.fontSize}px (<${min}px)`)
  );
}

async function shot(page, vp, name) {
  const dir = path.join(OUT_ROOT, vp);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png'), fullPage: false });
}

// ── per-viewport test groups ──────────────────────────────────────
for (const vp of VIEWPORTS) {
  test.describe(`UX audit — ${vp.name} (${vp.width}×${vp.height})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('home + sidebar collapse + key CTAs', async ({ page }) => {
      await bindConsole(page, vp.name);
      await gotoHome(page);
      await shot(page, vp.name, 'home-expanded');

      // 1.1 sidebar visible (desktop) or rail visible (mobile)
      if (!vp.isMobile) {
        const sidebarVisible = await page.locator('#appSidebar').isVisible();
        if (!sidebarVisible) flag(vp.name, 'visibility', 'Sidebar not visible on desktop after login');
      } else {
        // Mobile: rail button (hamburger equivalent) should be visible.
        const railVisible = await page.locator('#sidebarExpandBtn').isVisible();
        if (!railVisible) flag(vp.name, 'visibility', 'Mobile rail/expand button not visible');
      }

      // 1.2 Collapse the sidebar (desktop only — mobile starts collapsed).
      if (!vp.isMobile) {
        const topbarBefore = await page.locator('#statsV2App, #screenHome').first().boundingBox();
        const homeBefore = await page.locator('#screenHome').boundingBox();
        const refBox = homeBefore || topbarBefore;

        await page.click('#sidebarCollapseBtn');
        await page.waitForTimeout(300);
        await shot(page, vp.name, 'home-collapsed');

        const expandVisible = await page.locator('#sidebarExpandBtn').isVisible();
        if (!expandVisible) flag(vp.name, 'visibility', 'Expand rail button not visible after collapse');

        const refAfter = await page.locator('#screenHome').boundingBox();
        if (refBox && refAfter) {
          const dx = Math.abs(refAfter.x - refBox.x);
          const dw = Math.abs(refAfter.width - refBox.width);
          if (dx > 2 || dw > 2) {
            flag(vp.name, 'layout-jump',
              `Home shifts after collapse: Δx=${dx}px Δwidth=${dw}px (expected 0,0)`,
              { file: 'src/style.css' }
            );
          }
        }

        // 1.3 Expand back.
        await page.click('#sidebarExpandBtn');
        await page.waitForTimeout(300);
        const sidebarBackVisible = await page.locator('#appSidebar').isVisible();
        if (!sidebarBackVisible) flag(vp.name, 'visibility', 'Sidebar did not return after expand click');
      }

      // 1.4 Start practice button visible + enabled.
      const startBtn = page.locator('#startBtn');
      const startVisible = await startBtn.isVisible().catch(() => false);
      if (!startVisible) {
        flag(vp.name, 'clickable', 'Start practice button (#startBtn) not visible on Home');
      } else {
        const disabled = await startBtn.isDisabled();
        if (disabled) flag(vp.name, 'clickable', 'Start practice (#startBtn) is disabled');
      }

      // 1.5 Pick section / Daily question contextual CTA.
      const liftCta = page.locator('#liftCta');
      if (await liftCta.count()) {
        const cta = await liftCta.first().isVisible().catch(() => false);
        if (!cta) flag(vp.name, 'clickable', 'Lift CTA (#liftCta) not visible on Home');
      }

      await checkNoHorizontalScroll(page, vp.name, 'home');
      if (vp.isMobile) {
        await checkMinFontSize(page, vp.name, 'home');
        await checkAllButtonsSize(page, vp.name, 'home');
      }
    });

    test('navigation — all sidebar destinations', async ({ page }) => {
      await bindConsole(page, vp.name);
      await gotoHome(page);

      // On mobile, open the drawer first so nav items are clickable.
      if (vp.isMobile) {
        const expand = page.locator('#sidebarExpandBtn');
        if (await expand.isVisible().catch(() => false)) {
          await expand.click();
          await page.waitForTimeout(250);
        }
      }

      const destinations = [
        { key: 'statsV1',    appId: 'adminApp',      label: 'Detailed Statistics' },
        { key: 'stats',      appId: 'statsV2App',    label: 'Statistics' },
        { key: 'weak',       appId: 'weakQApp',      label: 'Weak questions' },
        { key: 'topics',     appId: 'topicsApp',     label: 'Statistics by topic' },
        { key: 'references', appId: 'referencesApp', label: 'References' },
        { key: 'profile',    appId: 'profileApp',    label: 'My profile' },
        { key: 'home',       appId: null,            label: 'Home' },
      ];

      for (const d of destinations) {
        // On mobile drawer closes after each nav click — reopen as needed.
        if (vp.isMobile) {
          const expand = page.locator('#sidebarExpandBtn');
          if (await expand.isVisible().catch(() => false)) {
            await expand.click();
            await page.waitForTimeout(200);
          }
        }
        const clicked = await page.locator(`[data-nav="${d.key}"]`).first().click().then(() => true).catch(() => false);
        if (!clicked) {
          flag(vp.name, 'clickable', `Nav item [data-nav="${d.key}"] (${d.label}) not clickable`);
          continue;
        }
        await page.waitForTimeout(500);

        if (d.appId) {
          const open = await page.locator(`#${d.appId}`).isVisible().catch(() => false);
          if (!open) flag(vp.name, 'navigation', `${d.label} did not become visible`);
        }

        // Active state should land on this nav item (desktop only — mobile
        // drawer hides after click).
        if (!vp.isMobile) {
          const active = await page.locator('#appSidebar .s2-sidebar-item.is-active').first()
            .getAttribute('data-nav').catch(() => null);
          if (active !== d.key) {
            flag(vp.name, 'navigation', `${d.label}: active state is "${active}", expected "${d.key}"`);
          }
        }

        await checkNoHorizontalScroll(page, vp.name, `nav-${d.key}`);

        // Capture per-page screenshot for the requested set.
        if (['home', 'statsV1', 'stats'].includes(d.key)) {
          await shot(page, vp.name, `nav-${d.key}`);
          // Also capture statsV1 in collapsed-sidebar state (desktop only).
          if (d.key === 'statsV1' && !vp.isMobile) {
            await page.click('#sidebarCollapseBtn').catch(() => {});
            await page.waitForTimeout(300);
            await shot(page, vp.name, 'nav-statsV1-collapsed');
            await page.click('#sidebarExpandBtn').catch(() => {});
            await page.waitForTimeout(300);
          }
        }
      }
    });

    test('exam mode — start, answer, next, finish', async ({ page }) => {
      await bindConsole(page, vp.name);
      // finishEarlyBtn triggers a native confirm("Finish test? Answered…");
      // auto-accept so the test reaches the result screen. The confirm is
      // a deliberate UX safeguard — we DO NOT remove it.
      page.on('dialog', (d) => d.accept().catch(() => {}));
      await gotoHome(page);

      const startBtn = page.locator('#startBtn');
      if (!(await startBtn.isVisible().catch(() => false))) {
        flag(vp.name, 'exam-flow', 'Cannot start exam: #startBtn not visible on Home');
        return;
      }
      if (await startBtn.isDisabled()) {
        flag(vp.name, 'exam-flow', 'Cannot start exam: #startBtn is disabled');
        return;
      }

      await startBtn.click();
      // Quiz screen should activate.
      await page.waitForSelector('#screenQuiz.active', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(700);
      await shot(page, vp.name, 'exam-mode');

      const quizActive = await page.locator('#screenQuiz.active').isVisible().catch(() => false);
      if (!quizActive) {
        flag(vp.name, 'exam-flow', 'Quiz screen did not activate after Start test');
        return;
      }

      // Question text visible.
      const questionText = await page.locator('.question-text, .quiz-question-text, [class*="question"] .text, .quiz-meta + *').first().textContent().catch(() => '');
      if (!questionText || questionText.trim().length < 5) {
        flag(vp.name, 'exam-flow', 'Question text appears empty or missing');
      }

      // Options visible.
      const optionsCount = await page.locator('#optionsList button, #optionsList .option-btn').count();
      if (optionsCount === 0) flag(vp.name, 'exam-flow', '#optionsList has no option buttons');

      // No horizontal scroll on quiz screen.
      await checkNoHorizontalScroll(page, vp.name, 'exam-mode');

      // Verify the quiz header / progress bar does not vertically overlap
      // the question card on mobile.
      if (vp.isMobile) {
        const header = await page.locator('#mainHeader').boundingBox().catch(() => null);
        const firstOpt = await page.locator('#optionsList button, #optionsList .option-btn').first().boundingBox().catch(() => null);
        if (header && firstOpt && header.y + header.height > firstOpt.y) {
          flag(vp.name, 'overlap', `Header (bottom ${Math.round(header.y + header.height)}px) overlaps first option (top ${Math.round(firstOpt.y)}px)`);
        }
      }

      // Select first option, then Next.
      if (optionsCount > 0) {
        await page.locator('#optionsList button, #optionsList .option-btn').first().click().catch(() => {});
        await page.waitForTimeout(300);
        const nextVisible = await page.locator('#nextBtn:not(.hidden)').isVisible().catch(() => false);
        if (!nextVisible) {
          flag(vp.name, 'exam-flow', 'Next button did not appear after selecting an option');
        } else {
          await page.locator('#nextBtn').click().catch(() => {});
          await page.waitForTimeout(500);
        }
      }

      // Finish early — should jump to result screen.
      const finishBtn = page.locator('#finishEarlyBtn:not(.hidden)');
      if (await finishBtn.isVisible().catch(() => false)) {
        await finishBtn.click().catch(() => {});
        await page.waitForTimeout(600);
      }
      const resultVisible = await page.locator('#screenResult.active, #screenResult:not([style*="display: none"])')
        .first().isVisible().catch(() => false);
      if (resultVisible) {
        await shot(page, vp.name, 'result-screen');
      } else {
        // Not fatal — finish-early may need confirmation. Just note it.
        flag(vp.name, 'exam-flow', 'Result screen not reached after finish-early click (may need confirmation dialog)', { severity: 'info' });
      }

      if (vp.isMobile) {
        await checkMinFontSize(page, vp.name, 'exam-mode');
        await checkAllButtonsSize(page, vp.name, 'exam-mode');
      }
    });

  });
}

// ── final report ──────────────────────────────────────────────────
test.afterAll(() => {
  // Group by category.
  const byCategory = {};
  issues.forEach(i => {
    byCategory[i.category] = byCategory[i.category] || [];
    byCategory[i.category].push(i);
  });

  const report = {
    timestamp: new Date().toISOString(),
    viewports: VIEWPORTS.map(v => v.name),
    totalIssues: issues.length,
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
    issues,
  };
  fs.writeFileSync(path.join(OUT_ROOT, 'report.json'), JSON.stringify(report, null, 2));

  // Deduplicate: same (category, message) across multiple viewports collapses
  // into a single entry with `viewports` array. Makes the report actionable
  // instead of 3-5× repetition for every mobile finding.
  const deduped = {};
  for (const i of issues) {
    const key = i.category + '||' + i.message;
    if (!deduped[key]) deduped[key] = { category: i.category, message: i.message, viewports: [], file: i.file };
    if (!deduped[key].viewports.includes(i.viewport)) deduped[key].viewports.push(i.viewport);
  }
  const dedupList = Object.values(deduped);
  const dedupByCategory = {};
  dedupList.forEach(d => {
    dedupByCategory[d.category] = dedupByCategory[d.category] || [];
    dedupByCategory[d.category].push(d);
  });

  // Suggested files-to-fix per category (heuristic, helps prioritise).
  const FILE_HINTS = {
    'small-font':        ['src/style.css (look for `font-size:` declarations <14px on mobile media queries)'],
    'small-tap-target':  ['src/style.css (button/icon classes — bump min-height to 40px on mobile)'],
    'layout-jump':       ['src/style.css (collapse/expand rules; ensure body padding stays constant)'],
    'horizontal-scroll': ['src/style.css (look for fixed widths or paddings exceeding viewport)'],
    'overlap':           ['src/style.css (header z-index / sticky positioning vs content top padding)'],
    'exam-flow':         ['src/app.js (`finishEarly`, `showResultScreen` — confirmation dialog handling)'],
    'navigation':        ['src/app.js (`bindAppSidebar`, `updateAppSidebarActive`)'],
    'clickable':         ['index.html (verify selectors / disabled-state)', 'src/app.js (`startBtn` / `liftCta` wiring)'],
    'visibility':        ['src/app.js (auth flow → setAppSidebarVisible)'],
    'js-error':          ['src/app.js'],
    'console-error':     ['src/app.js'],
  };

  // Markdown summary.
  const md = [];
  md.push('# UX audit report');
  md.push('');
  md.push(`- generated: ${report.timestamp}`);
  md.push(`- viewports: ${report.viewports.join(', ')}`);
  md.push(`- raw issues: **${report.totalIssues}** → deduplicated to **${dedupList.length}** unique findings`);
  md.push('');

  if (dedupList.length === 0) {
    md.push('## 🎉 No issues detected.');
  } else {
    md.push('## Summary by category');
    md.push('');
    md.push('| Category | Unique findings |');
    md.push('| --- | --- |');
    for (const [cat, list] of Object.entries(dedupByCategory)) {
      md.push(`| \`${cat}\` | ${list.length} |`);
    }
    md.push('');

    for (const [cat, list] of Object.entries(dedupByCategory)) {
      md.push(`### ${cat} (${list.length})`);
      md.push('');
      list.slice(0, 40).forEach(d => {
        const vps = d.viewports.length === report.viewports.length
          ? '_all viewports_'
          : d.viewports.join(', ');
        const file = d.file ? ` _[${d.file}]_` : '';
        md.push(`- ${d.message}${file} — **${vps}**`);
      });
      if (list.length > 40) md.push(`- _…and ${list.length - 40} more_`);
      md.push('');
    }

    md.push('## Files likely to need changes');
    md.push('');
    const filesToFix = new Set();
    for (const cat of Object.keys(dedupByCategory)) {
      (FILE_HINTS[cat] || []).forEach(f => filesToFix.add(f));
    }
    for (const f of filesToFix) md.push(`- ${f}`);
  }

  fs.writeFileSync(path.join(OUT_ROOT, 'report.md'), md.join('\n'));

  console.log('\n=== UX AUDIT SUMMARY ===');
  console.log(`Total issues: ${issues.length}`);
  for (const [cat, list] of Object.entries(byCategory)) {
    console.log(`  ${cat}: ${list.length}`);
  }
  console.log(`Reports: tmp/ux-audit/report.json + report.md`);
});
