-- Schema-v3 fixture from the 2.4.1 migrations, with receipt, event, payment
-- attempt and history rows. Keep it as SQL so migration edits cannot change
-- the database used to test upgrades.

CREATE TABLE receipts (
          seq             INTEGER PRIMARY KEY AUTOINCREMENT,
          id              TEXT NOT NULL UNIQUE,
          request_id      TEXT NOT NULL,
          resource_id     TEXT NOT NULL,
          payment_json    TEXT,
          delivered_at    TEXT NOT NULL,
          backend_status  INTEGER NOT NULL,
          duration_ms     INTEGER,
          protocol        TEXT,
          metadata_json   TEXT
        , authorization_json TEXT);
CREATE INDEX idx_receipts_request_id ON receipts(request_id);
CREATE INDEX idx_receipts_delivered_at ON receipts(delivered_at);
CREATE TABLE events (
          seq               INTEGER PRIMARY KEY AUTOINCREMENT,
          id                TEXT NOT NULL UNIQUE,
          type              TEXT NOT NULL,
          request_id        TEXT NOT NULL,
          resource_id       TEXT,
          at                TEXT NOT NULL,
          adapter           TEXT,
          payment_provider  TEXT,
          duration_ms       INTEGER,
          status            TEXT,
          data_json         TEXT
        );
CREATE INDEX idx_events_request_id ON events(request_id);
CREATE INDEX idx_events_at ON events(at);
CREATE TABLE payment_attempts (
          seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
          id                  TEXT NOT NULL UNIQUE,
          request_id          TEXT NOT NULL,
          resource_id         TEXT NOT NULL,
          provider             TEXT NOT NULL,
          replay_key          TEXT NOT NULL UNIQUE,
          status              TEXT NOT NULL,
          amount              TEXT NOT NULL,
          currency            TEXT NOT NULL,
          payer               TEXT,
          payee               TEXT,
          external_reference  TEXT,
          rejection_reason    TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        );
CREATE INDEX idx_payment_attempts_request_id ON payment_attempts(request_id);
CREATE INDEX idx_payment_attempts_created_at ON payment_attempts(created_at);
CREATE TABLE payment_attempt_history (
          seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
          id                  TEXT NOT NULL,
          request_id          TEXT NOT NULL,
          resource_id         TEXT NOT NULL,
          provider            TEXT NOT NULL,
          replay_key          TEXT NOT NULL,
          status              TEXT NOT NULL,
          amount              TEXT NOT NULL,
          currency            TEXT NOT NULL,
          payer               TEXT,
          payee               TEXT,
          external_reference  TEXT,
          rejection_reason    TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          superseded_at       TEXT NOT NULL
        );
CREATE INDEX idx_payment_attempt_history_replay_key ON payment_attempt_history(replay_key);
CREATE INDEX idx_payment_attempt_history_request_id ON payment_attempt_history(request_id);

INSERT INTO receipts (id, request_id, resource_id, payment_json, delivered_at, backend_status, duration_ms, protocol, metadata_json, authorization_json) VALUES
  ('receipt_paid', 'req_paid', 'resource.report', '{"status":"settled","provider":"x402","amount":"0.01","currency":"USDC","externalReference":"0xsettled","network":"eip155:31337"}', '2026-10-01T10:00:00.000Z', 200, 12, 'mcp', '{"adapter":"mcp"}', '{"method":"ap2","reference":"sha256:mandate"}'),
  ('receipt_failed', 'req_failed', 'resource.report', NULL, '2026-10-01T11:00:00.000Z', 502, NULL, NULL, NULL, NULL);

INSERT INTO events (id, type, request_id, resource_id, at, adapter, payment_provider, duration_ms, status, data_json) VALUES
  ('event_requested', 'resource.requested', 'req_paid', NULL, '2026-10-01T09:59:00.000Z', NULL, NULL, NULL, NULL, NULL),
  ('event_settled', 'payment.settled', 'req_paid', 'resource.report', '2026-10-01T10:00:00.000Z', 'mcp', 'x402', 5, 'ok', '{"externalReference":"0xsettled"}');

INSERT INTO payment_attempts (id, request_id, resource_id, provider, replay_key, status, amount, currency, payer, payee, external_reference, rejection_reason, created_at, updated_at) VALUES
  ('attempt_settled', 'req_paid', 'resource.report', 'x402', 'replay_settled', 'settled', '0.01', 'USDC', '0xbuyer', '0xmerchant', '0xsettled', NULL, '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:01.000Z'),
  ('attempt_reserved', 'req_reserved', 'resource.report', 'x402', 'replay_reserved', 'reserved', '0.01', 'USDC', NULL, NULL, NULL, NULL, '2026-10-01T10:01:00.000Z', '2026-10-01T10:01:00.000Z'),
  ('attempt_rejected', 'req_rejected', 'resource.report', 'x402', 'replay_rejected', 'rejected', '0.01', 'USDC', NULL, NULL, NULL, 'backend_failed', '2026-10-01T10:02:00.000Z', '2026-10-01T10:02:01.000Z'),
  ('attempt_uncertain', 'req_uncertain', 'resource.report', 'mpp', 'replay_uncertain', 'settlement-uncertain', '0.01', 'USDC', NULL, NULL, '0xpending', NULL, '2026-10-01T10:03:00.000Z', '2026-10-01T10:03:01.000Z'),
  ('attempt_failed', 'req_legacy', 'resource.report', 'x402', 'replay_failed', 'failed', '0.01', 'USDC', NULL, NULL, NULL, NULL, '2026-10-01T10:04:00.000Z', '2026-10-01T10:04:01.000Z');

INSERT INTO payment_attempt_history (id, request_id, resource_id, provider, replay_key, status, amount, currency, payer, payee, external_reference, rejection_reason, created_at, updated_at, superseded_at) VALUES
  ('attempt_archived', 'req_first_try', 'resource.report', 'x402', 'replay_rejected', 'rejected', '0.01', 'USDC', NULL, NULL, NULL, 'insufficient_funds', '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:01.000Z', '2026-10-01T10:02:00.000Z');

PRAGMA user_version = 3;
