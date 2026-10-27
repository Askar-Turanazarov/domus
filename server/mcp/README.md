# MCP-сервер «Chinor Park»

Квартиры из `apartments.json` (корень проекта), записи на показ и журнал вызовов по MCP (Streamable HTTP):
- **на сайте** — `POST https://<адрес сайта>/mcp` (маршрут в `server.js`, работает и на Vercel; без `MCP_TOKEN` в переменных окружения — `503`);
- **отдельно, для разработки** — `http://127.0.0.1:3001/mcp` (`node server/mcp/index.js` из корня проекта).

Данные — в хранилище сайта (`server/db.js`): с `DATABASE_URL` — Postgres (записи — таблица `bookings`, журнал — `mcp_calls`), без него — файлы `booking.json` и `mcp-calls.jsonl` в корне. Статусы квартир — с учётом изменений менеджера в `/admin.html`, как на витрине.
Все цены в сумах (целые). Зависимости — в корневом `package.json` (`@modelcontextprotocol/sdk`, `zod`).

## Запуск
```bash
# из корня проекта; в .env строка MCP_TOKEN=<32–64 символа>:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node server/mcp/index.js          # MCP «Chinor Park»: http://127.0.0.1:3001/mcp
node --test "test/tools/*.test.js"
```
Без `MCP_TOKEN` (или короче 32 символов) сервер не запускается. Каждый запрос — с заголовком `Authorization: Bearer <MCP_TOKEN>`, иначе `401`.

На Vercel: переменная `MCP_TOKEN` (Production, Sensitive) и Redeploy.

## Проверка curl (из корня проекта)
```bash
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_apartments","arguments":{"rooms":2,"maxPrice":900000000}}}'
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
curl -s -w ' %{http_code}\n' "${H[@]}" -d "$BODY" http://127.0.0.1:3001/mcp                                   # 401
set -a; . ./.env; set +a
curl -s -w ' %{http_code}\n' "${H[@]}" -H "Authorization: Bearer $MCP_TOKEN" -d "$BODY" http://127.0.0.1:3001/mcp   # 200
```

## Инструменты
| Инструмент | Вход | Выход |
|---|---|---|
| `search_apartments` | `rooms` (0 — студия), `maxPrice` (сум), `minArea` (м²), `floor`, `status` (`free` по умолчанию / `booked` / `sold` / `any`), `limit` (20) | `{ total, apartments: [{ no, floor, rooms, area, price, status }] }`, сначала дешёвые |
| `get_apartment` | `no` — номер квартиры | `{ no, floor, rooms, area, price, status, pricePerM2 }` |
| `calc_mortgage` | одно из: `loan` (сумма кредита), `price` + `downPct` 0–90, `no`; `years` 1–30, `rate` 0–60 % годовых | `{ price, down, loan, months, monthly, total, overpay }`, целые сумы |
| `book_viewing` | `name`, `phone` (+998 90 123 45 67), `datetime` (`2026-10-25T15:00`, Ташкент, до минуты, в будущем), `no` | `{ id, no, name, phone, datetime, createdAt }` → хранилище записей |

`calc_mortgage` — аннуитет с месячной ставкой: `i = rate / 12 / 100`, `n = years · 12`, платёж `loan · i / (1 − (1 + i)^−n)`; общая сумма = точный платёж · n, переплата = общая сумма − кредит, всё округляется до сума в конце. Пример: кредит 80 000 000 сум, 24 %, 10 лет → 1 763 848 сум в месяц, всего 211 661 730, переплата 131 661 730.

`book_viewing` проверяет, что квартира существует и не продана и что на это же время на эту квартиру нет другой записи; статус квартиры не меняет. Ошибки — понятным текстом.

## Заявки на показ на сайте
Страница менеджера `/bookings.html` (вход по паролю менеджера, как `/admin.html`) читает записи через `GET /api/bookings` и обновляет таблицу каждые 3 секунды без перезагрузки. Записей нет — «Заявок пока нет».

## Журнал вызовов
Каждый вызов инструмента и каждый отказ 401 попадает в журнал (одна запись: время, инструмент, ок/ошибка, мс, параметры, первая строка ответа); хранятся последние 1000.
Имени, телефона и токена в журнале нет: у `book_viewing` пишутся только номер квартиры и время, у вызовов с неверными параметрами — только названия полей.
Неизвестные параметры (например `max_price` вместо `maxPrice`) — ошибка, а не молча отброшенный фильтр.
Страница менеджера `/calls.html` (вход по паролю менеджера) показывает журнал, обновляясь каждые 3 секунды; субагент определяется по инструменту:
`search_apartments`, `get_apartment` → `apt_finder`; `calc_mortgage` → `mortgage_consultant`; `book_viewing` → `booking_manager`.

## Claude Code
`.mcp.json` в корне проекта (в git не попадает):
```json
{ "mcpServers": { "chinor-park": { "type": "http", "url": "https://<адрес сайта>/mcp",
  "headers": { "Authorization": "Bearer <тот же MCP_TOKEN, что в .env>" } } } }
```

Для разработки с отдельным сервером — `"url": "http://localhost:3001/mcp"`.
