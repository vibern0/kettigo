import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import test from "node:test";

test("uses same-origin ingestion and reports repeated retry failures", async () => {
  const source = await readFile(new URL("../src/lib/client-errors.ts", import.meta.url), "utf8");
  let options;
  const context = vm.createContext({ window: {}, Sentry: { init: (value) => { options = value; } } });
  vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "").replace(/export /g, "")), context);
  vm.runInContext("initializeClientErrors()", context);
  assert.equal(options.tunnel, "/api/client-events");
  assert.deepEqual(Array.from(options.integrations([{ name: "Dedupe" }, { name: "Other" }]), (x) => x.name), ["Other"]);
});

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

test("passkey gas diagnostics survive delivery while arbitrary metadata is excluded", async () => {
  const source = await readFile(new URL("../src/lib/client-errors.ts", import.meta.url), "utf8");
  const events = [];
  let config;
  const context = vm.createContext({
    window: {},
    Sentry: { init: (value) => { config = value; }, captureException: (error, options) => events.push({ error, options }) },
  });
  vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "").replace(/export /g, "")), context);
  vm.runInContext(`reportClientToast({title:'Transaction failed'}, {action:'claimPrize',stage:'execution'}, Object.assign(new Error('AA24 signature error'), {
    passkeyDiagnostics: {phase:'submission',verifierProbe:'measured',verifierGas:'356759',bundlerVerificationGas:'308778',requestedVerificationGas:'600000',sponsoredVerificationGas:'600000',submittedVerificationGas:'600000',aaCode:'AA24',submittedMaxFeePerGas:'110000',sender:'0xabcdef1234567890',signature:'secret',callData:'secret',rpcUrl:'https://rpc.example/?apikey=secret'}
  }))`, context);
  const diagnostics = events[0].options.contexts.passkey_operation;
  assert.equal(diagnostics.phase, "submission");
  assert.equal(diagnostics.bundlerVerificationGas, "308778");
  assert.equal(diagnostics.submittedVerificationGas, "600000");
  assert.equal(diagnostics.aaCode, "AA24");
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret|sender|signature|callData|rpcUrl|apikey/);
  const delivered = config.beforeSend({ contexts: events[0].options.contexts, request: { secret: true }, extra: { secret: true }, breadcrumbs: ["secret"] });
  assert.equal(delivered.contexts.passkey_operation.submittedVerificationGas, "600000");
  assert.equal(delivered.request, undefined);
  assert.equal(delivered.extra, undefined);
  assert.equal(delivered.breadcrumbs, undefined);
});

test("diagnostic values cannot smuggle URLs or signatures through allowed field names", async () => {
  const source = await readFile(new URL("../src/lib/client-errors.ts", import.meta.url), "utf8");
  const events = [];
  const context = vm.createContext({ window: {}, Sentry: { init: () => {}, captureException: (error, options) => events.push({error,options}) } });
  vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "").replace(/export /g, "")), context);
  vm.runInContext(`reportClientError(Object.assign(new Error('failed'), {passkeyDiagnostics:{phase:'https://secret',submittedVerificationGas:'0xdeadbeef',aaCode:'AA24 secret'}}), {action:'claimPrize',stage:'execution'})`, context);
  assert.doesNotMatch(JSON.stringify(events[0].options), /secret|deadbeef/);
});
