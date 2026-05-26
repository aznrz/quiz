# Playwright e2e tests — exams-quiz

End-to-end tests for the static learning-engine layer. The setup here is
deliberately reusable: it works for any static site that exposes pure JS
modules on `window` (no build pipeline, no framework).

## What's tested

| Spec | Layer | Login required |
|------|-------|----------------|
| `tests/e2e/smoke.spec.js` | page loads, scripts wire up, engine globals exist, public APIs return valid shapes | no |
| `tests/e2e/learning-flows.spec.js` | recommendation priority logic, coach verdict thresholds, remediation rule-based output | no — uses `page.evaluate` data injection |

We do **not** test full UI flows that need Firebase Google auth — that
would require either a service account or an interactive run, both of
which add cost without proportional value at v1. Instead, we test the
**logic** that drives those UI flows by stubbing the data layer at runtime.

## How to run

```bash
# 1. Install dev deps (one-time)
npm install
npx playwright install chromium

# 2. Run all e2e tests (auto-starts python http.server on :8000)
npm run test:e2e

# 3. Watch with UI mode
npm run test:e2e:ui

# 4. See the browser instead of headless
npm run test:e2e:headed
```

The Playwright config (`playwright.config.js`) auto-starts `python -m http.server 8000`
and reuses an existing server on port 8000 if you already have one.
Override the URL with `BASE_URL=http://localhost:3000 npm run test:e2e`.

## Pattern: testing pure JS modules on a static site

This is the reusable part. The recipe works for any static site where
business logic lives in classic scripts that attach helpers to `window`:

### 1. Expose your logic on `window`

In your script (classic, not ES module):

```js
(function (global) {
  function getRecommendedAction(examCode) { /* ... */ }
  global.recommendationEngine = { getRecommendedAction };
})(typeof window !== 'undefined' ? window : globalThis);
```

### 2. Drive the logic via `page.evaluate`

```js
test('recommendation has a primary action', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const action = await page.evaluate(() =>
    window.recommendationEngine.getRecommendedAction('PL-300')
  );

  expect(action.type).toBeDefined();
});
```

### 3. Stub the data layer when you need controlled inputs

The engines read globals like `loadStore()`, `loadMastery()`,
`getExamQuestions()`. Tests override those globals before calling, then
restore in `afterEach`. See `learning-flows.spec.js` → `seedFixtures` /
`restoreFixtures`.

This is faster and more stable than driving real UI clicks, because:

- no login/auth dependency
- deterministic inputs → deterministic outputs
- failures point at the rule, not at flaky DOM timing

### 4. Keep one or two real-DOM tests as canaries

Smoke tests in `smoke.spec.js` still verify the page loads, console is
clean, and globals are wired. If the script tag breaks or a typo lands
on a global name, smoke catches it even though the logic tests don't
touch the real flow.

## Console-error filtering

Smoke filters out three known third-party noises:

- `firebase` (Firestore Rules permissions errors during anonymous reads)
- `favicon` (404 in dev because we don't ship one)
- `Password field is not contained in a form` (browser DOM warning,
  not from our code)

If you adopt this pattern in another project, **explicitly list** the
third-party error patterns you accept. A blanket `errors.length === 0`
will fight you forever; an empty allowlist forces you to think about
each warning the first time it appears.

## What we deliberately did NOT do

- **No `playwright.config.ts`** — the project has zero TypeScript, so
  keeping config in `.js` avoids dragging `tsc` into the repo.
- **No fixtures file** — fixture builders live inline in `learning-flows.spec.js`.
  When tests grow past ~5 specs, extract to `tests/e2e/fixtures.js`.
- **No CI runner config** — that's a separate decision (GitHub Actions vs
  Cloudflare CI). When you add CI, set `CI=1` so reporter switches to `line`.
- **No visual regression tests** — the UI is in flux; pixel-diffs would
  be noise. Add when the design stabilizes.

## When something fails

Playwright keeps `test-results/` with traces, screenshots, and video for
failures (configured in `playwright.config.js → use.trace/screenshot/video`).
View them with:

```bash
npx playwright show-trace test-results/<test>/trace.zip
```

`test-results/` and `playwright-report/` are gitignored.

## Reusing this in another project

Copy these files to the new project and adapt:

- `package.json` (just the `scripts` and `devDependencies` blocks)
- `playwright.config.js` (change port + webServer command if not Python)
- `tests/e2e/smoke.spec.js` (keep the structure, swap globals)
- `tests/e2e/learning-flows.spec.js` (replace fixtures and assertions)
- `.gitignore` entries: `node_modules/`, `test-results/`, `playwright-report/`, `playwright/.cache/`

Then `npm install && npx playwright install chromium && npm run test:e2e`.
