"use client";

import {
  createConfig,
  createWalletAccountStore,
  delegateForUserDecryptionContract,
  getDelegationExpiryContract,
  indexedDBStorage,
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
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { CONTRACTS, RPC_URL } from "./contracts";
import type { PasskeySmartSession } from "./smart-session";
import {
  createDelegatedZamaSessionManager,
  createPersistentCredentialOptions,
  createZamaSessionManager,
  getOrCreateZamaReadSessionKey,
  loadZamaReadSessionKey,
  prepareZamaReadContracts,
  removeZamaReadSessionKey,
  signZamaReadSessionTypedData,
  type ZamaReadSessionKey,
} from "./zama-session-manager";

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

class ReadSessionZamaSigner implements GenericSigner {
  readonly walletAccount: ReturnType<typeof createWalletAccountStore>;
  readonly #account: ReturnType<typeof privateKeyToAccount>;

  constructor(private readonly privateKey: Hex) {
    this.#account = privateKeyToAccount(privateKey);
    this.walletAccount = signerStore(getAddress(this.#account.address));
  }

  requireWalletAccount() {
    return this.walletAccount.getSnapshot() ?? {
      address: getAddress(this.#account.address),
      chainId: sepolia.id,
    };
  }

  signTypedData(typedData: EIP712TypedData) {
    return signZamaReadSessionTypedData(this.privateKey, typedData) as Promise<ZamaHex>;
  }

  async writeContract(): Promise<ZamaHex> {
    throw new Error("The balance read session cannot submit transactions.");
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
    ...createPersistentCredentialOptions(indexedDBStorage),
    relayers: { [chain.id]: web({ timeout: DEFAULT_TIMEOUT_MS }) },
  });
}

const smartZamaSessions = createZamaSessionManager((session: PasskeySmartSession) =>
  new ZamaSDK(configFor(new SmartAccountZamaSigner(session))),
);

function browserStorage() {
  if (typeof window === "undefined") {
    throw new Error("Balance read sessions are only available in the browser.");
  }
  return window.localStorage;
}

async function ensureReadSessionDelegated(
  session: PasskeySmartSession,
  key: ZamaReadSessionKey,
  contracts: Address[],
) {
  const acl = getAddress(zamaSepolia.aclContractAddress);
  const delegator = getAddress(session.address);
  const delegate = getAddress(key.address);
  const expiration = BigInt(Math.floor(key.expiresAtMs / 1_000));
  const uniqueContracts = [...new Set(contracts.map(getAddress))];
  const delegationStates = await Promise.all(uniqueContracts.map(async (contractAddress) => ({
    contractAddress,
    currentExpiration: await publicClient.readContract(getDelegationExpiryContract(
      acl,
      delegator,
      delegate,
      contractAddress,
    )),
  })));
  const calls = delegationStates.flatMap(({ contractAddress, currentExpiration }) => {
    if (currentExpiration >= expiration) return [];
    const config = delegateForUserDecryptionContract(
      acl,
      delegate,
      contractAddress,
      expiration,
    );
    return [{
      to: acl,
      data: encodeFunctionData(config),
    }];
  });

  if (calls.length > 0) {
    await session.sendTransaction(calls);
  }
}

const delegatedZamaSessions = createDelegatedZamaSessionManager({
  async loadSessionKey(session: PasskeySmartSession) {
    return loadZamaReadSessionKey(
      browserStorage(),
      session.address,
      (privateKey) => getAddress(privateKeyToAccount(privateKey).address),
    );
  },
  async createSessionKey(session: PasskeySmartSession) {
    return getOrCreateZamaReadSessionKey(browserStorage(), session.address, Date.now(), {
      generatePrivateKey,
      getAccountAddress: (privateKey) => getAddress(privateKeyToAccount(privateKey).address),
    });
  },
  isSessionKeyValid(key) {
    return key.expiresAtMs > Date.now();
  },
  createResource(key) {
    return new ZamaSDK(configFor(new ReadSessionZamaSigner(key.privateKey)));
  },
  ensureDelegated: ensureReadSessionDelegated,
});

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

function decryptedValueForHandle(values: Record<string, unknown>, handle: Hex) {
  if (!Object.hasOwn(values, handle)) {
    throw new Error("Reveal result is unavailable.");
  }
  return Reflect.get(values, handle);
}

export function createPublicZamaSDK() {
  return new ZamaSDK(configFor());
}

export function withSmartZamaSDK<Result>(
  session: PasskeySmartSession,
  operation: (sdk: ZamaSDK) => Promise<Result>,
) {
  return smartZamaSessions.run(session, operation);
}

export async function decryptWithSmartReadSession(
  session: PasskeySmartSession,
  encryptedInputs: Array<{ encryptedValue: Hex; contractAddress: Address }>,
) {
  const normalized = encryptedInputs.map((input) => ({
    encryptedValue: input.encryptedValue,
    contractAddress: getAddress(input.contractAddress),
  }));
  const allowedContracts = [
    asChecksumAddress(CONTRACTS.confidentialUsdc, "Savings token"),
    asChecksumAddress(CONTRACTS.confidentialPrizePool, "Prize pool"),
  ];
  const { delegationContracts } = prepareZamaReadContracts(
    normalized.map((input) => input.contractAddress),
    allowedContracts,
  );
  const delegator = getAddress(session.address);
  return delegatedZamaSessions.run(session, delegationContracts, (sdk) =>
    sdk.decryption.delegatedDecryptValues(normalized, delegator, delegator),
  );
}

export async function clearSmartZamaSession(session: PasskeySmartSession) {
  await Promise.all([
    smartZamaSessions.clear(session),
    delegatedZamaSessions.clear(session),
  ]);
  removeZamaReadSessionKey(browserStorage(), session.address);
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

  return clearValueToBigInt(decryptedValueForHandle(result, handle));
}

export async function decryptSmartUint64(
  session: PasskeySmartSession,
  handle: Hex,
  contractAddress: Address,
) {
  if (isZeroEncryptedHandle(handle)) return 0n;

  const result = await decryptWithSmartReadSession(session, [{
    encryptedValue: handle,
    contractAddress: getAddress(contractAddress),
  }]);
  return clearValueToBigInt(decryptedValueForHandle(result, handle));
}

export async function decryptPublicUint64(sdk: ZamaSDK, handle: Hex) {
  const decrypted = await sdk.decryption.decryptPublicValues([handle], { timeout: DEFAULT_TIMEOUT_MS });
  const clearValue = decryptedValueForHandle(decrypted.clearValues, handle);
  if (typeof clearValue !== "bigint" && typeof clearValue !== "number" && typeof clearValue !== "string") {
    throw new Error("Reveal result is unavailable.");
  }

  return {
    clearValue: clearValueToBigInt(clearValue),
    decryptionProof: decrypted.decryptionProof as Hex,
  };
}
