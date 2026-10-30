# Merkle + FHE validation, 2026-10-27

The approach passed **4,096 funded local accounts and every account's claim
check**, and an isolated **two-participant Sepolia lifecycle** using real FHE
inputs, randomness, token transfers and EIP-712 user decryption. No production
contracts or frontend were integrated or redeployed.

It is a viable research candidate, but is **not ready for integration** without
decisions on eligibility, admission, claim costs and historical data service.
The live test is an interoperability/security smoke test, not a 4,096-user
Sepolia load test or an audit.

Follow-up: [user-triggered checks, reusable slots, positive admission and a
persistent SQLite archive](ON_DEMAND_VALIDATION.md). The slot-exhaustion finding
below describes this original append-only candidate; the new probe tests an
alternative. No full-population scan is required for individual prize checks.

## Population experiment

Both the original mode-2 lab and the stripped Sepolia candidate were separately
tested with 4,096 distinct local accounts. Each account received underlying
tokens, approved and wrapped them, and deposited through the real ERC-7984
callback. No synthetic population or privileged balance seeding was used.
Hardhat impersonation supplied local transaction senders. The FHE backend was
the local simulator; this does not measure live signing or coprocessor TPS.

Every account underwent a historical eligibility check after 64 accounts had
withdrawn and redeposited. Independent plaintext balances/ticket were used
only as local assertions, never as proof inputs. Exactly one 13-unit prize was
paid. All remaining principal stayed backed. A cold event replay reconstructed
the frozen tree after the later mutations.

Results for the deployed candidate's source:

| Measurement | Result |
| --- | ---: |
| Actual funded participants / claim checks | 4,096 / 4,096 |
| Tree depth / finite slot capacity | 32 / 2^32 |
| Stored current-tree nodes | 8,211 |
| Historical node events at the draw | 135,168 |
| Decoded event JSON | 88,476,960 bytes |
| Cold historical replay | about 7 seconds locally |
| Complete local run | about 128 seconds |
| Peak runner RSS | about 4.7 GiB |
| Close gas, local Cancun model | 372,580 |
| Close HCU total / depth, installed local model | 2,081,096 / 1,747,064 |
| Claim gas, local Cancun model | 618,501–779,264 |
| All 4,096 checks, local gas sum | 2,842,637,843 |

Closing at 1, 32, 33, 256, 1,024, 2,048 and 4,096 accounts used the same HCU.
Deposit HCU also stayed approximately 7.59 million at fixed depth. Gas changes
with new versus existing storage and claim index. Current tree storage is
overwritten, but archived events, ACL entries, ciphertexts and per-draw claim
state continue growing. The runner's memory use is a test-tool measurement,
not a protocol capacity limit.
In particular, permanently allowing each new historical handle to the pool
still grows the global ACL state with updates and tree depth. Overwriting the
pool's own tree does not eliminate that storage cost.

The measured workload and exact values are in
[stress-candidate-results.json](stress-candidate-results.json). The independent
original-lab run is in [stress-results.json](stress-results.json).

## Sepolia evidence

Deployment uses a dedicated test ERC-20, its confidential wrapper, and the
stripped [SepoliaMerkleProbe](contracts/SepoliaMerkleProbe.sol). The probe has
no deterministic draws, sparse-index fixture, ZK claim mode or public-reveal
entrypoint. Only its owner can close draws. This controls the research run;
it does not implement a production draw/eligibility policy.

- [Research pool](https://sepolia.etherscan.io/address/0xBe1Ee20673C3f93C9F10cCE4A843277d86A6c5A8)
- [Confidential token](https://sepolia.etherscan.io/address/0x514e9fA654e29e55a8d2529bCC0dfdD20b740f39)
- [Underlying test token](https://sepolia.etherscan.io/address/0x2bD792E7cEa3b81eD66f78F6091b4493e8EFc1A4)

Two new wallets deposited 3 and 7 units. A separate sponsor funded 11 units.
The owner closed a draw with FHE randomness. The first wallet withdrew before
claiming; the archive was then rebuilt from the exact close event, and a keeper
submitted both checks to their fixed beneficiaries. User decryption returned
awards 0 and 11. Both principals were withdrawn and both wallet token balances
returned to their wrapped amount plus the appropriate award.

The live flow verifies own-principal/award decryption, structured
`NOT_ENTITLED` rejection for another account's historical principal, the ticket
and the root sum, and exact `NotEligible`/`AlreadyChecked` errors for redirection
and replay. Negative contract checks use `staticCall`, so acceptance cannot
accidentally send a transaction. Research plaintext amounts and awards are
recorded intentionally; publishing them discloses this fixture's winner.
One live random draw establishes interoperability and payout conservation,
not a statistical test of weighted randomness or an independent RNG audit.

The script verifies deployment creation input against the compiled artifact
and constructor arguments, checks owner/token/depth/underlying, and records
the actual runtime code hash separately from the compiler template hash.
All receipts and current status are in [sepolia-results.json](sepolia-results.json).

Representative confirmed receipts:

| Operation | Actual Sepolia gas | Receipt |
| --- | ---: | --- |
| Deploy research pool | 18,269,861 | [deployment](https://sepolia.etherscan.io/tx/0x62f7e01ea4b222b797a61737c97cca2c638dc1a43b38d4ee23783acc2b6c62d0) |
| First participant deposit | 11,127,415 | [deposit](https://sepolia.etherscan.io/tx/0x4634fcf39bfa0d4f223de1d9b33f3f13cd363182b78b032b811ef21cbf10c842) |
| Second participant deposit | 4,752,213 | [deposit](https://sepolia.etherscan.io/tx/0xcdc8401079492531c960bcbae3bbd50d8ca55ba14da12f02c6680fdbb556480d) |
| FHE random draw | 1,342,690 | [close](https://sepolia.etherscan.io/tx/0x07e0f57ebe7ff535cac2cda91bb5f955b62fcc35af248338e5b25aa8f2f2386f) |
| Historical checks and payouts | 1,776,031 / 1,780,210 | [first](https://sepolia.etherscan.io/tx/0x00f2a7949d7b1980d19bfd1d9b7b96abad98fbe4e01f405cd3aef0baeeed4e13), [second](https://sepolia.etherscan.io/tx/0xdd870d0f028695e68d38c00d48ad39bad9019fb9e307160bf20dd862bd66746a) |
| Withdraw principal | about 3.37 million | [withdrawal](https://sepolia.etherscan.io/tx/0xa2b059a4962394add555ac7564b1bd7b0f26209d1bee7fbc091e83485ab34457) |
| Two-deposit transaction batch | 7,597,722 | [batch](https://sepolia.etherscan.io/tx/0x81dc23ece0e38f7aba0715d0bd975389b616dc021923d12cd1daff8e8adfd507) |

Initial measured encryption calls took approximately 3–8 seconds; own-value
decryptions approximately 2.4–4.6 seconds. These are small samples, include
client/relayer work, and do not establish a latency SLA. Transaction confirmation
usually required a block and sometimes two. Retries overwrite latency samples;
the saved JSON is the authority for the final run's measurements.

## Actual transaction limits and local/live differences

Read-only live calls discovered executor
`0x92C920834Ec8941d2C77D188936E1f7A6f49c127`, version `FHEVMExecutor v0.5.0`,
and HCULimit `0xa10998783c8CF88D886Bc30307e631D6686F0A22`, version
`HCULimit v0.3.0`. At the sampled blocks, the transaction limits were
20,000,000 total HCU and 5,000,000 HCU depth. The configured block HCU cap was
281,474,976,710,655. These settings are mutable and are queried during each run.
The installed local plugin uses an older host/HCU implementation.

At depth 32, a token `multicall` containing **two deposits fits; three do not**.
This is tested locally and against the live host: the oversized live call is
simulated and must return exactly `HCUTransactionLimitExceeded`; the two-deposit
batch is actually mined, its 2-unit principal decrypted, and then withdrawn.
The normal one-deposit transaction budget does not grow with population.

Sepolia currently uses Amsterdam gas accounting. Local tests target Cancun.
State-heavy operations are therefore substantially more expensive live than
the original local gas estimates. Total transaction gas can exceed the old
16-million figure because execution and state gas have separate budgets. Do
not extrapolate mainnet fees, TPS or live capacity from the local wall clock.
Sources: [current Zama addresses](https://docs.zama.org/protocol/solidity-guides/smart-contract/configure/contract_addresses),
[Sepolia network configuration](https://github.com/eth-clients/sepolia),
and [EIP-8037](https://eips.ethereum.org/EIPS/eip-8037).

An initial underlying-token deployment hit Hardhat's 1-gwei fee floor and spent
0.003699856 test ETH. Later transactions use an explicit 100,000-wei gas price.
The complete 24-receipt run spent 0.0037077672935 test ETH in transaction fees;
the temporary research wallets were also funded with 0.00001 test ETH each.
The live harness now signs with fresh pending nonces, records hashes before
broadcast, reconciles saved receipts, and checks remaining maximum fee budget
before sending. The fee incident and a stale-nonce failure are recorded; they
are tooling issues, not protocol performance measurements. No private key is
stored in the report or source.

## Security and integration decisions

1. **End-of-draw weight permits short holding periods.** A reproduced test funds
   an empty pool, deposits one unit, closes with real FHE randomness, withdraws,
   and takes the full reserve. This is legitimate under the current eligibility
   rule, not forged weight. Arbitrary close timing makes it easier. Owner-gated
   closure does not prevent just-in-time deposits around a known draw. Decide
   minimum holding period, prior snapshots or time-weighted eligibility before
   marketing this as rewarding longer-term savings.
2. **Zero/rejected deposits and withdrawn accounts consume permanent slots.**
   A depth-4 test exhausts all 16 slots with actual zero-value callbacks, then
   rejects a genuine new participant while preserving their tokens. Depth 32
   makes complete exhaustion expensive, but state spam and lifetime address
   churn remain. Capacity is finite; this is not unlimited admission.
3. **Checking all accounts voluntarily costs O(N) individual checks.** Users
   can instead check only themselves; nobody must scan the population. A secret
   ticket cannot be looked up by the indexer. Each checked account needs a
   transaction to compute and persist its award before decryption. A keeper can submit checks but cannot
   decrypt users' results. The 4,096-check local sum is 2.84 billion gas, before
   accounting for Amsterdam's higher state costs. Decide who pays and when
   checks are submitted. O(1) close does not make all-user settlement free.
4. **Historical service is a liveness dependency.** The old helper replayed the
   latest tree and failed to recover a past draw after mutations. That bug was
   reproduced and fixed. New tests cover exact same-block close ordering,
   shuffled/duplicate/missing/removed logs, pagination and replay after a branch
   rollback. This is a reconstruction tool, not a durable production indexer
   with finality, checkpoints, backups and operational recovery.
5. **Retention and sustained live load are unproven.** The live test consumes
   historical handles after mutations over minutes. It does not establish
   weeks/months of ciphertext availability. No hosted retention SLA was found.
   Root updates also create dependencies across deposit transactions, so a
   live burst may build coprocessor backlog even if each transaction fits HCU.
   A sustained multi-wallet load/soak test is still needed to quantify that.
6. **Privacy is narrower than anonymity.** Addresses, indices, timing, handle
   topology and claim activity are observable. Public-handle reuse tests reject
   unauthorized withdrawals/transfers, and aggregate ACLs do not carry one
   depositor's allowance into another depositor's new totals. Winner-only later
   actions or unwrapping can still reveal information. RNG remains the existing
   multiply-high 64-bit mapping with finite-resolution bias.
7. **Production composition is not tested.** This pool keeps its test-token
   principal liquid. Morpho, queued withdrawals, Safe/account abstraction,
   keeper scheduling, upgrade/governance policy and adversarial reentrancy with
   other token implementations need separate integration and audit work.

## Reproduce and inspect

Final verification: 21 focused lab tests passed; the large stress test is
opt-in and was separately run successfully for both contracts. The unchanged
production suite passed 34 tests and the prior tree-probe suite passed 21.
Strict TypeScript checking passed for the lab configuration, tests and live
runner. Independent read-only review found no new Merkle binding/accounting
defect; its live-runner receipt recovery, pre-send budget, code provenance and
precise-negative-check findings were addressed and exercised by the resumed
live run. This review is not a security audit.

Use the pinned `pnpm@10.11.1` and the lab's frozen install. Existing circuit
artifacts are generated using the instructions in [README.md](README.md).
From `packages/contracts`:

```sh
pnpm exec hardhat test --config experiments/claim-lab/hardhat.config.ts
MERKLE_STRESS=1 STRESS_CANDIDATE=1 pnpm exec hardhat test --config experiments/claim-lab/hardhat.config.ts experiments/claim-lab/test/MerkleStress.test.ts
```

For live validation, set `DOTENV_CONFIG_PATH` to an existing funded Sepolia-only
signer environment. The script never uses production contract-address env
values and resumes only the isolated addresses in its own result file.

```sh
DOTENV_CONFIG_PATH=/absolute/path/to/contracts/.env DOTENV_CONFIG_QUIET=true RESEARCH_GAS_PRICE_WEI=100000 node -r dotenv/config node_modules/hardhat/internal/cli/cli.js run --no-compile --config experiments/claim-lab/hardhat.config.ts --network sepolia experiments/claim-lab/sepolia-validate.ts
```

Do not delete the live result file to restart: it contains receipts required
to prevent duplicate transactions. New research-wallet keys are stored with
mode 0600 only in ignored `cache/sepolia-research-wallets.json`. Keep that file
locally if resuming. The Sepolia relayer needs no signup/API key, per
[Zama's auth guide](https://docs.zama.org/protocol/sdk/guides/relayer-api-keys).
