# Merkle + FHE v2 migration and rollback

Status: implementation preparation. This file does not record an activated
release, completed audit, approved budget or proven claim-retention duration.
Ethereum Sepolia (11155111) remains the only deployment network.

## Existing deployments and preserved liabilities

Read-only inventory on 2026-11-04 found two different configured deployments:

| Configuration | Pool | Wrapper |
| --- | --- | --- |
| Deployed Worker source | `0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b` | `0x6B26B258436bcCE719Be8F9B30F87FDFD9BdFA8a` |
| Local app environment | `0x9c23E5f7143612dc1232FC643A57300291e0d719` | `0x3B4F71c77e288d92871Cda495891Cd42f543A3f5` |

The Worker pool's runtime hash was
`0x274d61d9715be69e898763e72a46a92530c83ef92c5cade8a222235f3c9ff403`
(13,464 bytes); its adapter was
`0xb2dAb46E04c875E6C8c1B966cFC3E1f40f063e90`. The local-environment pool's
runtime hash was
`0x71ccb969d9f7e2c397edd97be32e0d13a87e7e73da9c78616c01a917bde393d4`
(13,466 bytes). Both reported a 32-participant maximum and owner
`0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc`. These observations are not an
upgradeability audit. Re-read canonical state before release; draw and balance
state changes over time.

Do not infer principal amounts from ciphertext handles, participant counts or
archive records. An inventory records handles, authorized account-side
reconciliation, pending withdrawal batches and claims, wrapper unwrap requests,
Morpho supplied/available principal and shares, old draw behavior, and credited
winnings. Unavailable amounts remain explicitly unknown. Never publish a
user's decrypted balances without separate authorization.

Default to a new immutable versioned pool. Never overwrite the old pool's
address in a manifest or point new proofs at a legacy pool. Source changes do
not change existing bytecode. The old pools continue to own all their existing
liabilities; no indexer or operator copies secret balances into the new pool.

## Release manifest and forward path

Before any routing change, retain a versioned manifest with chain ID, pool,
wrapper, adapter, deployment transaction/block/hash, compiler and optimizer
settings, source commit, creation/runtime hashes, linked libraries, owner,
proof-service namespace, archive start block, confirmation policy and keeper
identity. Verify source and hashes against the actual confirmed deployments.
The manifest must distinguish candidate deployment from active routing.

1. Pass contract, proof-service, web and keeper tests, clean frozen installation,
   real build, deployment dry run, independent review and Codacy local/cloud PR
   gates. Use the pinned package-manager versions.
2. Deploy the candidate and its own adapter/configuration. Start ingestion at
   its deployment block. Do not share the old adapter's pool authority.
3. Exercise deposit, positive admission, draw, historical check, encrypted
   credit, wallet claim and savings reinvestment. Exercise queued withdrawal
   through Morpho restoration, wrapper finalization and original-USDC recovery.
4. Exercise canonical reorg rollback, archive outage, read-only failover,
   independent backup restore and complete historical RPC backfill. Principal
   withdrawal and existing credited claims remain available during outage.
5. Run the separately approved capacity envelope. Record measured limits,
   unsuccessful attempts and operational gaps; never infer unlimited capacity.
6. Keep explicit routes to both legacy positions. Each selected version fixes
   the pool, wrapper, RPC, keeper and proof namespace together. Old-pool
   withdrawal/settlement and existing prize claims continue to work.
7. Migration is voluntary: the account withdraws from its old pool, waits for
   final USDC receipt, then explicitly deposits into and joins the new pool.
   There is no silent funds migration, delegated reconstruction or forced exit.
8. Switch new onboarding only after release gates pass. Update roadmap and
   public docs only after actual activation, with measured operating and proven
   retention limits. A deployment alone is not activation.

## Rollback rehearsal

Before cutover, exercise selecting the prior version while the candidate has
principal, an outstanding withdrawal, an unchecked draw and credited winnings.
Verify that all four liabilities remain reachable at their original addresses.
Disable new candidate onboarding/routing if necessary; retain a clearly
reachable candidate-position route for withdrawals, checks and claims.

Keep both versioned keepers, complete archives, independent backups and keys.
Rollback never deletes state, redirects a proof to another pool, releases an
unchecked reserve, copies a liability, or reuses a signed transaction under a
new nonce. Reconcile exact submitted hashes before resuming any operator job.
Code rollback does not roll back chain state or stored service data.

## Gates that cannot be inferred from a short live smoke test

The eight-account canary at research pool
`0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27`, draw 2, remains untouched until
**2026-12-27T16:04:36Z**. Preserve its ignored keys, signed-attempt history and
archive backups independently of Git. At/after that date, rebuild paths, use
fresh SDK storage, check aged handles, perform the actual entitlement payouts
and verify conservation. An archive restore proves path availability; it does
not restore Zama ciphertext payloads. A failure blocks a promised 60-day feature
and requires a retention redesign before release.

Independent cryptography/ACL lifetime/randomness/overflow/replay/liquidity
review remains a release gate. Automated tests and a source review must not be
represented as an independent cryptographic audit. Mainnet release is outside
this runbook and remains subject to `docs/ROAD_TO_MAINNET.md`.
