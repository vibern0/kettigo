# Task 4b1a canonical receipt report

## Delivered

- Added `lookupCanonicalUserOperationReceipt(dependencies, operation, options)` in
  `packages/web/src/lib/canonical-user-operation-receipt.ts`.
- The verifier requires a complete relay receipt, then independently reads the
  outer Ethereum receipt and its block. It decodes EntryPoint 0.7
  `UserOperationEvent` with viem's ABI and requires exactly one event for the
  frozen expected operation hash and Safe sender.
- Confirmed and failed results now carry immutable `transactionHash`,
  `blockNumber`, and `blockHash`. Missing/reverted/unavailable chain state is
  pending; malformed or contradictory identity data raises
  `SafeUserOperationIntegrityError` with the safe operation identity.
- Both `session.lookupUserOperation` and the post-submission receipt path use
  this verifier. The counterfactual relay refresh remains terminal-only.
- Receipt reads are injectable through `getTransactionReceipt` and `getBlock`.
  The lookup has one 10 second deadline by default, accepts an optional abort
  signal, aborts late reads, and observes abandoned promise rejection.

## Verification

- `node --experimental-strip-types --import ./packages/keeper/src/register-ts-loader.mjs --test packages/web/tests/passkey-safe.test.mjs` — 30 passing.
- `pnpm --dir packages/web typecheck` — passing.
- `./node_modules/.bin/prettier --write packages/web/src/lib/canonical-user-operation-receipt.ts packages/web/src/lib/passkey-safe.ts packages/web/src/lib/smart-session.ts packages/web/tests/passkey-safe.test.mjs` — passing.
- `git diff --check` — passing.

## Remaining boundary

This slice deliberately does not add the following polling/observer/rejection
matrix or durable recovery/UI state; those belong to Task 4b1b. The canonical
verifier is ready for that caller-level matrix.
