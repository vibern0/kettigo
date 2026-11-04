# Merkle + FHE v2: proposed Sepolia validation envelope

Status: proposed, not approved or started. This is a new run. The completed
claim-lab soak, its clock, wallets, budgets and eight-account retention canary
are excluded. Never send a check for research pool
`0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27`, draw 2, before
2026-12-27T16:04:36Z.

## Exact scope and ceilings

- Network: Ethereum Sepolia, chain 11155111 only.
- Target: a new versioned release-candidate pool recorded in a runtime/source
  hash manifest, with its own adapter, proof archive and keeper namespace.
  No deposits, prize transfers or configuration writes to either legacy pool.
- Signer: the configured deployment operator. Generate 33 new participant
  wallets and one new sponsor wallet; retain keys only in the ignored run
  directory. Do not reuse the retention-canary wallets or ignored cache.
- Gas funding sent to all generated wallets, summed: at most **0.005 Sepolia
  ETH**. Include failed funding attempts in the accounting; never reset totals
  on restart. Operator transaction fees are accounted separately below.
- Total transaction fees, including deploys, funding, successes, reverts and
  replacements: at most **0.003 Sepolia ETH**.
- Maximum transaction gas price: **100,000 wei**. A fee estimate above this
  ceiling pauses the run; it does not raise the ceiling.
- At most **600 distinct signed transactions**, including contract deployment,
  approvals, wrap/deposit, admission, draws, checks, withdrawals and finalization.
  Exact rebroadcast of the same signed bytes is one transaction, with every
  attempt retained. A new hash counts even if its nonce is unchanged.
- At most **100 Circle Sepolia USDC** committed across participants and prize
  funding. Existing principal or prizes are never migrated automatically.
- Start: the first signed transaction after explicit approval of this envelope
  and release-candidate gates. Record UTC `startedAt` before signing.
- Stop: **two hours after `startedAt`**, or immediately at a ceiling or abort
  condition. Restart does not move the deadline or erase interruptions.

## Phases and service objective

1. Verify candidate bytecode/source, fresh empty pool, independent archive
   namespace, RPC history and safe old-pool access. Run one complete lifecycle
   with queued USDC withdrawal before increasing load.
2. Exercise 1, 8, then 33 distinct active funded participants. Close draws
   serially through a dedicated operator. Check varied occupied positions,
   including the rightmost occupied leaf. Clearly distinguish sparse local
   depth-32 fixtures from live funded population.
3. Run bounded cycles with concurrency 1, then 4, then 8, preserving exact
   saved intents, nonces and hashes. No all-account automatic check is needed
   to close a draw. Reserve unchecked prizes without expiry.
4. Exercise archive restart, independent backup restore and a separate complete
   RPC backfill; prove archive outage does not block principal withdrawal or
   existing credited claims. Test rollback routing without deleting liabilities.
5. Restore participant principal via the queued withdrawal path; report any
   unsettled liability rather than extending the run silently.

A workload meets the initial objective only when all participant operations
complete within five minutes, no signed transaction is unresolved, canonical
backing/conservation checks pass, and proof-service lag is within the configured
confirmation window plus two blocks. An uninterrupted two-hour observation is
required to describe the run as uninterrupted. A stopped or restarted run is
reported with its actual coverage gaps, even if subsequent recovery succeeds.

## Abort and evidence

Stop new signatures on an unknown/consumed nonce, unexpected bytecode or chain,
unexplained backing mismatch, forged or orphaned proof, real confirmed-block
ACL denial, loss of persistent storage, first unrecoverable provider/relayer
error, budget limit or deadline. Reconcile saved exact transactions read-only;
never silently retry an intent with a new nonce. Preserve the first error.

Persist signed bytes before broadcast with restrictive file permissions. Never
publish keys, credentials or signed raw transactions. Sanitized evidence must
include unique successes, every failure/timeout, attempted and completed rates,
backlog, all-attempt latency percentiles, fee/gas accounting, measured HCU where
available, canonical receipts, conservation and coverage interruptions. Report
only the highest workload meeting the objective. This run cannot prove 60-day
ciphertext availability and cannot authorize a 60-day retention promise.
