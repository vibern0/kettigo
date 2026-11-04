// A confirmed receipt can precede an RPC backend's latest-state view. Never
// retry a permission denial unless the exact marker is permitted at that block.
export async function confirmedPublicProof<T>(
  handle: string, confirmedPermission: () => Promise<boolean>, prove: () => Promise<T>,
  wait: (ms: number) => Promise<void>, retry: (attempt: number, delay: number) => void,
): Promise<T> {
  if (!await confirmedPermission()) throw new Error("Confirmed admission marker is not publicly decryptable");
  for (let attempt = 1; ; attempt++) {
    try { return await prove(); }
    catch (error: any) {
      let cause = error, mismatch = false;
      if (error.code === "DECRYPTION_FAILED") {
        for (let depth = 0; cause && depth < 4; depth++, cause = cause.cause) {
          const message = String(cause.shortMessage ?? cause.message ?? "").split("\n")[0];
          if (message === `Handle ${handle} is not allowed for public decryption`) mismatch = true;
        }
      }
      if (!mismatch || attempt >= 6) throw error;
      const delay = 1000 * 2 ** (attempt - 1);
      retry(attempt, delay); await wait(delay);
    }
  }
}
