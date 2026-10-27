-- 02-data-model §3 — events, jobs, outbox. Do not edit after the first deploy: changes go into a new migration (02 §6).

CREATE TABLE events (                                 -- журнал событий ядра (NFR-OBS-01, FR-BKG-12)
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL,
  type           text NOT NULL,                       -- 'booking.paid', … (§04.2)
  actor          jsonb NOT NULL,
  apartment_no   int,
  booking_id     uuid,
  payment_id     uuid,
  client_id      uuid,
  viewing_id     uuid,
  order_id       uuid,
  staff_id       uuid,
  data           jsonb NOT NULL DEFAULT '{}',         -- детали без ПДн: суммы, сроки, причины
  request_id     text
);
CREATE INDEX events_at      ON events (at);
CREATE INDEX events_type_at ON events (type, at);
CREATE INDEX events_booking ON events (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX events_client  ON events (client_id)  WHERE client_id IS NOT NULL;
CREATE INDEX events_apt     ON events (apartment_no) WHERE apartment_no IS NOT NULL;

CREATE TABLE jobs (                                   -- отложенные задачи (§04.5, D-04)
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type               text NOT NULL,                   -- 'booking.expire', … (§04.6)
  run_at             timestamptz NOT NULL,
  payload            jsonb NOT NULL,
  dedupe_key         text UNIQUE,                     -- 'booking.expire:<id>:<expiresAt>'
  status             text NOT NULL CHECK (status IN ('scheduled','running','done','skipped','failed','cancelled')),
  attempts           int  NOT NULL DEFAULT 0,
  locked_until       timestamptz,                     -- защита от зависшего running
  last_error         text,
  qstash_message_id  text,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  done_at            timestamptz
);
CREATE INDEX jobs_due ON jobs (run_at) WHERE status = 'scheduled';

CREATE TABLE outbox (                                 -- все исходящие сообщения (FR-DEMO-02, NFR-OBS-04)
  id                 bigserial PRIMARY KEY,
  created_at         timestamptz NOT NULL,
  event_id           bigint REFERENCES events(id),
  channel            text NOT NULL DEFAULT 'telegram' CHECK (channel IN ('telegram')),
  audience           text NOT NULL CHECK (audience IN ('client','staff_group','staff_dm')),
  op                 text NOT NULL DEFAULT 'send' CHECK (op IN ('send','edit','send_document')),
  chat_id            bigint,                          -- null → skipped (нет Telegram)
  client_id          uuid,
  staff_id           uuid,
  template           text NOT NULL,                   -- 'booking_confirmed' (§04.4)
  lang               text NOT NULL,
  vars               jsonb NOT NULL,                  -- данные для шаблона
  rendered           jsonb,                           -- {text, parse_mode, reply_markup} — предпросмотр в админке
  edit_message_id    bigint,                          -- для op = edit («Взял Азиз»)
  attachment         jsonb,                           -- {kind:'booking_pdf', bookingId} (S)
  status             text NOT NULL CHECK (status IN ('pending','sending','sent','retry','failed','skipped','cancelled')),
  skip_reason        text,                            -- no_telegram, blocked, disabled
  attempts           int  NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz,
  last_error         text,
  sent_at            timestamptz,
  tg_message_id      bigint,
  dedupe_key         text UNIQUE                      -- 'booking_confirmed:<bookingId>' — не дублировать
);
CREATE INDEX outbox_due    ON outbox (next_attempt_at) WHERE status IN ('pending','retry');
CREATE INDEX outbox_recent ON outbox (created_at DESC);
