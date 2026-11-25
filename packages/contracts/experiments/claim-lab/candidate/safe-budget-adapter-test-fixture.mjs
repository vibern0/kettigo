import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "ethers";

import { CandidateRunJournal, ORIGINAL_ENVELOPE as envelope } from "./journal.mjs";
import { SafeBudgetAdapter } from "./safe-budget-adapter.mjs";

export const SAFE = "0x1111111111111111111111111111111111111111";
export const ENTRY_POINT = getAddress("0x0000000071727de22e5e9d8baf0edac6f37da032");
export const POOL = "0x2222222222222222222222222222222222222222";
export const SIGNATURE = "0x1234";
export const HASH = `0x${"ab".repeat(32)}`;
export const ORIGINAL_ENVELOPE = envelope;

export function operation(overrides = {}) {
  return {
    sender: SAFE,
    nonce: 0n,
    factory: "0x",
    factoryData: "0x",
    callData: "0x1234",
    callGasLimit: 1n,
    verificationGasLimit: 2n,
    preVerificationGas: 3n,
    maxFeePerGas: 4n,
    maxPriorityFeePerGas: 1n,
    paymaster: "0x",
    paymasterVerificationGasLimit: 0n,
    paymasterPostOpGasLimit: 0n,
    paymasterData: "0x",
    signature: "0x",
    ...overrides,
  };
}

export async function createJournal(options = {}) {
  return CandidateRunJournal.open({
    directory: await mkdtemp(join(tmpdir(), "kettigo-safe-budget-")),
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
    ...options,
  });
}

export async function reopenJournal(directory, options = {}) {
  return CandidateRunJournal.open({
    directory,
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
    ...options,
  });
}

export function adapter(journal, options = {}) {
  return new SafeBudgetAdapter({
    journal,
    expected: { chainId: 11155111, entryPoint: ENTRY_POINT, safe: SAFE, journalTarget: POOL },
    callPolicy: {
      assert: ({ callData }) => {
        if (callData !== "0x1234") throw new Error("unapproved nested call target");
      },
    },
    identity: () => ({
      chainId: 11155111,
      entryPoint: ENTRY_POINT,
      sender: SAFE,
      userOperationHash: HASH,
    }),
    now: () => 1000,
    ...options,
  });
}

export function evidence(identity, overrides = {}) {
  return {
    state: "confirmed",
    operation: identity,
    transactionHash: `0x${"22".repeat(32)}`,
    blockNumber: 42n,
    blockHash: `0x${"33".repeat(32)}`,
    nonce: 0n,
    actualGasCost: 7n,
    ...overrides,
  };
}

export async function signedAttempt(journal, intentId = "safe-reconcile") {
  const fence = adapter(journal);
  const reservation = await fence.reserve({ intentId, operation: operation(), offeredAt: 1000 });
  await fence.saveSigned({ reservation, operation: operation({ signature: SIGNATURE }) });
  await journal.recordAttempt(intentId);
  return fence;
}
