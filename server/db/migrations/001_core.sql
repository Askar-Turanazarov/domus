-- 02-data-model §3 — schema_migrations, staff, settings, apartments, clients, bookings, viewings, orders, order_files. Do not edit after the first deploy: changes go into a new migration (02 §6).

CREATE TABLE schema_migrations (
  version     text PRIMARY KEY,            -- '001_init', '002_kb', ...
  applied_at  timestamptz NOT NULL
);

CREATE TABLE staff (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login                 text NOT NULL UNIQUE CHECK (login = lower(login)),
  name                  text NOT NULL,              -- в группе: «Взял Азиз»
  role                  text NOT NULL CHECK (role IN ('manager','head')),
  password_hash         text NOT NULL,              -- scrypt, формат как в Domus adminAuth
  session_version       int  NOT NULL DEFAULT 1,    -- +1 = все сессии сотрудника недействительны
  telegram_user_id      bigint UNIQUE,              -- привязка для «Беру клиента» (FR-ADM-11)
  telegram_username     text,
  tg_link_code_hash     text,                       -- одноразовый код привязки, sha256
  tg_link_expires_at    timestamptz,
  lang                  text NOT NULL DEFAULT 'ru' CHECK (lang IN ('ru','uz','en')),
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL,
  last_login_at         timestamptz
);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL,
  updated_by  uuid REFERENCES staff(id)    -- null = сид / система
);

CREATE TABLE apartments (
  no               int  PRIMARY KEY,                -- номер квартиры из Domus, 1…92
  building         text NOT NULL DEFAULT 'chinor-park',
  floor            int  NOT NULL CHECK (floor BETWEEN 1 AND 60),
  rooms            int  NOT NULL CHECK (rooms BETWEEN 0 AND 6),   -- 0 = студия
  area             numeric(6,1) NOT NULL CHECK (area > 0),        -- м²
  price            bigint NOT NULL CHECK (price > 0),             -- сум
  sold_at          timestamptz,                     -- not null = продана
  sold_booking_id  uuid,                            -- бронь, которая стала продажей (FK ниже)
  sold_by          jsonb,                           -- actor
  sold_note        text,
  updated_at       timestamptz NOT NULL,
  version          int NOT NULL DEFAULT 1
);
CREATE INDEX apartments_search ON apartments (rooms, floor, price);

CREATE TABLE clients (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text,                         -- как представился (≤ 100)
  phone                 text,                         -- E.164
  phone_verified        boolean NOT NULL DEFAULT false, -- true = поделился контактом в Telegram
  telegram_user_id      bigint UNIQUE,
  telegram_username     text,
  telegram_chat_id      bigint,                       -- личный чат с ботом; null = боту не писал
  tg_blocked_at         timestamptz,                  -- бот заблокирован (ответ 403) — не слать
  lang                  text NOT NULL DEFAULT 'ru' CHECK (lang IN ('ru','uz','en')),
  channels              text[] NOT NULL DEFAULT '{}', -- web, telegram, mini, admin, mcp
  first_channel         text NOT NULL,
  visitor_id            text,                         -- id посетителя сайта (cookie dvid), для воронки
  assigned_staff_id     uuid REFERENCES staff(id),    -- «Беру клиента» (BR-20)
  assigned_at           timestamptz,
  lead_score            text CHECK (lead_score IN ('hot','warm','cold')),   -- S
  lead_summary          text,                                               -- S
  lead_next_step        text,                                               -- S
  lead_scored_at        timestamptz,
  lead_scored_message_id bigint,                      -- последнее учтённое сообщение (кеш NFR-COST-04)
  merged_into           uuid REFERENCES clients(id),  -- карточка склеена в другую
  possible_duplicate_of uuid REFERENCES clients(id),  -- подсказка менеджеру, без склейки
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  last_seen_at          timestamptz
);
CREATE UNIQUE INDEX clients_verified_phone ON clients (phone)
  WHERE phone_verified AND merged_into IS NULL;      -- один подтверждённый владелец номера
CREATE INDEX clients_phone    ON clients (phone) WHERE merged_into IS NULL;
CREATE INDEX clients_assigned ON clients (assigned_staff_id) WHERE merged_into IS NULL;
CREATE INDEX clients_visitor  ON clients (visitor_id);

CREATE SEQUENCE booking_no_seq START 1001;

CREATE TABLE bookings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no                 int  NOT NULL UNIQUE DEFAULT nextval('booking_no_seq'),   -- «Бронь №1042»
  apartment_no       int  NOT NULL REFERENCES apartments(no),
  client_id          uuid NOT NULL REFERENCES clients(id),
  status             text NOT NULL CHECK (status IN
                       ('held','booked','hold_expired','released','expired','cancelled','converted')),
  channel            text NOT NULL,            -- где начато: web, mini, telegram, admin, mcp
  created_by         jsonb NOT NULL,           -- actor
  expires_at         timestamptz NOT NULL,     -- ТЕКУЩИЙ срок: конец удержания или конец брони
  held_at            timestamptz NOT NULL,
  booked_at          timestamptz,              -- момент оплаты
  closed_at          timestamptz,              -- переход в конечный статус
  deposit_amount     bigint NOT NULL,          -- снимок BR-03 на момент удержания
  price_at_booking   bigint NOT NULL,          -- снимок цены квартиры
  consent_version    text,                     -- версия оферты (FR-BKG-13); null = ещё не согласился (§03.4)
  consent_at         timestamptz,
  access_version     int  NOT NULL DEFAULT 1,  -- версия личной ссылки /b/<no>-<sig>; +1 = старая ссылка не работает (§03.14)
  cancel_initiator   text CHECK (cancel_initiator IN ('client','developer')),
  cancel_reason      text,                     -- текст причины (FR-BKG-08)
  extended_count     int  NOT NULL DEFAULT 0,
  version            int  NOT NULL DEFAULT 1,  -- защита от действий по устаревшему экрану
  updated_at         timestamptz NOT NULL,
  CHECK (status NOT IN ('booked','expired','converted') OR booked_at IS NOT NULL),
  CHECK (cancel_initiator IS NULL OR status = 'cancelled')   -- отменить можно и удержание (§03.7)
);

-- ГЛАВНАЯ ГАРАНТИЯ FR-BKG-03: не больше одной активной записи на квартиру
CREATE UNIQUE INDEX bookings_one_active ON bookings (apartment_no)
  WHERE status IN ('held','booked');

CREATE INDEX bookings_client   ON bookings (client_id, status);
CREATE INDEX bookings_due      ON bookings (expires_at) WHERE status IN ('held','booked');
CREATE INDEX bookings_closed   ON bookings (closed_at)  WHERE closed_at IS NOT NULL;

ALTER TABLE apartments ADD CONSTRAINT apartments_sold_booking_fk
  FOREIGN KEY (sold_booking_id) REFERENCES bookings(id);

CREATE TABLE viewings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apartment_no  int  NOT NULL REFERENCES apartments(no),
  client_id     uuid NOT NULL REFERENCES clients(id),
  at            timestamptz NOT NULL,             -- начало показа (Ташкент в интерфейсе)
  name          text NOT NULL,                    -- как в Domus: имя и телефон при записи
  phone         text NOT NULL,
  status        text NOT NULL CHECK (status IN ('scheduled','done','no_show','cancelled')),
  channel       text NOT NULL,
  created_by    jsonb NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
-- как в Domus: одна запись на квартиру и минуту, решает база (в том числе между параллельными функциями)
CREATE UNIQUE INDEX viewings_slot ON viewings (apartment_no, at) WHERE status = 'scheduled';
CREATE INDEX viewings_at ON viewings (at) WHERE status = 'scheduled';

CREATE SEQUENCE order_no_seq START 501;

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no              int  NOT NULL UNIQUE DEFAULT nextval('order_no_seq'),   -- «Заказ №512»
  kind            text NOT NULL CHECK (kind IN ('furniture','apartment_request')),
  client_id       uuid NOT NULL REFERENCES clients(id),
  booking_id      uuid REFERENCES bookings(id),   -- мебель к брони (FR-FURN-01)
  apartment_no    int  REFERENCES apartments(no),
  stage           text NOT NULL CHECK (stage IN
                    ('new','accepted','production','delivery','assembly','done','in_work','cancelled')),
  estimate        bigint,                          -- итог планировщика, сум
  prepay_amount   bigint,                          -- BR-21: round(estimate × pct / 100), кратно 1000
  prepaid_at      timestamptz,
  consent_version text,                            -- галочка оферты перед предоплатой
  doc             jsonb NOT NULL,                  -- документ заявки Domus (комнаты, мебель, комментарий), без имени и телефона
  ip_hash         text,
  lang            text NOT NULL DEFAULT 'ru',
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  version         int NOT NULL DEFAULT 1
);
CREATE INDEX orders_ip_time ON orders (ip_hash, created_at);   -- лимит заявок с IP, как в Domus
CREATE INDEX orders_client  ON orders (client_id);

CREATE TABLE order_files (
  order_id  uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name      text NOT NULL,                         -- plan.png, 3d.jpg
  data      bytea NOT NULL,
  PRIMARY KEY (order_id, name)
);
