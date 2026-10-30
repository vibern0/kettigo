export async function confirmedUserProof<T>(
  user: string, contract: string, handles: readonly string[], permissions: () => Promise<boolean[]>,
  decrypt: () => Promise<T>, wait: (ms: number) => Promise<void>, retry: (attempt: number, delay: number) => void,
): Promise<T> {
  const grants = await permissions();
  if (!handles.length || grants.length !== handles.length * 2 || !grants.every(v => v === true)) {
    throw new Error("Confirmed user/contract decryption permission missing");
  }
  const expected = new Set(handles.flatMap(h => [
    `User ${user} is not authorized to decrypt handle ${h}!`,
    `Dapp contract ${contract} is not authorized to user decrypt handle ${h}!`,
  ]));
  for (let attempt = 1; ; attempt++) {
    try { return await decrypt(); }
    catch (error: any) {
      let cause = error, mismatch = false;
      if (["NOT_ENTITLED", "DECRYPTION_FAILED"].includes(error.code)) {
        for (let depth = 0; cause && depth < 4; depth++, cause = cause.cause) {
          const message = String(cause.shortMessage ?? cause.message ?? "").split("\n")[0];
          if (expected.has(message)) mismatch = true;
        }
      }
      if (!mismatch || attempt >= 6) throw error;
      const delay = 1000 * 2 ** (attempt - 1); retry(attempt, delay); await wait(delay);
    }
  }
}
