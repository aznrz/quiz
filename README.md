# MS Cert Practice

Static PWA for Microsoft exam practice.

Site: [app.ms-cert.workers.dev](https://app.ms-cert.workers.dev/)
Version: **v1.20**

## Stack

- **Hosting:** Cloudflare Workers
- **Auth & Realtime data:** Firebase (Auth + Firestore) — the API key in
  `src/firebase-init.js` is **public by design** (Firebase identifies the
  project, access is enforced server-side via Firestore Rules + Auth, not by key secrecy)
- **Runtime DB:** `data/questions.v2.json` (single source of truth since 2026-04-29; served to production users via Firebase callable functions)
- **Staging DB:** local PostgreSQL `exams_quiz` (experimental, not on the live path)
- **Frontend:** vanilla JS + PWA (Service Worker)

## Source of truth

`data/questions.v2.json` is the **single source of truth** for question content.
All content edits — explanation rewrites, batch appends, schema bumps — happen
in this file. In production, the site reads the payload through Firebase
callable function `getQuestionsAllV2` (with legacy fallback to
`getQuestionsAll` during the migration); direct static loading is kept only
for localhost/dev fallback.

Legacy notes:
- `data/_archive/questions.json` is the **deprecated** legacy base (moved
  into `_archive/` 2026-04-30 to make the active boundary obvious). Frozen —
  do not edit, do not regenerate, do not load.
- `scripts/cleanup_questions_json.py` is **retired** and must not be run; it
  would overwrite `questions.v2.json` with stale content.

Cloud DB direction (locked 2026-04-28): when migration eventually happens,
**Neon** (not Supabase). Current focus shifted from analytics/portfolio to
learning-effectiveness features, so no migration this quarter.

## Active data pipeline

```text
microsoft-realism-test skill (separate repo: aznrz/skills)
        -> generates batch JSON under generated new data/<exam>/
        ->
python scripts/merge_batch.py "generated new data/<exam>/<batch>.json"
        -> validates (no ID/group_id collisions, sections exist) and appends
        -> updates exam.question_count + meta.{total, by_exam, generated_at}
        ->
data/questions.v2.json    source-of-truth artifact edited in git
        ->
Firebase callable functions getQuestionsAllV2 -> getQuestionsAll (legacy fallback)
        ->
loadDB() in src/app.js
```

## Canonical deploy pipeline

Use this exact sequence when question content changes:

1. Put the batch into `generated new data/<exam>/`.
2. Run `python scripts/merge_batch.py "generated new data/<exam>/<batch>.json"`.
3. If frontend assets changed, bump `CACHE` in `sw.js`.
4. Run `FUNCTIONS_DISCOVERY_TIMEOUT=120 firebase deploy --only functions` (Firebase **callable functions** only — never `firebase deploy --only hosting`; Firebase Hosting is **not** the live site).
5. Commit and `git push origin main`. Push triggers Cloudflare Workers auto-deploy (~1 min). Manual deploy: `npx wrangler deploy`.

### Single-question fix flow (no batch)

When polishing an already-merged question (improving the explanation, fixing a wrong answer key, correcting bilingual labels) edit `data/questions.v2.json` directly — there is no batch pipeline for one-off content fixes.

A fix is complete only when all three teaching fields are non-empty for that question:

- `explanation` — ≥100 chars target; explains *why* the correct answer is correct and why the strongest distractor is wrong (mirror to `details.explanation`).
- `tip` — ≥30 chars target; contrastive mnemonic, not an answer reveal (mirror to `details.remember`).
- `learn_url` — verifiable Microsoft Learn link (deep link preferred, exam baseline acceptable fallback); never invent GUID URLs.

Then bump `version` from `gen1` to `gen2` **only if** the starting value is exactly `gen1`. Other tags (`db1`, `db2`, `cs24`, `my1`) are provenance markers — leave them. After the fix, run the same deploy steps as a batch merge (sw.js cache bump → `FUNCTIONS_DISCOVERY_TIMEOUT=120 firebase deploy --only functions` → push). Full checklist: [wiki/pages/data-contract.md](./wiki/pages/data-contract.md) "Question fix workflow".

Why two deploy steps matter:
- `FUNCTIONS_DISCOVERY_TIMEOUT=120 firebase deploy --only functions` updates the bundled questions payload inside the Firebase **callable function** (`getQuestionsAllV2`). Never `firebase deploy --only hosting` — Firebase Hosting is **not** the live site, just dev leftover.
- `git push origin main` triggers Cloudflare Workers auto-build (~1 min) — updates the static frontend. Manual fallback: `npx wrangler deploy`.

Production runtime loading order:
1. `cloudSync.loadQuestions()`
2. Firebase callable `getQuestionsAllV2`
3. legacy callable fallback `getQuestionsAll`
4. localhost/dev only: direct `fetch('data/questions.v2.json')`

Notes:
- Each question carries a `version` field: `gen1` (legacy generated) /
  `gen2` (new generated under updated realism rules) / `cs24` (Coursera
  2024 source set, formerly `real1`) / `db1` (English DB import). Tags
  shortened 2026-04-30 from `gen.1.0` / `gen.2.0` / `real.1.0`; `real1`
  renamed to `cs24` on 2026-05-02. Old localStorage filter values are
  auto-migrated by `loadVersionFilter()`.
- The home screen has a global **version filter** (since v1.16): when more
  than one `version` value exists in the loaded base, a pill row appears
  above the exam selector — `Все версии / gen1 / gen2 / cs24 / db1` — and
  the active filter narrows the pool used by every mode (Practice, Слабые,
  Smart, Leitner, Кейс-стади, Flashcards, Избранные).
- The merge script is idempotent in spirit: it hard-fails on any ID or
  group_id collision and never writes a partial file.
- After a merge, bump `CACHE` in `sw.js` so existing PWA installs reload
  the data, then commit and push.
- `data/_archive/questions.json` stays in the repo as deprecated history;
  do not edit it.
- `EXAMS` is archival/reference only and is not the active publish owner.
- `data/manifest.json` and per-exam runtime packs are retired.

## Current folders that matter

| Path | Purpose |
|------|---------|
| `data/questions.v2.json` | Source-of-truth runtime database; served to production through Firebase function |
| `data/_archive/questions.json` | Deprecated. Frozen, kept for git history only. Do not edit. |
| `scripts/merge_batch.py` | Append a generated batch into `data/questions.v2.json` (validates, no collisions). |
| `scripts/cleanup_questions_json.py` | Retired pipeline. Do not run. |
| `generated new data/<exam>/` | Staging area for newly generated batches awaiting merge |
| `new data/<exam>/` | Legacy staging folders (kept empty with `.gitkeep`) |
| `src/app.js` | Core app logic |
| `src/engine/` | Readiness + recommendation engines (v1.10) |
| `src/ui/` | Study Plan / Remediation / Exam Coach cards (v1.10) |
| `src/config/exam-profiles.js` | Per-exam blueprint weights, pacing |
| `src/style.css` | Styling |
| `sw.js` | Offline/cache policy |
| `wiki/` | Durable project notes |

## Supported exams (runtime JSON)

| Exam | Questions | Group types in JSON |
|------|-----------|--------------------|
| PL-300 | 2885 | mini, std, case |
| AI-900 | 353 | mini, std |
| MO-200 | 125 | mini, std |
| IT-Specialist-Python | 84 | mini, std |
| DP-900 | 240 | mini, std |
| **Total** | **3687** | |

> Counts as of 2026-04-29 after dropping 182 filler-option questions
> (audit) and adding 40 gen2 PL-300 questions (mock_40 batch).

> Note: PostgreSQL staging uses a different taxonomy after migration 004 —
> only `case_study` groups + a single pool with `group_id IS NULL`.
> The two worlds will be reconciled when `export_to_json.py` lands.

## App modes

| Mode | Source |
|------|--------|
| Practice | stratified MCQ draw across `section_key` (largest-remainder by `EXAM_PROFILES.sectionWeights`); section filter inside the card narrows scope to one section |
| Blitz | same active MCQ pool, swipe UI |
| Case study | one `case_study` group |
| Weak topics | review pool from accuracy history |
| Smart Review | review pool from mastery + recency |
| Leitner | items with `nextReviewAt <= now` |
| Flashcards | active MCQ grouped by `section_key` |

> v1.13/v1.14: the standalone "Симуляция экзамена" and "По разделу" cards were
> retired; both flows now run through Practice (`buildStratifiedSession`).

## Data contract summary

Each question in `data/questions.v2.json` is expected to provide:

- `id`, `exam_code`, `section_key`, `section_label`
- `group_type`, `group_id`, `question_type`
- `options` (4–6 elements of `{key, text}`; UI auto-grids 5+ options at 2 cols mobile / 3 cols ≥600 px), `correct_answers` (list), `answer_text`
- `explanation` (≥100 chars by quality rule), `tip` (≥30 chars), `scenario`
- `version` (string: `gen1` / `gen2` / `cs24` / `db1`) — drives the
  home-screen version filter introduced in v1.16. `cs24` is Coursera 2024
  (renamed from `real1` on 2026-05-02).
- `learn_url` (optional string) — when non-empty, rendered as a clickable
  "📚 Microsoft Learn →" pill below the explanation; empty string is the
  safe default when no verified deep-link is available
- `domain` is metadata only, not a live test type

Forbidden patterns (encoded in the `microsoft-realism-test` skill validator
as hard fails — never reintroduce):

- Filler options: `Нет такой функции`, `Зависит от версии`, `Не применимо`,
  `Зависит от лицензии`. The 2026-04-29 audit removed 182 questions guilty
  of this anti-pattern.
- Explanations starting with `Правильный ответ: X.` (UI already highlights
  the correct option). Audit stripped 160 such prefixes.
- Generic placeholder explanations like `Этот вариант лучше всего соответствует
  требованию сценария…`. Audit replaced 80 instances of this exact phrase.

## Structure

```text
index.html
manifest.json
sw.js
package.json             # Playwright dev deps (no runtime build pipeline)
playwright.config.js     # e2e: auto-starts http.server on :8000
src/
  app.js
  style.css
  firebase-init.js
  metrics.js             # SSoT for metric constants + helpers (MetricsConfig, Metrics.*)
  branding.js            # SSoT for site name (SITE_NAME → applied via data-brand="name")
  config/
    exam-profiles.js     # per-exam weights, supportsCaseStudy, pacing
  engine/
    readiness.js         # getExamReadiness / getSectionReadiness / getReadinessBreakdown
    recommendation.js    # getRecommendedAction / getSecondaryActions / getStudyPlanDraft
  ui/
    study-plan.js        # home Study Plan card → routes into existing modes
    remediation.js       # post-mistake card under explanation
    exam-coach.js        # post-session report on result screen
tests/
  README.md              # testing pattern docs (reusable across projects)
  e2e/
    smoke.spec.js        # page load, globals wired, engine API shapes
    learning-flows.spec.js  # recommendation priority, coach verdicts, remediation
data/
  questions.v2.json    # single source of truth (edit here, read by live site)
  title-learn-links.json  # title -> learn_url reference (auto-grown by merge_batch.py)
  _archive/
    questions.json     # frozen legacy base, kept for git history only
new data/
  README.md
  PL-300/
  AI-900/
  DP-900/
  MO-200/
  IT-Specialist-Python/
wiki/
  pages/
scripts/
  audit_questions.py
  merge_batch.py              # append a generated batch to questions.v2.json
  cleanup_questions_json.py   # retired (do not run)
```

## Local development

```bash
python -m http.server 3000
```

Open `http://localhost:3000`.

## Tests

End-to-end tests use Playwright. They run against a static `python -m http.server`
on port 8000 (auto-started by Playwright's `webServer` config).

```bash
# one-time setup
npm install
npx playwright install chromium

# run all e2e tests (headless)
npm run test:e2e

# debug with browser visible
npm run test:e2e:headed

# interactive UI mode
npm run test:e2e:ui
```

Coverage today:
- `tests/e2e/smoke.spec.js` — page load, no console errors, all engine
  globals exposed, `EXAM_PROFILES` weights valid for all 5 exams,
  `getReadinessBreakdown` / `getRecommendedAction` / `getStudyPlanDraft`
  return expected shapes.
- `tests/e2e/learning-flows.spec.js` — recommendation priority logic
  (overdue Leitner, weakest section drill, practice fallback, case_study
  gating by exam profile), Exam Coach verdict thresholds, Remediation
  rule-based output.

See [tests/README.md](./tests/README.md) for the testing pattern, how to
extend it, and how to reuse it in another static-site project.

## Deployment

Push to `main` to trigger Cloudflare deployment.

## Content protection (since v1.18)

- `data/questions.v2.json` is **not** served as a public static file from the
  live host. It is gated behind Firebase callable functions in region
  `us-central1`. The site now calls **`getQuestionsAllV2` first**, then
  falls back to legacy **`getQuestionsAll`** only if needed. Both require
  authentication and share the same per-user rate limit of **100 calls / UTC day**
  (counter at
  `users/{uid}/quota/{YYYY-MM-DD}.getQuestionsAll`).
- Adding new questions: edit `data/questions.v2.json` (directly or via
  `merge_batch.py`), then run `FUNCTIONS_DISCOVERY_TIMEOUT=120 firebase deploy --only functions`. The
  predeploy hook `functions/sync-data.js` copies the JSON into
  `functions/data/questions.v2.json` before upload, then `git push origin main`
  to trigger Cloudflare Workers auto-deploy for the static frontend.
- If callable auth breaks again while the static `/data/` path remains hidden,
  the user-facing symptom is the full-screen "Exam data unavailable" panel.
  Check `firebase functions:log --only getQuestionsAllV2` first; if the old
  endpoint returns `403` but the new one behaves like a normal callable,
  switch the client to the fresh callable rather than reopening `/data/`.
- Admin whitelist (no quota) lives in `ADMIN_EMAILS` inside
  `functions/index.js`. Daily limit is `DAILY_LIMIT` in the same file.
- UI hardening (`installCopyGuard()` + email watermark in `src/app.js`)
  blocks copy / right-click / Ctrl+S/P/U on `.question-card`,
  `.scenario-text`, `#scenarioBlock`, `#explanation` and overlays the
  signed-in email diagonally on every question. These are casual-user
  defenses; the Cloud Function is the real protection.

See `wiki/log.md` (entries dated 2026-04-30) and `CLAUDE.md` § "Content
protection" for the full architecture, free-tier budget notes, and local
dev bypass.

## Current rules

- do not reintroduce manifest-based runtime loading
- do not reintroduce per-exam runtime packs without an explicit migration
- do not use `domain` as a live test source
- keep `README.md` and wiki pages aligned with runtime behavior
- after editing `data/questions.v2.json`, run `FUNCTIONS_DISCOVERY_TIMEOUT=120 firebase deploy --only functions` (not just `git push`) — the live site reads from the function bundle
- never run `firebase deploy --only hosting` — Firebase Hosting is **not** the production site; live frontend is **Cloudflare Workers** (`app.ms-cert.workers.dev`), redeployed automatically on `git push origin main` or manually via `npx wrangler deploy`
- never close a single-question fix without `explanation` + `tip` + `learn_url` all populated; bump `gen1` → `gen2` only when starting version is exactly `gen1`
- **all user-facing metrics go through [src/metrics.js](./src/metrics.js)** — single source of truth for constants (weights, windows, thresholds) and helper functions (`Metrics.getAccuracy`, `Metrics.getTotalPracticeMs`, `Metrics.getStreak`, etc.). Do **not** duplicate formulas like `correct/total*100` in render code; do **not** hardcode constants like Leitner intervals or streak thresholds. For "Just me" scope read local store; for "All"/cohort read cloud. Full reference + checklist in [METRICS.md](./METRICS.md).
- **site name lives in one constant** — [src/branding.js](./src/branding.js) `SITE_NAME`. UI elements use `data-brand="name"` attribute and JS sets `textContent` on DOMContentLoaded. To rename app — change one line in `branding.js` (note: `manifest.json` PWA name + `meta tags` must be updated manually — the browser reads those once at install).

## Documentation index (all top-level docs)

### Корневые `.md` файлы (что для чего)

| Файл | Назначение |
|---|---|
| [README.md](./README.md) | Этот файл. Entry point: стек, source of truth, pipeline, deploy, contracts. |
| [METRICS.md](./METRICS.md) | **Single source of truth для всех метрик** (Accuracy, Readiness, Coverage, Streak, Total practice и т.д.): формулы, источники данных, helper-функции в [src/metrics.js](./src/metrics.js), exam filter behaviour, чеклист добавления новой метрики. |
| [admin-docs/README.md](./admin-docs/README.md) | **Full admin guide** — все 4 admin страницы (Hub / Drafts / Feedback / Management), workflows (фикс broken question, batch upload, promo campaigns, drain overlay), архитектура, troubleshooting. Включает новую Publish Live кнопку. |
| [AGENTS.md](./AGENTS.md) | Load-bearing guardrails и pipeline для AI-агентов (Claude Code / Codex / Cursor). Aliases: `CLAUDE.md`, `CODEX.md`. |
| [ROADMAP.md](./ROADMAP.md) | Живой product roadmap: что сделано (`[x]`), что в процессе (`[~]`), что отложено (`[-]`). Текущие приоритеты. |
| [HANDOVER.md](./HANDOVER.md) | Снимок состояния проекта для передачи / возврата к работе после паузы. Содержит deploy notes (Cloudflare vs Firebase), Firestore структуру, callable IAM, hot paths. |
| [ACCESS-PLAN.md](./ACCESS-PLAN.md) | Архитектура подписок / промокодов / tier-system. Спецификация access-control (test_mode_enabled, killswitch, 22 callables). |
| [SCALE-CHECKLIST.md](./SCALE-CHECKLIST.md) | Дорожная карта на ~12 месяцев: что сделать чтобы держать рост от <100 до 10k MAU без катастроф. Tier 1-3 readiness work + Firestore backup setup. |
| [UX_QA_BASELINE.md](./UX_QA_BASELINE.md) | Зафиксированный baseline UX/QA после Waves 1-4 frontend modernization (2026-05-14). Что считается «правильным» поведением. |
| [design.md](./design.md) | Дизайн-токены: цвета темы «Stitch Dark», типографика, spacing scale. |
| [_role-questions-review.md](./_role-questions-review.md) | Рабочий артефакт: список PL-300 вопросов про Workspace Roles (Admin/Member/Contributor/Viewer) для ревью. Underscore prefix = WIP / личный файл, в Cloudflare не деплоится через `.assetsignore`. |

### Полу-документация в подпапках

| Путь | Что внутри |
|---|---|
| [scripts/README.md](./scripts/README.md) | **Индекс всех ~120 скриптов** по категориям: core pipeline, DataBoom, title taxonomy, bilingual, audit, frozen, one-shot fix-скрипты. |
| [wiki/](./wiki/) | Durable project notes: schema, data-contract, app-architecture, pwa-and-deploy, и т.д. Подробнее — [wiki/README.md](./wiki/README.md). |
| [wiki/pages/](./wiki/pages/) | Тематические страницы wiki. См. таблицу в [AGENTS.md "Where details live"](./AGENTS.md). |
| [wiki/log.md](./wiki/log.md) | Activity log — что менялось когда. |
| [generated new data/AGENTS.md](./generated%20new%20data/AGENTS.md) | Staging-area: правила batch ingest, schema одного вопроса, naming-конвенции. |
| [generated new data/databoom/BOT-INSTRUCTION.md](./generated%20new%20data/databoom/BOT-INSTRUCTION.md) | Универсальная инструкция для бота-экстрактора DataBoom (rekhert.com). Параметры под экзамены — в [SQL-PARAMS.md](./generated%20new%20data/databoom/SQL-PARAMS.md), [MIX-PARAMS.md](./generated%20new%20data/databoom/MIX-PARAMS.md). |
| [generated new data/<EXAM>/BATCH-GENERATOR-PROMPT.md](./generated%20new%20data/) | GPT-промпт для генерации batch JSON (один на каждый из: STATS, ML, MATHDS, SQL). |
| [skills/microsoft-realism-test/SKILL.md](./skills/microsoft-realism-test/SKILL.md) | Skill для генерации реалистичных Microsoft-стиль тестов с валидатором запрещённых паттернов. |
| [sql/migrations/](./sql/migrations/) | Schema migrations log (PostgreSQL staging — experimental, не на live runtime path). |
| [sql/Мои ноты по поводу развития сайта.md](./sql/Мои%20ноты%20по%20поводу%20развития%20сайта.md) | Dev-ноты (legacy — см. ROADMAP для текущего плана). |
| [tests/README.md](./tests/README.md) | Playwright e2e testing pattern. |

### Что **не** деплоится в прод

Подробности в [.assetsignore](./.assetsignore). Кратко: всё что выше + `.env*`, `.firebase/`, `firestore.{rules,indexes.json}`, `_role-*`, `inject_admin.ps1`, `wiki/`, `scripts/`, `sql/` — не уходит на Cloudflare Worker.
