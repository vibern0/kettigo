type CredentialDependencies = {
  getCredential(
    rawId: string,
    rpId: string,
    options?: CredentialRequestOptions,
  ): Promise<Credential>;
};

/** Creates a relay-local credential boundary for exactly one direct operation. */
export function withDirectCredentialLease<T extends CredentialDependencies>(
  deps: T,
  assertActive: () => void,
): T {
  return {
    ...deps,
    getCredential: async (rawId, rpId, options) => {
      assertActive();
      return deps.getCredential(rawId, rpId, options);
    },
  };
}
