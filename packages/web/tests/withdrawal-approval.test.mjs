import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const page = await readFile(new URL("../src/app/savings/page.tsx", import.meta.url), "utf8");
function handler(name, end) {
  const start = page.indexOf(`  async function ${name}(`);
  return stripTypeScriptTypes(page.slice(start, page.indexOf(`  ${end}`, start)));
}

function fixture(overrides = {}) {
  const state = { step: "confirm", sent: 0, updates: [], amount: "10", signed: false };
  const session = { address: "0x1234567890123456789012345678901234567890" };
  const prepared = { session, value: 10n, preparedAt: Date.now(), transaction: {
    cancel() { state.cancelled = true; },
    async send(options) { state.sent++; options.onSigned(); return "0xabc"; },
  } };
  const context = {
    activeSession: () => session,
    preparedWithdrawal: { current: prepared },
    setWithdrawSheetStep: (step) => { state.step = step; },
    setWithdrawAmount: (amount) => { state.amount = amount; },
    poolReady: true,
    addresses: { pool: session.address },
    publicClient: { waitForTransactionReceipt: async () => ({ status: "success" }) },
    rememberWithdrawalRequest: () => {},
    refreshBalances: async () => {},
    refreshConfidentialBalances: async () => {},
    refreshPendingWithdrawals: async () => {},
    // These paths must never run after Confirm.
    asAddress: () => { throw new Error("Network preparation is still running after Confirm"); },
    ...overrides,
  };
  const withdraw = vm.runInNewContext(`(${handler("withdrawConfidential", "function rememberWithdrawalRequest(").trim()})`, context);
  return { state, session, prepared, context, withdraw: () => withdraw(10n,
    (patch) => state.updates.push(patch), () => { state.signed = true; }) };
}

test("withdrawal Confirm sends the prepared approval without repeating network preparation", async () => {
  const flow = fixture();
  await flow.withdraw();
  assert.equal(flow.state.sent, 1);
  assert.equal(flow.state.signed, true);
  assert.equal(flow.state.amount, "");
  assert.equal(flow.context.preparedWithdrawal.current, undefined);
});

for (const reason of ["expired", "account changed", "amount changed"]) {
  test(`withdrawal requires another review when ${reason}`, async () => {
    const flow = fixture();
    if (reason === "expired") flow.prepared.preparedAt -= 61_000;
    if (reason === "account changed") flow.prepared.session = { ...flow.session };
    if (reason === "amount changed") flow.prepared.value = 20n;
    await assert.rejects(flow.withdraw(), /review your withdrawal again/);
    assert.equal(flow.state.sent, 0);
    assert.equal(flow.state.cancelled, true);
    assert.equal(flow.state.step, "entry");
  });
}

test("cancelled passkey approval returns withdrawal to entry for fresh preparation", async () => {
  const flow = fixture();
  flow.prepared.transaction.send = async () => { throw new Error("Approval cancelled"); };
  await assert.rejects(flow.withdraw(), /Approval cancelled/);
  assert.equal(flow.context.preparedWithdrawal.current, undefined);
  assert.equal(flow.state.step, "entry");
  assert.equal(flow.state.amount, "10");
});

test("withdrawal prepares balance access alongside input and includes it in one approval", async () => {
  let resolveInput;
  const input = new Promise((resolve) => { resolveInput = resolve; });
  let checkingAccess = false;
  let calls;
  const session = { address: "0x1234567890123456789012345678901234567890",
    async prepareTransaction(batch) { calls = batch; return { send() {}, cancel() {} }; },
  };
  const prepare = vm.runInNewContext(`(${handler("prepareWithdrawal", "async function withdrawConfidential(").trim()})`, {
    activeSession: () => session,
    poolReady: true,
    addresses: { pool: session.address },
    asAddress: (address) => address,
    withSmartZamaSDK: (_session, operation) => operation({}),
    encryptUint64: () => input,
    prepareSmartReadSessionCalls: async () => { checkingAccess = true; return [{ to: "acl", data: "delegate" }]; },
    confidentialPrizePoolAbi: [],
    encodeFunctionData: ({ functionName, args }) => {
      assert.equal(functionName, "requestWithdrawal");
      assert.deepEqual(Array.from(args), ["handle", "proof"]);
      return "withdraw";
    },
  });
  const preparing = prepare(10n);
  assert.equal(checkingAccess, true, "access checks must start before input preparation finishes");
  assert.equal(calls, undefined, "the operation must wait for the input proof");
  resolveInput({ handle: "handle", inputProof: "proof" });
  await preparing;
  assert.equal(JSON.stringify(calls), JSON.stringify([
    { to: "acl", data: "delegate" }, { to: session.address, data: "withdraw" },
  ]));
});

for (const invalidated of [false, true]) {
  test(`withdrawal review ${invalidated ? "discards preparation after closing or editing" : "waits for the passkey operation before showing Confirm"}`, async () => {
    let resolvePreparation;
    let cancelled = false;
    const preparation = new Promise((resolve) => { resolvePreparation = resolve; });
    const state = { step: "entry", preparing: false };
    const preparationId = { current: 0 };
    const prepared = { current: undefined };
    const review = vm.runInNewContext(`(${handler("reviewWithdraw", "async function runTrackedTransaction(").trim()})`, {
      parsedWithdrawAmount: 10n, principal: 20n,
      activeSession: () => ({}),
      withdrawalPreparationId: preparationId,
      preparedWithdrawal: prepared,
      setPreparingWithdrawal: (value) => { state.preparing = value; },
      prepareWithdrawal: () => preparation,
      setWithdrawSheetStep: (step) => { state.step = step; },
    });
    const reviewing = review();
    assert.equal(state.step, "entry");
    assert.equal(state.preparing, true);
    if (invalidated) preparationId.current++;
    resolvePreparation({ send() {}, cancel() { cancelled = true; } });
    await reviewing;
    assert.equal(state.step, invalidated ? "entry" : "confirm");
    assert.equal(cancelled, invalidated);
    assert.equal(Boolean(prepared.current), !invalidated);
    if (!invalidated) assert.equal(state.preparing, false);
  });
}
