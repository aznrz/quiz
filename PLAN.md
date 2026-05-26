# Naruto Quiz — Unified Development Plan (PLAN.md)

This document is the **Single Source of Truth** for the Naruto Quiz («Коноха») project, representing a complete migration from the `exams-quiz` Microsoft Certification prep engine. It consolidates history, architectural decisions, manual verification steps, and remaining tasks to ensure any AI agent or human developer can pick up where the previous session left off.

---

## 🏛️ Architecture & Global Decisions

1. **Free Tier Compatibility (Spark Plan):**
   * Free-tier Firebase projects **cannot deploy Cloud Functions** (requires a paid Blaze plan).
   * **Solution:** Moved question database loading to a local fetch (`./data/questions.v2.json`) and configured direct client-side Firestore event logging into the `events/` collection. 
   * **Firestore Security Rules:** Open append-only (`allow create`) to allow secure event logging without Cloud Functions.
2. **Authentication:**
   * Google Sign-In only. Open to anyone. `canAccess` evaluates to `() => true` to bypass paywalls/tiers.
3. **Database Schema:**
   * Question text is stored in the `"prompt"` field (not `"question"`), mapping directly to the frontend engine (`q.prompt`).
4. **Branding:**
   * Site Name: **Коноха Quiz** (configured dynamically in `src/branding.js` and statically in `index.html` placeholders).
   * Color Theme: Naruto Orange (`#f97316` / `#c2410c`) and Crimson Red (`#dc2626` / `#b91c1c`) replacing MS Indigo/Purple (`#6366f1` / `#4f46e5`).

---

## 📜 История выполнения (Steps 1–13 ✅ DONE)

### ✅ Step 1 — Санитария (Удаление лишнего)
Удалены все специфичные для Microsoft документы, данные и папки:
* Файлы: `ACCESS-PLAN.md`, `HANDOVER.md`, `METRICS.md`, `ROADMAP.md`, `SCALE-CHECKLIST.md`, `design.md`, `UX_QA_BASELINE.md`, `AGENTS.md`, `_role-questions-review.md`, `audit-local-v4.json`.
* Директории: `study-materials/`, `stitch-export/`, `wiki/`, `admin-docs/`, `sql/`, `scripts/`, `skills/`, `tools/`, `data/audit/`.
* Вспомогательные данные: `demo.json`, `singletons-review.csv`, `subtopics-consolidate.csv`, `title-learn-links.json`.

### ✅ Step 2 — Удаление административной панели
* Удален фронтенд админки: `admin.html`, `admin-drafts.html`, `admin-edit.html`, `admin-feedback.html`, `admin-management.html`.
* Удалены скрипты: `src/admin-drafts.js`, `src/admin-management.js`.
* Репозитории очищены от неиспользуемых сервисных файлов: `accessRepo`, `configRepo`, `emailOverrideRepo`, `ipRateLimitRepo`, `planRepo`, `promoRepo`, `rateLimitRepo`, `auditRepo`.

### ✅ Step 3 — Очистка подписок и тарифов
* **`src/firebase-init.js`:** Удалены вызовы `callable` для админки/промокодов; установлена безусловная авторизация `canAccess: () => true`.
* **`index.html`:** Очищен заголовок, удалены кнопки тарифных сеток (`tierBadgeBtn`), модальные окна тарифов (`plansModal`, `promoCodeModal`) и панели подписок.
* **`src/app.js`:** Заменены вызовы синхронизации подписок, установлены предохранители на отсутствующие элементы DOM.

### ✅ Step 4 — Профиль экзамена (Exam Profiles)
* `src/config/exam-profiles.js` переписан под единственный поддерживаемый экзамен `NARUTO` с тремя уровнями сложности (`easy` — Лёгкие, `medium` — Средние, `hard` — Эксперт).

### ✅ Step 5 — Первичный брендинг
* `src/branding.js` установлен в `SITE_NAME = 'Naruto Quiz'`.
* `manifest.json` обновлен (название "Naruto Quiz", тема `#f97316`, фоновый цвет `#1a1a1a`).
* `sw.js` очищен от кэширования удаленных файлов админки.

### ✅ Step 6 — Firebase Конфигурация
* Создан проект `naruto-quiz-98b5` в Firebase CLI.
* Обновлен конфигурационный файл инициализации `src/firebase-init.js` и идентификатор проекта в `.firebaserc`.

### ✅ Step 7 — Базовый контент
* Сгенерированы первые 10 высококачественных вопросов по Наруто на русском языке с пояснениями.

### ✅ Step 8 — Переименование Cloudflare
* `wrangler.jsonc` настроен на проект `naruto` с деплоем на `naruto.ms-cert.workers.dev`.

### ✅ Step 9 — Первый коммит и публикация в Git
* Выполнен первый коммит, привязан удаленный репозиторий `https://github.com/aznrz/naruto.git` и отправлен в ветку `main`.

### ✅ Step 10 — Замена страницы справочника (References)
* Старая шпаргалка по PL-300 полностью заменена в `index.html` на красочный и подробный **«Справочник шиноби»** на русском языке.
* Справочник содержит: интерактивную таблицу рангов ниндзя, обзор пяти стихий чакры, информацию о легендарных Саннинах, великих скрытых деревнях, преступной группе Акацуки и полноценный FAQ (о Шарингане, джинчуриках, Режиме Мудреца и запрещенных дзюцу).

### ✅ Step 11 — Добавление вопросов по «Бриджертонам»
* По запросу пользователя в базу `data/questions.v2.json` добавлено **10 вопросов по вселенной сериала «Бриджертоны»** (id `nrt-051` — `nrt-060`) с качественными описаниями и вариантами ответов. Общий счетчик вопросов доведен до **60**.
* Запущен скрипт `node functions/sync-data.js` для копирования вопросов в каталог облачных функций.

### ✅ Step 12 — Брендирование экрана логина (Landing Page)
* Удален вводящий в заблуждение список из 5 несуществующих IT-экзаменов Microsoft.
* Разработана единая красивая карточка **Тест «Коноха» — 60 вопросов (включая 10 про Бриджертоны!)** в оранжевом стиле.
* Иконка входа `📝` заменена на тематический символ спирали `🍥`. Экран переведен на русский язык.

### ✅ Step 13 — Чистка интерфейса от PL-300
* Отредактированы внутренние графики статистики: надпись «Pass probability by day (PL-300 heuristic)» переведена как **«Вероятность прохождения (алгоритм Конохи)»**.
* Тэг пути обучения в боковом меню изменен с `PL-300` на **«Коноха»**.

---

## 🛠️ Pre-flight check & Ручные действия (Firebase Console)

Перед полноценным локальным использованием и фиксацией проекта необходимо вручную настроить консоль Firebase:
1. Перейдите по ссылке: [Firebase Console - naruto-quiz-98b5](https://console.firebase.google.com/project/naruto-quiz-98b5)
2. **Включить Аутентификацию:** Раздел **Authentication** -> вкладка **Sign-in method** -> включить провайдер **Google** (указать контактную почту поддержки и сохранить).
3. **Создать Базу Данных:** Раздел **Firestore Database** -> нажать **Create database** -> выбрать режим **Start in test mode** -> выбрать ближайший сервер (например, eur3) и подтвердить создание.

---

## 🔴 Priority 0 — Полное удаление MS-следов

Удалить остаточные упоминания Microsoft, Power BI и старых экзаменов из исходников.

### 1. Поиск и удаление в `index.html` и `_worker.js`:
* Найти и вырезать любые ссылки на платные тарифы, упоминания "Microsoft certification practice test" или "Power BI".
* Проверить `_worker.js` на наличие старых маршрутов админки или подписок, очистить их.

### 2. Чистка файлов и каталогов:
* Окончательно удалить неиспользуемые файлы тестов в папке `tests/` и документацию в `docs/`.

---

## 🔥 Priority 1 — Запуск и Smoke-тест

### Task A — Проверка Firebase Firestore
* Проверить деплой правил безопасности Firestore из локального файла `firestore.rules`.
* Запустить команду для проверки:
  ```bash
  firebase deploy --only firestore
  ```

### Task B — Локальный Smoke-тест
1. Запустить локальный сервер:
   ```bash
   npx http-server -p 8080 -c-1
   ```
2. Открыть в браузере `http://localhost:8080`.
3. Нажать кнопку **Войти через Google** (убедиться, что открывается OAuth-окно).
4. Проверить загрузку вопросов викторины (должно подгрузиться 60 вопросов).
5. Пройти тест на 3-4 вопроса, убедиться, что объяснения ответов и прогресс отображаются без консольных ошибок.

### Task C — Деплой на Cloudflare Workers
* Выполнить итоговую сборку и загрузку на сервер Cloudflare:
  ```bash
  npx wrangler deploy
  ```
* Убедиться, что сайт доступен по адресу `https://naruto.ms-cert.workers.dev` и работает стабильно.

---

## 🟡 Priority 2 — Расширение контента (Контрольный список тем)

База вопросов успешно расширена до 60 вопросов! 
* **1-50:** Высококачественные вопросы по Наруто (Узумаки, Кюби, экзамен на Чунина, техники Расенган/Чидори, Акацуки, Саннины, свойства чакры и Биджу).
* **51-60:** Вопросы по вселенной сериала «Бриджертоны» (Леди Уислдаун, виконт Энтони, семья Фезерингтон, Кейт Шарма и др.).

---

## 🟢 Priority 3 — Визуальный полиш и Рефакторинг

### Task D — Замена иконок PWA (ВЫПОЛНЕНО)
* Иконки `assets/icon-192.png` и `assets/icon-512.png` обновлены на сгенерированный оранжевый логотип со знаком Конохи.

### Task E — Тотальный ремапинг цветов CSS
* Найти в `src/style.css` все упоминания фиолетового цвета `#6366f1` / `rgba(99,102,241` и заменить их на оранжевый цвет `#f97316` / `rgba(249,115,22` для полной перекраски интерфейса кнопок, фокусов, прогресс-баров и активных элементов.

### Task F — Удаление мертвых MS-ассетов (ВЫПОЛНЕНО)
* Папки `assets/db2/` и старые SVG-пояснения полностью вырезаны из репозитория.

### Task G — Чистка мертвых тестов (ВЫПОЛНЕНО)
* Из папки `tests/` удалены неактуальные файлы `access-flow.spec.mjs`, `admin-flow.spec.mjs`, `learning-flows.spec.js`.

### Task H — Обновление README.md
* Переписать `README.md` под проект «Коноха Quiz».

### Task I — Оптимизация functions/package.json
* Удалить лишние бэкенд-зависимости.

### Task J — Аудит firestore.rules
* Упростить файл правил безопасности Firestore.

### Task K — Чистка index.html от orphan-элементов
* Провести аудит и удалить невидимые/неактуальные блоки DOM.

---

## 🏁 Task M — Финальный Commit

После выполнения всех задач сделать финальный срез:
```bash
git add .
git commit -m "chore: complete naruto quiz rebranding, css theme recolor and MS assets cleanup"
git push
```

---

## 📊 Журнал работы и Прогресс

| Этап | Задача | Статус | Комментарий |
|---|---|:---:|---|
| **Priority 1** | Task A (Firebase Firestore deploy) | `[x]` | Правила успешно развернуты. |
| | Task B (Локальный Smoke-тест) | `[x]` | Тестирование пройдено, авторизация и загрузка работают. |
| | Task C (Wrangler deploy на Cloudflare) | `[x]` | Рабочая версия доступна на workers.dev. |
| **Priority 2** | Добавление вопросов по Наруто (до 50) | `[x]` | Добавлено 50 вопросов по Наруто. |
| | Добавление вопросов по Бриджертонам | `[x]` | Добавлено 10 вопросов (итого 60). |
| **Priority 3** | Task D (Замена PWA-иконок) | `[x]` | Новые оранжевые иконки Конохи загружены. |
| | Task E (Замена фиолетового цвета в CSS) | `[ ]` | Требуется завершить ремапинг переменных в style.css. |
| | Task F (Удаление старой MS-графики) | `[x]` | Папки db2 и SVG-файлы удалены. |
| **Priority 4** | Task G (Удаление мертвых тестов) | `[x]` | Сломанные тесты вырезаны. |
| | Task H (Перезапись README.md) | `[ ]` | Ждет финального текста. |
| | Task I (Чистка package.json функций) | `[ ]` | Требуется обрезать лишние deps. |
| | Task J (Firestore rules audit) | `[ ]` | Требуется упрощение под static-схему. |
| | Task K (Чистка index.html от мусора) | `[ ]` | Ждет рефакторинга. |
