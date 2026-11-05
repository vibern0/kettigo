import { Interface, getAddress, getBytes, hexlify, isAddress } from "ethers";

const EXECUTE = new Interface(["function executeUserOp(address to,uint256 value,bytes data,uint8 operation)"]);
const MULTISEND = new Interface(["function multiSend(bytes transactions)"]);
const WRAPPER = new Interface(["function transferAndCall(address recipient,uint256 amount,bytes callback)"]);
const GRANT = new Interface(["function grant(address recipient)"]);
const FORBIDDEN = new Set([
  "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b",
  "0x9c23E5f7143612dc1232FC643A57300291e0d719",
  "0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27",
].map(getAddress));

function fail(message) {
  throw new Error(`safe call policy: ${message}`);
}
function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) fail(`invalid ${label}`);
  return getAddress(value);
}
function bytes(value, label) {
  if (typeof value !== "string" || value.length > 524_288 || !validBytes(value)) fail(`invalid ${label}`);
  return value.toLowerCase();
}
function validBytes(value) {
  if (!value.startsWith("0x") || value.length % 2) return false;
  for (let index = 2; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}
function numberAt(bytesValue, offset, width) {
  if (offset + width > bytesValue.length) fail("truncated MultiSend call");
  const view = new DataView(bytesValue.buffer, bytesValue.byteOffset, bytesValue.byteLength);
  let result = 0n;
  for (let index = offset; index < offset + width; index += 1) result = (result << 8n) + BigInt(view.getUint8(index));
  return result;
}
function decodeMultiSend(value) {
  const packed = getBytes(value);
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const calls = [];
  let offset = 0;
  while (offset < packed.length) {
    if (packed.length - offset < 85) fail("truncated MultiSend call");
    const operation = view.getUint8(offset);
    const to = getAddress(hexlify(packed.slice(offset + 1, offset + 21)));
    const amount = numberAt(packed, offset + 21, 32);
    const length = numberAt(packed, offset + 53, 32);
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) fail("oversized MultiSend input");
    const end = offset + 85 + Number(length);
    if (end > packed.length) fail("truncated MultiSend input");
    calls.push({ operation, to, value: amount, data: hexlify(packed.slice(offset + 85, end)).toLowerCase() });
    offset = end;
  }
  if (!calls.length) fail("empty MultiSend");
  return calls;
}
function exactCall(call, expected) {
  return call.operation === 0 && call.to === expected.to && call.value === expected.value && call.data === expected.data;
}
function decode(functionInterface, name, data, label) {
  try {
    const parsed = functionInterface.parseTransaction({ data });
    if (!parsed || parsed.name !== name) fail(`unexpected ${label}`);
    return parsed.args;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("safe call policy:")) throw error;
    fail(`invalid ${label}`);
  }
}
function assertWrapper(call, expected) {
  if (call.to !== expected.target) return;
  const [recipient, , callback] = decode(WRAPPER, "transferAndCall", call.data, "wrapper transfer");
  if (getAddress(recipient) !== expected.callbackRecipient || bytes(callback, "wrapper callback") !== expected.callbackData)
    fail("unexpected wrapper callback recipient or data");
}
function assertGrant(call, expected) {
  if (call.to !== expected.target) return;
  const [recipient] = decode(GRANT, "grant", call.data, "grant");
  if (getAddress(recipient) !== expected.recipient) fail("unexpected grant recipient");
}

/** Fixed workload validator for the installed Safe4337 executeUserOp + MultiSend ABI shape. */
export function createFixedSafeCallPolicy({ module, multiSend, factory, factoryData, calls, wrapper, grants } = {}) {
  const fixed = {
    module: address(module, "module"),
    multiSend: address(multiSend, "MultiSend"),
    factory: address(factory, "factory"),
    factoryData: bytes(factoryData, "factory data"),
    calls: Array.isArray(calls) && calls.length
      ? calls.map((call) => ({ to: address(call.to, "call target"), value: BigInt(call.value), data: bytes(call.data, "call data") }))
      : fail("expected calls required"),
    wrapper: {
      target: address(wrapper?.target, "wrapper target"),
      callbackRecipient: address(wrapper?.callbackRecipient, "wrapper callback recipient"),
      callbackData: bytes(wrapper?.callbackData, "wrapper callback data"),
    },
    grants: Array.isArray(grants)
      ? grants.map((grant) => ({ target: address(grant.target, "grant target"), recipient: address(grant.recipient, "grant recipient") }))
      : fail("approved grants required"),
  };
  if (FORBIDDEN.has(fixed.factory) || FORBIDDEN.has(fixed.multiSend)) fail("forbidden fixed target");
  for (const call of fixed.calls) if (FORBIDDEN.has(call.to)) fail("forbidden expected target");

  return Object.freeze({
    assert({ factory: candidateFactory, factoryData: candidateFactoryData, callData } = {}) {
      if (address(candidateFactory, "factory") !== fixed.factory || bytes(candidateFactoryData, "factory data") !== fixed.factoryData)
        fail("factory setup differs from pinned expected setup");
      const [target, value, data, operation] = decode(EXECUTE, "executeUserOp", callData, "Safe executeUserOp");
      if (getAddress(target) !== fixed.multiSend || BigInt(value) !== 0n || Number(operation) !== 1) fail("unexpected Safe execute target");
      const [packed] = decode(MULTISEND, "multiSend", data, "MultiSend");
      const calls = decodeMultiSend(packed);
      for (const call of calls) if (FORBIDDEN.has(call.to)) fail("forbidden nested recipient");
      for (const call of calls) {
        assertWrapper(call, fixed.wrapper);
        for (const grant of fixed.grants) assertGrant(call, grant);
      }
      const expectedCalls = fixed.calls.values();
      if (calls.length !== fixed.calls.length || !calls.every((call) => exactCall(call, expectedCalls.next().value)))
        fail("nested calls differ from the pinned intended call list");
      return true;
    },
  });
}
