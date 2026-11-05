import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { URL } from "node:url";
import { TextEncoder } from "node:util";

import {
  assertionAbi,
  mergePinnedSponsorEstimations,
  parseClientDataFields,
  parseDerSignature,
} from "./safe-sdk-equivalence.mjs";
import { createPrecredentialPermit } from "./safe-precredential-permit.mjs";

const requireWeb = createRequire(new URL("../../../../web/package.json", import.meta.url));
const relay = requireWeb("@safe-global/relay-kit");
const protocol = requireWeb("@safe-global/protocol-kit");
const viem = requireWeb("viem");
const accountAbstraction = requireWeb("viem/account-abstraction");
const requireTypes = createRequire(
  new URL(
    "../../../../web/node_modules/.pnpm/@safe-global+types-kit@4.0.1_typescript@5.9.3_zod@4.6.5/node_modules/@safe-global/types-kit/package.json",
    import.meta.url,
  ),
);
const { SigningMethod } = requireTypes("@safe-global/types-kit");

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const MODULE = "0x4444444444444444444444444444444444444444";
const SHARED_SIGNER = "0x5555555555555555555555555555555555555555";
const BROWSER_PLATFORM = {
  createAbortController: () => ({
    signal: { aborted: false },
    abort() {
      this.signal.aborted = true;
    },
  }),
  setTimer: () => ({ timer: "synthetic" }),
  clearTimer: () => {},
};
const encodeUtf8 = (value) => new TextEncoder().encode(value);

function syntheticUserOperation() {
  return {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: (1n << 255n) + 9n,
    factory: "0x2222222222222222222222222222222222222222",
    factoryData: "0x1234",
    callData: "0xabcdef",
    callGasLimit: 100n,
    verificationGasLimit: 200n,
    preVerificationGas: 300n,
    maxFeePerGas: 400n,
    maxPriorityFeePerGas: 500n,
    paymaster: "0x3333333333333333333333333333333333333333",
    paymasterData: "0x5678",
    paymasterVerificationGasLimit: 600n,
    paymasterPostOpGasLimit: 700n,
    signature: "0x",
  };
}

function safeOptions() {
  return {
    chainId: 11155111,
    entryPoint: ENTRY_POINT,
    moduleAddress: MODULE,
    validAfter: 0,
    validUntil: 0,
  };
}

test("bounded assertion helpers match Relay Kit's public ABI oracle", () => {
  assert.equal(relay.getRelayKitVersion(), "6.1.1");
  const challenge = "A".repeat(43);
  const client = `{"type":"webauthn.get","challenge":"${challenge}","origin":"https://example.test"}`;
  const fields = parseClientDataFields(client);
  const der = "0x3006020101020102";
  const { r, s } = parseDerSignature(der);
  const authenticatorData = new Uint8Array([1, 2, 3, 4]);
  const local = assertionAbi({ authenticatorData, clientDataFields: fields, r, s, encodeUtf8 });
  assert.equal(
    local,
    relay.getSignatureBytes({ authenticatorData, clientDataFields: fields, r, s }),
  );
  assert.throws(() => parseClientDataFields(client.replace(challenge, "short")), /client data/);
  assert.throws(() => parseDerSignature("0x3007020101020102"), /DER/);
});

test("strict sponsor merge and SafeOp digest match the pinned Relay Kit fixture", () => {
  const original = syntheticUserOperation();
  const estimations = {
    maxFeePerGas: 900n,
    maxPriorityFeePerGas: 901n,
    verificationGasLimit: 902n,
    preVerificationGas: 903n,
    callGasLimit: 904n,
    paymasterPostOpGasLimit: 905n,
    paymasterVerificationGasLimit: 906n,
    paymaster: "0x6666666666666666666666666666666666666666",
    paymasterData: "0xbeef",
  };
  const expected = mergePinnedSponsorEstimations(original, estimations);
  const operation = new relay.SafeOperationV07({ ...original }, safeOptions());
  operation.addEstimations(estimations);
  assert.deepEqual(operation.getUserOperation(), {
    ...expected,
    signature: "0x000000000000000000000000",
  });
  const safeOperation = operation.getSafeOperation();
  assert.equal(safeOperation.validAfter, 0);
  assert.equal(safeOperation.validUntil, 0);
  assert.equal(
    operation.getHash(),
    viem.hashTypedData({
      domain: { chainId: 11155111, verifyingContract: MODULE },
      types: operation.getEIP712Type(),
      primaryType: "SafeOp",
      message: safeOperation,
    }),
  );
  const wire = relay.userOperationToHexValues(operation.getUserOperation(), ENTRY_POINT);
  assert.equal(wire.nonce, `0x${original.nonce.toString(16)}`);
  assert.equal(wire.paymaster, estimations.paymaster);
  assert.equal(wire.paymasterData, estimations.paymasterData);
  const userOperationHash = accountAbstraction.getUserOperationHash({
    chainId: 11155111,
    entryPointAddress: ENTRY_POINT,
    entryPointVersion: "0.7",
    userOperation: operation.getUserOperation(),
  });
  assert.notEqual(operation.getHash(), userOperationHash);
  assert.throws(
    () => mergePinnedSponsorEstimations(original, { sender: original.sender }),
    /unknown sponsor field/,
  );
  assert.deepEqual(mergePinnedSponsorEstimations(original, { maxFeePerGas: 0n }), original);
});

test("SDK wire nullability and bounded parser mutations stay strict", () => {
  const absentPaymaster = syntheticUserOperation();
  absentPaymaster.paymaster = "0x";
  absentPaymaster.paymasterData = "0x";
  absentPaymaster.paymasterVerificationGasLimit = 0n;
  absentPaymaster.paymasterPostOpGasLimit = 0n;
  const operation = new relay.SafeOperationV07(absentPaymaster, safeOptions());
  const wire = relay.userOperationToHexValues(operation.getUserOperation(), ENTRY_POINT);
  assert.equal(wire.paymaster, null);
  assert.equal(wire.paymasterData, null);
  assert.equal(wire.paymasterVerificationGasLimit, null);
  assert.equal(wire.paymasterPostOpGasLimit, null);
  assert.throws(
    () =>
      parseClientDataFields(
        '{"type":"webauthn.get","challenge":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
      ),
    /client data/,
  );
  assert.throws(
    () => parseDerSignature(`0x30${"48"}${"02"}${"21"}${"01".repeat(33)}020101`),
    /DER/,
  );
});

test("Protocol Kit adjusts and packs each accepted ETH_SIGN V with zero validity", async () => {
  const assertion = assertionAbi({
    authenticatorData: new Uint8Array(37).fill(1),
    clientDataFields: ',"origin":"https://example.test"',
    r: 1n,
    s: 2n,
    encodeUtf8,
  });
  const safeHash = new relay.SafeOperationV07(syntheticUserOperation(), safeOptions()).getHash();
  for (const v of [0, 1, 27, 28]) {
    const signed = `${assertion.slice(0, -2)}${v.toString(16).padStart(2, "0")}`;
    const adjusted = await protocol.adjustVInSignature(
      SigningMethod.ETH_SIGN,
      signed,
      safeHash,
      SHARED_SIGNER,
    );
    assert.match(adjusted, /(?:1f|20)$/);
    const packed = protocol.buildSignatureBytes([
      new protocol.EthSafeSignature(SHARED_SIGNER, adjusted, true),
    ]);
    const wire = viem.encodePacked(["uint48", "uint48", "bytes"], [0n, 0n, packed]);
    assert.equal(wire.slice(0, 26), "0x000000000000000000000000");
    assert.ok(wire.length > 2 + 24);
  }
  const invalid = `${assertion.slice(0, -2)}02`;
  await assert.rejects(
    () => protocol.adjustVInSignature(SigningMethod.ETH_SIGN, invalid, safeHash, SHARED_SIGNER),
    /Invalid signature/,
  );
});

test("precredential permit synchronously gates an exact one-use WebAuthn request", () => {
  const challenge = new Uint8Array(32).fill(7);
  const rawId = new Uint8Array([1, 2, 3]);
  let nativeCalls = 0;
  const permit = createPrecredentialPermit({
    reservationId: "r1",
    challenge,
    rawId,
    rpId: "example.test",
    deadlineAt: 2000,
    now: () => 1000,
    platform: BROWSER_PLATFORM,
  });
  const request = {
    publicKey: {
      challenge,
      allowCredentials: [{ type: "public-key", id: rawId }],
      rpId: "example.test",
      userVerification: "required",
    },
  };
  const result = permit.start(request, (input) => {
    nativeCalls += 1;
    return input;
  });
  assert.equal(nativeCalls, 1);
  assert.equal(result.publicKey.signal.aborted, false);
  assert.throws(() => permit.start(request, () => request), /used/);
  permit.stop();
});

test("precredential permit rejects altered scope and aborts after synchronous native start", async () => {
  const challenge = new Uint8Array(32).fill(3);
  const rawId = new Uint8Array([4, 5, 6]);
  const makeRequest = () => ({
    publicKey: {
      challenge,
      allowCredentials: [{ type: "public-key", id: rawId }],
      rpId: "example.test",
      userVerification: "required",
    },
  });
  const expired = createPrecredentialPermit({
    reservationId: "expired",
    challenge,
    rawId,
    rpId: "example.test",
    deadlineAt: 4,
    now: () => 4,
    platform: BROWSER_PLATFORM,
  });
  assert.throws(() => expired.start(makeRequest(), () => undefined), /unavailable/);
  const stopped = createPrecredentialPermit({
    reservationId: "stopped",
    challenge,
    rawId,
    rpId: "example.test",
    deadlineAt: 100,
    now: () => 1,
    stopped: () => true,
    platform: BROWSER_PLATFORM,
  });
  assert.throws(() => stopped.start(makeRequest(), () => undefined), /unavailable/);
  const permit = createPrecredentialPermit({
    reservationId: "scope",
    challenge,
    rawId,
    rpId: "example.test",
    deadlineAt: 1000,
    now: () => 1,
    platform: BROWSER_PLATFORM,
  });
  const altered = makeRequest();
  altered.publicKey.rpId = "other.test";
  assert.throws(() => permit.start(altered, () => undefined), /does not match/);
  let signal;
  const result = permit.start(makeRequest(), (request) => {
    signal = request.publicKey.signal;
    return Promise.resolve("native-started");
  });
  assert.equal(await result, "native-started");
  assert.equal(signal.aborted, false);
  permit.stop();
  assert.equal(signal.aborted, true);
  assert.equal(
    await permit.capture({ id: "synthetic" }, async (assertion) => assertion.id),
    "synthetic",
  );
});
