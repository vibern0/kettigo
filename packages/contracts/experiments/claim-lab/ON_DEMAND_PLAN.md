# On-demand prize checks and participant lifecycle research

User request: explore contract/tooling changes needed for user-only checking,
alternatives to permanent zero-value slots, and reliable historical claims.
This extends the throwaway research spike; no product integration is implied.

- Keep a check per account and per draw. At depth32 that is bounded32-step work,
  not a scan of N users. Checking R historical draws still costs O(R). Preserve
  old claims indefinitely in this experiment. A persistent proof service serves
  one account's path without replaying the whole history on every request.
- Compare append-only slots (simple, lifetime churn consumes capacity), recycled
  slots (capacity follows concurrent participants), and positive admission
  (prevents actual zero deposits from occupying slots, adds asynchronous work).
  Prototype recycled slots plus verified positive admission. Generation-bound
  leaves authenticate historical owner/index regardless of current membership.
- First deposits remain withdrawable pending principal until a threshold-signed
  proof of `pendingBalance > 0` is verified. Publish only that admission bit,
  not balances/tickets. Nonces invalidate stale proofs after any pending update.
  Pending balances are not eligible before admission. An operator can finalize
  admission without another user signature. Dust/Sybil admission remains a
  separate policy issue; a positive amount is not a Sybil defense.
- `withdrawAllAndExit` releases the slot. Ordinary partial withdrawal cannot
  branch on an encrypted zero result and therefore does not automatically exit.
  Frozen roots and per-draw checks survive slot reuse and rejoining elsewhere.
- Use local SQLite temporal node/slot versions, canonical event ordering,
  transactional rollback, restart recovery and read-only proof queries. This
  stores hashes/handles, not the FHE ciphertext payloads stored by Zama.

Acceptance: funded/zero admission, forged and stale proof rejection, immediate
pending withdrawal, old claims after reuse/rejoin, no forced checks of other
accounts, backing conservation, SQLite restart/rollback, authentic proof served
from indexed point-in-time reads, and rejection of corrupt/mixed paths.

Remaining unknowns: long-term Zama ciphertext retention, sustained live load,
minimum savings/eligibility policy, and integration with Morpho/Safe. Nothing
about an indexer alone removes those dependencies.
