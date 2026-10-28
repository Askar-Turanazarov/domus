# Ревью безопасности (14 §14, DoD-8) — 28.10.2026

Кто: Claude (Opus 5.5), ручной проход по коду репозитория `domus/` (ветка `main`) против 14 §2–§13 и чек-листа 14 §14.
Агент `security-reviewer` из Domus и `/security-review` по ветке **не запускались** — по плану это 30.10 (14 §14), можно отдельной сессией.

**Итог: критичных (critical) и высоких (high) находок нет.** Две средние — отклонения от 14 §7 (заголовки), решение за автором. Три мелкие исправлены в этом же проходе.

## Находки

| # | Уровень | Что | Где | Статус |
|---|---|---|---|---|
| S1 | medium | Не было CSP (14 §7). Встроенные `<script>` темы, флага входа, `preload3d` и `print.html` мешали строгой CSP. Обработчиков `on*=` в HTML на самом деле нет: в первом проходе grep ошибочно совпал с `content="` | `server/http/securityHeaders.js`, `vercel.json` | **Исправлено** (`16db498`): CSP по 14 §7 без `unsafe-inline`/`unsafe-eval` для скриптов. Добавлены Google Fonts (`style-src`/`font-src`) и importmap three по `sha256` (файлом её не подключить). `/mini` — `telegram.org` в `script-src` и `frame-ancestors`. Скрипты вынесены в `/js/theme-boot.js`, `adm-boot.js`, `preload3d.js` (генерирует `npm run preload`), `print.js`. Тест: нет встроенных скриптов, хеш совпадает, `vercel.json` = сервер. Витрина, планировщик (2D/3D), прогулка, iframe 3D, `/mini`, админка, дашборд, оплата, печать проверены в браузере |
| S2 | medium | `X-Frame-Options: SAMEORIGIN` вместо `DENY` (14 §7). Самой витрине нужен iframe 3D (`building.html`), а в Telegram Web внутри `/mini` блокировались `/b/`, `/pay/` и 3D | `server/http/securityHeaders.js`, `vercel.json` | **Исправлено** (`16db498`, решение автора 28.10 — «по страницам»). Служебные страницы и API (`/admin*`, `/dashboard*`, `admin.html`, `bookings.html`, `calls.html`, `/api/*`): `DENY` + `frame-ancestors 'none'`. Публичные: `frame-ancestors 'self' https://web.telegram.org https://*.telegram.org`, `SAMEORIGIN` оставлен для старых браузеров (новые при `frame-ancestors` его не смотрят). `/mini` — как было. Проверено в браузере: 3D и `/b/` во фрейме открываются, `/admin/` и `/dashboard/` — нет |
| S3 | low | Не было `Permissions-Policy` и `Cross-Origin-Opener-Policy` (14 §7). HSTS даёт сама Vercel на `*.vercel.app` [проверить заголовком на продакшене] | `server/http/securityHeaders.js` | **Исправлено** вместе с S1: `camera=(), microphone=(), geolocation=(), payment=()`; COOP `same-origin` везде, кроме `/b/` и `/pay/` (оттуда переход на Stripe) |
| S4 | low | `CRON_SECRET` сравнивался обычным `===` (14 §8 — постоянное время) | `server/events/runner.js` `cronAllowed` | **Исправлено**: `secretOk` (sha256 + `timingSafeEqual`), как у вебхука Telegram |
| S5 | low | Не было `robots.txt` (14 §7: `Disallow: /b/ /o/ /pay/ /mini /admin /dashboard /api/`). Личные страницы и так отдают `X-Robots-Tag: noindex` | `public/robots.txt` | **Исправлено** |
| S6 | low | `POST /api/bookings/hold` не проверял `Origin` (14 §15: чужой `Origin` → `403`). Фактически браузер и так не пропускал: обязательный `Idempotency-Key` + `application/json` требуют CORS-preflight, а CORS-заголовков нет | `server/http/bookings.js` | **Исправлено**: `foreignOrigin` вынесен в `common.js` (общий с админкой), тест в `test/api/journey.test.js` |
| S7 | low | `npm audit --omit=dev`: 1 moderate — `qs` (DoS в `qs.stringify` с `arrayFormat: 'comma'`; приложение так `qs` не вызывает, Express использует только разбор). high/critical — 0 (14 §13 требует исправлять только их) | `package-lock.json` | Открыто: `npm audit fix` — по решению автора (меняет lock-файл) |
| S9 | low | `ADMIN_TOKEN` (Bearer) ещё открывает старые маршруты Domus `/api/orders`, `/api/calls`… (вопрос из D4-01). Сравнение в постоянное время, короче 16 знаков или `change-me…` — выключен. Не задан в Vercel → путь Bearer закрыт, остаётся только вход сотрудника | `server.js` `bearerOk` | Оставлен; рекомендация — **не задавать** `ADMIN_TOKEN` на продакшене, убрать вместе с переносом маршрутов под `/api/admin/*` (13 §11) |
| S8 | info | `gitleaks` не установлен (системный инструмент — только с разрешения автора). Вместо него — поиск по всем файлам репозитория шаблонов ключей (`sk_live_/sk_test_`, `AIza…`, `ghp_…`, `sk-ant-…`, `whsec_…`, токен бота, `postgres://user:pass@`) и по именам файлов во всей истории git (`.env`, `.mcp.json`): найдены только поддельные строки в тестах; в истории — только `.env.example` без значений | — | Чисто; `npx gitleaks detect` — в чек-листе 16 §8 перед пушем |

## Что проверено и в порядке

- **Вход и сессии (§2):** scrypt, cookie `HttpOnly; SameSite=Strict; Secure` (`server/adminAuth.js:76`), `SESSION_SECRET` < 32 знаков → `503 feature_disabled`; изменяющие запросы админки — `X-Requested-With` + свой `Origin` (`server/http/admin.js`), тесты `test/adminLogin.test.js`.
- **Права (§3):** `test/security/rights.test.js` — все маршруты из `test/routes.json` с меткой доступа; без учётных данных → 401/403; analyst только читает; manager на Head → 403.
- **Ссылки (§4):** HMAC-подпись личных ссылок, `timingSafeEqual`, `404 link_invalid` без подсказок (`server/core/links.js`, `server/http/bookings.js`).
- **Лимиты (§5):** удержания по IP / телефону / клиенту, чат, эмулятор карты, мини-апп (`hold:ip`, `hold:client`) — тесты на управляемых часах.
- **Подписи (§8):** Stripe (сырое тело), Click (md5 + сверка суммы), QStash (`Receiver.verify`), Telegram вебхук (секрет в постоянное время), мини-апп (`initData` HMAC, `auth_date` ≤ 24 ч, кэш с повторной сверкой — `server/telegram/initData.js`), Cron (после S4).
- **Секреты (§9):** `.env*` в `.gitignore`, `.env.example` без значений; `LINK_SECRET` обязателен на продакшене; MCP-токены ≥ 32 знаков, `timingSafeEqual` (`server/mcp/index.js`).
- **SQL:** все значения — параметрами `$n`; в строку SQL подставляются только константы и собранные кодом условия.
- **ИИ (§11):** права в коде, изменяющие инструменты — только черновик «Подтвердите» (один на ход); injection-маршрут — шаблон без инструментов. Контрольный набор `eval:agents` (D4-13): 3 из 3 injection без вызовов и черновиков.
- **XSS:** см. S1 — модельный текст не идёт в `innerHTML`.

## Вопросы автору (в `handoff.md`)

1. ~~**S1 CSP:**~~ решено автором 28.10 — вариант «настоящая CSP», сделано в `16db498`. Было: делать ли до защиты? Нужно вынести 2 строки темы из `<head>` в файл и снять `on*=` с HTML Domus — это правка многих страниц витрины/планировщика (≈ 1–2 ч + проверка в браузере). Без этого CSP можно включить только в режиме `Report-Only`.
2. ~~**S2 XFO:**~~ решено автором 28.10 — «по страницам», `16db498`. Было: оставить `SAMEORIGIN` (нужен iframe 3D) или заменить на CSP `frame-ancestors 'self' https://web.telegram.org https://*.telegram.org` для всех страниц — тогда Telegram Web сможет открывать `/b/`, `/pay/` и 3D внутри мини-аппа.
3. **S7:** запускать ли `npm audit fix`.

Открыто после S1: `report-uri /api/client-errors` из 14 §7 не подключён, такого маршрута в проекте нет (нарушения CSP пока видны только в консоли браузера). S2 решён (`16db498`).
