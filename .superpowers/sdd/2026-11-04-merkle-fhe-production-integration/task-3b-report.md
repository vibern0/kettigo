# Task 3b — RPC ingestion and reorg recovery

## Delivered

The Worker now initializes its archive itself before the first scheduled tick,
persisting the real deployment-parent block hash as a canonical anchor. It
validates the saved canonical checkpoint before deciding that finalized head has
no new work, finds a bounded common ancestor (128 blocks), atomically rolls
back an orphaned suffix, and disables the namespace for an unknown/deep fork.
Rollback to deployment retains the persisted anchor rather than replacing it
with a zero hash. The D1 commit trigger now fails closed if state is absent.

Ingestion checks RPC chain identity, header continuity, per-log canonical block
hashes, exact deduplicated receipt/log equivalence, and independently calls the
draw snapshot at the close block before accepting a `DrawSnapshotClosed` log.
The public `RpcSource` contract adds `chainId()` and `drawSnapshot(drawId,
block)`. `D1Archive` adds `canonicalBlock`, `disable`, and an optional
`initialize(namespace, deploymentParentHash)` anchor. The Worker and HTTP
verification now share `PRIMARY_RPC_URL` / `HISTORICAL_RPC_URL`; the obsolete
`RPC_URL` field is no longer part of `Env`.

## RED / GREEN evidence

RED (before the ingestion change):

```text
pnpm --filter @kettigo/proof-service test -- ingest.worker.test.ts
3 failures: no-work checkpoint reorg remained at nextBlock 4/5, and
canonicalBlock was absent for the empty-block assertion.
```

GREEN:

```text
pnpm --filter @kettigo/proof-service test       # 10 passed
pnpm --filter @kettigo/proof-service typecheck  # passed
pnpm --filter @kettigo/proof-service build      # Wrangler dry-run passed
pnpm --filter @kettigo/protocol test            # 23 passed
```

The native Worker/D1 coverage now includes a persisted deployment anchor,
multi-block reorg/common-ancestor rollback while no new head work exists, and
a complete two-slice empty-block backfill. Existing archive tests retain CAS,
header, duplicate, and rollback predecessor coverage.

## Deliberately remaining for Task 3c

This is not Task 3 completion. HTTP adverse-path coverage, full receipt
fallback limits/error-cause preservation, independent backup/restore on Node
24, and the live bounded historical backfill remain Task 3c/operations work.
No remote D1 operation, deployment, Ethereum transaction, signing, or
decryption was performed.
