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

### 🔴 Step 6 — Firebase config (WAITING ON USER)

`src/firebase-init.js` lines 7–15 still point to OLD project `exams-quiz-db`. Must replace.

User must:
1. Create Firebase project at console.firebase.google.com
2. Enable Auth → Google sign-in
3. Enable Firestore (production mode)
4. Get `firebaseConfig` from Project Settings → Your apps → Web app
5. Provide config to bot

Bot then replaces `src/firebase-init.js` lines 7–15 + updates `.firebaserc` project id.

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

## Key files

| File | Role |
|------|------|
| `src/firebase-init.js` | Firebase client — `window.cloudSync` global; **needs new config (Step 6)** |
| `src/app.js` | Main app engine — Leitner, quiz flow, UI |
| `src/config/exam-profiles.js` | NARUTO exam definition |
| `src/branding.js` | SITE_NAME, updates `data-brand="name"` DOM nodes |
| `index.html` | Single-page app shell |
| `manifest.json` | PWA manifest |
| `sw.js` | Service worker, cache: `naruto-quiz-v1` |
| `wrangler.jsonc` | Cloudflare Worker config, name: `naruto` |
| `data/questions.v2.json` | Source of truth for questions |
| `functions/data/questions.v2.json` | Copy for Cloud Functions (sync via sync-data.js) |
| `functions/index.js` | Cloud Functions: getQuestionsAll, getQuestionsAllV2, logEvent |
| `.firebaserc` | Firebase project pointer — **update after Step 6** |
