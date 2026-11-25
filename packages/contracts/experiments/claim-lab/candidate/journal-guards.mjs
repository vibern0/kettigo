export function assertOpen(journal, fail) {
  if (journal.closed) fail("journal is closed");
  if (journal.poisoned) fail("journal persistence is uncertain");
}

export function assertSigningAllowed(journal, fail) {
  assertOpen(journal, fail);
  if (journal.state.startedAt === null || journal.now() >= journal.state.deadlineAt)
    fail("deadline reached");
  if (journal.state.intents.some((intent) => intent.firstUnrecoverableError))
    fail("unrecoverable error stops signatures");
}
