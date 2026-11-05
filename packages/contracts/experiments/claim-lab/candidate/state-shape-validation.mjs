export const isNatural = (value) => Number.isSafeInteger(value) && value >= 0;

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
