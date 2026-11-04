# Historical proof archive (research only)

`ProofArchive.ts` stores one chain/pool/tree namespace in a local SQLite file
using Node 24's built-in `node:sqlite`. It adds no database service or package
dependency and does not change or deploy the application's contracts.

```ts
import { ProofArchive } from "./ProofArchive";

const archive = new ProofArchive({
  path: "./proofs.sqlite",
  chainId: "11155111",
  pool: poolAddress,
  depth,
  zero: zeroHandle,
  emptyHashes, // levels 0 through depth, inclusive
});

archive.ingest(decodedLogs);
const draws = archive.listDraws(undefined, 20);
const proof = archive.proof(draws[0].drawId, account, {
  rootHash: onchainDraw.rootHash,
  rootSum: onchainDraw.sum,
});
archive.close();
```

Ingest decoded `SlotAssigned`, `SlotReleased`, `NodeUpdated`, and `Closed` logs
with `{ blockNumber, blockHash, logIndex, name, args }`. `logIndex` must be the
block-global log index. Preserve all four event types from the pool's deployment
onward; an RPC response that silently omits events is not a complete archive.
The arguments match the event names in `ReusableMerkleProbe`. Addresses are
normalized to checksum form. Handle and hash fields are opaque bytes32 values;
the archive performs no decryption, signatures, or balance arithmetic.

`ingest` accepts duplicates, shuffled batches, and older backfills. A conflicting
payload at the same position, block hash, or reused draw id fails the whole
batch. Before ingesting a replacement branch, call `rollbackFrom(forkBlock)`.
Rollback atomically removes that block and all later nodes, slot versions,
draws, and canonical block hashes. Canonicality and confirmations are the
ingestion caller's responsibility; this module does not contact an RPC.

Proofs use the node versions and the account's owner/index/generation at the
exact `Closed` log, including earlier logs in the same block. Later withdrawal,
slot reuse, or rejoining at another index does not alter old proofs. Every
request uses O(depth) indexed point-in-time node lookups and checks the leaf,
each ancestor hash, and the frozen root hash/sum. Missing path nodes or corrupted
paths fail. Untouched sibling subtrees use the validated configured empty tree.
Pass the independently read onchain root when validating an untrusted archive.

The result contains `drawId`, checksum `account`, bigint `index` and
`generation`, `balance`, `siblingHashes`, `siblingSums`, `parentSums`, `rootHash`,
`rootSum`, `chainId`, and checksum `pool`. Use a bigint-to-string JSON replacer
if exposing the object over HTTP. The module contains no HTTP listener.

`listDraws(cursor?, limit?)` returns metadata rows in descending draw-id order.
The cursor is exclusive; pass the last returned `drawId` for the next page.
The default is 20 rows and the maximum is 100. No participant records or proof
paths are returned by this query. `close()` is idempotent. Reopening the file
with another chain, pool, depth, zero handle, or empty tree is rejected.

Run the focused tests from `packages/contracts`:

```sh
pnpm exec hardhat test --no-compile \
  --config experiments/claim-lab/hardhat.config.ts \
  experiments/claim-lab/test/ProofArchive.test.ts
```
