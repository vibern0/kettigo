# Snapshot-tree feasibility validation

Date: 2026-10-19. This is a **throwaway research prototype**, not a replacement
for the production pool. Its unrestricted `ForTest` methods deliberately bypass
token funding, authentication, and deployment safeguards.

## Verdict

The encrypted snapshot-tree and per-account prize-settlement approach is feasible
in the installed Zama/EVM environment. It removes the fixed participant admission
cap and the requirement to process all participants when closing a draw.

This validates the draw mechanism, not production readiness or literally infinite
capacity. Persistent storage and deposit gas are substantial. Token integration,
live coprocessor latency, and sponsored-account economics still need validation.
Production sources, dependencies, and deployment configuration were not changed.

## Reproduce

Run from the repository root after installing the contracts package from its
frozen lockfile:

```sh
pnpm --dir packages/contracts exec hardhat test --config experiments/snapshot-tree/hardhat.config.ts
pnpm --dir packages/contracts exec tsc --noEmit --target ES2022 --module commonjs --esModuleInterop --skipLibCheck experiments/snapshot-tree/hardhat.config.ts experiments/snapshot-tree/test/SnapshotTreeProbe.test.ts
pnpm --dir packages/contracts exec hardhat test
node packages/contracts/experiments/snapshot-tree/read-sepolia.mjs
```

The first command writes `results.json`. The final command performs only
read-only RPC calls and writes `network-check.json`. It never loads a signer.

Environment: Node 24.21.0, Hardhat 2.29.1, Solidity 0.8.28, optimizer 200 runs,
via IR, Cancun EVM; `@fhevm/solidity` 0.11.1; Hardhat plugin and mock-utils 0.4.2.

## Evidence

The probe has 21 tests. The unchanged production contract suite has 34 tests.
The probe TypeScript check passes independently of Hardhat's test transpilation.

The tests cover:

- 65 independently registered address records, including tree growth at 32/33
  and 64/65, withdrawal, and return without duplicate registration.
- A fully materialized tree with 1,024 distinct address records. Registration
  setup uses plaintext test helpers; this is not 1,024 wallet onboarding sessions.
- Real encrypted deposit/withdrawal inputs and owner-only user decryption.
  Another account cannot decrypt principal or winnings; participants cannot
  decrypt the aggregate principal or draw ticket.
- The actual `FHE.randEuint64()` draw path. Deterministic random-word helpers
  separately exercise exact interval boundaries.
- All eight tickets in a distribution with weights `[0, 1, 3, 0, 4]`, with
  settlement in reverse registration order. Exactly one nonzero interval receives
  each prize; the allocation is `[0, 1, 3, 0, 4]` prizes.
- Immutable draw eligibility after withdrawal, deposit, account registration,
  reinvestment, and later draw closure. A last-index winner can withdraw their
  full principal after cutoff and still settle the closed draw.
- Replay prevention for winning and losing accounts, invalid draw IDs, independent
  later draws, out-of-order settlement, and repeated claims without double payment.
- Prize carry through empty and all-zero draws, per-account arithmetic overflow,
  retained winnings when reinvestment exceeds the account cap, and explicit
  aggregate overflow rejection at `2^64 - 1`, independent of participant count.
- An independent balance/interval model across 104 balance changes, eight draws,
  and 64 delayed settlements with a deterministic pseudorandom workload.
- Exact path depths 5, 10, 14, 20, 24, and 32 using compact uniform fixtures.

Large fixtures share equal immutable subtrees. They exercise the exact traversal
depth, ciphertext operations, snapshot updates, and worst-index prefix checks.
They do **not** demonstrate onboarding or operating millions/billions of wallets,
real-world throughput, or the full storage footprint of independent accounts.
The 1,024-address materialized check independently matches the compact fixture's
draw-close and prize-check gas at that depth in this environment.

## Measurements

Local EVM gas, rounded. See `results.json` for exact gas, FHE event counts, global
HCU, and maximum sequential HCU depth. These are pool-core operations, excluding
ERC-7984 transfer/wrapping, Morpho, Safe, Pimlico, relayer charges, and keeper
infrastructure.

| Population/fixture | Deposit or registration | Close draw | Check last-index account | Withdrawal |
| --- | ---: | ---: | ---: | ---: |
| 1,024 materialized addresses | 1.43M | 0.395M | 0.510M | not profiled |
| 1,024 compact leaves, depth 10 | 1.48M | 0.395M | 0.510M | 1.39M |
| 1,048,576 compact leaves, depth 20 | 2.63M | 0.395M | 0.743M | 2.54M |
| 16,777,216 compact leaves, depth 24 | 3.08M | 0.395M | 0.836M | 2.99M |
| 4,294,967,296 compact leaves, depth 32 | 4.00M | 0.395M | 1.02M | 3.91M |

The materialized registration uses the plaintext setup helper; compact-fixture
deposit and withdrawal measurements include encrypted external-input validation.
Differences between those columns should not be interpreted as an account-growth
discount. Compact fixtures can also benefit from EVM access reuse.

Draw close is independent of participant count: approximately 2.081M global HCU,
1.747M maximum sequential HCU, ten FHE events, and 394,834 local gas for every
profiled depth. At depth 32 the encrypted deposit uses approximately 6.198M global
HCU and 0.581M sequential HCU; checking the last index uses approximately 5.886M
global HCU and 1.360M sequential HCU.

Every measured tree operation fits the documented 20M global / 5M sequential HCU
budgets enforced by the local host contracts. Zama's [HCU documentation](https://docs.zama.org/protocol/solidity-guides/development-guide/hcu)
describes those as devnet limits; this report does not independently measure the
live Sepolia limits.

### Existing scan comparison

The comparison deploys the **unmodified** `ConfidentialPrizePool`, with a test-only
token callback driver and no Morpho adapter. It isolates the existing draw.

| Registered addresses | Close result | Local gas | Global HCU | Sequential HCU |
| --- | --- | ---: | ---: | ---: |
| 2 | executes | 0.658M | 3.914M | 2.302M |
| 8 | executes | 1.895M | 9.765M | 2.596M |
| 16 | executes | 3.545M | 17.566M | 4.650M |
| 32 | reverts | unavailable | unavailable | `HCUTransactionDepthLimitExceeded` |

The configured 32-address limit is therefore not evidence that a 32-person draw
is executable. The 33rd registration also reverts with `TooManyParticipants`.
The baseline test records a reverted draw as a failure outcome in the metrics;
the test itself passes only if it observes the expected HCU-limit rejection.

## Why this works

Each account has a stable public leaf index. Encrypted subtree totals are internal
to the pool. A deposit or withdrawal copies the index's path, applying the same
validated encrypted delta independently to every ancestor. Historical roots stay
immutable; closing a draw only saves a root, count, depth, prize, and random ticket.

A checking account follows its **own public index**, not a secret winner index.
The pool sums the relevant left-sibling totals and tests the encrypted interval
`prefix <= ticket < prefix + snapshotBalance`. It credits the encrypted prize or
zero and records that account/draw as checked. The caller supplies neither an
alternative account nor an unauthenticated interval proof. Sibling sums and the
ticket never gain user decryption permission. Non-winners execute the same
encrypted selection and crediting operations.

Two details matter for FHE depth:

1. Ancestors update from the same accepted delta instead of recomputing each
   parent from a newly computed child.
2. Prefix terms use a balanced reduction instead of a sequential running sum.

Closing costs O(1) with respect to membership. Balance changes and checking one
draw cost O(log N). An account checking D missed draws still needs O(D log N)
work; the frontend must chunk catch-up. If everyone checks every draw, the total
work across users is O(N log N), even though no draw-wide transaction is required.

## Limits and unresolved decisions

- **Storage and gas:** this simplest persistent tree allocates `depth + 1` new
  three-slot nodes on each existing-account balance change. At depth 20 that is
  21 nodes, about 2 KB of logical node slots, plus other state. Old roots and
  unclaimed draw records must remain available. A production design needs a
  storage/cost budget and should evaluate compact layouts or checkpointing.
- **Economic scalability:** at a hypothetical 1 gwei gas price, a 2.63M-gas
  deposit core costs 0.00263 ETH before the excluded overhead. Technical
  executability does not establish affordable small deposits. No fiat-price
  assumption is used here.
- **Token backing:** the probe proves internal prize-reserve conservation,
  principal accounting, and selection. It does not transfer real ERC-7984 tokens,
  restore Morpho liquidity, or prove a fully integrated asset/liability invariant.
- **Randomness precision:** the existing multiply-high mapping
  `floor(random64 * total / 2^64)` has finite-resolution bias when the total does
  not divide `2^64`. Tests document this rather than describing the mapping as
  mathematically exact uniform randomness. A participant interval's probability
  differs from ideal proportional odds by less than `1 / 2^64`; this is inherited
  draw math, not a new tree effect.
- **Product behavior:** winnings are determined by the frozen draw, but materialize
  in the account's winnings ledger when that account settles. “Check prize” needs
  a sponsored transaction followed by EIP-712 user decryption. This has not been
  exercised through the existing passkey/Safe frontend.
- **Availability:** an offline winner's prize remains reserved. There is no
  forfeiture, expiry, pruning, or automatic global settlement in this prototype.
- **Security scope:** passing access-control and conservation tests is not an
  audit or a formal privacy proof. The helper entry points are intentionally
  insecure and must never be exposed in a funded contract.
- **Live verification:** read-only Sepolia metadata succeeds; see
  `network-check.json`. No deployment signer is configured in the contracts
  environment, so the probe was not deployed. Live FHE execution, decryption
  latency, real gas, and sponsored-account costs remain unverified.

## Recommended next gate

Proceed to a written production design only with the cost tradeoff acknowledged.
Keep one pool, FHE randomness, encrypted balances/winnings, and frozen eligibility
at draw close. Explicitly design ERC-7984 backing, prize escrow, withdrawal weight
updates, historic-state retention, bounded catch-up, and sponsorship budgets.
Then validate a disposable Sepolia canary with actual tokens and the real
passkey/EIP-712 flow before selecting a production layout or migrating users.

This experiment does not select another network, authorize a live migration, or
modify any existing pool or yield-adapter deployment.
