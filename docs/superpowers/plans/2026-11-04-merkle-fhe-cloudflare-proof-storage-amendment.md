# Merkle + FHE: Cloudflare proof storage amendment

Status: approved by the user on 2026-11-04 for Worker + D1. This replaces
the earlier unapproved client-reconstruction proposal. Tasks 1–2 remain
unchanged; this adapts Task 3's Node/local-SQLite deployment to Cloudflare.

## Proposed design

Use a dedicated Cloudflare Worker and a separate D1 SQLite database in the
existing account. This is internal infrastructure, not a new user-facing draw
history feature. D1 stores canonical onchain event records, point-in-time tree
nodes and ownership generations, draw metadata and ingestion checkpoints.
No readable balances, winner-selection logic, signing keys or FHE decryption
move into the database.

A bounded ingestion job follows confirmed canonical logs from deployment.
Database event/checkpoint updates commit atomically. It verifies close roots
against independently read contract state and rolls back orphaned checkpoints.
A proof request uses indexed historical lookups, not a complete event replay;
the Worker authenticates the path/root and canonical close identity before
returning the original Task 3 scoped API response. The app checks response
identity and submits the unchanged beneficiary-bound `checkPrize` call.

Preserve the original API, checksum and decimal-string bigint conventions,
structured unavailable/indexing/not-eligible outcomes, bounded work/concurrency,
rate limiting, monitoring, retention and restore requirements. Use D1 primary
or explicit consistency sessions so replicas cannot turn fresh records into
incorrect negative responses. A canonicality failure disables affected proofs;
it never changes entitlement or releases reserved funds.

Keep database schema/indexes and proof hashing separable from the Worker API,
so local tests and independent backup restoration run on Node 24 SQLite. Use
actual Workers/D1 runtime integration tests for async batches, rollback and
checkpoint conflicts. Generate binding types from Wrangler configuration.

Keep independent exported backups and test restoration separately from a full
RPC backfill. D1 recovery facilities alone do not prove indefinite retention.
Document measured database/query/Worker limits. No host/volume or container is
needed; no existing waitlist/app tables or their schema are repurposed.

## Alternatives and tradeoffs

- The original external Node server preserves its exact runtime but requires
  a separately operated host, disk and credentials absent from this project.
- Browser reconstruction avoids a service but requires fresh devices to replay
  historical events and puts historical-RPC availability directly on users.
- Worker plus D1 retains the original indexed proof API and durable SQLite
  model in the existing hosting account. It requires adapting synchronous
  SQLite transactions to D1 async atomic batches and verifying platform limits.
  This is the recommended approach; PostgreSQL is unnecessary.

## Implementation change

Task 3 still creates `packages/proof-service/`, but deploys a Worker with a D1
binding instead of a Node HTTP listener and local persistent disk. Its tests
cover namespace mismatch, duplicate/shuffled/missing logs, same-block ordering,
reorg rollback, checkpoint conflicts, tampered backups, onchain-root mismatch,
RPC fallback and unavailable outcomes. Preserve the existing contract and web
requirements, run clean frozen install/build and Wrangler dry run, deploy the
new Worker/database, and test actual endpoints/restore/backfill before claiming
success. Task 4 consumes the original proof-service API.

Principal withdrawals and existing credited claims remain independent of proof
service availability. The untouched research canary and its earliest test date
2026-12-27T16:04:36Z remain unchanged; a D1 backup does not prove Zama ciphertext
retention. Codacy Cloud remains an explicitly blocked release gate.

References: [D1 binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
and [atomic batches](https://developers.cloudflare.com/d1/observability/find-expensive-queries/).
