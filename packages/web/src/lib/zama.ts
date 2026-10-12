"use client";

import {
  createConfig,
  createWalletAccountStore,
  memoryStorage,
  ZamaSDK,
  type EIP712TypedData,
  type GenericSigner,
  type Hex as ZamaHex,
  type ZamaConfig,
} from "@zama-fhe/sdk";
import { sepolia as zamaSepolia } from "@zama-fhe/sdk/chains";
import { web } from "@zama-fhe/sdk/web";
import { ViemProvider } from "@zama-fhe/sdk/viem";
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { RPC_URL } from "./contracts";
import type { PasskeySmartSession } from "./smart-session";

const ZERO_HANDLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
const DEFAULT_TIMEOUT_MS = 8_000;

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
});

const provider = new ViemProvider({ publicClient });

function signerStore(address: Address) {
  return createWalletAccountStore({ address, chainId: sepolia.id });
}

class SmartAccountZamaSigner implements GenericSigner {
  readonly walletAccount: ReturnType<typeof createWalletAccountStore>;

  constructor(private readonly session: PasskeySmartSession) {
    this.walletAccount = signerStore(getAddress(session.address));
  }

  requireWalletAccount() {
    return this.walletAccount.getSnapshot() ?? { address: getAddress(this.session.address), chainId: sepolia.id };
  }

  signTypedData(typedData: EIP712TypedData) {
    return this.session.signTypedData(typedData) as Promise<ZamaHex>;
  }

  writeContract(config: any) {
    return this.session.sendTransaction([{
        to: getAddress(config.address),
        data: encodeFunctionData(config as any),
        value: config.value,
      }]) as Promise<ZamaHex>;
  }
}

function chainConfig() {
  return {
    ...zamaSepolia,
    network: RPC_URL,
  };
}

function configFor(signer?: GenericSigner): ZamaConfig {
  const chain = chainConfig();
  return createConfig({
    chains: [chain],
    provider,
    signer,
    storage: memoryStorage,
    relayers: { [chain.id]: web({ timeout: DEFAULT_TIMEOUT_MS }) },
  });
}

export function asChecksumAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${label} is not a valid address.`);
  }

  return getAddress(value);
}

export function isZeroEncryptedHandle(handle: unknown) {
  return typeof handle === "string" && handle.toLowerCase() === ZERO_HANDLE;
}

export function clearValueToBigInt(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  throw new Error("Reveal result is unavailable.");
}

export function createPublicZamaSDK() {
  return new ZamaSDK(configFor());
}

export function createSmartZamaSDK(session: PasskeySmartSession) {
  return new ZamaSDK(configFor(new SmartAccountZamaSigner(session)));
}

export async function encryptUint64(
  sdk: ZamaSDK,
  contractAddress: Address,
  userAddress: Address,
  value: bigint,
) {
  const encrypted = await sdk.encrypt({
    contractAddress: getAddress(contractAddress),
    userAddress: getAddress(userAddress),
    values: [{ type: "euint64", value }],
  });

  return {
    handle: encrypted.encryptedValues[0] as Hex,
    inputProof: encrypted.inputProof as Hex,
  };
}

export async function decryptUint64(
  sdk: ZamaSDK,
  handle: Hex,
  contractAddress: Address,
) {
  if (isZeroEncryptedHandle(handle)) return 0n;

  const result = await sdk.decryption.decryptValues([{
    encryptedValue: handle,
    contractAddress: getAddress(contractAddress),
  }]);

  return clearValueToBigInt(result[handle]);
}

export async function decryptPublicUint64(sdk: ZamaSDK, handle: Hex) {
  const decrypted = await sdk.decryption.decryptPublicValues([handle], { timeout: DEFAULT_TIMEOUT_MS });
  const clearValue = decrypted.clearValues[handle];
  if (typeof clearValue !== "bigint" && typeof clearValue !== "number" && typeof clearValue !== "string") {
    throw new Error("Reveal result is unavailable.");
  }

  return {
    clearValue: clearValueToBigInt(clearValue),
    decryptionProof: decrypted.decryptionProof as Hex,
  };
}
