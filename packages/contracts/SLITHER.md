# Solidity security review for PR #52

## Principal restoration

Morpho's withdrawal result is a claim about how much USDC the adapter received.
The adapter now reads its USDC balance immediately before and after withdrawal.
It requires the closing balance to cover the opening balance plus the amount
reported by Morpho. Full restores still redeem the position by shares, use the
one-unit rounding reserve when needed, and send surplus to the prize pool.
The adapter updates the principal and reserve before interacting with Morpho.
A short delivery or a failed wrap reverts the transaction, including those
updates. Harvest uses the same receipt check.

Slither reports two high-impact `reentrancy-balance` paths in this code. In
`_withdrawFromMorpho`, the opening balance is the lower bound needed for the
receipt check. The closing balance comes from a new call to the immutable USDC
contract. In `restorePrincipalToPool`, the opening balance determines how much
liquidity to request. Every entry that can move adapter funds requires the pool
as caller and takes the same reentrancy guard. The pool also serializes manual
restore, settlement, draw close, pending-principal unwrap and paid prize claim.
The adapter requires delivery before it wraps. These two residual warnings are
false positives under the deployed USDC, wrapper and Morpho trust assumptions.

The two `incorrect-equality` comparisons implement exact integer choices.
Zero assets and zero shares skip the withdrawal. A positive shortfall equal
to all recorded supplied principal redeems all shares, after an explicit
upper-bound check. Unsolicited USDC can reduce the shortfall and stays available
for subsequent requests.

## Pool and token findings

| Reviewed sites | Disposition |
| --- | --- |
| Deposit hook, admission, membership exit, prize proof, reinvestment, withdrawal queue and encrypted tree updates | Slither follows encrypted arithmetic, ciphertext permission grants and proof verification into external contracts. These paths call the configured Zama executor, ACL and KMS. They do not dispatch to an account or delegate. The token hook checks the immutable sender. Tree events follow the write whose hash and handle they publish. |
| Draw close and Morpho supply, harvest and restore | The pool guards draw closure across harvest. The wrapper's authenticated prize-funding callback must remain available during harvest. Supply and harvest events publish values returned by the adapter. Every asset-moving adapter entry takes its guard. Manual restore credits the promised liquidity before the adapter call so queued withdrawals see it, then reverts on a mismatch. |
| Settlement, unwrap and payout | Settlement validates the aggregate proof and serializes restoration before opening claims on funded liquidity. Pending-principal unwrap consumes its pending amount and count before invoking the immutable wrapper. Claim processing clears the claimant's entitlement first, then stores the request ID the wrapper actually returned. Its unwrap path burns and records a request without invoking the recipient. |
| Paid prize claim and reinvestment | The pinned ERC-7984 implementation can return an encrypted zero for an unsuccessful transfer. The pool now debits, returns and emits the actual payment. Reinvestment returns and emits the amount accepted under the savings cap. The paid claim uses the ordinary transfer method, which does not invoke a recipient hook. |
| FHE permission and disclosure calls | On an initialized ciphertext these operations return the same handle and update permissions by side effect. The draw, tree and batch sites operate on results of FHE arithmetic or an initialized canonical zero. First-use account mappings need special treatment. Delegate setup now stores the normalized handles. A first prize claim passes the normalized amount to the token. Other calls to the account-permission helper already have initialized handles. |
| Adapter transfers after wrapping | The configured six-decimal USDC wrapper checks the supply bound on mint. The adapter transfers the handle it just received from wrapping. Plain principal transfer has no receiver hook. Prize transfer goes to the pool's funding branch, which credits the actual encrypted amount received and accepts it. |
| Timestamp comparisons | Draw close, withdrawal batch rollover/close and principal unwrap use the block timestamp for scheduled eligibility. Winner selection uses FHE randomness. |
| Informational findings | The capitalized funding tag is the existing public constant getter. The adapter implements the pool's interface structurally. Dependency pragma ranges resolve to the single configured solc version. |

The displayed `publicPrizeReserve` also accepts a sponsor-declared cleartext
amount in callback data. The encrypted reserve used for prizes credits the
token-reported amount. Binding the displayed value to that transfer requires a
change to the public funding protocol. This is a separate display-integrity
limitation.

## Test contracts and archived V1

The harness uses the handles returned by the ACL functions. Shadowed parameter
names were clarified. The callback fixture checks its constructor addresses and
the mock market invokes a typed callback. The observer deliberately performs
calls and records whether each returned or reverted. Its remaining
`unused-return` and `reentrancy-benign` findings describe test observations.

The V1 fixture is pinned to the source digest in its provenance record. It
remains in the scan and in migration tests. Its FHE-only call paths, event
ordering and clock comparisons have the same rationale as above. The following
are **accepted historical limitations** of that fixture:

- Draw close harvests before completing its draw state. Settlement calls the
  configured adapter before marking the batch funded. Those paths depend on the
  adapter's behavior during the interaction.
- Paid claims discard the actual transferred amount. First-use prize and
  delegate paths can discard normalized zero handles returned by Zama. The
  active pool contains the corrections.

## How CI applies this review

The raw Markdown, JSON and SARIF artifacts retain every detector result.
`scripts/slither-reviewed.json` records the reviewed source locations by
contract file, function signature and detector. Slither can order and group
the same reentrancy traces differently between runs. The review compares the
set of operations for each site, including severity, roles, source text and
enclosing function bodies. Editing a reviewed function or introducing a new
reported operation requires a new review. Obsolete entries must be removed.

For a failed check, inspect the raw report, trace the calls and either fix
the issue or document the precise reason here. Only then record the
corresponding fingerprint printed by `pnpm contracts:analyze`. Compiler and
analyzer failures also fail the workflow.
