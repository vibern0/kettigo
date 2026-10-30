# Merkle + FHE stress and Sepolia validation plan

**Goal:** establish measured scaling limits and security risks before integration.
**Scope:** extend the authorized throwaway experiment; no production integration,
PR, branch rewrite, mainnet transaction, or existing deployment mutation.
**Architecture:** authoritative mutable ciphertext sum tree, frozen draw roots,
historical Merkle paths, FHE weighted comparison, fixed-recipient payouts.
**Execution:** native implementation with independent read-only research/review.

1. Stress the existing mode-2 contract with 4,096 distinct accounts using actual
   local wrapper-token transfers. Check totals/backing, random draws, checkpoint
   gas/HCU, all-account claims, withdrawals and old snapshots. Record actual
   counts, run time, state/event growth, resource headroom and failures.
2. Add historical archive reconstruction at the exact close event. Test missing,
   shuffled/duplicate logs, same-block ordering, and canonical replay after reorg.
   Add adversarial raw-handle ACL reuse and document zero-slot and timing attacks.
3. Create a Sepolia-only research candidate with modes 0/1 and test entrypoints
   removed and owner-controlled draws. Run the same local lifecycle tests first.
   Resolve the user's existing signer without exposing secrets, discover live
   network contracts/limits, deploy isolated test-token contracts and run actual
   encrypted deposit/draw/claim/withdraw/decryption checks. Record receipts and
   latency; metadata-only reads never count as live FHE validation.
4. Review findings, rerun relevant regressions/type checks, and write a report
   distinguishing local proof, live proof, limitations and integration blockers.

**Review focus:** historical recovery liveness; ciphertext ACL composition;
unchanged principal backing under delayed claims; end-of-draw/zero-slot abuse;
local Cancun versus live Amsterdam host/gas configuration.

**Progress:** scope and credentials inspected. No signer in this worktree;
user authorized using an existing signer setup. Checking primary checkout.
Live read-only research finds HCU20m/depth5m and a newer HCU host plus Amsterdam
state-gas accounting; do not equate local gas with Sepolia gas.

**Completed:** original mode2 and stripped candidate each passed 4,096 funded
accounts and 4,096 historical checks. Current model principal stayed backed.
Cold recovery, corrupted/missing/shuffled logs, same-block close ordering and
canonical replay after rollback are tested. Public-handle ACL reuse is denied;
zero-slot exhaustion and timing capture are reproduced as integration risks.
Sepolia has confirmed encrypted deposits, genuine RNG close, historical claims,
both award decryptions, structured unauthorized decrypt denial, both principal
withdrawals, fixed-recipient/replay rejection, backing conservation, and a
two-deposit batch/cleanup. Three-deposit eth_call fails exact transaction HCU
limit. Receipts/source hashes are recorded in the isolated lab result file.

**Ruling:** stress population locally and run isolated live interoperability/
security checks — this avoids presenting 4,096 mock-backend accounts as 4,096
live users. Sustained live throughput and long-duration retention remain open.
**Ruling:** owner controls research draw closing — bounds this experiment but
does not settle the protocol's end-of-draw/holding-time policy.
**Operational incidents:** first deployment used Hardhat's 1-gwei floor and
spent 0.003699856 test ETH; explicit fee quotes/pre-send budget checks now replace
that behavior. A stale nonce was retried using fresh pending nonces with saved
signed transaction hashes. Existing signer and deployment addresses were not
changed; no secrets were copied into tracked artifacts.

**Report:** packages/contracts/experiments/claim-lab/VALIDATION.md.
