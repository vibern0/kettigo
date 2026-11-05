import { Transaction, getAddress, isAddress, keccak256 } from "ethers";

const CHAIN_ID = 11155111;
const ZERO = "0x";
const fail = (message) => {
  throw new Error(`candidate EOA sender: ${message}`);
};
const asBigInt = (value, label) => {
  try {
    const result = BigInt(value);
    if (result < 0n) throw new Error();
    return result;
  } catch {
    fail(`invalid ${label}`);
  }
};
const sameAddress = (left, right) => getAddress(left) === getAddress(right);
const errorText = (error) => String(error?.message ?? error).slice(0, 2048);

function normalizedTarget(to) {
  if (to === null) return null;
  if (!isAddress(to)) fail("invalid target");
  return getAddress(to);
}
function normalizedRequest(request) {
  if (!request || typeof request.intentId !== "string" || !request.intentId) fail("invalid intent");
  if (!Number.isSafeInteger(request.nonce) || request.nonce < 0) fail("invalid nonce");
  if (typeof request.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(request.data))
    fail("invalid data");
  const to = normalizedTarget(request.to);
  if (to === null && request.data === ZERO) fail("empty creation input");
  const value = asBigInt(request.value, "value");
  const gasLimit = asBigInt(request.gasLimit, "gas limit");
  const gasPrice = asBigInt(request.gasPrice, "gas price");
  if (!gasLimit || !gasPrice) fail("gas limit and gas price must be positive");
  return { ...request, to, value, gasLimit, gasPrice };
}
function unsignedTransaction(request) {
  return {
    type: 0,
    chainId: CHAIN_ID,
    nonce: request.nonce,
    to: request.to,
    data: request.data,
    value: request.value,
    gasLimit: request.gasLimit,
    gasPrice: request.gasPrice,
  };
}
function transactionDigest(request) {
  return Transaction.from(unsignedTransaction(request)).unsignedHash;
}
function sameBytes(value, expected) {
  return String(value).toLowerCase() === String(expected).toLowerCase();
}
function assertDecoded(raw, expected, hash, sender, reservedDigest = transactionDigest(expected)) {
  const decoded = Transaction.from(raw);
  if (
    decoded.type !== 0 ||
    Number(decoded.chainId) !== CHAIN_ID ||
    decoded.nonce !== expected.nonce ||
    decoded.to !== expected.to ||
    !sameBytes(decoded.data, expected.data) ||
    decoded.value !== expected.value ||
    decoded.gasLimit !== expected.gasLimit ||
    decoded.gasPrice !== expected.gasPrice ||
    decoded.hash !== hash ||
    decoded.unsignedHash !== reservedDigest ||
    !decoded.from ||
    !sameAddress(decoded.from, sender)
  )
    fail("signed transaction does not match reserved request");
}

/** A deliberately small EOA-only sender for the durable candidate runner. */
export class DurableEoaSender {
  constructor({ journal, provider, signer, actor, targets = [], creationInputDigests = [] } = {}) {
    if (!journal || !provider || !signer || !actor || !isAddress(actor))
      fail("missing sender dependency");
    this.journal = journal;
    this.provider = provider;
    this.signer = signer;
    this.actor = getAddress(actor);
    this.targets = new Set(targets.map((target) => getAddress(target)));
    this.creationInputDigests = new Set(creationInputDigests.map((digest) => digest.toLowerCase()));
    this.inflight = new Map();
    this.actorTail = Promise.resolve();
  }

  async submit(request) {
    const normalized = normalizedRequest(request);
    if (!sameAddress(normalized.sender, this.actor)) fail("unknown actor");
    this.#assertTarget(normalized);
    const existing = this.inflight.get(normalized.intentId);
    if (existing) return existing;
    const operation = this.actorTail.then(() => this.#submit(normalized));
    this.actorTail = operation.catch(() => {});
    this.inflight.set(normalized.intentId, operation);
    try {
      return await operation;
    } finally {
      this.inflight.delete(normalized.intentId);
    }
  }

  async reconcile(intentId) {
    const intent = this.journal.intent(intentId);
    if (!intent?.signed) fail("unknown signed intent");
    const raw = intent.signed.raw;
    const saved = Transaction.from(raw);
    assertDecoded(
      raw,
      {
        nonce: intent.nonce,
        to: intent.to,
        data: intent.input,
        value: saved.value,
        gasLimit: saved.gasLimit,
        gasPrice: saved.gasPrice,
      },
      intent.signed.hash,
      intent.sender,
      intent.unsignedDigest,
    );
    const known = await this.provider.getTransaction(intent.signed.hash);
    if (known) this.#assertKnownTransaction(known, intent);
    let receipt;
    try {
      receipt = await this.provider.getTransactionReceipt(intent.signed.hash);
    } catch (error) {
      await this.journal.recordObservation(intentId, { stage: "receipt", error: errorText(error) });
      return { state: "unresolved" };
    }
    if (!receipt) return { state: "unresolved" };
    try {
      await this.#recordCanonicalReceipt(intent, receipt);
      return { state: receipt.status === 1 ? "success" : "reverted" };
    } catch (error) {
      await this.journal.recordObservation(intentId, {
        stage: "receipt-validation",
        error: errorText(error),
        unrecoverable: true,
      });
      throw error;
    }
  }

  async #submit(request) {
    const reserved = await this.journal.reserve({
      intentId: request.intentId,
      sender: this.actor,
      nonce: request.nonce,
      unsignedDigest: transactionDigest(request),
      to: request.to,
      input: request.data,
      offeredAt: request.offeredAt,
      maxFeeWei: request.gasLimit * request.gasPrice,
      maxGasPriceWei: request.gasPrice,
      fundingWei: request.fundingWei ?? 0n,
      usdcCommitment: request.usdcCommitment ?? "0",
    });
    const intent = reserved.intent;
    if (!intent.signed) {
      const network = await this.provider.getNetwork();
      if (Number(network.chainId) !== CHAIN_ID) fail("provider is not Sepolia");
      await this.#assertNonce(request.nonce);
      await this.journal.assertSigningPermit();
      const signerAddress = getAddress(await this.signer.getAddress());
      if (signerAddress !== this.actor) fail("signer is not actor");
      const raw = await this.signer.signTransaction(unsignedTransaction(request));
      const decoded = Transaction.from(raw);
      assertDecoded(raw, request, decoded.hash, this.actor);
      await this.journal.saveSigned(request.intentId, raw, decoded.hash);
    }
    return this.#broadcastOrReconcile(request.intentId);
  }

  async #broadcastOrReconcile(intentId) {
    const outcome = await this.reconcile(intentId);
    if (outcome.state !== "unresolved") return outcome;
    const intent = this.journal.intent(intentId);
    await this.#assertResumeNonce(intent);
    await this.journal.assertSigningPermit();
    await this.journal.recordAttempt(intentId);
    try {
      const hash = await this.provider.sendRawTransaction(intent.signed.raw);
      if (!sameBytes(hash, intent.signed.hash)) fail("provider returned mismatched hash");
    } catch (error) {
      await this.journal.recordObservation(intentId, {
        stage: "broadcast",
        error: errorText(error),
      });
      return { state: "unresolved" };
    }
    return this.reconcile(intentId);
  }

  #assertTarget(request) {
    if (request.to !== null && !this.targets.has(request.to)) fail("write target is not allowed");
    if (request.to === null) {
      const digest = keccak256(request.data).toLowerCase();
      if (!this.creationInputDigests.has(digest)) fail("creation input is not allowed");
    }
  }
  async #assertNonce(nonce) {
    const [latest, pending] = await Promise.all([
      this.provider.getTransactionCount(this.actor, "latest"),
      this.provider.getTransactionCount(this.actor, "pending"),
    ]);
    if (latest !== nonce || pending !== nonce) fail("unexplained nonce consumption");
  }
  async #assertResumeNonce(intent) {
    const [latest, pending] = await Promise.all([
      this.provider.getTransactionCount(this.actor, "latest"),
      this.provider.getTransactionCount(this.actor, "pending"),
    ]);
    if (latest > intent.nonce || pending > intent.nonce)
      fail("unexplained nonce consumption during resume");
  }
  #assertKnownTransaction(transaction, intent) {
    if (
      transaction.hash !== intent.signed.hash ||
      Number(transaction.chainId) !== CHAIN_ID ||
      !sameAddress(transaction.from, intent.sender) ||
      transaction.to !== intent.to ||
      !sameBytes(transaction.data, intent.input) ||
      transaction.nonce !== intent.nonce
    )
      fail("saved hash transaction mismatch");
  }
  async #recordCanonicalReceipt(intent, receipt) {
    const transaction = await this.provider.getTransaction(intent.signed.hash);
    const block = await this.provider.getBlock(receipt.blockNumber);
    if (!transaction || !block || receipt.blockHash !== block.hash) fail("non-canonical receipt");
    this.#assertKnownTransaction(transaction, intent);
    if (receipt.hash !== intent.signed.hash) fail("receipt transaction mismatch");
    await this.journal.recordTerminal(intent.intentId, {
      hash: intent.signed.hash,
      status: receipt.status,
      feeWei: BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice),
      from: intent.sender,
      to: intent.to,
      input: intent.input,
      nonce: intent.nonce,
      chainId: CHAIN_ID,
    });
  }
}
