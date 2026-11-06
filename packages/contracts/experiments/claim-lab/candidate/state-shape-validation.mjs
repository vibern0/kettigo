export const isNatural = (value) => Number.isSafeInteger(value) && value >= 0;
const UINT = /^(0|[1-9][0-9]*)$/;

export function validBudget(budget) {
  return (
    Number.isSafeInteger(budget.signedCount) &&
    budget.signedCount >= 0 &&
    ["feeReservedWei", "feeActualWei", "fundingCommittedWei", "usdcCommittedMicro"].every((key) =>
      UINT.test(budget[key] ?? ""),
    )
  );
}

export function validTarget(to, input, { validAddress, hex, maxInput }) {
  return (
    (validAddress(to) || to === null) &&
    typeof input === "string" &&
    input.length <= maxInput &&
    hex.test(input) &&
    (to !== null || input !== "0x")
  );
}

export function validClock(state, envelope) {
  return state.startedAt === null
    ? state.deadlineAt === null && state.intents.length === 0
    : Number.isSafeInteger(state.startedAt) &&
        Number.isSafeInteger(state.deadlineAt) &&
        state.deadlineAt === state.startedAt + envelope.durationMs;
}

export function validTransition(state, signed, attempts, terminal) {
  return (
    {
      reserved: !signed && attempts === 0 && !terminal,
      signed: signed && attempts === 0 && !terminal,
      "broadcast-attempted": signed && attempts > 0 && !terminal,
      terminal: signed && attempts > 0 && Boolean(terminal),
    }[state] === true
  );
}
