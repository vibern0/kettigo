# Proof service operations

The Worker uses only the dedicated D1 database `kettigo-proof-v2-sepolia`
(`60fc25ef-1686-4c1a-b8b4-604456d00bdb`) through `PROOF_DB`. It must never be
pointed at the application/waitlist database.

## Before deployment

Set `CHAIN_ID`, checksum `POOL_ADDRESS`, `TREE_DEPTH`, `ZERO_HANDLE`,
`EMPTY_HASHES_JSON`, `DEPLOYMENT_BLOCK`, the confirmation policy, and two
independent RPC URLs (primary plus archival fallback). Apply migrations only
to the dedicated database, deploy with the pinned Wrangler, and verify the
scheduled ingestion checkpoint, D1 query costs, lag, and both routes.

The archival fallback is a release gate: an RPC that prunes a known event
block cannot prove recovery. A missing fallback means the service must report
history unavailable rather than claim recoverability.

## Backup and restore

On an operational schedule, export a consistent D1 SQL snapshot and a
canonical-log export to independent retained storage. Store a manifest beside
each export containing SHA-256 digests, namespace parameters, earliest/latest
block, row counts, and export time. Validate the manifest before importing into
an isolated restore fixture; run SQLite integrity checks and namespace checks,
then compare draw roots and canonical block hashes to the independent RPC.

D1 Time Travel is only short-window recovery and overwrites the database; it
does not replace retained exports. R2 is not enabled for this account, so no
unattended cloud backup exists yet. An operator must retain exports in an
approved independent location and exercise both SQL restore and full RPC
backfill separately before asserting recovery readiness.

The local retained-export path requires Node 24 and uses the native SQLite
adapter. Use the pinned Wrangler to create a dedicated D1 SQL export, retain it
outside this repository, and pin its SHA-256 and complete namespace manifest
in a separate trusted location:

```sh
pnpm --filter @kettigo/proof-service exec wrangler d1 export kettigo-proof-v2-sepolia --remote --output retained/proof.sql
node --experimental-transform-types tools/replay-retained.mts seal-sql retained/proof.sql retained/proof.sql.manifest.json retained/namespace.json
node --experimental-transform-types tools/replay-retained.mts restore-sql retained/proof.sql retained/proof.sql.manifest.json retained/imported.sqlite retained/namespace.json
node --experimental-transform-types tools/replay-retained.mts export retained/imported.sqlite retained/canonical.json retained/canonical.manifest.json 11155111 0xCHECKSUM_POOL
node --experimental-transform-types tools/replay-retained.mts restore-canonical retained/canonical.json retained/canonical.manifest.json retained/replayed.sqlite retained/namespace.json
pnpm --filter @kettigo/proof-service test:restore
```

`retained/namespace.json` is the separately retained release namespace
configuration (checksum pool address, depth, zero handle, all empty hashes and
deployment block). It is not generated from a backup payload. Each restore
target must be a new pathname; publication fails atomically if it already
exists.

The SQL file is restored only after its separately retained digest/namespace
manifest is verified; the canonical export is replayed only after its separate
trusted manifest exactly matches. The tool imports a trusted, explicitly named
SQL snapshot into a new isolated target; it never runs a wildcard directory of
SQL and never replaces a source or existing target. Canonical replay rebuilds
all derived production tables from namespace metadata, the deployment-parent
anchor, continuous headers (including empty blocks), and original logs.

`test:restore` exercises clean SQL-snapshot restoration and canonical replay
into separate targets, verifies SQLite integrity, and compares every field of
a genuine depth-32 historical proof after an exit/reuse/rejoin sequence. The
digest detects accidental mutation, while the separately pinned manifest binds
the expected namespace/ranges/counts. Neither alone authenticates a fully
malicious backup provider: verify canonical close blocks and roots against an
independent Ethereum source before operational recovery. Keep this separate
from the complete archival-RPC backfill exercise.

No Worker endpoint serves exports. Retained local exports are an operator task,
not an automated cloud backup claim.

## Service limits and monitoring

The public API accepts only canonical decimal identifiers, a URI of at most
2048 bytes, and draw pages of 1 through 100. It uses a primary-consistent D1
session, at most eight in-flight proof requests, and a bounded/expiring per-IP
map (60 requests per minute, 4096 tracked keys). Monitor the sanitized
checkpoint state (`nextBlock` and `lastFinalizedBlock`) and alert on finalized
lag, disabled namespaces, or scheduler failures. The scheduler processes at
most two blocks per tick. The shared RPC source pins one provider per operation;
fallback receipt recovery is deliberately bounded and may fail closed under a
provider outage rather than exceed Worker subrequest limits.

## Incident behavior

On a canonical hash conflict, stop serving the affected namespace, roll back
from the fork in one D1 batch, re-ingest confirmed receipts, and verify every
closed root onchain. Do not return negative eligibility while a range is
behind, incomplete, orphaned, malformed, or unable to authenticate against
RPC. Withdrawals and already credited winnings do not depend on this service.
