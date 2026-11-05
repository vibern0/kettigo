const MAX_ERROR = 2_048;
const fail = (message) => {
  throw new Error(`candidate journal: ${message}`);
};
const natural = (value) => Number.isSafeInteger(value) && value >= 0;

export function validateObservations(intent) {
  for (const observation of intent.observations ?? []) {
    if (
      !observation ||
      !natural(observation.at) ||
      typeof observation.stage !== "string" ||
      !observation.stage ||
      observation.stage.length > 64 ||
      typeof observation.error !== "string" ||
      !observation.error ||
      observation.error.length > MAX_ERROR ||
      typeof observation.unrecoverable !== "boolean"
    )
      fail("invalid persisted observation");
  }
}

export function validatePersistedErrors(intent, validAttempt) {
  for (const attempt of intent.attempts)
    if (!validAttempt(attempt)) fail("invalid persisted attempt");
  const events = [...intent.attempts, ...(intent.observations ?? [])]
    .filter((event) => event.error)
    .sort((left, right) => left.at - right.at);
  const first = events[0]?.error ?? null;
  const unrecoverable = events.find((event) => event.unrecoverable)?.error ?? null;
  if (intent.firstError !== first || intent.firstUnrecoverableError !== unrecoverable)
    fail("invalid persisted errors");
}

export function validAttempt(attempt) {
  return (
    Boolean(attempt) &&
    natural(attempt.at) &&
    (attempt.error === null ||
      (typeof attempt.error === "string" &&
        Boolean(attempt.error) &&
        attempt.error.length <= MAX_ERROR)) &&
    typeof attempt.unrecoverable === "boolean"
  );
}
