# Task 3 F3 deadline and operator-input report

## Completed

- Replaced the detached `Promise.race` timeout with a single operation deadline signal.
  The signal aborts in-flight RPC fetches and prevents any later provider/fallback calls.
- Propagated the optional signal through `RpcSource`, `EthereumRpc`, fallback selection,
  and each ingestion RPC step. Existing callers without a signal remain supported.
- Checked the signal before archive initialization, disable, rollback, and ingest mutation.
  D1 batches cannot be cancelled; once `archive.ingest` starts, the worker awaits its
  atomic settlement rather than claiming a false hard deadline.
- Restricted `/internal/tick` to POST, bounded authorization bytes and both declared and
  streamed request bodies to 1024 bytes, retained fixed-time token comparison, and added
  `Cache-Control: no-store` to tick result/error JSON.
- Added coverage for real `EthereumRpc` fetch aborts, no fallback after deadline, no
  archive mutation after cancellation, streamed oversized bodies, and successful POST
  checkpoint results.

## Verification

All run in `packages/proof-service` on 2026-11-04:

```text
pnpm --filter @kettigo/proof-service test
5 files / 38 tests passed

pnpm --filter @kettigo/proof-service typecheck
tsc --noEmit passed

pnpm --filter @kettigo/proof-service build
wrangler deploy --dry-run passed
```

## Remaining

This covers F3 only. No live RPC/deployment, backup tooling, UI work, or Codacy changes
were made. The deadline is intentionally bounded for cancellable network work; an
already-started atomic D1 batch is awaited to completion.
