import { Buffer } from "node:buffer";

const DEFAULT_MAX_JOURNAL_BYTES = 2_000_000;

const fail = (message) => {
  throw new Error(`candidate workload driver: ${message}`);
};
const errorText = (error) =>
  String(error?.message ?? error)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/https?:\/\/[^/\s]+/g, "[redacted-url]")
    .replace(/0x[0-9a-fA-F]{16,}/g, "[redacted-hex]")
    .slice(0, 256);

/** Executes only journal-bound EOA actions; Safe/browser attachment remains external. */
export class FiniteWorkloadDriver {
  constructor({
    journal,
    reconcileIntent,
    resolveConditional,
    executeAction,
    maxJournalBytes = DEFAULT_MAX_JOURNAL_BYTES,
  } = {}) {
    if (!journal || typeof journal.workloadDefinition !== "function") fail("journal required");
    for (const [name, value] of Object.entries({
      reconcileIntent,
      resolveConditional,
      executeAction,
    }))
      if (typeof value !== "function") fail(`${name} callback required`);
    if (!Number.isSafeInteger(maxJournalBytes) || maxJournalBytes < 1)
      fail("invalid journal limit");
    this.journal = journal;
    this.reconcileIntent = reconcileIntent;
    this.resolveConditional = resolveConditional;
    this.executeAction = executeAction;
    this.maxJournalBytes = maxJournalBytes;
  }

  async run() {
    const workload = this.journal.workloadDefinition();
    if (!workload) fail("bound workload required");
    this.#assertSize();
    const metrics = {
      completed: 0,
      submitted: 0,
      unresolved: 0,
      failed: 0,
      blocked: 0,
      backlog: 0,
      journalBytes: 0,
    };
    const pending = new Set();
    const blocked = new Set();
    await this.#recoverSavedIntents(metrics);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const action of workload.actions) {
        if (this.journal.actionResult(action.id)) continue;
        if (pending.has(action.id)) continue;
        if (!(action.dependencies ?? []).every((id) => this.journal.actionResult(id))) {
          blocked.add(action.id);
          continue;
        }
        if (action.kind !== "eoa") {
          blocked.add(action.id);
          continue;
        }
        try {
          const result = action.refs?.condition
            ? await this.resolveConditional(action)
            : await this.executeAction(action);
          if (!result) {
            metrics.submitted += 1;
            pending.add(action.id);
            continue;
          }
          if (result.actionId !== action.id) fail("callback returned foreign action result");
          await this.journal.recordActionResult(action.id, result);
          this.#assertSize();
          metrics.completed += 1;
          progressed = true;
        } catch (error) {
          metrics.failed += 1;
          metrics.lastError = errorText(error);
        }
      }
    }
    metrics.backlog = workload.actions.filter(
      (action) => !this.journal.actionResult(action.id),
    ).length;
    metrics.blocked = blocked.size;
    metrics.journalBytes = this.journal.journalBytes();
    return Object.freeze(metrics);
  }

  async #recoverSavedIntents(metrics) {
    for (const intent of this.journal.snapshot().intents) {
      try {
        const recovered = await this.reconcileIntent(intent);
        if (recovered?.actionId && recovered.result) {
          await this.journal.recordActionResult(recovered.actionId, recovered.result);
          this.#assertSize();
          metrics.completed += 1;
        } else if (recovered?.state === "unresolved") metrics.unresolved += 1;
      } catch (error) {
        metrics.failed += 1;
        metrics.lastError = errorText(error);
      }
    }
  }

  #assertSize() {
    const bytes = this.journal.journalBytes();
    if (bytes > this.maxJournalBytes) fail(`journal size ${bytes} exceeds ${this.maxJournalBytes}`);
    return bytes;
  }
}

/** Stable, secret-free CLI output for operators and CI logs. */
export function sanitizeWorkloadDriverReport(report) {
  const fields = [
    "completed",
    "submitted",
    "unresolved",
    "failed",
    "blocked",
    "backlog",
    "journalBytes",
  ];
  const result = Object.fromEntries(fields.map((field) => [field, Number(report?.[field] ?? 0)]));
  if (typeof report?.lastError === "string") result.lastError = errorText(report.lastError);
  return Object.freeze(result);
}
