-- 02-data-model §3 — telegram_updates, rate_limits, idempotency_keys, client_link_codes, analytics_visits. Do not edit after the first deploy: changes go into a new migration (02 §6).

CREATE TABLE telegram_updates (            -- повтор вебхука Telegram не обрабатывается дважды
  update_id    bigint PRIMARY KEY,
  kind         text NOT NULL,              -- message, callback_query, my_chat_member, …
  received_at  timestamptz NOT NULL,
  done_at      timestamptz,
  error        text
);

CREATE TABLE rate_limits (                 -- лимиты с фиксированным окном (NFR-SEC-04, §14.5)
  key           text NOT NULL,             -- 'chat:client:<id>', 'hold:ip:<hash>', …
  window_start  timestamptz NOT NULL,
  count         int NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE idempotency_keys (            -- повтор POST с тем же Idempotency-Key возвращает тот же ответ
  scope         text NOT NULL,             -- 'hold', 'payment.start', 'admin.extend', …
  key           text NOT NULL,
  request_hash  text NOT NULL,             -- тот же ключ с другим телом → 409
  status        int,
  response      jsonb,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE client_link_codes (           -- привязка Telegram к клиенту сайта: t.me/<bot>?start=lk_<code> (§03.9)
  code_hash   text PRIMARY KEY,            -- sha256(code)
  client_id   uuid NOT NULL REFERENCES clients(id),
  booking_id  uuid REFERENCES bookings(id),
  expires_at  timestamptz NOT NULL,        -- 7 суток
  used_at     timestamptz
);

CREATE TABLE analytics_visits (            -- посетители витрины для воронки (FR-DSH-03)
  day           date NOT NULL,             -- день по Ташкенту
  visitor_hash  text NOT NULL,             -- sha256(dvid + соль дня) — без IP и cookie в открытом виде
  channel       text NOT NULL CHECK (channel IN ('web','mini')),
  first_at      timestamptz NOT NULL,
  PRIMARY KEY (day, visitor_hash)
);
