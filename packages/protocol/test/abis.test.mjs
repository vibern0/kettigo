import assert from "node:assert/strict";
import test from "node:test";

import {
  confidentialPrizePoolAbi,
  confidentialUsdcAbi,
  erc20Abi,
  morphoBlueAbi,
  morphoIrmAbi,
  morphoOracleAbi,
  morphoYieldAdapterAbi,
  unwrapFinalizedEvent,
  unwrapRequestedEvent,
  wethAbi,
} from "../src/index.ts";

function has(abi, type, name) {
  return abi.some((item) => item.type === type && item.name === name);
}

test("official Morpho ABIs expose every shared read and write", () => {
  for (const name of ["market", "position", "idToMarketParams", "accrueInterest", "supply", "withdraw", "supplyCollateral", "borrow", "repay", "withdrawCollateral"]) {
    assert.equal(has(morphoBlueAbi, "function", name), true, name);
  }
  assert.equal(has(morphoIrmAbi, "function", "borrowRateView"), true);
  assert.equal(has(morphoOracleAbi, "function", "price"), true);
});

test("custom ABIs contain the union consumed by the web app, keepers, and lab", () => {
  for (const name of [
    "PRIZE_FUNDING_DATA", "token", "morphoYieldAdapter", "drawId", "drawInterval", "nextDrawAt",
    "participantCount", "publicPrizeReserve", "MAX_USER_PRINCIPAL", "morphoAvailablePrincipalAssets",
    "morphoAccruedYieldAssets", "morphoPendingDepositCount", "lastMorphoUnwrapAt", "morphoUnwrapInterval",
    "encryptedTotalPrincipal", "encryptedPrizeReserve", "encryptedPendingMorphoPrincipal", "encryptedPrincipalOf",
    "encryptedWinningsOf", "currentWithdrawalBatchId", "withdrawalAccounts", "withdrawalUnwrapRequest",
    "withdrawalBatchStatus", "withdrawalBatchClosesAt", "withdrawalBatchFunded",
    "withdrawalBatchRestoredAmount", "withdrawalBatchRequestCount", "withdrawalBatchClaimantCount",
    "hasWithdrawalClaim", "encryptedWithdrawalBatchTotal", "encryptedWithdrawalBatchMorphoRestore",
    "closeDraw", "claimPrize", "claimPrizeToSavings", "requestWithdrawal", "claimWithdrawalToUsdc",
    "closeWithdrawalBatch", "settleWithdrawalBatch", "processWithdrawal", "supplyAvailableMorphoPrincipal",
    "requestMorphoPrincipalUnwrap",
    "membershipTreeDepth", "membershipZero", "emptyHash", "membershipNode", "checked",
  ]) assert.equal(has(confidentialPrizePoolAbi, "function", name), true, name);

  for (const name of ["DrawSnapshotClosed", "SlotAssigned", "SlotReleased", "NodeUpdated"]) {
    assert.equal(has(confidentialPrizePoolAbi, "event", name), true, name);
  }

  for (const name of ["wrap", "confidentialBalanceOf", "confidentialTransferAndCall", "unwrap", "finalizeUnwrap", "unwrapRequester", "multicall"]) {
    assert.equal(has(confidentialUsdcAbi, "function", name), true, name);
  }
  assert.equal(has(confidentialUsdcAbi, "event", "UnwrapRequested"), true);
  assert.equal(has(confidentialUsdcAbi, "event", "UnwrapFinalized"), true);

  for (const name of ["usdc", "confidentialUsdc", "prizePool", "morpho", "marketId", "suppliedPrincipal", "idlePrincipal", "availablePrincipalAssets", "accruedYieldAssets", "suppliedAssets", "marketParams"]) {
    assert.equal(has(morphoYieldAdapterAbi, "function", name), true, name);
  }
});

test("token and event exports come from the canonical ABI surfaces", () => {
  assert.equal(has(erc20Abi, "function", "approve"), true);
  assert.equal(has(erc20Abi, "function", "balanceOf"), true);
  assert.equal(has(wethAbi, "function", "deposit"), true);
  assert.equal(has(wethAbi, "function", "withdraw"), true);
  assert.equal(unwrapRequestedEvent, confidentialUsdcAbi.find((item) => item.type === "event" && item.name === "UnwrapRequested"));
  assert.equal(unwrapFinalizedEvent, confidentialUsdcAbi.find((item) => item.type === "event" && item.name === "UnwrapFinalized"));
});
