import { occupiedFee } from "./receipt.mjs";

const UINT = /^(0|[1-9][0-9]*)$/;
const fail = (message) => {
  throw new Error(`candidate journal: ${message}`);
};
const zero = () => ({
  signedCount: 0,
  feeReservedWei: "0",
  feeActualWei: "0",
  fundingCommittedWei: "0",
  usdcCommittedMicro: "0",
});
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());

export function validIntentBudget(intent) {
  return ["maxFeeWei", "maxGasPriceWei", "fundingWei", "usdcCommitmentMicro"].every((key) =>
    UINT.test(intent[key] ?? ""),
  );
}

export function assertBudget({ state, budget, envelope, fee, funding, usdc }) {
  const feeCap = state.safePolicy?.caps.maxAggregateFeeWei ?? envelope.maxFeeWei;
  if (budget.signedCount + 1 > envelope.maxSignedTransactions) fail("signature budget exceeded");
  if (occupiedFee(state) + fee > BigInt(feeCap)) fail("fee budget exceeded");
  if (BigInt(budget.fundingCommittedWei) + funding > BigInt(envelope.maxFundingWei))
    fail("funding budget exceeded");
  if (BigInt(budget.usdcCommittedMicro) + usdc > BigInt(envelope.maxUsdcMicro))
    fail("USDC budget exceeded");
}

export function validateRecomputedBudget(state) {
  const expected = zero();
  for (const intent of state.intents) {
    expected.signedCount += 1;
    expected.feeReservedWei = (
      BigInt(expected.feeReservedWei) + BigInt(intent.maxFeeWei)
    ).toString();
    expected.fundingCommittedWei = (
      BigInt(expected.fundingCommittedWei) + BigInt(intent.fundingWei)
    ).toString();
    expected.usdcCommittedMicro = (
      BigInt(expected.usdcCommittedMicro) + BigInt(intent.usdcCommitmentMicro)
    ).toString();
    if (intent.terminal)
      expected.feeActualWei = (
        BigInt(expected.feeActualWei) + BigInt(intent.terminal.feeWei)
      ).toString();
  }
  if (canonical(expected) !== canonical(state.budget)) fail("invalid persisted budget");
}

export function validatePersistedCaps(state, envelope) {
  const feeCap = state.safePolicy?.caps.maxAggregateFeeWei ?? envelope.maxFeeWei;
  const safeCount = state.intents.filter((intent) => intent.kind === "user-operation").length;
  if (
    state.budget.signedCount > envelope.maxSignedTransactions ||
    occupiedFee(state) > BigInt(feeCap) ||
    BigInt(state.budget.fundingCommittedWei) > BigInt(envelope.maxFundingWei) ||
    BigInt(state.budget.usdcCommittedMicro) > BigInt(envelope.maxUsdcMicro) ||
    state.intents.some((intent) =>
      intent.kind === "user-operation" && state.safePolicy
        ? BigInt(intent.maxGasPriceWei) > BigInt(state.safePolicy.caps.maxSafeFeePerGas)
        : BigInt(intent.maxGasPriceWei) > BigInt(envelope.maxGasPriceWei),
    ) ||
    (state.safePolicy && safeCount > state.safePolicy.caps.maxSafeIntents)
  )
    fail("persisted state exceeds approved cap");
}
export function validatePersistedUniqueness(state) {
  const ids = new Set();
  const nonces = new Set();
  for (const intent of state.intents) {
    const nonce = `${intent.sender.toLowerCase()}:${intent.nonce}`;
    if (ids.has(intent.intentId) || nonces.has(nonce)) fail("duplicate persisted intent");
    ids.add(intent.intentId);
    nonces.add(nonce);
  }
}
