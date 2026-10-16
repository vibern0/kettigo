import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const page = await readFile(new URL("../src/app/savings/page.tsx", import.meta.url), "utf8");
// Run the page's transaction handler with controlled UI state and async work.
const handler = stripTypeScriptTypes(page.slice(
  page.indexOf("  async function runTrackedTransaction("),
  page.indexOf("  async function run(action:"),
));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const state = { confirming: undefined, deposit: "confirm", withdraw: undefined, patches: [], toasts: [], reports: [] };
  const timers = [];
  let running;
  const run = vm.runInNewContext(`(${handler.trim()})`, {
    flushSync: (callback) => callback(),
    afterNextPaint: async () => {},
    setConfirmingAction: (value) => { state.confirming = value; },
    setDepositSheetStep: (value) => { state.deposit = value; },
    setWithdrawSheetStep: (value) => { state.withdraw = value; },
    window: { setTimeout: (callback) => timers.push(callback) },
    session: { address: "0x1234567890123456789012345678901234567890" },
    runAction: (_input, runner) => {
      running = runner({ update: (patch) => state.patches.push(patch) });
      return "deposit-action";
    },
    toast: (value) => state.toasts.push(value),
    reportClientToast: (_toast, context, cause) => state.reports.push({ error: cause, context }),
    getErrorMessage: (error) => error.message,
  });
  return { state, run, elapse: () => timers.splice(0).forEach((callback) => callback()), done: () => running };
}

test("keeps deposit confirmation open while passkey approval is pending", async () => {
  const approval = deferred();
  const flow = fixture();
  await flow.run("Deposit 10 USDC", "deposit", async (update) => {
    update({ status: "waiting-wallet" });
    await approval.promise;
  }, "Deposit complete.");
  flow.elapse();
  assert.equal(flow.state.deposit, "confirm");
  assert.equal(flow.state.confirming, "deposit");
  assert.equal(flow.state.toasts.length, 0);
  approval.resolve();
  await flow.done();
});

test("hands off after signing while confirmation continues in the background", async () => {
  const confirmation = deferred();
  const flow = fixture();
  await flow.run("Deposit 10 USDC", "deposit", async (_update, onSigned) => {
    onSigned();
    await confirmation.promise;
  }, "Deposit complete.");
  assert.equal(flow.state.deposit, undefined);
  assert.equal(flow.state.confirming, undefined);
  assert.equal(flow.state.toasts.some((toast) => toast.title === "Deposit complete."), false);
  // Finishing an older background action must not close a newly opened sheet.
  flow.state.deposit = "entry";
  flow.state.confirming = "withdraw";
  confirmation.resolve();
  await flow.done();
  assert.equal(flow.state.deposit, "entry");
  assert.equal(flow.state.confirming, "withdraw");
  assert.equal(flow.state.patches.at(-1).status, "completed");
  assert.equal(flow.state.toasts.at(-1).title, "Deposit complete.");
});

test("leaves the deposit form available to retry after cancelled approval", async () => {
  const approval = deferred();
  const flow = fixture();
  await flow.run("Deposit 10 USDC", "deposit", async () => approval.promise, "Deposit complete.");
  flow.elapse();
  approval.reject(new Error("Approval cancelled"));
  await flow.done();
  assert.equal(flow.state.deposit, "confirm");
  assert.equal(flow.state.confirming, undefined);
  assert.equal(flow.state.patches.at(-1).status, "failed");
  assert.equal(flow.state.toasts.at(-1).tone, "error");
});

 test("reports caught deposit failures with action context", async () => {
  const flow = fixture();
  const failure = new Error("Encryption service unavailable");
  await flow.run("Deposit 10 USDC", "deposit", async () => { throw failure; }, "Deposit complete.");
  await flow.done();
  assert.equal(flow.state.reports.length, 1);
  assert.equal(flow.state.reports[0].error, failure);
  assert.equal(flow.state.reports[0].context.action, "deposit");
});
