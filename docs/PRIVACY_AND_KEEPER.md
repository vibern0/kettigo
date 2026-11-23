# Privacy and Keeper Notes

Kettigo is in an early experimental phase. The current production guardrail is
a `1,000 USDC` principal limit per account, enforced by `ConfidentialPrizePool`
and mirrored in the deposit UI.

## Morpho keeper cadence

User deposits enter the pool as confidential `cUSDC`. The pool does not send each
deposit directly to Morpho. Instead, deposits accumulate in an encrypted pending
principal bucket.

A keeper runs on a fixed cadence, currently intended to be every five minutes.
When the interval has elapsed and there has been deposit activity, it asks the
pool to unwrap the pending principal to the Morpho adapter. On a later run, the
keeper discovers that request from wrapper events, obtains Zama's public
decryption proof, and finalizes the unwrap. Once the adapter has USDC, the keeper
supplies it to Morpho. Idle runs update Morpho's recorded interest accounting
at most once per hour. This idle accrual does not harvest yield or fund the
prize reserve. Each ready `closeDraw()` accrues interest again, harvests the
resulting surplus, and allocates it to the closing draw in one transaction.
The longer idle accrual window reduces extra sub-base-unit rounding in a small
test market; draw closes and other market operations still trigger accrual.

## Known privacy tradeoffs

The five-minute keeper cadence intentionally trades some privacy for a smoother
first-phase product:

- Observers can see that an unwrap happened for a time window.
- The finalized unwrap amount is public.
- Harvested yield and the active prize amount are public.
- Deposit transaction timing and participant addresses are visible.
- Individual pool principal and winnings remain encrypted.

This is better for liveness than waiting for a fixed number of deposits, but it
does reveal activity at the cadence boundary. Later versions can improve this
with longer or randomized windows, minimum batch thresholds, decoy liquidity,
separate liquidity buffers, and more careful keeper scheduling.

## Keeper safety

The Cloudflare Cron Trigger dispatches `keepers.yml` on
`codex/merkle-fhe-production-integration` every five minutes. GitHub Actions
runs the legacy and V2 pools sequentially using the same signer. Each pool has
its own deployment block and draw threshold. A failed pool job leaves the
other pool eligible to run.
The Morpho keeper runs every five minutes:

1. supply finalized adapter USDC to Morpho;
2. finalize the oldest ready Morpho-bound unwrap;
3. request a timed unwrap for pending pool principal;
4. accrue Morpho interest when no higher-priority work is pending and at least
   one hour has elapsed since the market's last update.

Each ready `closeDraw()` refreshes Morpho interest before calculating and
harvesting surplus, then snapshots the closing draw's prize. A zero-yield close
continues without withdrawing or emitting a harvest event. The keeper has no
standalone harvest action. Exceptionally, restoring all supplied principal
withdraws the adapter's full share position and routes any realized surplus to
the prize reserve for the next draw that closes.

The keeper scans from `MORPHO_KEEPER_START_BLOCK` (at or before the active pool deployment)
to the latest block in exact 10,000-block chunks for wrapper requests and matching
finalizations. This prevents a delayed request from aging out of discovery. A
temporarily unavailable Zama public-decryption proof leaves the request pending
for the next scheduled run instead of submitting a transaction.

The scheduled runner may use `SEPOLIA_RPC_URL` for historical reads and
`SEPOLIA_WRITE_RPC_URL` for transaction submission. Keeping those endpoints
separate avoids requiring a paid RPC tier when one free provider does not offer
both capabilities.

`MORPHO_KEEPER_MAX_TXS` is retained for configuration compatibility, but the
scheduled runtime hard-caps every run to one transaction. When reusing a wrapper for a fresh pool, set
`MORPHO_KEEPER_START_BLOCK` at or before the new pool deployment, before any
requests can originate from it. The hosted jobs use `11864127` for the legacy
pool and `12078643` for V2.

The withdrawal keeper runs every five minutes. It scans the current and recent
withdrawal batch ids, closes expired nonempty open batches, and settles closed
batches after Zama public decryption returns the aggregate withdrawal amount and
the aggregate Morpho restore amount. `WITHDRAWAL_KEEPER_LOOKBACK_BATCHES`
controls the bounded scan depth and defaults to `8`.

Each function returns after broadcasting its transaction instead of waiting for a
receipt. The next scheduled run reads the confirmed onchain state before choosing
another action. This avoids platform retries while preserving idempotent progress.

## V2 admission keeper

`pnpm keeper:all` and `pnpm keeper:watch` run the admission keeper before the
draw keeper. To run one admission pass, use `pnpm keeper:admission`. The
candidate pool uses the deployment block in its Sepolia release manifest.
For a different V2 deployment, set `ADMISSION_KEEPER_START_BLOCK` to that
pool's deployment block. Leave the variable unset for legacy pools.

The keeper finds accounts through the selected pool's `AdmissionRequested`
events. It checks the current request, obtains a proof for its boolean marker,
checks that the request is still current, and waits for the finalization
receipt. Positive proofs admit the account. Negative proofs clear the request.
A deposit enters a draw once admission confirms before that draw closes.

Each pass scans the most recent 128 blocks and up to 64 pages of 2,000 finalized
blocks from the saved cursor. It checks up to 12 accounts. Unfinished work
carries over in a chain-, pool- and deployment-specific file under
`packages/keeper/cache/`. GitHub Actions restores the latest V2 checkpoint and
saves the updated cursor and retry queue after each pass. Keep that directory
between runs on other hosts. On a fresh host, backfill starts at deployment while recent requests
are processed immediately. Onchain state makes replay after a restart safe.
