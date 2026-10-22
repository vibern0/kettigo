import assert from "node:assert/strict";
import test from "node:test";

import { getPrizeActions } from "../src/lib/prize-actions.ts";
import * as prizeActions from "../src/lib/prize-actions.ts";

test("shows only claim choices when a prize can be claimed", () => {
  const actions = getPrizeActions({
    connected: true,
    ready: true,
    busy: false,
    hasPrizeToClaim: true,
    workingAction: undefined,
  });

  assert.deepEqual(
    actions.map((action) => action.id),
    ["addPrizeToSavings", "claimPrize"],
  );
});

test("shows only check prize when no claimable prize is known", () => {
  const actions = getPrizeActions({
    connected: true,
    ready: true,
    busy: false,
    hasPrizeToClaim: false,
    workingAction: undefined,
  });

  assert.deepEqual(
    actions.map((action) => action.id),
    ["checkPrize"],
  );
});

test("celebrates even a minimum-unit prize after it is revealed", () => {
  const feedback = prizeActions.getPrizeRevealFeedback?.(1n);
  assert.equal(feedback?.celebration, "prize");
  assert.equal(feedback?.tone, "success");
  assert.ok(feedback?.description.includes("0.000001 USDC"));
});

test("gives a calm response without a celebration when winnings are zero", () => {
  const feedback = prizeActions.getPrizeRevealFeedback?.(0n);
  assert.equal(feedback?.tone, "info");
  assert.equal(feedback?.celebration, undefined);
});
