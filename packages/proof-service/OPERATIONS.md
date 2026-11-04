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

## Incident behavior

On a canonical hash conflict, stop serving the affected namespace, roll back
from the fork in one D1 batch, re-ingest confirmed receipts, and verify every
closed root onchain. Do not return negative eligibility while a range is
behind, incomplete, orphaned, malformed, or unable to authenticate against
RPC. Withdrawals and already credited winnings do not depend on this service.
