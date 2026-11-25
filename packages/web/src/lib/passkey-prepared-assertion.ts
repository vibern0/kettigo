type CredentialDependencies = {
  getCredential(
    rawId: string,
    rpId: string,
    options?: CredentialRequestOptions,
  ): Promise<Credential>;
};

export function createDeferredPasskeyAssertion(dependencies: CredentialDependencies): {
  signingDependencies: CredentialDependencies;
  waitUntilReady(): Promise<void>;
  markReady(): void;
  requestFromConfirmation(): void;
  cancel(): void;
  fail(error: unknown): void;
} {
  let requestAssertion: (() => Promise<Credential>) | undefined;
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  const assertionReady = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  let resolveAssertion!: (credential: Credential) => void;
  let rejectAssertion!: (error: unknown) => void;

  return {
    signingDependencies: {
      getCredential(rawId, rpId, options) {
        requestAssertion = () => dependencies.getCredential(rawId, rpId, options);
        const assertion = new Promise<Credential>((resolve, reject) => {
          resolveAssertion = resolve;
          rejectAssertion = reject;
        });
        ready();
        return assertion;
      },
    },
    waitUntilReady: () => assertionReady,
    markReady: ready,
    requestFromConfirmation() {
      if (!requestAssertion) return;
      // Invoke credentials.get in the Confirm click's call stack.
      try {
        requestAssertion().then(resolveAssertion, rejectAssertion);
      } catch (error) {
        rejectAssertion(error);
      }
    },
    cancel() {
      rejectAssertion?.(new Error("Transaction review closed."));
    },
    fail: failed,
  };
}
