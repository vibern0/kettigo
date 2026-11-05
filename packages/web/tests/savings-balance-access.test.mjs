import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const page = await readFile(new URL("../src/app/savings/page.tsx", import.meta.url), "utf8");

function handler(name, end) {
  const start = page.indexOf(`  ${name}`);
  return stripTypeScriptTypes(page.slice(start, page.indexOf(`  ${end}`, start)));
}

test("balance access review prepares before Confirm and Confirm sends once without another preparation", async () => {
  const state = { prepare: 0, send: 0, refreshed: 0, step: undefined };
  const session = {
    async prepareTransaction(calls, options) {
      state.prepare += 1;
      assert.equal(options.signal.aborted, false);
      assert.deepEqual(calls, [{ to: "acl", data: "grant" }]);
      return {
        cancel() {},
        async send() {
          state.send += 1;
          return "0xabc";
        },
      };
    },
  };
  const context = {
    activeSession: () => session,
    cancelOwnedReview: () => {},
    AbortController,
    reviewAbort: { current: undefined },
    setAccessReviewStep: (value) => {
      state.step = value;
    },
    prepareSmartReadSessionCalls: async () => [{ to: "acl", data: "grant" }],
    refreshConfidentialBalances: async () => {
      state.refreshed += 1;
    },
    preparedAccess: { current: undefined },
    Date,
    toast: () => {},
    reportClientToast: () => {},
    getErrorMessage: (error) => error.message,
  };
  const review = vm.runInNewContext(
    `(${handler("async function reviewBalanceAccess", "function confirmBalanceAccess").trim()})`,
    context,
  );
  const confirm = vm.runInNewContext(
    `(${handler("function confirmBalanceAccess", "async function copyPendingHash").trim()})`,
    context,
  );
  await review();
  assert.equal(state.prepare, 1);
  assert.equal(state.send, 0);
  assert.equal(state.step, "confirm");
  confirm();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.send, 1);
  assert.equal(state.refreshed, 1);
  assert.equal(context.preparedAccess.current, undefined);
});

test("a cancelled balance-access review disposes a late prepared transaction", async () => {
  let resolve;
  let cancelled = false;
  const session = {
    prepareTransaction: () =>
      new Promise((done) => {
        resolve = done;
      }),
  };
  const controller = { signal: { aborted: false } };
  const context = {
    activeSession: () => session,
    cancelOwnedReview: () => {},
    AbortController: class {
      constructor() {
        return controller;
      }
    },
    reviewAbort: { current: undefined },
    setAccessReviewStep: () => {},
    prepareSmartReadSessionCalls: async () => [{ to: "acl", data: "grant" }],
    refreshConfidentialBalances: async () => {},
    preparedAccess: { current: undefined },
    Date,
    toast: () => {},
    reportClientToast: () => {},
    getErrorMessage: (error) => error.message,
  };
  const review = vm.runInNewContext(
    `(${handler("async function reviewBalanceAccess", "function confirmBalanceAccess").trim()})`,
    context,
  );
  const reviewing = review();
  await new Promise((done) => setImmediate(done));
  controller.signal.aborted = true;
  resolve({
    cancel() {
      cancelled = true;
    },
    send() {},
  });
  await reviewing;
  assert.equal(cancelled, true);
  assert.equal(context.preparedAccess.current, undefined);
});
