# Task 3 HTTP/archive matrix report

Scoped to F1/F2/F5/F6 native Worker + D1 HTTP/archive evidence only.

## Added evidence

- A reusable genuine depth-32 D1 fixture, whose node path and root are built
  from the production hash functions.
- HTTP proof success independently checks the returned root, namespace,
  account, generation, and all 32 sibling levels through JSON-RPC wire-shaped
  Ethereum responses.
- HTTP outcomes cover authenticated `NOT_ELIGIBLE`, known-unindexed `INDEXING`,
  known indexed-but-absent `HISTORY_UNAVAILABLE`, unknown draw 404, malformed
  and over-uint256 identifiers, wrong-chain providers, provider outage, root
  mismatch, close/checkpoint orphaning, and immutable namespace mismatch after
  real data exists.
- CORS assertions cover success and every exercised unavailable/negative
  outcome. The 60 requests per 60-second window and eight concurrent requests
  are explicitly exercised per Worker isolate (the in-memory limiter is
  intentionally isolate-local).
- Archive coverage retains historical owner/generation across same-block close,
  release, reassignment, and rejoin; it rejects the replacement beneficiary and
  fails closed for a missing required historical node.

## Verification

```text
pnpm --filter @kettigo/proof-service test
5 test files passed, 34 tests passed

pnpm --filter @kettigo/proof-service typecheck
tsc --noEmit exited 0

pnpm --filter @kettigo/proof-service build
wrangler deploy --dry-run exited 0

pnpm exec prettier --check packages/proof-service/tests/fixtures.ts packages/proof-service/tests/archive.worker.test.ts packages/proof-service/tests/server.http-matrix.worker.test.ts
All matched files use Prettier code style

git diff --check
exited 0
```

## Remaining gaps outside this slice

This does **not** declare Task 3 complete. Source review/F7, tick deadline
cancellation (F3), retained backup/restore implementation (F4), remote
deployment/backfill, and live operational acceptance remain pending.
