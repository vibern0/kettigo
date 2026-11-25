import { Interface, getAddress, getBytes, hexlify, isAddress } from "ethers";

const EXECUTE = new Interface([
  "function executeUserOp(address to,uint256 value,bytes data,uint8 operation)",
]);
const MULTISEND = new Interface(["function multiSend(bytes transactions)"]);
const WRAPPER = new Interface([
  "function wrap(address to,uint256 amount)",
  "function confidentialTransferAndCall(address to,bytes32 encryptedAmount,bytes inputProof,bytes data)",
  "function multicall(bytes[] data)",
]);
const ACL = new Interface([
  "function delegateForUserDecryption(address delegate,address contractAddress,uint64 expirationDate)",
]);
const ERC20 = new Interface(["function approve(address spender,uint256 amount)"]);
const FORBIDDEN = new Set(
  [
    "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b",
    "0x9c23E5f7143612dc1232FC643A57300291e0d719",
    "0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27",
  ].map(getAddress),
);

function fail(message) {
  throw new Error(`safe call policy: ${message}`);
}
function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) fail(`invalid ${label}`);
  return getAddress(value);
}
function validBytes(value) {
  if (!value.startsWith("0x") || value.length % 2) return false;
  for (let i = 2; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}
function bytes(value, label) {
  if (typeof value !== "string" || value.length > 524_288 || !validBytes(value))
    fail(`invalid ${label}`);
  return value.toLowerCase();
}
function decode(contract, name, data, label) {
  try {
    const parsed = contract.parseTransaction({ data });
    if (!parsed || parsed.name !== name) fail(`unexpected ${label}`);
    return parsed.args;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("safe call policy:")) throw error;
    fail(`invalid ${label}`);
  }
}
function uint(input, offset, width) {
  if (offset + width > input.length) fail("truncated MultiSend call");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let result = 0n;
  for (let i = offset; i < offset + width; i += 1)
    result = (result << 8n) + BigInt(view.getUint8(i));
  return result;
}
function decodeMultiSend(value) {
  const packed = getBytes(value);
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const calls = [];
  let offset = 0;
  while (offset < packed.length) {
    if (packed.length - offset < 85) fail("truncated MultiSend call");
    const length = uint(packed, offset + 53, 32);
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) fail("oversized MultiSend input");
    const end = offset + 85 + Number(length);
    if (end > packed.length) fail("truncated MultiSend input");
    calls.push({
      operation: view.getUint8(offset),
      to: getAddress(hexlify(packed.slice(offset + 1, offset + 21))),
      value: uint(packed, offset + 21, 32),
      data: hexlify(packed.slice(offset + 85, end)).toLowerCase(),
    });
    offset = end;
  }
  if (!calls.length) fail("empty MultiSend");
  return calls;
}
function fixedCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) fail("expected calls required");
  return calls.map((call) => ({
    to: address(call.to, "call target"),
    value: BigInt(call.value ?? 0),
    data: bytes(call.data, "call data"),
  }));
}
function sameCall(left, right) {
  return (
    left.operation === 0 &&
    left.to === right.to &&
    left.value === right.value &&
    left.data === right.data
  );
}
function noForbidden(calls) {
  for (const call of calls) if (FORBIDDEN.has(call.to)) fail("forbidden nested recipient");
}
function denyForbidden(value, label) {
  if (FORBIDDEN.has(value)) fail(`forbidden ${label}`);
}
function assertDeposit(call, expected) {
  if (!expected || call.to !== expected.token) return;
  const [parts] = decode(WRAPPER, "multicall", call.data, "wrapper multicall");
  if (parts.length !== 2) fail("unexpected wrapper multicall");
  const [recipient, amount] = decode(WRAPPER, "wrap", parts[0], "wrapper wrap");
  const [pool, handle, proof, callback] = decode(
    WRAPPER,
    "confidentialTransferAndCall",
    parts[1],
    "wrapper transfer",
  );
  denyForbidden(getAddress(recipient), "wrapper recipient");
  denyForbidden(getAddress(pool), "wrapper callback recipient");
  if (
    getAddress(recipient) !== expected.user ||
    BigInt(amount) !== expected.amount ||
    getAddress(pool) !== expected.pool ||
    bytes(handle, "encrypted handle") !== expected.handle ||
    bytes(proof, "input proof") !== expected.proof ||
    bytes(callback, "callback data") !== "0x"
  )
    fail("unexpected wrapper deposit roles");
}
function assertDelegation(call, expected) {
  if (!expected || call.to !== expected.acl) return;
  const [delegate, contractAddress, expiration] = decode(
    ACL,
    "delegateForUserDecryption",
    call.data,
    "ACL delegation",
  );
  denyForbidden(getAddress(delegate), "ACL delegate");
  denyForbidden(getAddress(contractAddress), "ACL delegated contract");
  if (
    getAddress(delegate) !== expected.delegate ||
    getAddress(contractAddress) !== expected.contract ||
    BigInt(expiration) !== expected.expiration
  )
    fail("unexpected ACL delegation roles");
}
function assertApproval(call, expected) {
  if (!expected || call.to !== expected.token) return;
  const [spender, amount] = decode(ERC20, "approve", call.data, "ERC-20 approval");
  denyForbidden(getAddress(spender), "approval spender");
  if (getAddress(spender) !== expected.spender || BigInt(amount) !== expected.amount)
    fail("unexpected approval roles");
}
function bindRoles(calls, roles) {
  for (const call of calls) {
    assertDeposit(call, roles.deposit);
    for (const delegation of roles.delegations) assertDelegation(call, delegation);
    for (const approval of roles.approvals) assertApproval(call, approval);
  }
}

/** Fixed Relay Kit 6.1.1 workload validator for exact direct/batch calls and actual wrapper/ACL roles. */
export function createFixedSafeCallPolicy({
  module,
  multiSend,
  deployedCalls,
  counterfactual,
  roles = {},
} = {}) {
  const fixed = {
    module: address(module, "module"),
    multiSend: address(multiSend, "MultiSend"),
    deployedCalls: fixedCalls(deployedCalls),
    counterfactual: counterfactual
      ? {
          factory: address(counterfactual.factory, "factory"),
          factoryData: bytes(counterfactual.factoryData, "factory data"),
          calls: fixedCalls(counterfactual.calls),
        }
      : null,
    roles: {
      deposit: roles.deposit
        ? {
            token: address(roles.deposit.token, "token"),
            user: address(roles.deposit.user, "user"),
            pool: address(roles.deposit.pool, "pool"),
            amount: BigInt(roles.deposit.amount),
            handle: bytes(roles.deposit.handle, "handle"),
            proof: bytes(roles.deposit.proof, "proof"),
          }
        : null,
      delegations: Array.isArray(roles.delegations)
        ? roles.delegations.map((entry) => ({
            acl: address(entry.acl, "ACL"),
            delegate: address(entry.delegate, "delegate"),
            contract: address(entry.contract, "delegated contract"),
            expiration: BigInt(entry.expiration),
          }))
        : [],
      approvals: Array.isArray(roles.approvals)
        ? roles.approvals.map((entry) => ({
            token: address(entry.token, "approval token"),
            spender: address(entry.spender, "approval spender"),
            amount: BigInt(entry.amount),
          }))
        : [],
    },
  };
  noForbidden(fixed.deployedCalls);
  denyForbidden(fixed.module, "module");
  denyForbidden(fixed.multiSend, "MultiSend");
  if (fixed.counterfactual) noForbidden(fixed.counterfactual.calls);
  if (fixed.counterfactual) denyForbidden(fixed.counterfactual.factory, "factory");
  function selected(operation) {
    if (operation.factory === "0x" && operation.factoryData === "0x") return fixed.deployedCalls;
    if (
      !fixed.counterfactual ||
      operation.factory !== fixed.counterfactual.factory ||
      operation.factoryData !== fixed.counterfactual.factoryData
    )
      fail("factory setup differs from pinned expected setup");
    return fixed.counterfactual.calls;
  }
  return Object.freeze({
    assert(operation) {
      const expected = selected(operation);
      const [target, value, data, mode] = decode(
        EXECUTE,
        "executeUserOp",
        operation.callData,
        "Safe executeUserOp",
      );
      const outer = {
        operation: 0,
        to: getAddress(target),
        value: BigInt(value),
        data: bytes(data, "Safe call data"),
      };
      let calls;
      if (outer.to === fixed.multiSend && outer.value === 0n && Number(mode) === 1) {
        const [packed] = decode(MULTISEND, "multiSend", outer.data, "MultiSend");
        calls = decodeMultiSend(packed);
      } else if (Number(mode) === 0) calls = [outer];
      else fail("unexpected Safe execute target");
      noForbidden(calls);
      bindRoles(calls, fixed.roles);
      const iterator = expected.values();
      if (
        calls.length !== expected.length ||
        !calls.every((call) => sameCall(call, iterator.next().value))
      )
        fail("nested calls differ from the pinned intended call list");
      return true;
    },
  });
}
