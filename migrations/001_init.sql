-- 初始表结构。所有表放在独立的 topup schema 中：
-- Supabase 默认只通过 HTTP 接口（PostgREST）暴露 public schema，业务表不放在 public 可避免卡密等数据被外部读取。
-- 时间戳统一为毫秒（BIGINT），金额统一为「分」（INTEGER）。

CREATE TABLE plans (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  price_cents  INTEGER NOT NULL CHECK (price_cents > 0),
  sort         INTEGER NOT NULL DEFAULT 0,
  active       SMALLINT NOT NULL DEFAULT 1,
  created_at   BIGINT  NOT NULL
);

-- 卡密状态见 src/types.ts CardStatus
CREATE TABLE card_keys (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id      BIGINT  NOT NULL REFERENCES plans(id),
  code         TEXT    NOT NULL UNIQUE,
  status       TEXT    NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'LOCKED', 'USED', 'INVALID')),
  order_id     BIGINT,
  note         TEXT    NOT NULL DEFAULT '',
  created_at   BIGINT  NOT NULL,
  locked_at    BIGINT,
  used_at      BIGINT
);
CREATE INDEX idx_card_plan_status ON card_keys(plan_id, status);

-- 订单状态见 src/types.ts OrderStatus
CREATE TABLE orders (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no          TEXT    NOT NULL UNIQUE,
  access_key        TEXT    NOT NULL,
  plan_id           BIGINT  NOT NULL REFERENCES plans(id),
  plan_name         TEXT    NOT NULL,
  amount_cents      INTEGER NOT NULL,
  pay_channel       TEXT    NOT NULL,
  pay_qr            TEXT,
  pay_trade_no      TEXT,
  status            TEXT    NOT NULL CHECK (status IN (
                      'PENDING_PAYMENT', 'PAID', 'QUEUED', 'REDEEMING', 'SUCCESS',
                      'FAILED', 'EXPIRED', 'MANUAL_REVIEW', 'REFUNDED')),
  token_enc         TEXT,
  token_mask        TEXT,
  account_email     TEXT    NOT NULL DEFAULT '',
  card_id           BIGINT  REFERENCES card_keys(id),
  upstream_task_id  TEXT,
  token_attempts    INTEGER NOT NULL DEFAULT 0,
  submit_attempts   INTEGER NOT NULL DEFAULT 0,
  card_switches     INTEGER NOT NULL DEFAULT 0,
  query_attempts    INTEGER NOT NULL DEFAULT 0,
  next_run_at       BIGINT,
  message           TEXT    NOT NULL DEFAULT '',
  client_ip         TEXT    NOT NULL DEFAULT '',
  created_at        BIGINT  NOT NULL,
  expire_at         BIGINT  NOT NULL,
  paid_at           BIGINT,
  token_at          BIGINT,
  finished_at       BIGINT,
  updated_at        BIGINT  NOT NULL
);
ALTER TABLE card_keys ADD CONSTRAINT fk_card_order FOREIGN KEY (order_id) REFERENCES orders(id);
CREATE INDEX idx_orders_status_next ON orders(status, next_run_at);
CREATE INDEX idx_orders_ip_status ON orders(client_ip, status);
CREATE INDEX idx_orders_plan_status ON orders(plan_id, status);

CREATE TABLE order_logs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id),
  event      TEXT   NOT NULL,
  detail     TEXT   NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_order_logs_order ON order_logs(order_id);

-- 纵深防御：开启行级安全且不建任何放行策略 —— 即使 schema 被误暴露，anon / authenticated 也读不到任何行。
-- 服务端以表所有者身份连接，不受 RLS 限制。
ALTER TABLE plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_keys  ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_logs ENABLE ROW LEVEL SECURITY;

-- Supabase 内置角色存在时，撤销其对本 schema 的一切权限（普通 PostgreSQL 没有这些角色，跳过）
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', current_schema(), r);
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', current_schema(), r);
    END IF;
  END LOOP;
END $$;
