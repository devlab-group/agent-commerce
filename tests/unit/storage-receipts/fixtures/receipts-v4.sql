-- Fixed 2.5.0 (schema v4) fixture: v3 rows plus journal examples for delivered,
-- uncertain, reclaimed and manually resolved purchases. Keep this SQL fixed
-- so migration changes do not alter the upgrade test's input.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
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
        , authorization_json TEXT, transaction_id TEXT);
INSERT INTO receipts VALUES(1,'receipt_paid','req_paid','resource.report','{"status":"settled","provider":"x402","amount":"0.01","currency":"USDC","externalReference":"0xsettled","network":"eip155:31337"}','2026-10-01T10:00:00.000Z',200,12,'mcp','{"adapter":"mcp"}','{"method":"ap2","reference":"sha256:mandate"}',NULL);
INSERT INTO receipts VALUES(2,'receipt_failed','req_failed','resource.report',NULL,'2026-10-01T11:00:00.000Z',502,NULL,NULL,NULL,NULL,NULL);
INSERT INTO receipts VALUES(3,'receipt_v4_delivered','req_v4_delivered','resource.report','{"status":"settled","provider":"x402","amount":"0.01","currency":"USDC","externalReference":"0xtx_v4"}','2026-10-20T12:00:07.000Z',200,NULL,NULL,NULL,NULL,'txn_v4_delivered');
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
        , transaction_id TEXT);
INSERT INTO events VALUES(1,'event_requested','resource.requested','req_paid',NULL,'2026-10-01T09:59:00.000Z',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO events VALUES(2,'event_settled','payment.settled','req_paid','resource.report','2026-10-01T10:00:00.000Z','mcp','x402',5,'ok','{"externalReference":"0xsettled"}',NULL);
INSERT INTO events VALUES(3,'event_v4_delivered','resource.delivered','req_v4_delivered','resource.report','2026-10-20T12:00:10.000Z',NULL,NULL,NULL,NULL,NULL,'txn_v4_delivered');
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
        , transaction_id TEXT, resolution_json TEXT);
INSERT INTO payment_attempts VALUES(1,'attempt_settled','req_paid','resource.report','x402','replay_settled','settled','0.01','USDC','0xbuyer','0xmerchant','0xsettled',NULL,'2026-10-01T10:00:00.000Z','2026-10-01T10:00:01.000Z',NULL,NULL);
INSERT INTO payment_attempts VALUES(2,'attempt_reserved','req_reserved','resource.report','x402','replay_reserved','reserved','0.01','USDC',NULL,NULL,NULL,NULL,'2026-10-01T10:01:00.000Z','2026-10-01T10:01:00.000Z',NULL,NULL);
INSERT INTO payment_attempts VALUES(3,'attempt_rejected','req_rejected','resource.report','x402','replay_rejected','rejected','0.01','USDC',NULL,NULL,NULL,'backend_failed','2026-10-01T10:02:00.000Z','2026-10-01T10:02:01.000Z',NULL,NULL);
INSERT INTO payment_attempts VALUES(4,'attempt_uncertain','req_uncertain','resource.report','mpp','replay_uncertain','settlement-uncertain','0.01','USDC',NULL,NULL,'0xpending',NULL,'2026-10-01T10:03:00.000Z','2026-10-01T10:03:01.000Z',NULL,NULL);
INSERT INTO payment_attempts VALUES(5,'attempt_failed','req_legacy','resource.report','x402','replay_failed','failed','0.01','USDC',NULL,NULL,NULL,NULL,'2026-10-01T10:04:00.000Z','2026-10-01T10:04:01.000Z',NULL,NULL);
INSERT INTO payment_attempts VALUES(6,'attempt_v4_1','req_v4_delivered','resource.report','x402','replay_v4_delivered','settled','0.01','USDC','0xbuyer','0xmerchant','0xtx_v4',NULL,'2026-10-20T12:00:01.000Z','2026-10-20T12:00:03.000Z','txn_v4_delivered',NULL);
INSERT INTO payment_attempts VALUES(7,'attempt_v4_2','req_v4_uncertain','resource.report','mpp','replay_v4_uncertain','settlement-uncertain','0.01','USDC',NULL,NULL,'0xmaybe',NULL,'2026-10-20T12:00:11.000Z','2026-10-20T12:00:13.000Z','txn_v4_uncertain',NULL);
INSERT INTO payment_attempts VALUES(8,'attempt_v4_4','req_v4_second','resource.report','near','replay_v4_reclaim','reserved','0.01','USDC',NULL,NULL,NULL,NULL,'2026-10-20T12:00:20.000Z','2026-10-20T12:00:20.000Z','txn_v4_second',NULL);
INSERT INTO payment_attempts VALUES(9,'attempt_v4_5','req_v4_resolved','resource.report','x402','replay_v4_resolved','settled','0.01','USDC',NULL,NULL,NULL,NULL,'2026-10-20T12:00:21.000Z','2026-10-20T12:00:24.000Z','txn_v4_resolved','{"method":"manual","actor":"ops","reason":"checked the explorer","at":"2026-10-20T12:00:23.000Z","externalReference":"0xmanual"}');
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
        , transaction_id TEXT, resolution_json TEXT);
INSERT INTO payment_attempt_history VALUES(1,'attempt_archived','req_first_try','resource.report','x402','replay_rejected','rejected','0.01','USDC',NULL,NULL,NULL,'insufficient_funds','2026-10-01T09:00:00.000Z','2026-10-01T09:00:01.000Z','2026-10-01T10:02:00.000Z',NULL,NULL);
INSERT INTO payment_attempt_history VALUES(2,'attempt_v4_3','req_v4_first','resource.report','near','replay_v4_reclaim','rejected','0.01','USDC',NULL,NULL,NULL,'backend_failed','2026-10-20T12:00:16.000Z','2026-10-20T12:00:17.000Z','2026-10-20T12:00:20.000Z','txn_v4_first',NULL);
CREATE TABLE transactions (
          seq                        INTEGER PRIMARY KEY AUTOINCREMENT,
          id                         TEXT NOT NULL UNIQUE,
          request_id                 TEXT NOT NULL,
          resource_id                TEXT NOT NULL,
          protocol                   TEXT NOT NULL,
          state                      TEXT NOT NULL,
          provider                   TEXT NOT NULL,
          attempt_id                 TEXT NOT NULL,
          replay_key                 TEXT NOT NULL,
          network                    TEXT,
          asset                      TEXT,
          authorization_json         TEXT,
          reservation_id             TEXT,
          locator_json               TEXT,
          expires_at                 TEXT,
          input_digest               TEXT,
          config_digest              TEXT NOT NULL,
          settling_at                TEXT,
          backend_dispatched_at      TEXT,
          backend_deadline_at        TEXT,
          backend_status             INTEGER,
          backend_error_code         TEXT,
          receipt_id                 TEXT,
          persistence_failures_json  TEXT,
          completed_at               TEXT,
          created_at                 TEXT NOT NULL,
          updated_at                 TEXT NOT NULL
        );
INSERT INTO transactions VALUES(1,'txn_v4_delivered','req_v4_delivered','resource.report','mcp','delivered','x402','attempt_v4_1','replay_v4_delivered','eip155:31337','0xasset','{"method":"ap2","reference":"sha256:mandate_v4","hold":"consumed"}','hold_v4_delivered','{"kind":"eip3009","nonce":"0xnonce","from":"0xbuyer"}','2026-10-20T13:00:00.000Z','sha256:input','sha256:terms','2026-10-20T12:00:02.000Z','2026-10-20T12:00:05.000Z','2026-10-20T12:10:00.000Z',200,NULL,'receipt_v4_delivered',NULL,'2026-10-20T12:00:09.000Z','2026-10-20T12:00:01.000Z','2026-10-20T12:00:09.000Z');
INSERT INTO transactions VALUES(2,'txn_v4_uncertain','req_v4_uncertain','resource.report','mcp','payment-uncertain','mpp','attempt_v4_2','replay_v4_uncertain',NULL,NULL,'{"method":"ap2","reference":"sha256:mandate_v4_u","hold":"uncertain"}','hold_v4_uncertain',NULL,NULL,NULL,'sha256:terms','2026-10-20T12:00:12.000Z',NULL,NULL,NULL,NULL,NULL,'["receipt"]','2026-10-20T12:00:15.000Z','2026-10-20T12:00:11.000Z','2026-10-20T12:00:15.000Z');
INSERT INTO transactions VALUES(3,'txn_v4_first','req_v4_first','resource.report','mcp','payment-failed','near','attempt_v4_3','replay_v4_reclaim',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'sha256:terms',NULL,'2026-10-20T12:00:18.000Z','2026-10-20T12:00:18.000Z',502,'BACKEND_ERROR',NULL,NULL,'2026-10-20T12:00:19.000Z','2026-10-20T12:00:16.000Z','2026-10-20T12:00:19.000Z');
INSERT INTO transactions VALUES(4,'txn_v4_second','req_v4_second','resource.report','mcp','payment-pending','near','attempt_v4_4','replay_v4_reclaim',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'sha256:terms',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-10-20T12:00:20.000Z','2026-10-20T12:00:20.000Z');
INSERT INTO transactions VALUES(5,'txn_v4_resolved','req_v4_resolved','resource.report','mcp','settled-undelivered','x402','attempt_v4_5','replay_v4_resolved',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'sha256:terms',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-10-20T12:00:21.000Z','2026-10-20T12:00:21.000Z');
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('receipts',3);
INSERT INTO sqlite_sequence VALUES('events',3);
INSERT INTO sqlite_sequence VALUES('payment_attempts',9);
INSERT INTO sqlite_sequence VALUES('payment_attempt_history',2);
INSERT INTO sqlite_sequence VALUES('transactions',5);
CREATE INDEX idx_receipts_request_id ON receipts(request_id);
CREATE INDEX idx_receipts_delivered_at ON receipts(delivered_at);
CREATE INDEX idx_events_request_id ON events(request_id);
CREATE INDEX idx_events_at ON events(at);
CREATE INDEX idx_payment_attempts_request_id ON payment_attempts(request_id);
CREATE INDEX idx_payment_attempts_created_at ON payment_attempts(created_at);
CREATE INDEX idx_payment_attempt_history_replay_key ON payment_attempt_history(replay_key);
CREATE INDEX idx_payment_attempt_history_request_id ON payment_attempt_history(request_id);
CREATE INDEX idx_transactions_state_seq ON transactions(state, seq);
CREATE INDEX idx_transactions_request_id ON transactions(request_id);
CREATE INDEX idx_transactions_replay_key ON transactions(replay_key);
CREATE INDEX idx_payment_attempt_history_id ON payment_attempt_history(id);
COMMIT;

PRAGMA user_version = 4;
