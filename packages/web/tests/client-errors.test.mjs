import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import test from "node:test";

test("caught errors reach the configured error source without RPC secrets or amounts", async () => {
  const source = await readFile(new URL("../src/lib/client-errors.ts", import.meta.url), "utf8");
  const events = [];
  const context = vm.createContext({
    window: {},
    Sentry: { init: () => {}, captureException: (error, options) => events.push({ error, options }) },
  });
  vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "").replace(/export /g, "")), context);
  vm.runInContext(`reportClientError(Object.assign(new Error('RPC failed https://rpc.example/?apikey=secret 0xabcdef1234567890'), {stack: 'Error: RPC failed https://rpc.example/?apikey=secret\\n    at deposit (https://app.kettigo.xyz/_next/static/chunks/savings.js:12:34)'}), { action: 'deposit', stage: 'preparation' })`, context);
  assert.equal(events.length, 1);
  assert.equal(events[0].options.tags.action, "deposit");
  assert.equal(events[0].options.tags.stage, "preparation");
  assert.doesNotMatch(events[0].error.message, /apikey|secret|abcdef/);
  assert.match(events[0].error.stack, /savings.js:12:34/);
  assert.doesNotMatch(events[0].error.stack, /apikey|secret/);
});

test("error toast messages reach the configured error source", async () => {
  const source = await readFile(new URL("../src/lib/client-errors.ts", import.meta.url), "utf8");
  const events = [];
  const context = vm.createContext({
    window: {},
    Sentry: { init: () => {}, captureException: (error, options) => events.push({ error, options }) },
  });
  vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "").replace(/export /g, "")), context);
  vm.runInContext(`reportClientToast({ title: 'Amount is above your wallet balance.' }, { action: 'deposit', stage: 'validation' })`, context);
  assert.equal(events.length, 1);
  assert.equal(events[0].error.message, "Amount is above your wallet balance.");
  assert.equal(events[0].options.tags.action, "deposit");
  assert.equal(events[0].options.tags.stage, "validation");
});
