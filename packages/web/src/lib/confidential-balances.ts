"use client";

import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import {
  CONTRACTS,
  RPC_URL,
  confidentialPrizePoolAbi,
  confidentialUsdcAbi,
} from "./contracts";
import type { PasskeySmartSession } from "./smart-session";
import {
  asChecksumAddress,
  clearValueToBigInt,
  createSmartZamaSDK,
  isZeroEncryptedHandle,
} from "./zama";

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
});

type DecryptRequest = {
  key: "confidentialBalance" | "principal";
  handle: `0x${string}`;
  contract: `0x${string}`;
};

type DecryptedBalances = {
  confidentialBalance?: bigint;
  principal?: bigint;
};

async function decryptHandles(
  requests: DecryptRequest[],
  currentSession: PasskeySmartSession,
) {
  if (requests.length === 0) return {};

  const sdk = createSmartZamaSDK(currentSession);
  try {
    const results = await sdk.decryption.decryptValues(
      requests.map((request) => ({
        encryptedValue: request.handle,
        contractAddress: request.contract,
      })),
    );

    return Object.fromEntries(requests.map((request) => [request.key, results[request.handle]]));
  } finally {
    sdk.terminate();
  }
}

export async function decryptConfidentialBalances(
  currentSession: PasskeySmartSession,
): Promise<DecryptedBalances> {
  const user = currentSession.address;
  const token = asChecksumAddress(CONTRACTS.confidentialUsdc, "Savings token");
  const pool = asChecksumAddress(CONTRACTS.confidentialPrizePool, "Prize pool");

  const [balanceHandle, principalHandle] = await Promise.all([
    publicClient.readContract({
      address: token,
      abi: confidentialUsdcAbi,
      functionName: "confidentialBalanceOf",
      args: [user],
    }),
    publicClient.readContract({
      address: pool,
      abi: confidentialPrizePoolAbi,
      functionName: "encryptedPrincipalOf",
      args: [user],
    }),
  ]);

  const balances: DecryptedBalances = {};
  const requests: DecryptRequest[] = [];

  if (isZeroEncryptedHandle(balanceHandle)) {
    balances.confidentialBalance = 0n;
  } else {
    requests.push({
      key: "confidentialBalance",
      handle: balanceHandle as `0x${string}`,
      contract: token,
    });
  }

  if (isZeroEncryptedHandle(principalHandle)) {
    balances.principal = 0n;
  } else {
    requests.push({
      key: "principal",
      handle: principalHandle as `0x${string}`,
      contract: pool,
    });
  }

  const [decryptedBalances] = await Promise.allSettled([
    decryptHandles(requests, currentSession),
  ]);

  for (const decrypted of [decryptedBalances]) {
    if (decrypted.status !== "fulfilled") continue;
    if (decrypted.value.confidentialBalance !== undefined) {
      balances.confidentialBalance = clearValueToBigInt(decrypted.value.confidentialBalance);
    }
    if (decrypted.value.principal !== undefined) {
      balances.principal = clearValueToBigInt(decrypted.value.principal);
    }
  }

  return balances;
}
