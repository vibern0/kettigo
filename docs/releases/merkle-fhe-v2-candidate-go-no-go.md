# Merkle + FHE candidate go/no-go packet

Status: **candidate contracts deployed; application release is not yet ready**.

Contracts compile with Solidity 0.8.28, Cancun, optimizer 200, and via-IR.
Read-only artifact evidence exists for the wrapper, pool, and adapter. The
proof service passed Worker (52), restore (23), and backfill (14) tests plus a
Wrangler dry-run. The web app passed 347 Node tests, 156 rendered tests,
typecheck, and production build.

The new wrapper, pool, and adapter are recorded with checksummed addresses and
runtime bytecode hashes in the candidate manifest. Do not reuse legacy
addresses. Proof Worker/app deployment, funding, and lifecycle testing remain
separate actions.
