"use client";

import Safe, {
  EthSafeSignature,
  buildSignatureBytes,
  getP256VerifierAddress,
  type ExtractedPasskeyData,
} from "@safe-global/protocol-kit";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { getSafeWebAuthnShareSignerDeployment } from "@safe-global/safe-modules-deployments";
import {
  createPublicClient,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { entryPoint07Address, type UserOperation } from "viem/account-abstraction";
import { sepolia } from "viem/chains";
import {
  lookupCanonicalUserOperationReceipt,
  SafeUserOperationIntegrityError,
  type EthereumBlock,
  type EthereumReceipt,
} from "./canonical-user-operation-receipt.ts";
import {
  getSafeUserOperationIdentity,
  SafeUserOperationFailedError,
  SafeUserOperationNotSubmittedError,
  SafeUserOperationPendingError,
  SafeUserOperationRejectedError,
} from "./passkey-operation.ts";
import { createPasskeyFeeEstimator } from "./passkey-fee-estimator.ts";
import { createDeferredPasskeyAssertion } from "./passkey-prepared-assertion.ts";
import {
  canonicalReceiptDependencies,
  sendPasskeyCalls,
  submitSignedPasskeyOperation,
  submissionTimedOut,
  withinSubmissionDeadline,
  type PasskeySubmissionDependencies,
  type SubmissionRelay,
} from "./passkey-submission.ts";
import {
  createGuardedPasskeySession,
  type PendingOperationLockManager,
} from "./pending-operation-session.ts";
import { withDirectCredentialLease } from "./direct-signing-fence.ts";
import { buildPasskeySigner } from "./passkey-signer.ts";

import { writePasskeyMetadata, type PasskeyMetadata } from "./passkey-metadata.ts";
import { createKettigoCredential, getKettigoCredential } from "./passkey-webauthn.ts";
import { publicConfig } from "./runtime-config.ts";
import {
  createPasskeyVerifierGasProbe,
  withPasskeyStage,
  type PasskeyGasDiagnostics,
} from "./passkey-gas.ts";
import type {
  PasskeySmartSession,
  SafeUserOperationIdentity,
  SafeUserOperationReceipt,
  SmartAccountCall,
  SmartTransactionOptions,
} from "./smart-session.ts";
export type { SafeUserOperationIdentity, SafeUserOperationReceipt } from "./smart-session.ts";
export { SafeUserOperationIntegrityError } from "./canonical-user-operation-receipt.ts";
export {
  getSafeUserOperationIdentity,
  SafeUserOperationFailedError,
  SafeUserOperationNotSubmittedError,
  SafeUserOperationPendingError,
  SafeUserOperationRejectedError,
} from "./passkey-operation.ts";
export { createPasskeyFeeEstimator } from "./passkey-fee-estimator.ts";
export { buildPasskeySigner } from "./passkey-signer.ts";

const SAFE_VERSION = "1.4.1" as const;
const SAFE_MODULES_VERSION = "0.3.0";
const SAFE_PASSKEY_MODULE_VERSION = "0.2.1";
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_RECEIPT_POLL_MS = 1_500;
const RPC_URL = publicConfig("NEXT_PUBLIC_RPC_URL", process.env.NEXT_PUBLIC_RPC_URL);
const PIMLICO_API_KEY = publicConfig(
  "NEXT_PUBLIC_PIMLICO_API_KEY",
  process.env.NEXT_PUBLIC_PIMLICO_API_KEY,
);
const PIMLICO_URL = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;
const SHARED_SIGNER_ADDRESS = sharedSignerAddress();

type PasskeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type SafeSignature = Parameters<typeof buildSignatureBytes>[0][number];

type ProtocolKitLike = {
  getAddress(): Promise<string>;
  getSafeMessageHash(messageHash: string): Promise<string>;
  signHash(hash: string): Promise<SafeSignature>;
  getSafeProvider?(): SafeProviderLike;
};

type SafeProviderLike = {
  signer?: unknown;
  getExternalSigner?(): Promise<unknown>;
};

type SafeOperationLike = {
  signatures: Map<string, SafeSignature>;
  addSignature(signature: SafeSignature): void;
};

type UserOperationReceiptLike = {
  success: boolean;
  receipt: { transactionHash: string };
  userOpHash: string;
  sender: string;
};

type RelayLike = SubmissionRelay & {
  protocolKit: ProtocolKitLike;
};

type RelayInitOptions = Parameters<typeof Safe4337Pack.init>[0];

type PasskeySafeDependencies = PasskeySubmissionDependencies & {
  createCredential(input: { rpId: string; rpName: string }): Promise<Credential>;
  extractPasskeyData(credential: Credential): Promise<ExtractedPasskeyData>;
  getVerifierAddress(chainId: string): string;
  initRelay(options: RelayInitOptions): Promise<RelayLike>;
  getCode(address: Address): Promise<Hex | undefined>;
  getCredential(
    rawId: string,
    rpId: string,
    options?: CredentialRequestOptions,
  ): Promise<Credential>;
  estimateVerifierGas(address: Address): Promise<bigint>;
  sleep(milliseconds: number): Promise<void>;
  pendingOperationLocks?: PendingOperationLockManager;
  pendingOperationStorage?: PasskeyStorage;
  preparationTimeoutMs?: number;
};

type ReceiptWaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
});

const defaultDependencies: PasskeySafeDependencies = {
  estimateVerifierGas: createPasskeyVerifierGasProbe(publicClient),
  createCredential: ({ rpId, rpName }) => createKettigoCredential({ rpId, rpName }),
  extractPasskeyData: (credential) => Safe.createPasskeySigner(credential),
  getVerifierAddress: getP256VerifierAddress,
  initRelay: async (options) => {
    const relay = (await Safe4337Pack.init(options)) as RelayLike;
    return "safeAddress" in options.options ? prepareDeployedRelay(relay) : relay;
  },
  getCode: (address) => publicClient.getCode({ address }),
  getTransactionReceipt: (input) =>
    publicClient.getTransactionReceipt(input) as unknown as Promise<EthereumReceipt>,
  getBlock: (input) => publicClient.getBlock(input) as unknown as Promise<EthereumBlock>,
  getCredential: (rawId, rpId, options) => getKettigoCredential(rawId, { rpId }, options),
  sleep: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
};

export async function createPasskeyAccount(
  input: { rpId: string; rpName: string; storage?: PasskeyStorage },
  dependencies: Partial<PasskeySafeDependencies> = {},
): Promise<PasskeySmartSession> {
  const deps = withDependencies(dependencies);
  const credential = await deps.createCredential({ rpId: input.rpId, rpName: input.rpName });
  const extracted = await deps.extractPasskeyData(credential);
  const metadata = signerMetadata(extracted, deps.getVerifierAddress(String(sepolia.id)));
  const relay = await deps.initRelay(
    relayOptions(metadata, predictedOptions(metadata.rawId), input.rpId, deps),
  );
  const address = getAddress(await relay.protocolKit.getAddress());
  const stored = writePasskeyMetadata({ ...metadata, safeAddress: address }, input.storage);
  return createGuardedPasskeySession(createSession(relay, stored, input.rpId, deps, true), {
    storage: input.storage ?? deps.pendingOperationStorage,
    locks: deps.pendingOperationLocks,
    preparationTimeoutMs: deps.preparationTimeoutMs,
  });
}

export async function restorePasskeyAccount(
  input: { metadata: PasskeyMetadata; rpId: string; storage?: PasskeyStorage },
  dependencies: Partial<PasskeySafeDependencies> = {},
): Promise<PasskeySmartSession> {
  const deps = withDependencies({
    ...dependencies,
  });
  const expectedAddress = getAddress(input.metadata.safeAddress);
  const predictedRelay = await deps.initRelay(
    relayOptions(input.metadata, predictedOptions(input.metadata.rawId), input.rpId, deps),
  );
  const derivedAddress = getAddress(await predictedRelay.protocolKit.getAddress());
  if (derivedAddress !== expectedAddress) {
    throw new Error("The restored Safe address does not match the saved account.");
  }
  const code = await deps.getCode(expectedAddress);
  const isDeployed = Boolean(code && code !== "0x");
  const relay = isDeployed
    ? await prepareDeployedRelay(
        await deps.initRelay(
          relayOptions(input.metadata, { safeAddress: expectedAddress }, input.rpId, deps),
        ),
      )
    : predictedRelay;
  return createGuardedPasskeySession(
    createSession(relay, input.metadata, input.rpId, deps, !isDeployed),
    {
      storage: input.storage ?? deps.pendingOperationStorage,
      locks: deps.pendingOperationLocks,
      preparationTimeoutMs: deps.preparationTimeoutMs,
    },
  );
}

export async function signSafeTypedData(
  protocolKit: Pick<ProtocolKitLike, "getSafeMessageHash" | "signHash">,
  typedData: unknown,
): Promise<Hex> {
  const digest = hashTypedData(typedData as Parameters<typeof hashTypedData>[0]);
  const safeMessageHash = await protocolKit.getSafeMessageHash(digest);
  const ownerSignature = await protocolKit.signHash(safeMessageHash);
  return buildSignatureBytes([ownerSignature]) as Hex;
}

export async function waitForUserOperationTransaction(
  relay: Pick<RelayLike, "getUserOperationReceipt">,
  userOperationHash: string,
  options: ReceiptWaitOptions = {},
): Promise<Hex> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_RECEIPT_POLL_MS;
  const sleep = options.sleep ?? defaultDependencies.sleep;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const receipt = await relay.getUserOperationReceipt(userOperationHash);
    if (receipt) {
      if (!receipt.success) throw new Error("The sponsored transaction failed.");
      return receipt.receipt.transactionHash as Hex;
    }
    await sleep(pollMs);
  }

  throw new Error("The sponsored transaction is still pending. Please try again.");
}

function createSession(
  initialRelay: RelayLike,
  metadata: PasskeyMetadata,
  rpId: string,
  deps: PasskeySafeDependencies,
  counterfactual: boolean,
): PasskeySmartSession {
  let relay = initialRelay;
  let usingCounterfactualRelay = counterfactual;
  let refreshRequired = false;

  async function refreshDeploymentState(): Promise<void> {
    if (!refreshRequired) return;
    const code = await withinSubmissionDeadline(
      () => deps.getCode(getAddress(metadata.safeAddress)),
      deps.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS,
    );
    if (code === submissionTimedOut) throw new Error("Safe deployment state refresh timed out.");
    if (!code || code === "0x") {
      if (!usingCounterfactualRelay) {
        relay = await deps.initRelay(
          relayOptions(metadata, predictedOptions(metadata.rawId), rpId, deps),
        );
        usingCounterfactualRelay = true;
      }
      refreshRequired = false;
      return;
    }
    const refreshedRelay = await prepareDeployedRelay(
      await deps.initRelay(
        relayOptions(metadata, { safeAddress: getAddress(metadata.safeAddress) }, rpId, deps),
      ),
    );
    relay = refreshedRelay;
    usingCounterfactualRelay = false;
    refreshRequired = false;
  }

  return {
    address: getAddress(metadata.safeAddress),
    signTypedData: async (typedData) => {
      await refreshDeploymentState();
      return signSafeTypedData(relay.protocolKit, typedData);
    },
    lookupUserOperation: async (operation) => {
      if (
        operation.chainId !== sepolia.id ||
        operation.entryPoint !== getAddress(entryPoint07Address)
      ) {
        throw new SafeUserOperationIntegrityError(
          operation,
          "The operation is not for this network.",
        );
      }
      if (operation.sender !== getAddress(metadata.safeAddress)) {
        throw new SafeUserOperationIntegrityError(operation, "The operation is not for this Safe.");
      }
      const outcome = await lookupCanonicalUserOperationReceipt(
        canonicalReceiptDependencies(relay, deps),
        operation,
      );
      if (usingCounterfactualRelay) refreshRequired = true;
      return outcome;
    },
    prepareTransaction: async (calls) => {
      await refreshDeploymentState();
      // Each prepared approval owns its relay and WebAuthn gate. Other wallet
      // actions cannot consume this operation's challenge or assertion.
      const assertion = createDeferredPasskeyAssertion(deps);
      const signingDeps = { ...deps, ...assertion.signingDependencies };
      const preparedRelay = await deps.initRelay(
        relayOptions(
          metadata,
          usingCounterfactualRelay
            ? predictedOptions(metadata.rawId)
            : { safeAddress: getAddress(metadata.safeAddress) },
          rpId,
          signingDeps,
        ),
      );
      const diagnostics: PasskeyGasDiagnostics = {};
      const operation = await withPasskeyStage(diagnostics, "estimation", () =>
        preparedRelay.createTransaction({
          transactions: calls.map((call) => ({
            to: getAddress(call.to),
            data: call.data,
            value: (call.value ?? 0n).toString(),
          })),
          options: {
            feeEstimator: createPasskeyFeeEstimator(undefined, {
              estimateVerifierGas: () =>
                deps.estimateVerifierGas(getAddress(metadata.verifierAddress)),
              diagnostics,
            }),
          },
        }),
      );
      const signedOperation = withPasskeyStage(diagnostics, "signing", () =>
        preparedRelay.signSafeOperation(operation),
      );
      // Run Safe's RPC checks now; pause only when its actual assertion is ready.
      void signedOperation.then(assertion.markReady, assertion.fail);
      await assertion.waitUntilReady();
      let used = false;
      return {
        cancel() {
          if (used) return;
          used = true;
          assertion.cancel();
        },
        async send(options?: SmartTransactionOptions): Promise<Hex> {
          if (used) throw new Error("Please go back and review your transaction again.");
          used = true;
          assertion.requestFromConfirmation();
          const signed = normalizePasskeySignature(await signedOperation);
          const tx = await submitSignedPasskeyOperation(
            preparedRelay,
            signed,
            deps,
            diagnostics,
            getAddress(metadata.safeAddress),
            options,
            () => {
              if (usingCounterfactualRelay) refreshRequired = true;
            },
          );
          return tx;
        },
      };
    },
    sendTransaction: async (calls, options) => {
      // Rebuild the deployed relay immediately before signing. A session can
      // outlive the relay's cached Safe/module state, which makes an otherwise
      // valid passkey assertion fail AA24. Refreshing before signing avoids a
      // second WebAuthn prompt and keeps the claim to one user confirmation.
      if (!usingCounterfactualRelay) refreshRequired = true;
      await refreshDeploymentState();
      const active = (
        options as SmartTransactionOptions & { __assertPendingOperationLease?: () => void }
      ).__assertPendingOperationLease;
      const signingRelay = active
        ? await prepareDeployedRelay(
            await deps.initRelay(
              relayOptions(
                metadata,
                usingCounterfactualRelay
                  ? predictedOptions(metadata.rawId)
                  : { safeAddress: getAddress(metadata.safeAddress) },
                rpId,
                withDirectCredentialLease(deps, active),
              ),
            ),
          )
        : relay;
      return sendPasskeyCalls(
        signingRelay,
        calls,
        deps,
        getAddress(metadata.verifierAddress),
        getAddress(metadata.safeAddress),
        normalizePasskeySignature,
        active,
        options,
        () => {
          if (usingCounterfactualRelay) refreshRequired = true;
        },
      );
    },
  };
}

function normalizePasskeySignature(operation: unknown): unknown {
  const safeOperation = operation as Partial<SafeOperationLike>;
  const signatures = safeOperation.signatures;
  if (!(signatures instanceof Map) || signatures.size !== 1 || !safeOperation.addSignature) {
    return operation;
  }
  const [signature] = signatures.values();
  if (
    signature.isContractSignature &&
    signature.signer.toLowerCase() === SHARED_SIGNER_ADDRESS.toLowerCase()
  )
    return operation;
  signatures.clear();
  safeOperation.addSignature(new EthSafeSignature(SHARED_SIGNER_ADDRESS, signature.data, true));
  return operation;
}

async function prepareDeployedRelay(relay: RelayLike): Promise<RelayLike> {
  const safeProvider = relay.protocolKit.getSafeProvider?.();
  const externalSigner = await safeProvider?.getExternalSigner?.();
  if (!safeProvider || !externalSigner || typeof externalSigner !== "object") return relay;

  const signer = externalSigner as {
    key?: unknown;
    account?: { address?: unknown };
  };
  if (signer.key !== "passkeyWallet" || !signer.account?.address) return relay;

  // Relay Kit 6.1.1 initializes an existing Safe without passing its owners
  // into Protocol Kit. That makes a shared WebAuthn signer look like the
  // individual signer contract. Keep the same passkey client, but bind its
  // account to the shared signer that is actually an owner of this Safe.
  signer.account = { ...signer.account, address: SHARED_SIGNER_ADDRESS };
  safeProvider.signer = externalSigner;
  return relay;
}

function relayOptions(
  metadata: Pick<PasskeyMetadata, "rawId" | "coordinates" | "verifierAddress">,
  options: RelayInitOptions["options"],
  rpId: string,
  dependencies: Pick<PasskeySafeDependencies, "getCredential">,
): RelayInitOptions {
  const signer = buildPasskeySigner(metadata, rpId, dependencies);
  return {
    provider: RPC_URL,
    signer,
    bundlerUrl: PIMLICO_URL,
    safeModulesVersion: SAFE_MODULES_VERSION,
    customContracts: {
      entryPointAddress: entryPoint07Address,
      safeWebAuthnSharedSignerAddress: SHARED_SIGNER_ADDRESS,
    },
    options,
    paymasterOptions: {
      isSponsored: true,
      paymasterUrl: PIMLICO_URL,
    },
  };
}

function sharedSignerAddress(): Address {
  const deployment = getSafeWebAuthnShareSignerDeployment({
    version: SAFE_PASSKEY_MODULE_VERSION,
    released: true,
    network: String(sepolia.id),
  });
  const address = Object.entries(deployment?.networkAddresses ?? {}).find(
    ([network]) => network === String(sepolia.id),
  )?.[1];
  if (!address) throw new Error("Safe passkey signer is unavailable on this network.");
  return getAddress(address);
}

function predictedOptions(rawId: string): RelayInitOptions["options"] {
  return {
    owners: [],
    threshold: 1,
    safeVersion: SAFE_VERSION,
    saltNonce: BigInt(keccak256(`0x${rawId}` as Hex)).toString(),
  };
}

function signerMetadata(
  extracted: ExtractedPasskeyData,
  verifierAddress: string,
): Omit<PasskeyMetadata, "safeAddress"> {
  const rawId = extracted.rawId.replace(/^0x/, "").toLowerCase();
  if (!/^[a-f0-9]+$/.test(rawId) || rawId.length % 2 !== 0) {
    throw new Error("Safe returned invalid passkey metadata.");
  }
  return {
    rawId,
    coordinates: {
      x: extracted.coordinates.x as Hex,
      y: extracted.coordinates.y as Hex,
    },
    verifierAddress: getAddress(verifierAddress),
  };
}

function withDependencies(overrides: Partial<PasskeySafeDependencies>): PasskeySafeDependencies {
  return { ...defaultDependencies, ...overrides };
}
