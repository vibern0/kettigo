# Merkle + FHE Production Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the application's 32-participant scan and admission ceiling using authenticated historical snapshots and individual FHE prize checks, while preserving principal withdrawals and existing prize-claim choices.

**Architecture:** Maintain a depth-32 encrypted sum tree with reusable, generation-bound slots. Each draw freezes its authenticated root, encrypted total, encrypted ticket and reserved prize; users check individual historical entitlements against that snapshot. A durable offchain event archive supplies proofs, but the contract authenticates every path and determines awards with FHE.

**Tech stack:** Solidity, Zama FHE/ERC-7984, Hardhat, TypeScript, Node 24 SQLite archive, existing web and keeper packages; pinned pnpm versions per package.

**Spec / evidence:** [Bounty scope](../../BOUNTY_SCOPE.md), [roadmap](../../ROADMAP.md), [on-demand design and limitations](../../../packages/contracts/experiments/claim-lab/ON_DEMAND_VALIDATION.md), [population validation](../../../packages/contracts/experiments/claim-lab/VALIDATION.md), and [soak results](../../../packages/contracts/experiments/claim-lab/SOAK_VALIDATION.md). This document supplies the proposed integration decisions below; research findings are evidence, not production approval.

## Status and authorization

**Execution update, 2026-11-04:** The user subsequently authorized implementation,
commits, Sepolia deployment/testing and a pull request. The user approved the
[Worker + D1 amendment](2026-11-04-merkle-fhe-cloudflare-proof-storage-amendment.md)
to Task 3 and the separate [live-run envelope](../../releases/merkle-fhe-v2-run-envelope.md).
The publication-only statements below describe the original planning change;
they do not supersede that later authorization. The untouched retention canary
still cannot be checked before its due date. Codacy Cloud authentication is
currently blocked; the user requested continued work with that gate reported.

As checked against fetched `origin/main` on 2026-11-04, `packages/contracts/contracts/ConfidentialPrizePool.sol` still defines `MAX_PARTICIPANTS = 32` and enforces it at registration. No Merkle claim or proof archive is integrated into the application contract/frontend. Research lives under `packages/contracts/experiments/`. Before execution, reconcile deployed bytecode and application addresses with the release manifest; this repository check is not an independent audit of an out-of-band deployment.

**Plan only.** Do not implement, run funded experiments, deploy, migrate funds, or change application addresses as part of publishing this document. Execution and release happen later. Publishing research on `main` did not activate it in the app.

“Unlimited” means removing the fixed 32-user bottleneck, not infinite capacity: this design has at most 2^32 concurrent slots, finite integer bounds, storage growth, and network/FHE throughput limits. Publish measured operating limits rather than an unlimited-capacity guarantee.

## Global constraints and integration decisions

- Validate on Ethereum Sepolia. This plan does not authorize another network or mainnet launch; existing mainnet-program gates remain separate.
- Keep Zama FHE balances, weighted onchain randomness, confidential winnings, checksum SDK addresses, and bigint-safe EIP-712 serialization.
- Preserve ERC-7984 accepted-transfer accounting, queued USDC withdrawals, Morpho backing/restoration, and existing signer/keeper architecture. Do not copy the research probe's liquid-principal withdrawal shortcut.
- Preserve existing product choices: a successful individual check **credits encrypted winnings**; the existing claim-to-wallet and add-to-savings actions consume that credit. The research probe pays directly, so this deliberate adaptation needs its own conservation and replay tests.
- Draw funds remain reserved until entitlement is checked. Initially retain historical claims without expiry. No operator sweep of unchecked prizes; no required all-account scan.
- Positive admission verifies the current accepted pending balance using Zama's signed decryption proof. Document disclosure of the positive-balance bit and delayed eligibility. Pending principal stays withdrawable before admission. Reuse a slot only after explicit full exit; authenticate historical owner and generation independently of current registration.
- Do not derive aggregate principal bounds from 32 accounts. Specify checked uint64 total/individual limits and test overflow; a larger tree does not increase integer capacity.
- Preserve the eight-account retention canary at research pool `0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27`, draw 2. No early checks. Earliest real 60-day test: **2026-12-27T16:04:36Z**. Preserve ignored keys, signed-attempt history, and archive backups securely; Git does not contain them.
- Product copy follows AGENTS.md; research terminology belongs in engineering docs. Do not promise a prize before checking.

## Review focus

1. Exiting/rejoining or slot reuse must never invalidate or redirect an earlier claim (Tasks 1–2).
2. Archive outage, omitted logs, or pruned RPC history must not prevent principal withdrawal or permit a forged payout (Tasks 3–4).
3. Partial/rejected callbacks, stale admission proofs, and pending withdrawals must never create unsupported draw weight (Task 1).
4. Relayer/RPC failure after transaction submission must reconcile the exact intent without duplicate sends or masking permission denial (Tasks 4–5).
5. Old pool liabilities and unclaimed draws must remain accessible through migration and rollback (Task 6).

## Task 1: Integrate membership and encrypted tree accounting

**Files:** Modify `packages/contracts/contracts/ConfidentialPrizePool.sol`; create `packages/contracts/contracts/libraries/EncryptedSnapshotTree.sol` and `packages/contracts/test/MerkleMembership.test.ts`. Reuse reviewed algorithms from `experiments/claim-lab/contracts/ReusableMerkleProbe.sol`, not its unrestricted research scaffolding.

- [ ] Write failing tests `admits33FundedUsers`, `rejectsZeroAndStaleAdmission`, `pendingWithdrawalInvalidatesAdmission`, `exitReusesSlotWithNewGeneration`, and `aggregateOverflowDoesNotCorruptBacking`. Include callback rejection/partial acceptance, dust admission, and the existing queued-withdrawal path.
- [ ] Run the focused Hardhat test and confirm each new expectation fails on the legacy implementation.
- [ ] Integrate owner/index/generation leaves, domain-separated parent hashes binding child sums, bounded tree updates, free-list reuse, and `finalizeAdmission(address,uint256,bool,bytes)` proof verification. Keep pending and active liabilities separate. Emit complete node, ownership, release, and admission events.
- [ ] Remove the registration limit and its derived aggregate bound only once all corresponding accounting paths use the new model. Prove every existing principal mutation, withdrawal request, restoration, and prize reinvestment updates the correct weight once; requested withdrawals stop earning weight immediately.
- [ ] Run focused tests and all existing contract/invariant suites. Commit this independently reviewable change.

## Task 2: Snapshot draws and settle one historical entitlement

**Files:** Modify `ConfidentialPrizePool.sol`; create `packages/contracts/test/MerkleClaims.test.ts` and `packages/contracts/test/MerkleClaims.invariant.test.ts`.

**Interface:** Add `checkPrize(uint256 drawId,address beneficiary,uint256 index,uint64 generation,bytes32 balanceHandle,bytes32[] siblingHashes,bytes32[] siblingSums,bytes32[] parentSums)`. Arrays have exactly tree depth entries; the decoded leaf/sums must authenticate to the stored draw root and encrypted root sum. Expose draw snapshot metadata and `checked(drawId,beneficiary)` for clients. Final ABI names/types must be frozen before Task 3.

- [ ] Write failing tests `closeDoesNotScanPopulation`, `oldClaimSurvivesExitReuseAndRejoin`, `rejectsWrongOwnerGenerationPathAndDraw`, `creditsEachOutcomeOnce`, and `creditThenClaimOrReinvestConservesFunds`. Cover same-block mutations around closure, duplicate losing checks, out-of-order claims and multiple unpaid draws.
- [ ] Implement frozen snapshot + reserved prize state, FHE prefix sum/interval comparison, and exactly-once encrypted credit to the fixed beneficiary. A relayer may submit but cannot redirect funds. Separate active prize funding, unchecked draw liabilities, credited winnings, and principal in conservation assertions.
- [ ] Preserve required FHE ACL access to historical handles; verify that users cannot decrypt the ticket, totals, or other balances. Review empty/all-zero draws, first/last intervals and existing randomness-mapping bias against the protocol-correctness plan; do not promote the research RNG mapping as an audited exact sampler.
- [ ] Run funded 33-account and 4,096-account local scenarios, independent weighted reference-model invariants, and worst-position depth-32 proofs. Record local FHE simulation separately from live evidence. Commit after the full contract suite passes.

## Task 3: Turn the temporal archive into an operated proof service

**Files:** Create `packages/proof-service/` with pinned package metadata, `src/archive.ts`, `src/ingest.ts`, `src/server.ts`, and focused tests. Adapt `experiments/claim-lab/indexer/ProofArchive.ts`; never import production runtime code from the experiments directory.

**Interface:** `GET /v1/:chainId/:pool/draws?cursor&limit` returns at most 100 draw records; `GET /v1/:chainId/:pool/draws/:drawId/proof/:account` returns the authenticated historical path plus chain/pool identity and canonical close block/hash. Serialize bigint values as decimal strings. Return structured `NOT_ELIGIBLE`, `INDEXING`, or `HISTORY_UNAVAILABLE` outcomes; malformed proofs are never successful responses.

- [ ] Add failing tests for namespace mismatch, reorg rollback, missing/duplicate/shuffled logs, same-block event ordering, corrupt backups, and onchain-root mismatch.
- [ ] Implement deployment-to-finalized-head ingestion with durable checkpoints, canonical block verification, transactional rollback, bounded backfill/query ranges, and monitoring of lag. Use a configurable documented confirmation policy and refuse to serve orphaned snapshots.
- [ ] Serve indexed point-in-time proofs authenticated against independently read onchain roots. No per-request full replay, decryption, or signing. Add request-size/rate limits and bounded concurrency.
- [ ] Operate persistent storage with independent backups and a tested historical RPC fallback. Prove a clean restore from retained logs, then a separate complete RPC backfill; the soak's configured RPC pruned known event blocks and cannot satisfy this requirement alone.
- [ ] Test read-only service failover and client rejection of tampered responses. Publish deployment, restore, monitoring and retention runbooks; commit the service after its tests pass.

## Task 4: Wire user-triggered checks into the app

**Files:** Modify `packages/web/src/lib/contracts.ts`, `prize-actions.ts`, `zama.ts`, and `packages/web/src/app/draw/page.tsx`; create `packages/web/src/lib/prize-proof-client.ts` and adjacent tests following existing package conventions.

- [ ] Add failing UI/action tests for pending admission, old unchecked draws after exit, malformed/archive-unavailable responses, transaction replacement/interruption, and already-checked outcomes.
- [ ] Fetch one historical proof per requested draw, validate chain/pool/beneficiary/snapshot scope, submit `checkPrize`, and decrypt the resulting winnings using the existing account signing flow. Mark a check complete only after its confirmed receipt and state reconciliation.
- [ ] Preserve claim-to-wallet and add-to-savings actions after credit; explain pending admission without promising eligibility. Paginate historical draws; checking R rounds costs R checks, not a single constant-cost lookup. Avoid unbounded automatic submissions on login.
- [ ] Keep principal withdrawal and existing credited claims usable during archive outage. Handle actual permission denial distinctly from bounded retries for confirmed-block visibility lag.
- [ ] Run web unit tests, actual build and browser end-to-end tests with the existing Safe/passkey path. Commit after success.

## Task 5: Establish live limits and operational recovery

**Files:** Add a separately configured research capacity runner under `packages/contracts/experiments/claim-lab/`; adapt `packages/keeper/src/draw-worker.mjs` and `transaction-sender.mjs` only where snapshot closing/admission integration requires it; add corresponding keeper tests.

- [ ] Unit-test persisted intent/nonce recovery, exact transaction reconciliation, first-error preservation, duplicate-job suppression, narrow permission retries, and provider/relayer outage handling before live use. Keep closure serial for a dedicated operator; never silently replace a consumed nonce.
- [ ] Before funding anything, write a new run envelope specifying wallets, phases, fee and gas-funding ceilings, gas price, transaction cap, start/stop times and abort criteria. Obtain authorization for that concrete envelope. Do not reuse/extend the completed soak's limits or reset its clock.
- [ ] Exercise increasing distinct active populations and concurrency, including 33+ live accounts and varied/rightmost proof positions where feasible. Simulation of a sparse worst-position fixture is separate evidence, not thousands of funded live accounts.
- [ ] Report unique successes, all failures/timeouts, backlog, offered/completed rates, end-to-end percentiles including unsuccessful attempts, fees, HCU and accounting. Stop at the first budget/safety limit; publish the highest workload meeting an explicitly recorded service objective, not an unlimited-capacity claim.
- [ ] Run an uninterrupted bounded soak of the hardened stack. Complete the untouched 60-day canary test on/after its due date using fresh SDK storage, rebuilt paths, aged handles and actual payout/conservation checks. If aged ciphertext availability fails, block the promised 60-day feature and redesign retention before release.

## Task 6: Release candidate, migration and rollback

**Files:** Add a versioned deployment/migration runbook under `docs/`; update `packages/contracts/scripts/deploy-confidential-pool.ts`, ABI/config manifests and application references only in a later approved release change. Extend `packages/contracts/scripts/smoke-withdrawal.ts` and add migration integration tests.

- [ ] Inventory live addresses, immutable/proxy status, principal, pending withdrawals, Morpho positions, old draw liabilities and credited winnings. Default to a new versioned pool unless an audited upgrade mechanism is verified; a source change cannot update existing immutable bytecode.
- [ ] Test voluntary old-pool withdrawal and explicit new-pool deposit/admission, while old claims and withdrawal settlement remain available. Do not reconstruct secret balances from the indexer or silently copy balances/prize liabilities. Keep a dual-version frontend route for users with old positions.
- [ ] Prove rollback before switching addresses: disable new onboarding/routing if necessary, preserve both pools' claim/withdrawal access, keep both archives and keepers, and never delete or redirect liabilities. Never point new-pool proofs at the old pool.
- [ ] Complete independent review of cryptography, ACL lifetime, randomness, overflow, replay and liquidity interactions. Apply repository Codacy local/cloud PR gates and deployment/build checks for affected services; fix findings before release approval.
- [ ] Prepare a fresh Sepolia release candidate with verified source/runtime hashes and reproducible manifest. Deployment and application address cutover require a later explicit go-ahead. Smoke-test deposit/admission, draw, delayed check, credit/claim/reinvest, queued USDC withdrawal, failover and rollback before opening access.
- [ ] Update roadmap and public documentation only after actual activation. State measured limits, archive dependency and proven claim-retention period. Mainnet launch remains subject to every existing mainnet-program gate.

## Completion criteria

- [ ] More than 32 real participants can use the integrated contract, frontend and withdrawal path; draw closing contains no population scan.
- [ ] Exactly-once individual checks preserve historical entitlement through exit/reuse and never spend principal or another draw's reserve.
- [ ] Durable proof service, backup restoration, historical RPC recovery and service monitoring are exercised.
- [ ] Distinct-wallet live capacity and uninterrupted operation have recorded budgets, objectives and outcomes; real 60-day retention has evidence before promising it.
- [ ] Versioned deployment, old-position access, rollback and independent review pass before application cutover.

No implementation, funded run, redeployment or address change is authorized by this plan's publication. Resume here when the user chooses to do the work.
