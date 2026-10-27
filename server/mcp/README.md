# MCP-сервер «chinor-park»

Те же инструменты, что у ИИ-агентов сайта (`server/tools/`), для внешних клиентов — Claude Desktop (SPEC 08 §7). Транспорт — Streamable HTTP, без сессий, ответы обычным JSON:
- **на сайте** — `POST https://<адрес сайта>/mcp` (маршрут в `server.js`, работает и на Vercel);
- **отдельно, для разработки** — `http://127.0.0.1:3001/mcp` (`node server/mcp/index.js`, порт — `MCP_PORT`).

Данные — в базе сайта: с `DATABASE_URL` — Neon, без него — PGlite в `.pglite/`. Все суммы — целые сумы.

## Два токена — две роли
| Переменная | Кто | Что видит |
|---|---|---|
| `MCP_CLIENT_TOKEN` | демо-клиент (D-24): `MCP_CLIENT_ID` — его запись в `clients` | `search_apartments`, `get_apartment`, `calc_mortgage`, `calc_installment`, `compare_finance`, `search_kb`, `my_bookings`, `book_viewing`, `create_booking`, `request_extension` |
| `MCP_HEAD_TOKEN` | руководитель, без id | читающие клиентские + `list_bookings`, `sales_summary`, `list_payments`, `list_viewings`, `extend_booking`, `cancel_booking` |

Токены — от 32 символов и разные; иначе роль выключена. Нет ни одного — `503 mcp_disabled`. Нет заголовка `Authorization: Bearer …` или токен неверный — `401` и строка в `tool_calls` (без инструмента, с хэшем адреса). Лимиты: 60 вызовов в минуту на токен, 20 неудачных попыток в минуту на адрес — потом `429` с `Retry-After`.

Демо-клиент создаётся один раз на каждую базу (локальную и Neon):
```bash
npm run mcp:client                         # локальная база
node --env-file=.env.neon scripts/mcp-client.js --yes    # Neon
```
Скрипт печатает `MCP_CLIENT_ID=…` — строку нужно вписать в `.env` (и в переменные Vercel).

## Подтверждение изменений
Меняющие инструменты (`extend_booking`, `cancel_booking`, `create_booking`, `book_viewing`, `request_extension`) работают в два шага:
1. Первый вызов ничего не меняет и возвращает черновик: `{ needsConfirmation, confirmToken, preview, expiresAt }`.
2. Клиент показывает условия человеку; после явного «да» повторяет вызов с теми же аргументами и `confirmToken`. Токен привязан к аргументам, одноразовый, живёт 10 минут (в базе — только его хэш).

События от таких действий пишутся с каналом `mcp` («через Claude Desktop»).

## Журнал
Каждый вызов — строка в `tool_calls` (источник `mcp`, роль, фаза preview/execute, мс). Токенов доступа и подтверждения, полных телефонов и имён там нет.

## Запуск и проверка
```bash
npm test                       # все тесты
node --test "test/mcp/*.test.js"
node server/mcp/index.js       # http://127.0.0.1:3001/mcp
```
Сгенерировать токен: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Claude Desktop
Через `mcp-remote` (SPEC 08 §8): Claude Desktop → Settings → Developer → Edit Config → `claude_desktop_config.json`:
```json
{ "mcpServers": { "chinor-park": { "command": "npx",
  "args": ["-y", "mcp-remote@<версия>", "https://<домен>/mcp", "--header", "Authorization:${CHINOR_AUTH}"],
  "env": { "CHINOR_AUTH": "Bearer <токен руководителя>" } } } }
```
Для роли клиента — тот же блок с токеном клиента (имя сервера, например, `chinor-park-client`). Токен в README и на скриншоты не попадает.
