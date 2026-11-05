# Task 4c3b B3a credited-review checkpoint

## Implemented API boundary

- `DrawPage` prepares both `claimPrize` and `claimPrizeToSavings` with
  `session.prepareTransaction([{ to, data }], { signal })` in both legacy1 and
  v2 modes. The credit panel now exposes a Ready `Confirm` action; its handler
  synchronously latches ownership before invoking `prepared.send`.
- `review-lease.ts` is the single page-owned review owner. It only cancels an
  unused contender, refuses contenders while a confirmation is in progress,
  and retains the attempted operation for Action Center status handling.
- `PrizeHistory` participates in that owner for check and access reviews. It
  keeps its selected state; no component key/remount is used for arbitration.
- A canonical receipt refreshes aggregate winnings and balances. An observed
  uncertain operation remains in Action Center as read-only status rather than
  being retried.

## Verification

- `pnpm --dir packages/web exec vitest run --config vitest.config.mts tests/draw-prize-history-activity.test.tsx tests/draw-prize-history.test.tsx tests/draw-prize-history-scope.test.tsx tests/draw-prize-proof-http.test.tsx tests/celebration-flows.test.tsx tests/action-center-pending.test.tsx` — 45 tests passed after the final source split.
- `pnpm --dir packages/web run typecheck` — passed.
- Prettier and `git diff --check` — passed.
- Scoped release-config Codacy routed Lizard and ESLint9 over the four owned
  paths. Lizard reported 0 after the activity fixture remained at its prior
  size; ESLint9 retains the established automatic-JSX/test-policy findings and
  its two adapter errors. Cloud review is unavailable locally.

## Still required in B3b

The broader outage/recovery, pending-admission refresh, canonical-terminal
matrix, and full lifecycle matrix remain intentionally outside this checkpoint.
