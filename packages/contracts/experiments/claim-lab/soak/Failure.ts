export class FailureLatch {
  private failure: unknown;
  private failed = false;
  get stopped(): boolean { return this.failed; }
  capture(error: unknown): unknown {
    if (!this.failed) { this.failed = true; this.failure = error; }
    return this.failure;
  }
  throwIfStopped(): void { if (this.failed) throw this.failure; }
}
