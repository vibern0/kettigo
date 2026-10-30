# Funded claim security experiments

Follow-up: [4,096-account stress test and live Sepolia validation](VALIDATION.md).
Further research: [user-triggered checks, reusable slots and SQLite proof history](ON_DEMAND_VALIDATION.md).

Local research started 2026-10-24; validation rerun 2026-10-27. Production contracts and deployment addresses
were not changed. This lab is deliberately unsuitable for deployment: mode A
contains a reproduced security flaw, and deterministic draw and sparse-index
helpers are unrestricted.

## Result

The best candidate tested here is **an authenticated historical Merkle path,
followed by an FHE interval check and a confidential payout**. It removes the
32-participant scan from draw closing. A Groth16 membership proof can replace
the Merkle authentication, but added substantial cost in this experiment.

This is evidence of local feasibility, not proof of production security or
literally unlimited capacity. The tested 32-level tree has 2^32 address slots;
individual amounts and the aggregate also have finite integer bounds. Every
operation has bounded work independent of how many slots are occupied. A
larger tree or growing-tree implementation needs its own validation.

See [the contracts](contracts/ClaimLabPool.sol), [tests](test/Claims.test.ts),
[circuits](zk/), and [recorded measurements](results.json).

## A: a ZK proof of a committed ticket range — security acceptance failed

An honest account deposits 100 units through the actual ERC-7984 token. An
attacker deposits 1 unit but commits to the interval `[0, 101)`. The contract
constructs the canonical tree itself: each leaf binds the account, the actual
encrypted balance handle, and the submitted range commitment. The attacker
does not choose a fake tree root or bypass the verifier.

The circuit proves membership, range bounds, and possession of the range
secret. The round's ticket and total are opened using the Zama public
decryption proof and checked against the stored handles. With ticket 0, which
belongs to the honest account's actual interval, the attacker's real Groth16
proof verifies onchain and transfers the entire 7-unit prize to the attacker.

The missing constraint is that the committed interval length equals the amount
in the encrypted balance. Putting a ciphertext handle next to a commitment
does not establish that relationship. This falsifies this particular
commitment-only integration; it does not show that all ZK constructions are
impossible. A different construction would need a verified plaintext/ciphertext
relation, authoritative commitment updates, conservation, and snapshot binding.
Opening the ticket also changes the privacy model and requires a decryption
round trip.

The explicit security acceptance command below fails with `expected 7 to equal
0`. The default test instead requires the counterexample to remain reproducible
and records mode A as unsound; its passing status does not endorse mode A.

## B: ZK membership authentication + FHE comparison — local tests passed

The contract derives balances from actual token callbacks and updates a
Poseidon tree. The Groth16 circuit authenticates the beneficiary, leaf index,
leaf balance handle, sibling handles, intermediate handles, and frozen root.
Full 256-bit handles are split into two constrained 128-bit limbs. The public
scope includes chain ID, contract address, and draw ID. Reuse in a later draw
fails even when its tree root is unchanged.

The circuit does not ask a prover to know the secret winning ticket or any
hidden balances. FHE computes the prefix interval and comparison after proof
verification. No debugger-decrypted value is used as a proof witness. The
circuit has 49,480 constraints and 73 public signals including its output.
Proof generation plus offchain verification took approximately four seconds
on this machine. The same proof is also checked by the generated Solidity
verifier before any payout.

This proves membership in the authoritative encrypted state. It provides no
anonymity in this design: the beneficiary and sibling handles remain public.
The output called `nullifier` is a deterministic scope tag, not an anonymous
credential. Replay protection is enforced per beneficiary and draw.

## C: Merkle membership authentication + FHE comparison — preferred candidate

Keccak hashes authenticate exactly the same kind of ciphertext-handle path,
without a separate SNARK. Leaves and internal nodes have different domains;
left/right position is determined by the account's registered index. Internal
hashes bind both child hashes and both child sum handles. Every intermediate
sum is bound by its parent hash, and the last sum must equal the saved root sum.

The current tree is overwritten on deposits and withdrawals. Every changed
node emits its hash and handle, allowing an untrusted indexer to reconstruct
historical paths. Each draw stores its root hash, root sum, ticket, prize,
remaining prize, and participant count. Later mutations cannot change that
round. Historical ciphertexts remain allowed to the pool.

Anyone can submit an authenticated check for a beneficiary. A check transfers
zero or the prize to that fixed beneficiary and grants only that beneficiary
access to the award. A caller cannot redirect it. This permits a keeper to
submit claims while keeping the recipient independent of the caller. Both
losing and winning checks are protected against replay. The lab uses a direct
check-and-payout flow; it does not implement a separate accumulated-credit UX.

## Measurements

Both B and C use 32-level trees in the comparison below. These are local EVM
gas and the installed FHE backend's HCU estimates, not live Sepolia latency,
fees, or coprocessor performance. Values are rounded; `results.json` preserves
the latest run. Deposits include actual wrapper-token transfer callbacks;
withdrawals and claim checks include actual confidential token transfers.

| Operation | B: Groth16 membership + FHE | C: Merkle path + FHE |
| --- | ---: | ---: |
| First funded deposit | 7.65M gas | 3.28M gas |
| Withdraw principal | 6.08M gas | 1.72M gas |
| Close draw | 411k gas | 393k gas |
| Check and pay, simple index | 1.25M gas | 624–629k gas |
| Check calldata | 2,628 bytes | 3,396 bytes |
| Close global HCU / depth | 2,081,096 / 1,747,064 | 2,081,096 / 1,747,064 |

C closed draws after 1, 33, and 65 actual funded participant callbacks with
identical HCU usage. EVM gas changes slightly with storage initialization.
The 65 accounts hold 2,145 total units. This is actual distinct local account
and token state, not a synthetic claim of millions of onboarded users.

A separate sparse-slot fixture places two funded accounts at opposite ends
of a depth-32 tree. It exercises the full 32-term prefix, without claiming to
materialize 2^32 users: about 1.01M claim gas, 6,310,032 global HCU and
1,567,000 HCU depth. This stays below the installed backend's transaction
limits. Most sibling sums in that sparse fixture are zero. The balanced
reduction avoids a 32-step FHE dependency chain.

At 65 participants, the current tree stores 160 nondefault nodes. Adding one
more account creates one node; repeated deposits by that account create no
additional tree nodes. Old rounds still need archived event data and
historical ciphertext availability: this reduces onchain tree-history storage,
not total data growth.

## What the tests check

The lab has 11 passing tests, including the reproduced mode-A counterexample.
The suite also checks actual backing after withdrawal and payout, insufficient
token balance producing zero accepted weight, account caps and refunds, token
callback authentication, input-owner binding, snapshot preservation, duplicate
claims, cross-round replay, public-statement tampering, failed attempts to
generate witnesses for forged balances/intermediate sums, unauthorized award
and ticket decryption, zero balances, empty-round prize carry, and every ticket
in a small weighted distribution.

The unchanged production suite has 34 passing tests. The previous
snapshot-tree feasibility suite has 21 passing tests. Those earlier probes
include separate aggregate-overflow and randomized-model tests; they are not
substitutes for testing this funded lab. TypeScript checking is also run for
this lab's configuration and test files.

## Limits and decisions still needed

- Closing the draw is O(1); checking one account is O(tree depth), bounded by
  32 levels in the tested tree. Users can check individually; there is no
  required all-user scan. Checking everyone voluntarily still costs O(N)
  individual checks. The indexer cannot directly identify a secret ticket's owner.
- The indexer has no authority over amounts or winners, but path availability
  matters. Archived paths can be rebuilt from events or served by multiple
  providers. Provider outage, reorg handling, data recovery, and long-term
  Zama ciphertext retention were not validated on the live network.
- Principal withdrawal uses current onchain state and needs no historical
  witness. The lab keeps principal liquid; it does not validate queued
  withdrawals or compose this design with Morpho, Safe, or account abstraction.
- Addresses, tree positions, timing, handle topology, and claim activity remain
  observable. Winner-only activity can reveal information. Keeping the ticket
  secret does not eliminate transaction-metadata disclosure.
- This preserves the existing multiply-high mapping of a 64-bit FHE random
  word into the total. Non-power-of-two totals have finite-resolution bias;
  this experiment does not implement exact rejection sampling.
- Groth16 uses fresh local research keys, not an audited production ceremony.
  Circuits, domain separation, trusted setup, contract integration, concurrency,
  Sybil storage spam, and claim liveness require further security work.
- The local FHE backend simulates encrypted execution. The SNARK computation,
  generated verifier, ordinary token state transitions, and adversarial calls
  are real local code, but this is not a live cryptographic FHE benchmark or a
  security audit. No external account or service signup is required.

## Reproduce

The contract workspace uses `pnpm@10.11.1`. In that workspace, first run its
normal frozen install if dependencies are absent. Then install the isolated
lab dependencies:

```sh
cd packages/contracts/experiments/claim-lab
pnpm install --frozen-lockfile
```

Install Circom 2.2.3 as `.tools/circom`. The binary used on macOS in this run is
the official [macos-amd64 release](https://github.com/iden3/circom/releases/download/v2.2.3/circom-macos-amd64),
with SHA-256
`e006332b3fe225f11c3b87bd2debbf5d7f568d6efbde25e5a6a12cd6988c8ecb`.
Make it executable. Other platforms must use their appropriate official binary.

```sh
node zk/build.mjs
cd ../..
pnpm exec hardhat test --config experiments/claim-lab/hardhat.config.ts
```

The build compiles both circuits, creates local test-only setup material, and
exports both Solidity verifiers. It takes several minutes on a fresh machine.
Unchanged local keys are reused. Large keys, binaries, generated verifiers,
build output, and node_modules are ignored. No production files are edited.

To reproduce the failed mode-A security acceptance criterion:

```sh
EXPECT_RANGE_SECURE=1 pnpm exec hardhat test --config experiments/claim-lab/hardhat.config.ts --grep 'A: reproduces'
```

That command intentionally exits nonzero. A partial test run overwrites the
measurement file with only its own results; rerun the full suite afterward.

Type check from `packages/contracts`:

```sh
pnpm exec tsc --noEmit --target ES2022 --module commonjs --esModuleInterop --strict --skipLibCheck --types node,mocha hardhat.config.ts experiments/claim-lab/hardhat.config.ts experiments/claim-lab/test/Claims.test.ts experiments/claim-lab/test/helpers.ts
```

Primary references: [Zama encrypted-input validation](https://docs.zama.org/protocol/solidity-guides/smart-contract/inputs),
[Zama verified public decryption](https://docs.zama.org/protocol/solidity-guides/smart-contract/oracle),
and [Circom's Groth16 setup and Solidity verifier workflow](https://docs.circom.io/getting-started/proving-circuits/).
Zama's input proof validates the encrypted input; the separate claim relation
must still be enforced by the application. The installed token implementation
is the authority for callback behavior used in these tests.
