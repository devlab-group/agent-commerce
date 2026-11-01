# Storage

The SQLite file at `storage.receipts.path` stores the gateway's records
across restarts:

- receipts, the commerce event log, payment attempts and the transaction
  journal;
- from 2.6.0, AP2 mandate holds, ACP idempotency claims and A2A x402 tasks
  waiting for payment;
- a record of each deprecated store file it imported.

The gateway creates the file at 0600, and any missing directory at 0700, and
runs it in WAL mode. Run one gateway per database.

## Deprecated store files

To upgrade from 2.5, keep the legacy paths set and their files in place.
2.6.0 still accepts both keys, and `start` imports the files.

In 2.6.0, ACP idempotency records and AP2 mandate holds use the receipt
database. The settings for their separate files are deprecated:
`protocols.acp.idempotency.path` and `authorization.ap2.replay.path`. For an
enabled feature, config warns when its key is set. It rejects identical path
values for these files and the receipt database, except `:memory:`. The
3.0.0 plan removes both keys.

`agent-commerce start` imports the files:

- Each source is imported once, with its rows and import marker committed
  together. Later starts skip recorded imports. ACP schema-v1 rows are
  skipped, matching the 2.5 migration; a nonzero count of claims not marked
  `completed` is logged at `warn`.
- `start` locks existing source files against writes until shutdown. While a
  lock is held, a 2.5 gateway cannot update that file.
- The first import needs a writable directory. If a read-only mount prevents
  the import, startup fails with `STORAGE_ERROR`. Make the directory writable
  or copy the file somewhere writable and point the key there. After a
  recorded import, `SQLITE_CANTOPEN` logs a warning instead; other lock
  failures still stop startup.
- With AP2 enabled, `reconcile` and `resolve` refuse an existing AP2 file with
  no recorded import. Run `start` first; these commands do not import it.
- Remove a key after its import succeeds and no 2.5 gateway uses the file.
  Changing a recorded source path is refused.

For an enabled feature with neither an import nor feature rows recorded,
`start` also checks for past use in the receipt database. If it finds that
evidence and the legacy key is unset or names a missing file, startup fails
with `STORAGE_ERROR`. Point the key at the file used by the previous version,
or at an empty file to explicitly accept the loss of its records.

## Backup

```bash
npm run agent-commerce -- backup --out ./backups/2026-11-01
```

`backup` opens sources read-only and can run alongside a live gateway. It
does not migrate or import records, or take a write lock on the sources.
`--config`, `--env-file` and `--json` work as they do for other commands.

- `--out` must name a new or empty directory. To create a new one, its parent
  must exist; the command creates it at 0700. An existing directory keeps its
  permissions.
- It writes `receipts.sqlite`, a consistent snapshot taken with
  `VACUUM INTO`. It refuses a receipt database at a schema other than v4 (2.5)
  or v5 (2.6).
- For enabled AP2 or ACP, it also copies any configured legacy file that
  exists, is not `:memory:` and has no recorded import. The copies are named
  `ap2-replay.sqlite` or `acp-idempotency.sqlite`. Before the first 2.6.0
  start, those files hold records absent from the receipt database. Each file
  is a separate snapshot.
- Every copy is created at 0600 and must pass `PRAGMA integrity_check`.
- `backup.json` is written last. It records the package version and creation
  time, plus each copy's source config key, schema version and SHA-256 hash.
  A directory without the manifest is an incomplete backup.

Exit 0 means the backup is complete; 1 means it is not.

## Restore

1. Stop the gateway, and any `reconcile` or `resolve` run.
2. Check each file against its SHA-256 in `backup.json`.
3. Delete the receipt database and its `-wal` and `-shm` files: a leftover
   WAL file belongs to the old database. Copy `receipts.sqlite` to
   `storage.receipts.path`.
4. Restore any `ap2-replay.sqlite` or `acp-idempotency.sqlite` included in the
   backup to the path named by its config key. Remove the old file and its
   `-wal` and `-shm` files before copying. Keep the key set so the next start
   imports the restored records.
5. Start the gateway, then run `agent-commerce reconcile`.

Restoring a backup discards local records written after its snapshot:

- Later receipts, events, payment attempts, holds, idempotency claims and
  pending tasks are lost. Transfers remain on chain.
- A proof spent after the backup reaches the facilitator again. On EVM,
  verification rejects the spent authorization. Solana and NEAR rely on the
  chain rejecting a transaction or nonce it has already processed. If a replay
  passes verification, the `authorization` flow runs the backend before
  settlement is refused, then withholds the response. The proof cannot pay
  twice, but the backend may run again.
- An AP2 mandate consumed after the backup can authorize another purchase
  until it expires. That purchase still requires payment.
- Retrying an ACP checkout under a key claimed after the backup reaches the
  merchant again with the same derived `Idempotency-Key`.

A transaction recorded as unresolved in the backup still needs `reconcile`
or `resolve` to establish its outcome.

A 2.5 gateway refuses a receipt database migrated by 2.6.0. To roll back to
2.5, restore a backup made before the upgrade.

## Shutdown

On the first SIGTERM or SIGINT, the gateway stops accepting connections and
waits for in-flight requests without a time limit. It then stops protocol
adapters, closes authorization providers and the database, and exits 0 on
success. A shutdown error exits 1.

A second SIGTERM or SIGINT exits immediately with status 1. An orchestrator
can also send SIGKILL when its grace period expires, terminating the process
without cleanup. Docker Compose's `stop_grace_period` defaults to 10 s.
Either forced exit can leave an unfinished purchase, for example an attempt
marked `reserved` or `settlement-uncertain`. Replays of those attempts return
409 without a fresh challenge. Run `reconcile` after restart; use `resolve`
when the available evidence cannot establish the outcome. Set the grace
period above your slowest settlement plus backend call.
