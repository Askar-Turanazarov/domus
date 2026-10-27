-- 02-data-model §3 — payments, refunds, payment_challenges, provider_events. Do not edit after the first deploy: changes go into a new migration (02 §6).

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE,         -- 'P-7F3A' — для людей и для Click merchant_trans_id
  kind                text NOT NULL CHECK (kind IN ('deposit','furniture_prepay','custom')),
  booking_id          uuid REFERENCES bookings(id), -- для deposit обязателен
  order_id            uuid REFERENCES orders(id),   -- для furniture_prepay обязателен
  client_id           uuid NOT NULL REFERENCES clients(id),
  provider            text NOT NULL CHECK (provider IN ('card','click','stripe')),
  amount              bigint NOT NULL CHECK (amount > 0),   -- сум
  currency            text NOT NULL DEFAULT 'UZS',          -- валюта у провайдера (D-05)
  provider_amount     bigint,                               -- сумма в единицах провайдера (Stripe: ×100)
  status              text NOT NULL CHECK (status IN
                        ('pending','processing','succeeded','failed','cancelled','refund_due','refunded')),
  failure_reason      text,                         -- ключ причины (§05.9)
  provider_ref        text,                         -- Stripe Checkout Session id / click_trans_id / id эмулятора
  provider_payment_ref text,                        -- Stripe PaymentIntent id
  click_prepare_id    bigint UNIQUE,                -- merchant_prepare_id (целое, протокол Click)
  card_brand          text,                         -- HUMO, UZCARD, VISA, MASTERCARD
  card_mask           text,                         -- '9860 •••• 0001'
  expires_at          timestamptz,                  -- до когда можно оплатить (= конец удержания)
  succeeded_at        timestamptz,
  created_by          jsonb NOT NULL,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  version             int NOT NULL DEFAULT 1,
  CHECK (kind <> 'deposit' OR booking_id IS NOT NULL),
  CHECK (kind <> 'furniture_prepay' OR order_id IS NOT NULL)
);
-- повтор уведомления провайдера не создаёт второй платёж (FR-PAY-05)
CREATE UNIQUE INDEX payments_provider_ref ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
-- у брони не больше одного зачтённого депозита (NFR-REL-01)
CREATE UNIQUE INDEX payments_one_deposit ON payments (booking_id) WHERE kind = 'deposit' AND status = 'succeeded';
-- не больше одного открытого платежа на бронь и на заказ (§05.2.2, P2)
CREATE UNIQUE INDEX payments_one_open_booking ON payments (booking_id) WHERE status IN ('pending','processing') AND booking_id IS NOT NULL;
CREATE UNIQUE INDEX payments_one_open_order   ON payments (order_id)   WHERE status IN ('pending','processing') AND order_id IS NOT NULL;
-- merchant_prepare_id для Click — целое по протоколу (§05.5.6)
CREATE SEQUENCE click_prepare_seq START 1;
CREATE INDEX payments_booking ON payments (booking_id);
CREATE INDEX payments_status  ON payments (status, created_at);
CREATE INDEX payments_client  ON payments (client_id);

CREATE TABLE refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     uuid NOT NULL REFERENCES payments(id),
  amount         bigint NOT NULL CHECK (amount > 0),
  reason         text NOT NULL CHECK (reason IN ('developer_cancel','late_payment','duplicate_payment','manual')),
  note           text,                              -- обязательна для manual (BR-11)
  status         text NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  provider_ref   text,                              -- Stripe Refund id
  failure        text,
  requested_by   jsonb NOT NULL,                    -- actor (system для авто)
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  completed_at   timestamptz
);
-- один активный или успешный возврат на платёж
CREATE UNIQUE INDEX refunds_one_per_payment ON refunds (payment_id) WHERE status IN ('pending','succeeded');

CREATE TABLE payment_challenges (               -- SMS-код эмуляторов карты и Click
  payment_id     uuid PRIMARY KEY REFERENCES payments(id),
  code_hash      text NOT NULL,                   -- sha256(code + payment_id)
  attempts       int  NOT NULL DEFAULT 0,         -- максимум 3
  scenario       text NOT NULL CHECK (scenario IN ('success','bank_declined','insufficient_funds')),
  card_brand     text NOT NULL,
  card_mask      text NOT NULL,
  expires_at     timestamptz NOT NULL,            -- код живёт 5 минут, но не дольше удержания
  created_at     timestamptz NOT NULL
);

CREATE TABLE provider_events (                  -- дедупликация входящих уведомлений
  provider       text NOT NULL,                   -- stripe, click
  event_id       text NOT NULL,                   -- Stripe: evt_…; Click: '<click_trans_id>:<action>'
  type           text NOT NULL,
  payment_id     uuid,
  result         text,                            -- что сделали: applied, ignored_duplicate, late, …
  received_at    timestamptz NOT NULL,
  PRIMARY KEY (provider, event_id)
);
