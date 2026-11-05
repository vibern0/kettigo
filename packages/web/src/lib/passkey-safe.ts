"use client";

import Safe, {
  EthSafeSignature,
  buildSignatureBytes,
  getP256VerifierAddress,
  type ExtractedPasskeyData,
  type PasskeyArgType,
} from "@safe-global/protocol-kit";
import { PimlicoFeeEstimator, Safe4337Pack } from "@safe-global/relay-kit";
import { getSafeWebAuthnShareSignerDeployment } from "@safe-global/safe-modules-deployments";
import {
  createPublicClient,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  RpcRequestError,
  type Address,
  type Hex,
} from "viem";
import {
  entryPoint07Address,
  getUserOperationHash,
  type UserOperation,
} from "viem/account-abstraction";
import { sepolia } from "viem/chains";
import {
  lookupCanonicalUserOperationReceipt,
  SafeUserOperationIntegrityError,
  type CanonicalReceiptDependencies,
  type EthereumBlock,
  type EthereumReceipt,
} from "./canonical-user-operation-receipt.ts";

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

export class SafeUserOperationPendingError extends Error {
  readonly operation: SafeUserOperationIdentity;
  constructor(operation: SafeUserOperationIdentity, cause?: unknown) {
    super("The sponsored transaction is still pending. Please try again.", { cause });
    this.name = "SafeUserOperationPendingError";
    this.operation = operation;
  }
}

export class SafeUserOperationFailedError extends Error {
  readonly operation: SafeUserOperationIdentity;
  readonly transactionHash?: Hex;
  constructor(operation: SafeUserOperationIdentity, transactionHash?: Hex) {
    super("The sponsored transaction failed.");
    this.name = "SafeUserOperationFailedError";
    this.operation = operation;
    this.transactionHash = transactionHash;
  }
}

export class SafeUserOperationRejectedError extends Error {
  readonly operation: SafeUserOperationIdentity;
  readonly code: number;
  constructor(operation: SafeUserOperationIdentity, code: number, cause?: unknown) {
    super("The sponsored transaction was rejected before submission.", { cause });
    this.name = "SafeUserOperationRejectedError";
    this.operation = operation;
    this.code = code;
  }
}

/** The signed operation is known, but no UserOperation was submitted. */
export class SafeUserOperationNotSubmittedError extends Error {
  readonly operation: SafeUserOperationIdentity;
  constructor(operation: SafeUserOperationIdentity, cause?: unknown) {
    super("The sponsored transaction was not submitted. Please review and try again.", { cause });
    this.name = "SafeUserOperationNotSubmittedError";
    this.operation = operation;
  }
}

const SAFE_VERSION = "1.4.1" as const;
const SAFE_MODULES_VERSION = "0.3.0";
const SAFE_PASSKEY_MODULE_VERSION = "0.2.1";
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_RECEIPT_POLL_MS = 1_500;
const USER_OPERATION_REJECTION_CODES = new Set([
  -32602, -32500, -32501, -32502, -32503, -32504, -32505, -32507, -32508,
]);
const PASSKEY_VERIFICATION_GAS_MARGIN = 50_000n;
const PASSKEY_DISPATCH_GAS = 100_000n;
// Sepolia's real P256 assertion needed ~417k for Safe.checkSignatures even
// though the dummy-signature estimate was ~309k. The captured operation failed
// validateUserOp at 358,778 gas and passed at 450k; leave headroom for the
// complete validation path and signature-dependent verifier cost.
const PASSKEY_MIN_VERIFICATION_GAS = 600_000n;
const RPC_URL = publicConfig("NEXT_PUBLIC_RPC_URL", process.env.NEXT_PUBLIC_RPC_URL);
const PIMLICO_API_KEY = publicConfig(
  "NEXT_PUBLIC_PIMLICO_API_KEY",
  process.env.NEXT_PUBLIC_PIMLICO_API_KEY,
);
const PIMLICO_URL = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;
const SHARED_SIGNER_ADDRESS = sharedSignerAddress();

export function getSafeUserOperationIdentity(
  userOperation: UserOperation<"0.7">,
): SafeUserOperationIdentity {
  const sender = getAddress(userOperation.sender);
  return Object.freeze({
    chainId: sepolia.id,
    entryPoint: getAddress(entryPoint07Address),
    sender,
    userOperationHash: getUserOperationHash({
      chainId: sepolia.id,
      entryPointAddress: getAddress(entryPoint07Address),
      entryPointVersion: "0.7",
      userOperation: { ...userOperation, sender },
    }),
  });
}

function sameHash(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function submittedRequestMethod(error: RpcRequestError): string | undefined {
  const request = error.metaMessages?.find((message) => message.startsWith("Request body: "));
  if (!request) return undefined;
  try {
    const body: unknown = JSON.parse(request.slice("Request body: ".length));
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const method = (body as { method?: unknown }).method;
    return typeof method === "string" ? method : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Relay Kit's pinned Safe4337Pack submits through viem with
 * `eth_sendUserOperation`. Only that authenticated viem request boundary can
 * prove that an ERC-7769 validation/inclusion response was not accepted.
 */
function bundlerRejection(error: unknown): RpcRequestError | undefined {
  const seen = new Set<object>();
  let candidate = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(candidate instanceof Error) || seen.has(candidate)) return undefined;
    seen.add(candidate);
    if (
      candidate instanceof RpcRequestError &&
      USER_OPERATION_REJECTION_CODES.has(candidate.code) &&
      submittedRequestMethod(candidate) === "eth_sendUserOperation"
    )
      return candidate;
    candidate = candidate.cause;
  }
  return undefined;
}

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
  getUserOperation?(): UserOperation<"0.7">;
};

type UserOperationReceiptLike = {
  success: boolean;
  receipt: { transactionHash: string };
  userOpHash: string;
  sender: string;
};

type RelayLike = {
  protocolKit: ProtocolKitLike;
  createTransaction(input: {
    transactions: Array<{ to: string; data: string; value: string }>;
    options?: { feeEstimator?: ReturnType<typeof createPasskeyFeeEstimator> };
  }): Promise<unknown>;
  signSafeOperation(operation: unknown): Promise<unknown>;
  executeTransaction(input: { executable: unknown }): Promise<string>;
  getUserOperationReceipt(userOperationHash: string): Promise<UserOperationReceiptLike | null>;
};

type RelayInitOptions = Parameters<typeof Safe4337Pack.init>[0];

type PasskeySafeDependencies = {
  createCredential(input: { rpId: string; rpName: string }): Promise<Credential>;
  extractPasskeyData(credential: Credential): Promise<ExtractedPasskeyData>;
  getVerifierAddress(chainId: string): string;
  initRelay(options: RelayInitOptions): Promise<RelayLike>;
  getCode(address: Address): Promise<Hex | undefined>;
  getTransactionReceipt(
    input: { hash: Hex },
    options?: { signal?: AbortSignal },
  ): Promise<EthereumReceipt | null>;
  getBlock(
    input: { blockNumber: bigint },
    options?: { signal?: AbortSignal },
  ): Promise<EthereumBlock | null>;
  getCredential(
    rawId: string,
    rpId: string,
    options?: CredentialRequestOptions,
  ): Promise<Credential>;
  estimateVerifierGas(address: Address): Promise<bigint>;
  sleep(milliseconds: number): Promise<void>;
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
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
  return createSession(relay, stored, input.rpId, deps, true);
}

export async function restorePasskeyAccount(
  input: { metadata: PasskeyMetadata; rpId: string },
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
  return createSession(relay, input.metadata, input.rpId, deps, !isDeployed);
}

export function buildPasskeySigner(
  metadata: Pick<PasskeyMetadata, "rawId" | "coordinates" | "verifierAddress">,
  rpId: string,
  dependencies: Pick<PasskeySafeDependencies, "getCredential">,
): PasskeyArgType {
  return {
    rawId: metadata.rawId,
    coordinates: metadata.coordinates,
    verifierAddress: getAddress(metadata.verifierAddress),
    getFn: (options) => dependencies.getCredential(metadata.rawId, rpId, options),
  };
}

type PimlicoFeeEstimatorLike = Pick<
  PimlicoFeeEstimator,
  "preEstimateUserOperationGas" | "postEstimateUserOperationGas"
>;

export function createPasskeyFeeEstimator(
  baseEstimator: PimlicoFeeEstimatorLike = new PimlicoFeeEstimator(),
  options: {
    estimateVerifierGas?: () => Promise<bigint>;
    diagnostics?: PasskeyGasDiagnostics;
  } = {},
) {
  const diagnostics = options.diagnostics ?? {};
  return {
    preEstimateUserOperationGas: (
      input: Parameters<PimlicoFeeEstimator["preEstimateUserOperationGas"]>[0],
    ) => baseEstimator.preEstimateUserOperationGas(input),
    async postEstimateUserOperationGas(
      input: Parameters<PimlicoFeeEstimator["postEstimateUserOperationGas"]>[0],
    ) {
      // Let the bundler and paymaster validate their network's limits. Account
      // deployment estimates can exceed a locally assumed verification ceiling.
      const bundlerGas = BigInt(input.userOperation.verificationGasLimit);
      diagnostics.bundlerVerificationGas = bundlerGas.toString();
      const proportionalMargin = (bundlerGas + 3n) / 4n;
      const estimatedVerificationGas =
        bundlerGas +
        (proportionalMargin > PASSKEY_VERIFICATION_GAS_MARGIN
          ? proportionalMargin
          : PASSKEY_VERIFICATION_GAS_MARGIN);
      let measuredVerificationGas = 0n;
      diagnostics.verifierProbe = "fallback";
      if (options.estimateVerifierGas) {
        try {
          const verifierGas = await options.estimateVerifierGas();
          if (verifierGas <= 0n) throw new Error("Invalid verifier gas estimate.");
          diagnostics.verifierGas = verifierGas.toString();
          diagnostics.verifierProbe = "measured";
          // Account for WebAuthn/Safe dispatch and signature-dependent P256 work.
          measuredVerificationGas = verifierGas + (verifierGas + 3n) / 4n + PASSKEY_DISPATCH_GAS;
        } catch {
          // Probe availability must not prevent the proven fallback from working.
        }
      }
      const minimumVerificationGas = [
        PASSKEY_MIN_VERIFICATION_GAS,
        estimatedVerificationGas,
        measuredVerificationGas,
      ].reduce((maximum, value) => (value > maximum ? value : maximum));
      diagnostics.requestedVerificationGas = minimumVerificationGas.toString();
      diagnostics.phase = "sponsorship";
      const sponsored = await baseEstimator.postEstimateUserOperationGas({
        ...input,
        userOperation: {
          ...input.userOperation,
          verificationGasLimit: minimumVerificationGas,
        },
      });
      const sponsoredVerificationGas =
        sponsored.verificationGasLimit == null ? 0n : BigInt(sponsored.verificationGasLimit);
      diagnostics.sponsoredVerificationGas = sponsoredVerificationGas.toString();
      if (sponsoredVerificationGas < minimumVerificationGas) {
        throw new Error("The paymaster returned insufficient verification gas for the passkey.");
      }
      return sponsored;
    },
  };
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

  async function ensureDeployedRelay(): Promise<void> {
    if (!refreshRequired) return;
    const refreshedRelay = await prepareDeployedRelay(
      await deps.initRelay(
        relayOptions(metadata, { safeAddress: getAddress(metadata.safeAddress) }, rpId, deps),
      ),
    );
    relay = refreshedRelay;
    refreshRequired = false;
  }

  return {
    address: getAddress(metadata.safeAddress),
    signTypedData: async (typedData) => {
      await ensureDeployedRelay();
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
      if (usingCounterfactualRelay) {
        usingCounterfactualRelay = false;
        refreshRequired = true;
      }
      return outcome;
    },
    prepareTransaction: async (calls) => {
      // Each prepared approval owns its relay and WebAuthn gate. Other wallet
      // actions cannot consume this operation's challenge or assertion.
      let requestAssertion: (() => Promise<Credential>) | undefined;
      let ready!: () => void;
      let failed!: (error: unknown) => void;
      const assertionReady = new Promise<void>((resolve, reject) => {
        ready = resolve;
        failed = reject;
      });
      let resolveAssertion!: (credential: Credential) => void;
      let rejectAssertion!: (error: unknown) => void;
      const signingDeps = {
        ...deps,
        getCredential(rawId: string, relyingParty: string, options?: CredentialRequestOptions) {
          requestAssertion = () => deps.getCredential(rawId, relyingParty, options);
          const assertion = new Promise<Credential>((resolve, reject) => {
            resolveAssertion = resolve;
            rejectAssertion = reject;
          });
          ready();
          return assertion;
        },
      };
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
      void signedOperation.then(ready, failed);
      await assertionReady;
      let used = false;
      return {
        cancel() {
          if (used) return;
          used = true;
          rejectAssertion?.(new Error("Transaction review closed."));
        },
        async send(options?: SmartTransactionOptions): Promise<Hex> {
          if (used) throw new Error("Please go back and review your transaction again.");
          used = true;
          if (requestAssertion) {
            // Invoke credentials.get in the Confirm click's call stack.
            try {
              requestAssertion().then(resolveAssertion, rejectAssertion);
            } catch (error) {
              rejectAssertion(error);
            }
          }
          const signed = normalizePasskeySignature(await signedOperation);
          const tx = await submitSignedOperation(
            preparedRelay,
            signed,
            deps,
            diagnostics,
            getAddress(metadata.safeAddress),
            options,
            () => {
              usingCounterfactualRelay = false;
              refreshRequired = true;
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
      await ensureDeployedRelay();
      const transactionHash = await sendCalls(
        relay,
        calls,
        deps,
        getAddress(metadata.verifierAddress),
        getAddress(metadata.safeAddress),
        options,
        () => {
          usingCounterfactualRelay = false;
          refreshRequired = true;
        },
      );
      return transactionHash;
    },
  };
}

async function sendCalls(
  relay: RelayLike,
  calls: SmartAccountCall[],
  deps: PasskeySafeDependencies,
  verifierAddress: Address,
  expectedSender: Address,
  options?: SmartTransactionOptions,
  onAccepted?: () => void,
): Promise<Hex> {
  const diagnostics: PasskeyGasDiagnostics = {};
  const operation = await withPasskeyStage(diagnostics, "estimation", () =>
    relay.createTransaction({
      transactions: calls.map((call) => ({
        to: getAddress(call.to),
        data: call.data,
        value: (call.value ?? 0n).toString(),
      })),
      options: {
        feeEstimator: createPasskeyFeeEstimator(undefined, {
          estimateVerifierGas: () => deps.estimateVerifierGas(verifierAddress),
          diagnostics,
        }),
      },
    }),
  );
  const signed = normalizePasskeySignature(
    await withPasskeyStage(diagnostics, "signing", () => relay.signSafeOperation(operation)),
  );
  return submitSignedOperation(
    relay,
    signed,
    deps,
    diagnostics,
    expectedSender,
    options,
    onAccepted,
  );
}

async function submitSignedOperation(
  relay: RelayLike,
  signed: unknown,
  deps: PasskeySafeDependencies,
  diagnostics: PasskeyGasDiagnostics,
  expectedSender: Address,
  options?: SmartTransactionOptions,
  onAccepted?: () => void,
): Promise<Hex> {
  // Read the final signed gas fields only; never copy identity, calldata,
  // paymaster data, or credential/signature material into diagnostics.
  const operation = signed as SafeOperationLike;
  if (!operation.getUserOperation) throw new Error("Safe did not provide a final UserOperation.");
  const userOperation = operation.getUserOperation();
  if (!userOperation) throw new Error("Safe did not provide a final UserOperation.");
  const identity = getSafeUserOperationIdentity(userOperation);
  if (identity.sender !== getAddress(expectedSender)) {
    throw new SafeUserOperationIntegrityError(identity, "The operation is not for this Safe.");
  }
  recordSubmittedGas(diagnostics, userOperation);
  options?.onSigned?.();
  try {
    await awaitSubmissionObserver(options?.onOperationPrepared, identity, deps.receiptTimeoutMs);
  } catch (error) {
    throw new SafeUserOperationNotSubmittedError(identity, error);
  }
  let hash: string;
  try {
    hash = await withPasskeyStage(diagnostics, "submission", () =>
      relay.executeTransaction({ executable: signed }),
    );
  } catch (error) {
    const rejection = bundlerRejection(error);
    const wrapped = rejection
      ? new SafeUserOperationRejectedError(identity, rejection.code, error)
      : new SafeUserOperationPendingError(identity, error);
    Object.assign(wrapped, {
      passkeyDiagnostics: (error as { passkeyDiagnostics?: unknown }).passkeyDiagnostics,
    });
    throw wrapped;
  }
  if (!sameHash(hash, identity.userOperationHash)) {
    throw new SafeUserOperationIntegrityError(
      identity,
      "The relay returned a different operation hash.",
    );
  }
  onAccepted?.();
  try {
    const outcome = await withPasskeyStage(diagnostics, "receipt", () =>
      pollCanonicalUserOperationReceipt(canonicalReceiptDependencies(relay, deps), identity, deps),
    );
    if (outcome.state === "pending") throw new SafeUserOperationPendingError(identity);
    if (outcome.state === "failed")
      throw new SafeUserOperationFailedError(identity, outcome.transactionHash);
    return outcome.transactionHash;
  } catch (error) {
    if (
      error instanceof SafeUserOperationFailedError ||
      error instanceof SafeUserOperationIntegrityError
    )
      throw error;
    if (error instanceof SafeUserOperationPendingError) throw error;
    throw new SafeUserOperationPendingError(identity, error);
  }
}

const submissionTimedOut = Symbol("submission-timed-out");

function recordSubmittedGas(
  diagnostics: PasskeyGasDiagnostics,
  operation: UserOperation<"0.7">,
): void {
  if (typeof operation.verificationGasLimit === "bigint")
    diagnostics.submittedVerificationGas = operation.verificationGasLimit.toString();
  if (typeof operation.callGasLimit === "bigint")
    diagnostics.submittedCallGas = operation.callGasLimit.toString();
  if (typeof operation.preVerificationGas === "bigint")
    diagnostics.submittedPreVerificationGas = operation.preVerificationGas.toString();
  if (typeof operation.maxFeePerGas === "bigint")
    diagnostics.submittedMaxFeePerGas = operation.maxFeePerGas.toString();
  if (typeof operation.maxPriorityFeePerGas === "bigint")
    diagnostics.submittedMaxPriorityFeePerGas = operation.maxPriorityFeePerGas.toString();
}

async function withinSubmissionDeadline<T>(
  callback: () => Promise<T>,
  timeoutMs: number,
): Promise<T | typeof submissionTimedOut> {
  if (timeoutMs <= 0) return submissionTimedOut;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(callback);
  // A non-cooperative relay or observer can finish after the caller's
  // deadline; retain its rejection so it never becomes an unhandled error.
  void work.catch(() => undefined);
  const timeout = new Promise<typeof submissionTimedOut>((resolve) => {
    timer = setTimeout(() => resolve(submissionTimedOut), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function awaitSubmissionObserver(
  observer: SmartTransactionOptions["onOperationPrepared"],
  identity: SafeUserOperationIdentity,
  timeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS,
): Promise<void> {
  if (!observer) return;
  const result = await withinSubmissionDeadline(
    () => Promise.resolve(observer(identity)),
    Math.max(0, timeoutMs),
  );
  if (result === submissionTimedOut) throw new Error("The transaction review timed out.");
}

async function pollCanonicalUserOperationReceipt(
  dependencies: CanonicalReceiptDependencies,
  identity: SafeUserOperationIdentity,
  options: Pick<PasskeySafeDependencies, "receiptTimeoutMs" | "receiptPollMs" | "sleep">,
): Promise<SafeUserOperationReceipt> {
  const timeoutMs = Math.max(0, options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS);
  const pollMs = Math.max(0, options.receiptPollMs ?? DEFAULT_RECEIPT_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingForLookup = deadline - Date.now();
    if (remainingForLookup <= 0) return Object.freeze({ state: "pending", operation: identity });
    const outcome = await lookupCanonicalUserOperationReceipt(dependencies, identity, {
      timeoutMs: remainingForLookup,
    });
    if (outcome.state !== "pending") return outcome;
    const remainingForSleep = deadline - Date.now();
    if (remainingForSleep <= 0) return outcome;
    const sleep = await withinSubmissionDeadline(
      () => options.sleep(Math.min(pollMs, remainingForSleep)),
      remainingForSleep,
    );
    if (sleep === submissionTimedOut)
      return Object.freeze({ state: "pending", operation: identity });
  }
}

function canonicalReceiptDependencies(
  relay: Pick<RelayLike, "getUserOperationReceipt">,
  deps: Pick<PasskeySafeDependencies, "getTransactionReceipt" | "getBlock">,
): CanonicalReceiptDependencies {
  return {
    getUserOperationReceipt: (operationHash) => relay.getUserOperationReceipt(operationHash),
    getTransactionReceipt: (input, options) => deps.getTransactionReceipt(input, options),
    getBlock: (input, options) => deps.getBlock(input, options),
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
