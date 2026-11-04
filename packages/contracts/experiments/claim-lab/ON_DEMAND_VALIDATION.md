# User-triggered prize checks and reusable membership

Research follow-up, 2026-10-27. No production pool or frontend integration.
See [the original population/live report](VALIDATION.md) for the separate
4,096-account experiment on the earlier append-only candidate.

## One person can check one draw

Checking everybody is optional. The existing Merkle + FHE design already
accepts a single account's path; there is no participant scan in `closeDraw`
or `claimMerkle`. A user can press **Check for a prize**, obtain their historical
path, submit one check transaction, and decrypt their own result. If the award
is positive, the same transaction sends it to that account. Anybody may pay for
or relay the transaction; the caller cannot choose another recipient.

For a fixed depth-32 tree the contract follows at most 32 levels, regardless
of occupied population. This is bounded work per account per draw. A growing
tree is O(log N); checking R historical draws is still O(R). Checking N people
costs N individual checks only if somebody elects to do that. An indexer cannot
look up a secret ticket's owner without the FHE interval computation.

The button is not an ordinary free `eth_call`: this design persists an FHE
award and transfers tokens onchain, then uses authorized user decryption.
Previously checked results can be read/decrypted again without another claim.
Unchecked prizes stay reserved indefinitely in this probe. Expiry, batching,
gas sponsorship and notifications are product/operational choices still open.

## Alternatives to permanent slots

| Approach | What it solves | Remaining cost or tradeoff |
| --- | --- | --- |
| Larger append-only tree | Removes the 32-address ceiling cheaply | All historical addresses, even empty ones, consume capacity |
| Recycle on explicit full exit | Capacity follows concurrent membership | Must authenticate historical owners/generations after reuse |
| Verify positive received balance before allocating | Zero/insufficient/rejected deposits cannot take tree slots | Asynchronous admission and permanent disclosure of one positive-balance bit |
| Minimum balance or admission bond | Raises the cost of dust/Sybil membership | Additional public or verified threshold, collateral, and access policy |
| Growing tree/shards | Extends concurrent capacity | New routing, snapshot and proof logic requiring separate validation |

The new [ReusableMerkleProbe](contracts/ReusableMerkleProbe.sol) combines explicit
exit with verified positive admission. It uses actual accepted ERC-7984 transfer
amounts. A pending deposit remains withdrawable without an admission proof or
indexer. It receives draw weight only after admission.

The contract publishes `pendingBalance > 0` as an FHE boolean. Anyone can obtain
a threshold-signed decryption proof and finalize admission. It verifies the
stored handle and current request nonce, consuming both before assignment.
Every pending mutation invalidates the old request. Actual balances and tickets
are not published. This bit becomes permanently publicly decryptable, including
new markers after pending withdrawals; see [Zama's public-decryption guide](https://docs.zama.org/protocol/solidity-guides/smart-contract/oracle).

`withdrawAllAndExit` clears the current leaf and puts its slot on a free list.
The slot's checked uint64 generation increments on its next assignment. Frozen
leaves bind historical owner, generation and balance handle. Historical claims
never read current account registration. Draws retain the monotonic index high
water mark, so exiting accounts cannot invalidate an old higher-index claim.
Per-account, per-draw replay protection survives exit and rejoining.

An ordinary withdrawal that happens to empty a balance keeps its slot until
explicit exit: the contract cannot branch on a secret zero without revealing
or proving that fact. Zero callbacks still create pending/ACL/event history;
this is not a complete spam defense. One-unit deposits can still occupy slots.
A depth-32 tree has 2^32 concurrent slots; finite integer, chain throughput and
storage bounds remain. No finite deployment literally supports infinite users.

A ZK positive-balance proof is an alternative only if it proves the relation
to the actual current token-funded state. A user-chosen range or commitment is
insufficient; the original lab reproduces that attack. This revision uses FHE
decryption attestations for admission, rather than adding a new SNARK circuit.

## Persistent historical proof tooling

[ProofArchive](indexer/ProofArchive.ts) is a working local SQLite temporal archive
using Node 24's built-in SQLite. It ingests node changes, assignments, releases
and closes, retaining exact block/log positions. A request finds one account's
historical slot and one path through indexed point-in-time queries. It does not
replay all events per user request. SQL index lookup costs still depend on
database size; this is not a claim of constant-time disk access.

The archive checks the owner/generation leaf, every ancestor and the saved
root. A caller supplies independently read onchain roots. A forged provider
cannot change balances or steal awards through an accepted path. The service
can still omit paths or go offline. Reopening under another chain, pool, depth
or canonical zero tree fails. Conflicting block hashes/events require explicit
transactional rollback. Draw metadata pagination is bounded to 100 rows.

The module is tested tooling, not a production service: it has no HTTP listener,
automatic RPC ingestion/finality policy, backups, availability monitor or deployed
keeper. The live research runner ingests actual pool events into it and reopens
the database before building the historical claim. Canonicality and complete
ingestion remain the caller's responsibilities. See [the API notes](indexer/README.md).

There are two different kinds of stored data:

- Our archive stores onchain hashes and ciphertext **handles**, plus ownership
  history. Lost local files can be rebuilt from complete canonical event logs.
- Zama's coprocessors store the actual encrypted payloads offchain. A handle is
  a pointer to that data; our SQLite file does not contain or restore it. See
  [Zama's FHE library overview](https://docs.zama.org/protocol/protocol/overview/library).

Thus, “archive recovery passed” means we recovered the right historical path
and handles. It does not prove those payloads remain available months later.
We found no hosted retention-duration guarantee in the reviewed documentation.
Likewise, a short successful live lifecycle does not measure sustained
multi-wallet traffic, coprocessor backlog, failure recovery or decryption latency
under load. These remain integration prerequisites. Principal withdrawal needs
no historical archive, but still depends on the chain and FHE infrastructure.

## Verification

[ReusableMerkle.test.ts](test/ReusableMerkle.test.ts) has ten new contract tests;
[ProofArchive.test.ts](test/ProofArchive.test.ts) has fourteen archive tests.
They cover zero/insufficient/cap-rejected deposits, stale true and false proofs,
altered proofs, full-capacity withdrawal, repeated exits, more lifetime owners
than slot capacity, pending-only draws, confidential access control, mixed
principal/prize backing, and claims after exit/reuse/rejoining/archive restart.
An additional 65-funded-account test crosses the old 32-user boundary, confirms
the same close HCU at 32 and 33 members, then checks only account 65. No other
participant must be checked for one person's check to complete.

All **45 research tests** pass, with the opt-in older 4,096-account stress test
skipped in this routine run. All **34 existing production contract tests** pass.
Strict TypeScript checks pass for the new tests, archive and live runner.
The 4,096-account stress result applies to the earlier candidate, not proof of
4,096 concurrent positive-admission transactions on this revision or on Sepolia.

Depth-32 local measurements ([recorded JSON](on-demand-results.json)):

| Operation | Gas | Global HCU | Maximum HCU depth |
| --- | ---: | ---: | ---: |
| Pending deposit | 1,067,046 | 2,844,128 | 995,000 |
| Positive admission | 2,661,938 | 5,508,000 | 162,000 |
| Close | 392,761 | 2,081,096 | 1,747,064 |
| Full exit | 1,645,609 | 5,932,032 | 369,000 |
| One user check (index zero) | 617,738 | 1,288,032 | 757,000 |

Local FHE execution is simulated; local gas understates the upgraded Sepolia
host's state costs. Successful live transactions establish that those particular
operations fit the current live limits, not a throughput guarantee.

Live revision results are recorded separately in
[sepolia-reusable-results.json](sepolia-reusable-results.json) by the resumable
[research runner](sepolia-reusable-validate.ts). It only uses Ethereum Sepolia,
the previously validated research token and research signer/wallets, a gas-price
ceiling of 100,000 wei and a maximum fee budget of 0.0001 test ETH. It records
signed hashes before broadcasting and records fees for successful or reverted
receipts. A missing saved transaction fails closed for manual reconciliation.

The new pool [0xAdB8…2C27](https://sepolia.etherscan.io/address/0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27)
passed **14 confirmed transactions**, blocks 12007443–12007468. The live run:

- Publicly decrypted and verified false and true admission markers. An altered
  boolean failed with the exact external-verifier `KMSInvalidSigner` error.
- Finalized a zero deposit without allocating a slot, then admitted Alice's
  actual three-unit deposit. Funded eleven prize units and closed with FHE RNG.
- Withdrew Alice's principal, admitted Bob's seven units into the same index at
  generation two, and reopened the persisted historical archive.
- [Checked Alice's old draw](https://sepolia.etherscan.io/tx/0x67a0de9599430c9db4d95d6844f5142f02a177ad892685340102a28103d6e067)
  at generation one while Bob remained unchecked. Alice privately decrypted her
  eleven-unit award. Redirection and replay returned exact `InvalidProof` and
  `AlreadyChecked` errors; Bob's attempt to decrypt Alice's award was denied.
- Withdrew Bob's principal and compared all three wallets' authorized token
  balances against their initial balances. Principal and prize transfers were
  conserved. The sponsor lost eleven units, Alice gained eleven, Bob was unchanged.

The run spent **0.0000061238499 test ETH** in fees. Public admission-proof
responses sampled **2.262–6.804 seconds**, excluding transaction confirmation.
Live gas was 9,559,698 for first positive admission, 3,094,863 for recycled
admission, 1,775,376 for the old user check, and approximately 3.23 million per
full exit. Deployment used 22,002,144 gas on the upgraded Sepolia host; its state
cost accounting differs from the local Cancun simulator.

The harness initially failed to decode the signature rejection because the
external verifier's custom error was absent from the pool ABI. We inspected
the returned selector, matched it to the installed FHE verifier source, added
that error ABI, and resumed the same deployment. No onchain transaction reverted;
the assertion incidents remain in the JSON. Negative checks now require exact
contract errors, so unrelated RPC failures cannot satisfy them.

This is still a two-wallet live lifecycle, not sustained population load or
long-term retention evidence. The indexer needs operational packaging and
recovery procedures before integration. Minimum holding periods/eligibility,
prize liability retention, dust resistance, and production yield/withdrawal
composition also remain open; reusable slots do not solve those policies.

Reproduce local checks from `packages/contracts`:

```sh
pnpm exec hardhat test --no-compile --config experiments/claim-lab/hardhat.config.ts
pnpm test
```

The live runner resumes its own saved deployment and uses existing research
wallets from the ignored cache. Configure the existing signer/RPC through the
environment, then run:

```sh
pnpm exec hardhat run --no-compile --config experiments/claim-lab/hardhat.config.ts \
  --network sepolia experiments/claim-lab/sepolia-reusable-validate.ts
```
