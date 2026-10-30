# Sustained processing and long-horizon recovery research

Authorized 2026-10-28: execute the previously proposed live capacity research.
No redeployment, production integration, mainnet, or external messages.
This remains isolated research, not a product implementation.

## Work

- [x] Validate 60 unattended daily rounds locally, cold archive rebuild, slot
  reuse and exactly-once claims. EVM time travel does not prove actual retention.
- [x] Review official storage/SDK semantics. Cold measurements must use a new
  MemoryStorage, fresh credentials and observed relayer HTTP, not cached results.
- [x] Implement and test transaction/budget policy before the live driver.
- [x] Implement resumable driver against the existing validated Sepolia pool.
- [x] Independently review, typecheck and run full local tests: final 124 research
  tests pass (one opt-in stress test skipped); prior 34 production tests passed.
- [x] Start and observe initial live phases, including the retention canary and
  a complete two-user load cycle with conservation checks.
- [x] Complete the 24-hour experiment with durable checkpoints, bounded fee
  exposure and hourly follow-up. Started 2026-10-28T16:04:38.978Z; finished
  2026-10-29T16:04:39.131Z. All 48 cycles settled, with four late cycles and
  recorded interruptions: this is not an uninterrupted availability pass.
- [x] Independently rebuild 382 proofs from retained event logs and verify all
  374 settled load claims and eight untouched canary claims onchain. RPC-only
  replay was blocked by pruned history; document the backup/fallback requirement.

## Chosen approach and controls

Use the existing ReusableMerkleProbe and research ConfidentialUSDC, matching
recorded code hashes/owner/chain. Reuse two research wallets and generate six
additional test-only wallets in the ignored, mode0600 cache. No new accounts
or external services are required. Contracts and application addresses stay put.

Ramp independent wallet concurrency 2,4,8. Separate transaction confirmation,
public admission proof, cold user-decryption readiness, round completion and
archive proof latency. Every cycle deposits, admits, sponsors a draw, exits,
checks each requested account and verifies private balances and prize totals.
Completed user actions and outstanding work matter, not merely submitted txs.

Run for24hours,48 load cycles every30minutes plus one retention draw, and at most3500 transactions. Finish an active cycle
before stopping. Cap aggregate quoted/reserved/actual fees at 0.0015 test ETH,
gas-funding transfers at 0.00064 test ETH, gas price at100000wei and RPC/relayer
concurrency at8. Funding is at most0.00008ETH per research wallet. No automatic
budget increases or new deployments. Respect429/Retry-After with backoff.

Save signed hashes/nonces before broadcast; retain signed raw tx only in the
ignored private cache for exact rebroadcast after a crash. Reserve pending fees
before another send. Serialize nonce assignment per sender, then allow receipt
waits concurrently. Stop on accounting mismatch, mined revert, conflicting
canonical receipt, unknown transaction, unexpected host/runtime or exhausted
budget. Persist all failed/mined fees. No blind resubmission with new nonces.

Maintain a SQLite temporal archive with complete incremental pool logs,
canonical checkpoint verification and independent onchain-root checks.
Reopen it before historical proofs. Data deletion/reorg recovery is separately
tested locally; this is not a claim of production indexer operations.

Create an eight-slot unclaimed retention canary (indices0..7) with recorded
chain timestamps, exact old paths and known total prize11. Exit/reuse those
slots during the soak. Leave all eight claims untouched for a future actual
day60 test. Periodic old-leaf decryptions are explicitly warm probes, not proof
against hypothetical refresh-on-access expiry. The day60 acceptance is new
claims consuming aged ticket/prefix/balance handles, cold award decryptions,
private token balance changes and conservation. A fresh process/store and HTTP
POST/GET evidence prevent client-cache false positives. Starting this canary
does not mean60days have elapsed or availability is guaranteed.

## Pass/fail interpretation

Report offered concurrency, successful/failed unique operations, tx receipt
latency, proof/decrypt p50/p95/p99, error codes/429s, outstanding requests,
backlog drain, cycle time, archive latency and recorded fees. Each user submits
its own permissionless admission/check; one isolated research wallet sponsors
token setup and prizes. After initial gas funding, only close uses the existing
owner. The owner is delegated (one pending tx allowed) and is shared with other
activity, so its nonce interference must not be mistaken for FHE capacity.
The original96-cycle ceiling was reduced to48 to fit each research wallet's
fixed gas allocation with user-paid admissions/checks. A bounded8-wallet
soak establishes behavior at that workload; it does not establish saturation
capacity or thousands of simultaneous live users. No operational SLA is inferred.

## Outputs

Public research status and sanitized metrics: soak-results.json and
soak-events.jsonl. Wallets, raw signed transactions and SQLite: ignored cache.
LongHorizon.test.ts covers local recovery; SoakPolicy.test.ts covers spend,
network and recipient limits. Source: soak/Policy.ts and sepolia-soak.ts.
