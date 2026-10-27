-- 02-data-model §3 — conversations, messages, agent_runs, ai_calls, ai_provider_state, pending_actions, tool_calls. Do not edit after the first deploy: changes go into a new migration (02 §6).

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('client','analyst')),
  client_id        uuid REFERENCES clients(id),       -- для client
  staff_id         uuid REFERENCES staff(id),         -- для analyst (FR-ADM-10)
  channel          text NOT NULL CHECK (channel IN ('web','telegram','mini','admin')),
  lang             text NOT NULL CHECK (lang IN ('ru','uz','en')),
  mode             text NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai','human')),   -- human = позвали менеджера (S)
  state            jsonb NOT NULL DEFAULT '{}',       -- память диалога (§07.6)
  summary          text,                              -- сжатие старых сообщений
  message_count    int  NOT NULL DEFAULT 0,
  turn_lock_until  timestamptz,                       -- идёт ход агента (§07.11)
  turn_lock_id     uuid,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  last_message_at  timestamptz
);
CREATE INDEX conversations_client ON conversations (client_id, last_message_at DESC);

CREATE TABLE messages (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user','assistant','staff','note')),
  text             text NOT NULL,                     -- что видел человек
  blocks           jsonb,                             -- карточки квартир, цитаты, подсказки, ссылка на pending_action
  turn_id          uuid,
  tg_message_id    bigint,
  feedback         smallint CHECK (feedback IN (-1, 1)),   -- C: 👍/👎
  feedback_note    text,
  created_at       timestamptz NOT NULL
);
CREATE INDEX messages_conversation ON messages (conversation_id, id);

CREATE TABLE agent_runs (                             -- один запуск одного агента в одном ходе (FR-AGT-07)
  id               bigserial PRIMARY KEY,
  turn_id          uuid NOT NULL,
  conversation_id  uuid,
  agent            text NOT NULL,     -- router, apt_finder, finance, booking, kb_consultant, analyst, qualifier, composer
  role             text NOT NULL CHECK (role IN ('tools','fast')),   -- какая цепочка моделей (§06.4)
  provider         text,              -- кто в итоге ответил: gemini / anthropic / scripted
  model            text,
  fallback         boolean NOT NULL DEFAULT false,   -- ответил не первый в цепочке
  steps            int  NOT NULL DEFAULT 0,          -- шагов цикла с инструментами
  tools            text[] NOT NULL DEFAULT '{}',
  input_tokens     int  NOT NULL DEFAULT 0,
  output_tokens    int  NOT NULL DEFAULT 0,
  cached_tokens    int  NOT NULL DEFAULT 0,
  cost_usd         numeric(10,6) NOT NULL DEFAULT 0,
  ms               int,
  first_event_ms   int,                              -- для NFR-PERF-03 (D-13)
  ok               boolean NOT NULL,
  error            text,                              -- класс ошибки, без ПДн
  created_at       timestamptz NOT NULL
);
CREATE INDEX agent_runs_turn ON agent_runs (turn_id);
CREATE INDEX agent_runs_at   ON agent_runs (created_at);

CREATE TABLE ai_calls (                               -- каждый запрос к API модели (учёт лимитов и денег, NFR-COST-03)
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL,
  turn_id          uuid,
  agent            text,
  provider         text NOT NULL CHECK (provider IN ('gemini','anthropic')),
  model            text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('chat','embed')),
  ok               boolean NOT NULL,
  error_class      text,                              -- §06.8: rate_minute, rate_day, overloaded, …
  input_tokens     int NOT NULL DEFAULT 0,
  output_tokens    int NOT NULL DEFAULT 0,
  cached_tokens    int NOT NULL DEFAULT 0,
  cost_usd         numeric(10,6) NOT NULL DEFAULT 0,
  ms               int
);
CREATE INDEX ai_calls_at ON ai_calls (provider, at);

CREATE TABLE ai_provider_state (                      -- здоровье провайдеров между экземплярами функции (§06.9)
  key              text PRIMARY KEY,                  -- 'gemini', 'gemini:gemini-3.8-flash', 'anthropic'
  status           text NOT NULL CHECK (status IN ('ok','cooldown','disabled')),
  cooldown_until   timestamptz,
  reason           text,
  failures         int NOT NULL DEFAULT 0,
  last_ok_at       timestamptz,
  last_error_at    timestamptz,
  updated_at       timestamptz NOT NULL
);

CREATE TABLE pending_actions (                        -- «Подтвердите: …» (FR-AGT-03, FR-MCP-05, D-10)
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool                text NOT NULL,                  -- create_booking, book_viewing, extend_booking, …
  args                jsonb NOT NULL,                 -- проверенные аргументы
  args_hash           text NOT NULL,                  -- sha256 канонического JSON args
  preview             jsonb NOT NULL,                 -- что показали человеку дословно
  source              text NOT NULL CHECK (source IN ('agent','mcp')),
  actor               jsonb NOT NULL,
  conversation_id     uuid REFERENCES conversations(id),
  client_id           uuid REFERENCES clients(id),
  confirm_token_hash  text UNIQUE,                    -- для MCP
  status              text NOT NULL CHECK (status IN ('pending','executing','executed','expired','cancelled','failed')),   -- executing: идёт вызов ядра (§07.8.3)
  result              jsonb,
  expires_at          timestamptz NOT NULL,           -- создано + 10 минут
  created_at          timestamptz NOT NULL,
  decided_at          timestamptz
);
CREATE INDEX pending_actions_conv ON pending_actions (conversation_id, status);

CREATE TABLE tool_calls (                             -- журнал инструментов: агенты, MCP, админка (Domus mcp_calls → сюда)
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL,
  source           text NOT NULL CHECK (source IN ('agent','mcp')),
  tool             text,                              -- null = отказ до выбора инструмента (неверный токен)
  role             text,                              -- client / head (по токену или actor)
  turn_id          uuid,
  conversation_id  uuid,
  pending_action_id uuid,
  phase            text CHECK (phase IN ('preview','execute')),   -- для изменяющих
  args             jsonb,                             -- после redact: телефоны и имена маскированы
  ok               boolean NOT NULL,
  error            text,                              -- код ошибки
  ms               int,
  ip_hash          text                               -- для MCP-отказов (NFR-SEC-06)
);
CREATE INDEX tool_calls_at ON tool_calls (at);
