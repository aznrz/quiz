# Naruto Quiz — Fork Plan

Repo forked from `exams-quiz` (MS-cert prep site) → Naruto anime fan quiz for friends.
Remote: `https://github.com/aznrz/naruto.git`

## Architecture decisions (locked in)

- **Auth:** Google sign-in only. Open to anyone. `canAccess` → `() => true`. No tiers/paywall.
- **Firebase:** NEW project (user creates). See Step 6 below.
- **Sections:** by difficulty — `easy` / `medium` / `hard` (Лёгкие / Средние / Эксперт).
- **Admin UI:** stripped entirely — html pages + cloud functions.
- **Questions:** in `data/questions.v2.json`. Next id: `nrt-011`.
- **Deploy:** Cloudflare Worker (static) + Firebase Functions (questions + events).
- **Engine:** kept as-is — readiness, Leitner, dailyStats, sections, question feedback.

---

## Steps status

### ✅ Step 1 — Hygiene (DONE)
Deleted MS-specific docs, data, directories:
- ACCESS-PLAN.md, HANDOVER.md, METRICS.md, ROADMAP.md, SCALE-CHECKLIST.md, design.md, UX_QA_BASELINE.md, AGENTS.md, _role-questions-review.md, audit-local-v4.json
- Dirs: study-materials/, stitch-export/, wiki/, admin-docs/, sql/, scripts/, skills/, tools/, assets/db1/, data/audit/
- Data files: demo.json, singletons-review.csv, subtopics-consolidate.csv, title-learn-links.json

### ✅ Step 2 — Strip admin (DONE)
- Removed: admin.html, admin-drafts.html, admin-edit.html, admin-feedback.html, admin-management.html
- Removed: src/admin-drafts.js, src/admin-management.js
- Rewrote functions/index.js (~60 lines): only getQuestionsAll, getQuestionsAllV2, logEvent
- Deleted repos: accessRepo, configRepo, emailOverrideRepo, ipRateLimitRepo, planRepo, promoRepo, rateLimitRepo, auditRepo

### ✅ Step 3 — Strip subscriptions (DONE)

**`src/firebase-init.js`:** removed admin/promo/draft callables; `canAccess: () => true`; `logout: () => signOut(auth)`; analytics cache consolidated to `_analyticsCache = { data, uid, ts, TTL: 60_000 }`

**`index.html`:** title→"Naruto Quiz", theme-color→#f97316, login subtitle→"Тест по вселенной Наруто", removed tierBadgeBtn, plansModal, promoCodeModal, profileSubscriptionPanel, profileSubscriptionPromoBtn, MS Cert content blocks; exam `<option>` → single NARUTO option

**`src/app.js`:** replaced `cloudSync.loadAccess(true)` (no longer exists) with `renderTierBadge(null)` + updateLockedModeCards/updateLockedSidebarItems calls. All other promo/plan listeners guarded with `if (element)` — silently skip since HTML removed.

### ✅ Step 4 — Exam profile (DONE)
`src/config/exam-profiles.js` replaced with NARUTO-only:
```js
'NARUTO': {
  label: 'Naruto Quiz',
  supportsCaseStudy: false,
  supportsMock: false,
  pacingSecondsPerQuestion: 30,
  passingScore: 700,
  sectionWeights: { easy: 0.34, medium: 0.33, hard: 0.33 },
  sectionLabels: { easy: 'Лёгкие', medium: 'Средние', hard: 'Эксперт' },
}
```

### ✅ Step 5 — Branding (DONE)
- `src/branding.js` → `SITE_NAME = 'Naruto Quiz'`
- `manifest.json` → name "Naruto Quiz", short_name "Naruto", theme_color #f97316, background_color #1a1a1a
- `sw.js` → cache `naruto-quiz-v1`; admin files removed from ASSETS/NETWORK_FIRST arrays

### ✅ Step 6 — Firebase config (DONE)

Automatically created new Firebase project `naruto-quiz-98b5` and registered Web app `Naruto Quiz Web` via Firebase CLI.
Replaced configuration in `src/firebase-init.js` and updated project ID in `.firebaserc`.

### ✅ Step 7 — Naruto questions (DONE — 10 questions)
`data/questions.v2.json` created with 10 questions (nrt-001…nrt-010):
- easy: nrt-001 to nrt-004
- medium: nrt-005 to nrt-008
- hard: nrt-009 to nrt-010

Synced to `functions/data/questions.v2.json` via `node functions/sync-data.js`.

**To add more questions:** edit `data/questions.v2.json` (next id: `nrt-011`), then run `node functions/sync-data.js`.

### ✅ Step 8 — Cloudflare rename (DONE)
`wrangler.jsonc` → `"name": "naruto"`

### ✅ Step 9 — First commit + push (DONE)

Created the first commit and pushed to `main` branch. All files are tracked and up-to-date.

---

# Next tasks (handover) — 2026-05-26

Steps 1–9 done. Project `naruto-quiz-98b5` exists, code in git, Firebase config wired up.
**User needs to manually enable Google Auth + Firestore in Firebase Console before deploy will work.** Link: https://console.firebase.google.com/project/naruto-quiz-98b5

Below are the remaining tasks, ordered by priority. Pick them up in order.

---

## 🔥 Priority 1 — Make the site actually run

### Task A — Deploy Firebase Functions
```bash
cd "C:\Users\AzizNazarov\GiHUB\naruto"
firebase deploy --only functions
```
This deploys `getQuestionsAll`, `getQuestionsAllV2`, `logEvent` to project `naruto-quiz-98b5`.
- If deploy fails with billing/permission errors, report to user (Blaze plan may be required for Gen 2 functions).
- Verify `functions/data/questions.v2.json` exists before deploy (predeploy hook copies it).

### Task B — Smoke test the app locally
1. Start a local server: `npx http-server -p 8080 -c-1` (or `python -m http.server 8080`) in repo root
2. Open `http://localhost:8080`
3. Click Google sign-in → should open OAuth popup
4. After login: app should call `getQuestionsAllV2` → load 10 questions → render quiz UI
5. Take a few questions, check answer recording, explanation display
6. If anything breaks, capture console errors and add them as TODOs

If Auth/Firestore not enabled in console yet → login will fail. That's the user's blocker, document it.

### Task C — Deploy to Cloudflare Worker
```bash
cd "C:\Users\AzizNazarov\GiHUB\naruto"
npx wrangler deploy
```
Worker name is `naruto` per `wrangler.jsonc`. Should publish at `naruto.<account>.workers.dev`. Confirm site loads.

---

## 🟡 Priority 2 — Add more questions

User wants to grow `data/questions.v2.json` over time for various quiz events. Currently 10 questions, target 50.

**Generate 40 more Naruto questions** (next ids: `nrt-011` … `nrt-050`):
- ~13 easy (basic characters, village names, simple plot facts)
- ~14 medium (techniques, clans, team compositions, arcs)
- ~13 hard (lore details, jutsu mechanics, character relationships, Shippuden/Boruto)

Use the existing schema (see `data/questions.v2.json`). Keep all text in Russian. Each question must have 4 options, exactly one `correct` index, and a 1–2 sentence `explanation`.

After editing, **always run**:
```bash
node functions/sync-data.js
```
to copy `data/` → `functions/data/`. Then redeploy functions.

---

## 🟢 Priority 3 — Visual polish

### Task D — Replace icons
`assets/icon-192.png` and `assets/icon-512.png` are still the old MS-cert purple icons. Replace with Naruto-themed orange icons (suggested: Konoha leaf symbol on orange #f97316 background, or a kunai). 192×192 and 512×512 PNG. User can provide, or use a placeholder generated from a simple SVG.

### Task E — Audit CSS for MS purple
Check `src/style.css` for hard-coded MS indigo `#6366f1` / `#4f46e5` colors. Replace with Naruto orange `#f97316` / red `#dc2626` palette where it makes sense (primary buttons, accents, focus rings). Be conservative — don't break the whole theme.

### Task F — Remove dead MS assets
Delete unused MS-specific image assets to shrink repo:
- `assets/db2/` — all PL-300 question images (entire folder)
- `assets/explanations/` — pl300_*.svg files
- `assets/generated_explanations/` — same
- `assets/manual/` — pl300_*.svg files
- `assets/mini/` — check contents, likely MS-specific

Check `index.html` and `src/app.js` first to make sure no img src references these paths — should be safe since these were tied to PL-300 questions that no longer exist.

---

## 🟢 Priority 4 — Repo cleanup

### Task G — Clean up tests
`tests/` folder has MS-specific Playwright tests that are now broken:
- `tests/access-flow.spec.mjs` — references removed access/promo flow → DELETE
- `tests/admin-flow.spec.mjs` — references removed admin UI → DELETE
- `tests/e2e/learning-flows.spec.js` — likely PL-300 specific, check and delete or rewrite
- `tests/e2e/smoke.spec.js` — keep as smoke test but update assertions for "Naruto Quiz" branding
- `tests/e2e/next-button-ux.spec.js` — check if engine-level (keep) or MS-content (delete)
- `tests/events-repo.test.mjs` — check; likely engine-level, keep if compatible
- `tests/extension-logic.test.mjs` — check
- `tests/sweep-smoke.spec.mjs` — check
- `tests/e2e-checklist.spec.mjs` — check
- `tests/auth-setup.mjs` — keep if generic auth helper

Rule of thumb: if the test references `pl300`, `dp900`, `Power BI`, `Microsoft`, `mock_exam`, `promo`, `admin` — delete.

### Task H — Audit README.md
`README.md` still describes the MS-cert project. Rewrite as a short Naruto Quiz readme: what the project is, how to run locally, how to add questions, how to deploy.

### Task I — Audit functions/package.json
Check `functions/package.json` for now-unused deps after the cleanup (the old code used `firebase-admin` for many things). Keep `firebase-functions`, `firebase-admin`. Likely no other deps needed.

### Task J — Audit firestore.rules
After admin/access removal, `firestore.rules` may still reference deleted collections (`access`, `plans`, `promo_codes`, `drafts`, etc.). Simplify to the rules actually needed:
- `users/{uid}` — owner read/write
- `analytics/{uid}` — owner read/write
- `daily_stats/{date}` — auth read, restricted write (via callable)
- `question_stats/{qid}` — auth read, restricted write
- `users/{uid}/reflections/{qid}` — owner read/write
- `users/{uid}/question_feedback/{id}` — owner write, no read
- `users/{uid}/data/{key}` — owner read/write

### Task K — Audit index.html for dead references
After removal of MS content, there may be orphan ids referenced by `src/app.js` (modal containers, etc). Grep `app.js` for `getElementById('xxxModal')` and check if the corresponding HTML still exists. Listeners on missing elements are no-op (already guarded with `if (element)`) so this is cleanup, not bug-fixing.

---

## After all tasks done

Final commit + push:
```bash
git add .
git commit -m "polish: deploy, cleanup MS assets, more questions, Naruto theming"
git push
```

---

## Key files

| File | Role |
|------|------|
| `src/firebase-init.js` | Firebase client (`window.cloudSync`); configured for `naruto-quiz-98b5` |
| `src/app.js` | Main app engine — Leitner, quiz flow, UI |
| `src/config/exam-profiles.js` | NARUTO exam definition |
| `src/branding.js` | `SITE_NAME = 'Naruto Quiz'` |
| `index.html` | SPA shell |
| `manifest.json` | PWA manifest |
| `sw.js` | Service worker, cache: `naruto-quiz-v1` |
| `wrangler.jsonc` | Cloudflare Worker config, name: `naruto` |
| `data/questions.v2.json` | Source of truth for questions (currently 10) |
| `functions/data/questions.v2.json` | Copy for Cloud Functions (auto-sync via `functions/sync-data.js`) |
| `functions/index.js` | Cloud Functions: getQuestionsAll, getQuestionsAllV2, logEvent |
| `.firebaserc` | `default: naruto-quiz-98b5` |
| `firestore.rules` | Security rules (needs audit — Task J) |
