# Quiz — викторина по поп-культуре

![JavaScript](https://img.shields.io/badge/JavaScript-ES6-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Firebase](https://img.shields.io/badge/Firebase-Firestore-FFCA28?style=flat-square&logo=firebase&logoColor=black)
![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-Offline-5A0FC8?style=flat-square&logo=pwa&logoColor=white)
![Status](https://img.shields.io/badge/Статус-Активный-22c55e?style=flat-square)

Этот репозиторий — PWA-приложение для проверки знаний по поп-культуре: аниме, сериалы, комиксы и музыка. Вопросы с объяснениями, уровни сложности, статистика прогресса и система интервального повторения Лейтнера.

Проект построен на чистом Vanilla JS без фреймворков, хостится на Cloudflare Workers, прогресс синхронизируется через Firebase Firestore с авторизацией через Google.

---

## 📁 Доступные квизы

| Тема | Вопросов | Уровни |
|---|:---:|---|
| Наруто | 50 | Легкий / Средний / Эксперт |
| Истребитель демонов | 50 | Легкий / Средний / Эксперт |
| Скрипка и музыка | 50 | Легкий / Средний / Эксперт |
| Бриджертоны | 30 | Легкий / Средний / Эксперт |
| Marvel | 20 | Легкий / Средний / Эксперт |
| DC Comics | 20 | Легкий / Средний / Эксперт |
| Игра в кальмара | 20 | Легкий / Средний / Эксперт |

---

## 🛠 Стек

| Слой | Инструменты |
|---|---|
| Хостинг | Cloudflare Workers |
| База данных | Firebase Firestore |
| Авторизация | Google Auth (Firebase) |
| Фронтенд | Vanilla JS ES6, CSS (glassmorphism) |
| Алгоритм повторения | Leitner System |
| Статистика | Wilson Interval readiness score |

---

## 🚀 Локальный запуск

```bash
npx http-server -p 8080 -c-1
# затем открыть http://localhost:8080
```

## ⚡ Деплой

```bash
npx wrangler deploy                          # фронтенд + вопросы → Cloudflare
firebase deploy --only firestore:rules       # правила Firestore
```
