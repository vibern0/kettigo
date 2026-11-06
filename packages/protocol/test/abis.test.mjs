import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const poolFunctionSurface = [
  "PRIZE_FUNDING_DATA",
  "token",
  "morphoYieldAdapter",
  "drawId",
  "drawInterval",
  "nextDrawAt",
  "participantCount",
  "publicPrizeReserve",
  "MAX_USER_PRINCIPAL",
  "morphoAvailablePrincipalAssets",
  "morphoAccruedYieldAssets",
  "morphoPendingDepositCount",
  "lastMorphoUnwrapAt",
  "morphoUnwrapInterval",
  "encryptedTotalPrincipal",
  "encryptedPrizeReserve",
  "encryptedPendingMorphoPrincipal",
  "encryptedPrincipalOf",
  "encryptedWinningsOf",
  "currentWithdrawalBatchId",
  "withdrawalAccounts",
  "withdrawalUnwrapRequest",
  "withdrawalBatchStatus",
  "withdrawalBatchClosesAt",
  "withdrawalBatchFunded",
  "withdrawalBatchRestoredAmount",
  "withdrawalBatchRequestCount",
  "withdrawalBatchClaimantCount",
  "hasWithdrawalClaim",
  "encryptedWithdrawalBatchTotal",
  "encryptedWithdrawalBatchMorphoRestore",
  "closeDraw",
  "claimPrize",
  "claimPrizeToSavings",
  "requestWithdrawal",
  "claimWithdrawalToUsdc",
  "closeWithdrawalBatch",
  "settleWithdrawalBatch",
  "processWithdrawal",
  "supplyAvailableMorphoPrincipal",
  "requestMorphoPrincipalUnwrap",
  "membershipTreeDepth",
  "membershipZero",
  "emptyHash",
  "membershipNode",
  "checked",
  "checkPrize",
  "pendingAdmissionOf",
  "finalizeAdmission",
  "membershipIndexOf",
  "encryptedAwardOf",
];
const poolEventSurface = [
  "AdmissionRequested",
  "DrawClosed",
  "WithdrawalBatchClosed",
  "MorphoPrincipalUnwrapRequested",
  "DrawSnapshotClosed",
  "PrizeChecked",
  "SlotAssigned",
  "SlotReleased",
  "NodeUpdated",
];
const wrapperFunctionSurface = [
  "wrap",
  "confidentialBalanceOf",
  "confidentialTransferAndCall",
  "unwrap",
  "finalizeUnwrap",
  "unwrapRequester",
  "multicall",
];
const adapterFunctionSurface = [
  "usdc",
  "confidentialUsdc",
  "prizePool",
  "morpho",
  "marketId",
  "suppliedPrincipal",
  "idlePrincipal",
  "availablePrincipalAssets",
  "accruedYieldAssets",
  "suppliedAssets",
  "marketParams",
];

function assertSurface(abi, type, names) {
  for (const name of names) assert.equal(has(abi, type, name), true, name);
}

test("official Morpho ABIs expose every shared read and write", () => {
  for (const name of [
    "market",
    "position",
    "idToMarketParams",
    "accrueInterest",
    "supply",
    "withdraw",
    "supplyCollateral",
    "borrow",
    "repay",
    "withdrawCollateral",
  ]) {
    assert.equal(has(morphoBlueAbi, "function", name), true, name);
  }
  assert.equal(has(morphoIrmAbi, "function", "borrowRateView"), true);
  assert.equal(has(morphoOracleAbi, "function", "price"), true);
});

test("custom ABIs contain the union consumed by the web app, keepers, and lab", () => {
  assertSurface(confidentialPrizePoolAbi, "function", poolFunctionSurface);
  assertSurface(confidentialPrizePoolAbi, "event", poolEventSurface);
  assertSurface(confidentialUsdcAbi, "function", wrapperFunctionSurface);
  assert.equal(has(confidentialUsdcAbi, "event", "UnwrapRequested"), true);
  assert.equal(has(confidentialUsdcAbi, "event", "UnwrapFinalized"), true);

  assertSurface(morphoYieldAdapterAbi, "function", adapterFunctionSurface);
});

test("token and event exports come from the canonical ABI surfaces", () => {
  assert.equal(has(erc20Abi, "function", "approve"), true);
  assert.equal(has(erc20Abi, "function", "balanceOf"), true);
  assert.equal(has(wethAbi, "function", "deposit"), true);
  assert.equal(has(wethAbi, "function", "withdraw"), true);
  assert.equal(
    unwrapRequestedEvent,
    confidentialUsdcAbi.find((item) => item.type === "event" && item.name === "UnwrapRequested"),
  );
  assert.equal(
    unwrapFinalizedEvent,
    confidentialUsdcAbi.find((item) => item.type === "event" && item.name === "UnwrapFinalized"),
  );
});

test("prize proof selectors match the compiled pool artifact", () => {
  const artifact = JSON.parse(
    readFileSync(
      new URL(
        "../../contracts/artifacts/contracts/ConfidentialPrizePool.sol/ConfidentialPrizePool.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).abi;
  const portable = (value) =>
    Array.isArray(value)
      ? value.map(portable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== "internalType")
              .map(([key, entry]) => [key, portable(entry)]),
          )
        : value;
  for (const name of [
    "checkPrize",
    "pendingAdmissionOf",
    "finalizeAdmission",
    "membershipIndexOf",
    "encryptedAwardOf",
  ]) {
    const shared = confidentialPrizePoolAbi.find(
      (item) => item.type === "function" && item.name === name,
    );
    const compiled = artifact.find((item) => item.type === "function" && item.name === name);
    assert.deepEqual(shared, portable(compiled), name);
  }
  for (const name of [
    "PrizeChecked",
    "AdmissionRequested",
    "DrawClosed",
    "WithdrawalBatchClosed",
    "MorphoPrincipalUnwrapRequested",
  ]) {
    const shared = confidentialPrizePoolAbi.find(
      (item) => item.type === "event" && item.name === name,
    );
    const compiled = artifact.find((item) => item.type === "event" && item.name === name);
    assert.deepEqual(shared, portable(compiled), name);
  }
});
