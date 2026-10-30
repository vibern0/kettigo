import { ethers } from "hardhat";
import type { ZamaSDK as SDK } from "@zama-fhe/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { ProofArchive } from "./indexer/ProofArchive";
import { assertBudget, assertResearchRequest } from "./soak/Policy";
import { nextCycle } from "./soak/WorkQueue";
import { recoverSignedRecord } from "./soak/Recovery";
import { RunState } from "./soak/RunState";
import { nextResearchNonce } from "./soak/Nonce";
import { admissionFromReceipt } from "./soak/Admission";
import { indexedRead } from "./soak/RpcRead";
import { confirmedPublicProof } from "./soak/PublicProof";
import { confirmedUserProof } from "./soak/UserProof";
import { knownTransaction } from "./soak/TransactionLookup";
import { FailureLatch } from "./soak/Failure";

// This runner has no deployment entrypoint. It only attaches to the previously
// validated research deployment. All monetary policy values are hard ceilings.
const dir = __dirname, cache = path.join(dir, "cache/soak");
fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
const output = path.join(dir, "soak-results.json"), logFile = path.join(dir, "soak-events.jsonl");
const load = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const runState = new RunState(output, path.join(cache, "runner.lock"));
let state: any = {
  version: 1, status: "preparing", transactions: {}, cycles: {}, measurements: [], http: {}, errors: [],
};
const save = () => {
  state.updatedAt = new Date().toISOString();
  runState.write(state);
};
const event = (value: any) => fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n");
const context = new AsyncLocalStorage<string>();
const originalFetch = globalThis.fetch.bind(globalThis);
let coolUntil = 0, outstanding = 0, lockOwned = false;
const failures = new FailureLatch();
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const route = url.pathname.match(/\/v[23]\/(?:delegated-)?(?:user-decrypt|public-decrypt|input-proof)(?:\/[^/]+)?$/)?.[0]
    .replace(/(user-decrypt|public-decrypt|input-proof)\/[^/]+$/, "$1/:job");
  const label = context.getStore() ?? "background", start = performance.now();
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  try {
    const response = await originalFetch(input, init);
    if (route) {
      const key = `${method}:${response.status}`;
      const counts = state.http[label] ??= {}; counts[key] = (counts[key] ?? 0) + 1;
      const retry = Number(response.headers.get("retry-after"));
      if (response.status === 429) coolUntil = Math.max(coolUntil, Date.now() + (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : 60) * 1000);
      event({ kind: "http", label, route, method, status: response.status, elapsedMs: Math.round(performance.now() - start) });
    }
    return response;
  } catch (e) { if (route) event({ kind: "http", label, route, method, status: "transport_error" }); throw e; }
};
// Install HTTP instrumentation before initializing any SDK/runtime instance.
const { ZamaSDK, MemoryStorage } = require("@zama-fhe/sdk");
const { sepolia } = require("@zama-fhe/sdk/chains");
const { createConfig } = require("@zama-fhe/sdk/ethers");
const { node } = require("@zama-fhe/sdk/node");
const limits = { feeWei: ethers.parseEther("0.0015"), fundingWei: ethers.parseEther("0.00064"), maxTransactions: 3500 };
const gasPrice = 100000n, durationMs = 24 * 3600000, intervalMs = 30 * 60000, loadCycles = 48;
const sdks = new Set<SDK>();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitUntil(time: number) {
  while (Date.now() < time) { save(); await sleep(Math.min(30000, time - Date.now())); }
}
async function measured<T>(label: string, fn: () => Promise<T>): Promise<T> {
  await waitUntil(coolUntil);
  const start = performance.now(); outstanding++;
  state.outstanding = outstanding; state.peakOutstanding = Math.max(state.peakOutstanding ?? 0, outstanding); save();
  try {
    const result = await context.run(label, fn);
    const row = { label, ok: true, elapsedMs: Math.round(performance.now() - start) };
    state.measurements.push(row); event({ kind: "operation", ...row }); return result;
  } catch (e: any) {
    const causes: any[] = []; let c=e;
    for(let n=0;c&&n<4;n++,c=c.cause) causes.push({name:c.name,code:c.code,message:String(c.shortMessage??c.message??"").replace(/https?:\/\/[^\s)]+/g,"[endpoint]").slice(0,300)});
    const row = { label, ok: false, elapsedMs: Math.round(performance.now() - start), code: String(e.code ?? e.name ?? "Error"), causes };
    state.measurements.push(row); state.errors.push({ ...row, at: new Date().toISOString() }); event({ kind: "operation", ...row }); throw e;
  } finally { outstanding--; state.outstanding = outstanding; save(); }
}
async function batch<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failures.stopped) { const i = next++; if (i >= items.length) return; try { await fn(items[i], i); } catch (e) { throw failures.capture(e); } }
  }));
  const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason;
}
async function main() {
  runState.acquire(); lockOwned = true;
  state = runState.read() ?? state;
  if (state.failure) { (state.incidents ??= []).push({ ...state.failure, resumedAt: new Date().toISOString() }); delete state.failure; }
  assert.equal((await ethers.provider.getNetwork()).chainId, 11155111n);
  const baseline = load(path.join(dir, "sepolia-reusable-results.json")); assert.equal(baseline.status, "passed");
  assert(process.env.PRIVATE_KEY && process.env.SEPOLIA_RPC_URL, "Use existing research signer setup");
  const owner = new ethers.Wallet(process.env.PRIVATE_KEY, ethers.provider); assert.equal(owner.address, baseline.owner);
  const address = ethers.getAddress(baseline.pool), tokenAddress = ethers.getAddress(baseline.token);
  assert.equal(ethers.keccak256(await ethers.provider.getCode(address)), baseline.runtimeHash);
  const prior = load(path.join(dir, "sepolia-results.json"));
  assert.equal(ethers.keccak256(await ethers.provider.getCode(tokenAddress)), prior.runtimeCodeHashes.token);
  const pool: any = await ethers.getContractAt("ReusableMerkleProbe", address, owner);
  const token: any = await ethers.getContractAt("ConfidentialUSDC", tokenAddress, owner);
  const underlying = ethers.getAddress(prior.contracts.usdc);
  const usdc: any = await ethers.getContractAt("MockUSDC", underlying, owner);
  assert.equal(await pool.owner(), owner.address); assert.equal(await pool.token(), tokenAddress); assert.equal(await pool.depth(), 32n);
  assert.equal(await token.underlying(), underlying);
  const walletFile = path.join(cache, "wallets.json");
  if (!fs.existsSync(walletFile)) {
    const old = load(path.join(dir, "cache/sepolia-research-wallets.json")); assert.equal(old.length, 2);
    const keys = [...old, ...Array.from({ length: 6 }, () => ethers.Wallet.createRandom().privateKey)];
    fs.writeFileSync(walletFile, JSON.stringify(keys), { mode: 0o600, flag: "wx", flush: true });
  }
  const wallets: import("ethers").Wallet[] = load(walletFile).map((k: string) => new ethers.Wallet(k, ethers.provider));
  const sponsor = wallets[0]; // Isolated research EOA; shared owner only closes draws.
  assert.equal(wallets.length, 8); assert.deepEqual(wallets.slice(0, 2).map((w: any) => w.address), baseline.participants);
  if (state.pool) assert.equal(state.pool, address);
  if (state.wallets) assert.deepEqual(state.wallets, wallets.map((w: any) => w.address));
  state.pool = address; state.token = tokenAddress; state.owner = owner.address; state.wallets = wallets.map((w: any) => w.address);
  state.limits = { feeBudgetWei: String(limits.feeWei), fundingBudgetWei: String(limits.fundingWei), maxTransactions: limits.maxTransactions, gasPriceWei: String(gasPrice), durationHours: 24, maxCycles: loadCycles };
  state.pid = process.pid; state.status = "preflight"; save();
  // The existing owner uses EIP-7702 delegation. Sepolia's txpool allowed only
  // one pending transaction for it; preserve independent user concurrency.
  state.ownerCodeIsDelegation = (await ethers.provider.getCode(owner.address)).startsWith("0xef0100");
  state.ownerMaxInFlight = 1;
  const block = await ethers.provider.getBlock("latest"); assert(block!.baseFeePerGas! < gasPrice, "Base fee exceeds fixed gas price");
  if(!state.protocol){
    const executor=new ethers.Contract(ethers.getAddress(prior.liveNetwork.executor),["function getVersion() view returns(string)","function getHCULimitAddress() view returns(address)"],ethers.provider);
    const hcuAddress=ethers.getAddress(await executor.getHCULimitAddress());
    const hcu=new ethers.Contract(hcuAddress,["function getVersion() view returns(string)","function getMaxHCUPerTx() view returns(uint256)","function getMaxHCUDepthPerTx() view returns(uint256)","function getGlobalHCUCapPerBlock() view returns(uint256)"],ethers.provider);
    state.protocol={block:block!.number,executor:await executor.getAddress(),executorVersion:await executor.getVersion(),hcu:hcuAddress,hcuVersion:await hcu.getVersion(),maxHcuPerTx:String(await hcu.getMaxHCUPerTx()),maxDepthPerTx:String(await hcu.getMaxHCUDepthPerTx()),blockHcuCap:String(await hcu.getGlobalHCUCapPerBlock()),node:process.version,sdk:"3.6.0"};save();
  }
  const makeSdk = (signer: any): SDK => {
    const chain = { ...sepolia, network: process.env.SEPOLIA_RPC_URL };
    const s = new ZamaSDK(createConfig({ chains: [chain], signer, storage: new MemoryStorage(), relayers: { [chain.id]: node({ timeout: 120000 }) } }));
    sdks.add(s); return s;
  };
  const freshOwn = async (label: string, signer: any, contract: string, handles: string[], confirmedBlock?: number) => measured(label, async () => {
    const postsBefore = Object.entries(state.http[label] ?? {}).reduce((n, [k, v]) => n + (k.startsWith("POST:2") ? Number(v) : 0), 0);
    const decrypt = async () => {
      const s = makeSdk(signer);
      try { return await s.decryption.decryptValues(handles.map(h => ({ contractAddress: ethers.getAddress(contract) as `0x${string}`, encryptedValue: h as `0x${string}` }))); }
      finally { s.terminate(); sdks.delete(s); }
    };
    const values = confirmedBlock === undefined ? await decrypt() : await confirmedUserProof(signer.address, ethers.getAddress(contract), handles,
      async () => {
        const grants: boolean[] = [];
        for (const h of handles) for (const account of [signer.address, ethers.getAddress(contract)]) {
          grants.push(await rpcRead<boolean>("user-acl-snapshot", () => acl.persistAllowed(h, account, {blockTag:confirmedBlock})));
        }
        return grants;
      }, decrypt, sleep, (attempt, delayMs) => {
        const row={label,block:confirmedBlock,attempt,delayMs,at:new Date().toISOString()};
        (state.userAclReadRetries??=[]).push(row);event({kind:"user_acl_read_retry",...row});save();
      });
      const postsAfter = Object.entries(state.http[label] ?? {}).reduce((n, [k, v]) => n + (k.startsWith("POST:2") ? Number(v) : 0), 0);
      assert(postsAfter > postsBefore, "Cold decryption made no new observed successful relayer POST");
      return handles.map(h => BigInt(values[h as `0x${string}`] as any));
  });
  // Existing ciphertext is already aged at preflight. This proves only its
  // measured age, not an eventual sixty days, and is explicitly a warm cohort.
  if (!state.agedBaseline) {
    const creation = await ethers.provider.getBlock(baseline.transactions["alice-old-check"].block);
    const handle = await pool.awardOf(1, wallets[0].address);
    const [value] = await freshOwn("preflight-aged-award", wallets[0], address, [handle]); assert.equal(value, 11n);
    state.agedBaseline = { handle, value: String(value), createdBlock: creation!.number, createdTimestamp: creation!.timestamp,
      observedTimestamp: block!.timestamp, ageSeconds: block!.timestamp - creation!.timestamp, coldHttp: state.http["preflight-aged-award"], kind: "previously accessed ciphertext" }; save();
  }
  if (process.env.SOAK_PREFLIGHT === "1") { state.status = "preflight_passed"; save(); return; }
  const allowed = { contracts: [address, tokenAddress, underlying], wallets: wallets.map((w: any) => w.address), maxGasPrice: gasPrice };
  const snapshot = () => ({ blockTag: Math.max(baseline.transactions["signature-probe-clear"].block,
    ...Object.values(state.transactions).filter((t: any) => t.status === "confirmed").map((t: any) => t.block)) });
  const rpcRead=<T>(label:string,read:()=>Promise<T>)=>indexedRead(read,sleep,(attempt,delayMs)=>{
    event({kind:"rpc_index_retry",label,attempt,delayMs});
    (state.rpcIndexRetries??=[]).push({label,attempt,delayMs,at:new Date().toISOString()});save();
  });
  const executor = new ethers.Contract(state.protocol.executor, ["function getACLAddress() view returns(address)"], ethers.provider);
  const acl = new ethers.Contract(ethers.getAddress(await executor.getACLAddress()), ["function isAllowedForDecryption(bytes32) view returns(bool)", "function persistAllowed(bytes32,address) view returns(bool)"], ethers.provider);
  // Recover the fsync(raw) -> save(ledger) crash window before preparing any
  // replacement inputs/signatures. Only the exact saved transaction may resume.
  for (const filename of fs.readdirSync(cache).filter(n => n.endsWith(".raw"))) {
    const label = filename.slice(0, -4);
    if (state.transactions[label]) continue;
    assert(/^(?:init-(?:gas-[0-7]|mint|approve|sponsor-mint|sponsor-approve|wrap-[2-7])|(?:retention|cycle-\d+)-(?:deposit-\d+|admit-\d+|fund|close|exit-\d+|check-\d+))$/.test(label), "Unknown orphan transaction label");
    const record = recoverSignedRecord(fs.readFileSync(path.join(cache, filename), "utf8"), [owner.address, ...wallets.map(w => w.address)], allowed);
    assertBudget(Object.values(state.transactions), { feeWei: BigInt(record.quotedFeeWei), valueWei: BigInt(record.valueWei) }, limits);
    state.transactions[label] = { ...record, submittedAt: fs.statSync(path.join(cache, filename)).mtime.toISOString(), recoveredOrphan: true }; save();
  }
  // Serialize budget reservation, nonce assignment and broadcast globally.
  // Receipts/proofs/decryptions still run concurrently across the cohort.
  let dispatchTail = Promise.resolve();
  async function reconcile(label: string) {
    const item = state.transactions[label];
    const tx = await knownTransaction(item.hash, () => ethers.provider.getTransaction(item.hash), async () => {
      const raw = fs.readFileSync(path.join(cache, `${label}.raw`), "utf8"); assert.equal(ethers.keccak256(raw), item.hash);
      return ethers.provider.broadcastTransaction(raw);
    }, sleep, (attempt, delayMs) => {
      const row={label,hash:item.hash,attempt,delayMs,at:new Date().toISOString()};
      (state.transactionLookupRetries??=[]).push(row);event({kind:"transaction_lookup_retry",...row});save();
    });
    assert(tx && tx.from === item.sender && tx.nonce === item.nonce, "Saved transaction identity mismatch");
    let receipt;
    try { receipt = await tx.wait(1, 180000); } catch (e: any) { if (e.receipt) receipt = e.receipt; else throw e; }
    assert(receipt);
    if (item.blockHash) assert.equal(receipt.blockHash, item.blockHash, "Canonical receipt changed; stop for recovery");
    Object.assign(item, { status: receipt.status === 1 ? "confirmed" : "reverted", block: receipt.blockNumber, blockHash: receipt.blockHash,
      gasUsed: String(receipt.gasUsed), feeWei: String(receipt.fee), confirmedAt: new Date().toISOString() }); save();
    assert.equal(receipt.status, 1, "Research transaction reverted"); return receipt;
  }
  // Resume all uncertain sends before allocating another nonce or fee budget.
  for (const label of Object.keys(state.transactions)) if (state.transactions[label].status !== "confirmed") await reconcile(label);
  async function sendInner(label: string, signer: any, prepare: () => Promise<any>) {
    if (state.transactions[label]) return reconcile(label);
    const dispatch = dispatchTail.catch(() => {}).then(async () => {
      failures.throwIfStopped();
      const request = await prepare(), value = BigInt(request.value ?? 0);
      const gasLimit = ((await signer.estimateGas(request)) * 12n + 9n) / 10n;
      assertResearchRequest({ chainId: 11155111n, to: request.to, value, gasPrice, gasLimit }, allowed);
      assertBudget(Object.values(state.transactions), { feeWei: gasLimit * gasPrice, valueWei: value }, limits);
      assert(await ethers.provider.getBalance(signer.address) >= gasLimit * gasPrice + value, "Research wallet gas insufficient");
      const networkNonce = Number(BigInt(await ethers.provider.send("eth_getTransactionCount", [signer.address, "pending"])));
      const nonce = nextResearchNonce(Object.values(state.transactions), signer.address, networkNonce);
      const raw = await signer.signTransaction({ ...request, chainId: 11155111n, gasPrice, gasLimit, nonce, type: 0 });
      const hash = ethers.keccak256(raw);
      fs.writeFileSync(path.join(cache, `${label}.raw`), raw, { mode: 0o600, flag: "wx", flush: true });
      state.transactions[label] = { hash, sender: signer.address, nonce, status: "signed", quotedFeeWei: String(gasLimit * gasPrice), valueWei: String(value), submittedAt: new Date().toISOString() }; save();
      try { await ethers.provider.broadcastTransaction(raw); state.transactions[label].status = "pending"; save(); }
      catch (e) { throw failures.capture(e); }
    }).catch(e => { throw failures.capture(e); });
    dispatchTail = dispatch;
    await dispatch;
    return measured(`tx-${label}`, () => reconcile(label));
  }
  let ownerTail: Promise<any> = Promise.resolve();
  function send(label: string, signer: any, prepare: () => Promise<any>): Promise<any> {
    if (signer.address !== owner.address) return sendInner(label, signer, prepare);
    const task = ownerTail.catch(() => {}).then(() => sendInner(label, signer, prepare))
      .catch(e => { throw failures.capture(e); });
    ownerTail = task;
    return task;
  }
  const inputSdks = new Map<string, SDK>();
  const inputSdk = (signer: any) => { if (!inputSdks.has(signer.address)) inputSdks.set(signer.address, makeSdk(signer)); return inputSdks.get(signer.address)!; };
  async function deposit(label: string, signer: any, amount: bigint, funding = false) {
    if (state.transactions[label]) { await reconcile(label); return; }
    const input = await measured(`encrypt-${label}`, () => inputSdk(signer).encrypt({ contractAddress: tokenAddress as `0x${string}`, userAddress: signer.address as `0x${string}`, values: [{ type: "euint64", value: amount }] }));
    await send(label, signer, () => token.connect(signer)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"].populateTransaction(address, input.encryptedValues[0], input.inputProof,
      ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint256"], [funding, 0])));
  }
  async function admit(label: string, signer: any) {
    if (state.transactions[label]) { await reconcile(label); return; }
    const depositReceipt = await reconcile(label.replace("-admit-", "-deposit-"));
    const p = admissionFromReceipt(depositReceipt.logs, address, signer.address);
    const proof: any = await measured(`public-proof-${label}`, () => confirmedPublicProof(p.marker,
      () => rpcRead<boolean>("admission-acl-snapshot", () => acl.isAllowedForDecryption(p.marker, {blockTag:depositReceipt.blockNumber})),
      () => inputSdk(signer).decryption.decryptPublicValues([p.marker]), sleep, (attempt, delayMs) => {
        const row = {label, marker:p.marker, block:depositReceipt.blockNumber, attempt, delayMs, at:new Date().toISOString()};
        (state.aclReadRetries ??= []).push(row); event({kind:"acl_read_retry", ...row}); save();
      }));
    assert.equal(proof.clearValues[p.marker], true);
    await send(label, signer, () => pool.connect(signer).finalizeAdmission.populateTransaction(signer.address, p.nonce, true, proof.decryptionProof));
  }
  if (!state.initialBalances) {
    assert.equal(await pool.activeCount(), 0n, "Initial pool is occupied");
    const balances: string[] = [];
    for (const [i, signer] of [owner, ...wallets].entries()) {
      const h = await token.confidentialBalanceOf(signer.address);
      balances.push(h === ethers.ZeroHash ? "0" : String((await freshOwn(`initial-balance-${i}`, signer, tokenAddress, [h]))[0]));
    }
    state.initialBalances = balances; state.initialUnderlying = String(await usdc.balanceOf(tokenAddress)); save();
  }
  state.status = "initializing_wallets"; save();
  // Fixed one-time funding per wallet, including the two reused research wallets.
  await batch(wallets, 2, async (w, i) => { await send(`init-gas-${i}`, owner, async () => ({ to: w.address, value: ethers.parseEther("0.00008") })); });
  await send("init-sponsor-mint", sponsor, () => usdc.connect(sponsor).faucet.populateTransaction(sponsor.address, 6000n));
  await send("init-sponsor-approve", sponsor, () => usdc.connect(sponsor).approve.populateTransaction(tokenAddress, 6000n));
  // All wraps share the sponsor nonce: await receipts rather than queueing its
  // finite underlying allowance against unconfirmed state during gas estimation.
  for (let i = 2; i < 8; i++) await send(`init-wrap-${i}`, sponsor, () => token.connect(sponsor).wrap.populateTransaction(wallets[i].address, 1000n));
  const db = path.join(cache, "proofs.sqlite"), existed = fs.existsSync(db);
  if (!existed) delete state.archiveCursor;
  const options = { path: db, chainId: "11155111", pool: address, depth: 32, zero: await pool.zero(),
    emptyHashes: await Promise.all(Array.from({ length: 33 }, (_, l) => pool.emptyHash(l))) };
  async function archive(throughBlock: number) {
    const a = new ProofArchive(options);
    try {
      if (state.archiveCursor) assert.equal((await ethers.provider.getBlock(state.archiveCursor.block))?.hash, state.archiveCursor.hash, "Indexer checkpoint orphaned; explicit rollback required");
      const end = await rpcRead("archive-header",async()=>{
        const b=await ethers.provider.getBlock(throughBlock);
        if(!b)throw Object.assign(new Error("header not found"),{code:-32000});return b;
      });
      for (let start = state.archiveCursor ? state.archiveCursor.block + 1 : baseline.transactions.deploy.block; start <= end!.number; start += 500) {
        const raw = await rpcRead("archive-logs",()=>ethers.provider.getLogs({ address, fromBlock: start, toBlock: Math.min(end!.number, start + 499) }));
        const names = new Set(["NodeUpdated", "SlotAssigned", "SlotReleased", "Closed"]);
        a.ingest(raw.flatMap(log => {
          const p = pool.interface.parseLog(log); if (!p || !names.has(p.name)) return [];
          return [{ blockNumber: log.blockNumber, blockHash: log.blockHash, logIndex: log.index, name: p.name,
            args: Object.fromEntries(p.fragment.inputs.map((v: any, i: number) => [v.name, p.args[i]])) }];
        }));
      }
      state.archiveCursor = { block: end!.number, hash: end!.hash }; save();
    } finally { a.close(); }
    return new ProofArchive(options);
  }
  async function round(key: string, cohort: any[], concurrency: number, canary = false) {
    const cycle = state.cycles[key] ??= { key, size: cohort.length, concurrency, startedAt: new Date().toISOString(), status: "running", canary };
    if (cycle.status === "completed" || cycle.status === "settled") return;
    await batch(cohort, concurrency, async (w, i) => { await deposit(`${key}-deposit-${i}`, w, 1n); await admit(`${key}-admit-${i}`, w); });
    await deposit(`${key}-fund`, sponsor, 11n, true);
    const closed = await send(`${key}-close`, owner, () => pool.closeDraw.populateTransaction());
    const parsed = closed.logs.map((l: any) => { try { return pool.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Closed");
    assert(parsed); cycle.drawId = Number(parsed.args.id); save();
    await batch(cohort, concurrency, async (w, i) => { await send(`${key}-exit-${i}`, w, () => pool.connect(w).withdrawAllAndExit.populateTransaction()); });
    const a = await measured(`archive-${key}`, ()=>archive(closed.blockNumber));
    try {
      const draw = await rpcRead<{rootHash:string;sum:string}>("draw-snapshot",()=>pool.draws(cycle.drawId,{blockTag:closed.blockNumber}));
      const proofs = cohort.map(w => a.proof(cycle.drawId, w.address, { rootHash: draw.rootHash, rootSum: draw.sum }));
      if (canary) {
        assert.deepEqual(proofs.map(p => Number(p.index)).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7]);
        const last = await ethers.provider.getBlock(Math.max(...cohort.map((_, i) => state.transactions[`${key}-exit-${i}`].block)));
        state.retentionCanary = { chainId: "11155111", pool: address, drawId: cycle.drawId, prize: "11", createdAt: last!.timestamp,
          earliestDay60: new Date((last!.timestamp + 60 * 86400) * 1000).toISOString(), policy: "All claims untouched; no ticket/prefix decrypt probes", proofs };
      } else {
        await batch(proofs, concurrency, async (p, i) => {
          await send(`${key}-check-${i}`, cohort[i], () => pool.connect(cohort[i]).claimMerkle.populateTransaction(cycle.drawId, p.account, p.index, p.generation, p.balance, p.siblingHashes, p.siblingSums, p.parentSums));
        });
        const awards: string[] = [];
        await batch(cohort, concurrency, async (w, i) => {
          const h = await rpcRead<string>("award-snapshot",()=>pool.awardOf(cycle.drawId, w.address, {blockTag:state.transactions[`${key}-check-${i}`].block}));
          awards[i] = String((await freshOwn(`cold-award-${key}-${i}`, w, address, [h], state.transactions[`${key}-check-${i}`].block))[0]);
        });
        assert.equal(awards.reduce((n, s) => n + BigInt(s), 0n), 11n, "Prize conservation failure"); cycle.awards = awards;
      }
    } finally { a.close(); }
    assert.equal(await rpcRead("active-count",()=>pool.activeCount(snapshot())), 0n);
    assert.equal(await rpcRead("underlying-balance",()=>usdc.balanceOf(tokenAddress, snapshot())), BigInt(state.initialUnderlying) + 6000n);
    cycle.status = canary ? "completed" : "settled"; cycle.completedAt = new Date().toISOString();
    cycle.elapsedMs = Date.parse(cycle.completedAt) - Date.parse(cycle.startedAt); save();
  }
  // First preserve a real eight-position cohort for an eventual day60 claim.
  await round("retention", wallets, 2, true);
  if (!state.startedAt) { state.startedAt = new Date().toISOString(); state.stopAt = new Date(Date.now() + durationMs).toISOString(); save(); }
  state.status = "running"; save();
  while (true) {
    const work = nextCycle(state.cycles, Date.now(), Date.parse(state.stopAt), loadCycles);
    if (!work) break;
    const n = work.index;
    const key = `cycle-${n}`;
    if (state.cycles[key]?.status === "completed") continue;
    const concurrency = n === 0 ? 2 : n === 1 ? 4 : 8;
    const due = Date.parse(state.startedAt) + n * intervalMs;
    await waitUntil(Math.max(work.resume ? Date.now() : due, coolUntil));
    if (!work.resume && Date.now() >= Date.parse(state.stopAt)) break;
    await round(key, wallets.slice(0, concurrency), concurrency);
    // Full principal has returned. Verify each requested user's accumulated
    // confidential token delta without granting the operator aggregate access.
    let funded = 0n;
    for (const [label, tx] of Object.entries(state.transactions) as [string, any][]) if (label.endsWith("-fund") && tx.status === "confirmed") funded += 11n;
    await batch(wallets, concurrency, async (w, i) => {
      let expected = BigInt(state.initialBalances[i + 1]) + (i >= 2 ? 1000n : 0n);
      if (w.address === sponsor.address) expected -= funded;
      for (const c of Object.values(state.cycles) as any[]) if (["completed", "settled"].includes(c.status) && !c.canary && i < c.size) expected += BigInt(c.awards[i]);
      const h = await rpcRead<string>("token-balance-snapshot",()=>token.confidentialBalanceOf(w.address, snapshot()));
      assert.equal((await freshOwn(`cold-balance-${key}-${i}`, w, tokenAddress, [h], snapshot().blockTag))[0], expected, "Principal/token balance mismatch");
    });
    const ownerHandle = await rpcRead<string>("owner-balance-snapshot",()=>token.confidentialBalanceOf(owner.address, snapshot()));
    assert.equal((await freshOwn(`cold-owner-${key}`, owner, tokenAddress, [ownerHandle], snapshot().blockTag))[0], BigInt(state.initialBalances[0]));
    state.lastConservationAt = new Date().toISOString(); state.lastConservationTxCount = Object.keys(state.transactions).length;
    state.cycles[key].status = "completed"; state.cycles[key].completedAt=state.lastConservationAt;
    state.cycles[key].elapsedMs=Date.parse(state.lastConservationAt)-Date.parse(state.cycles[key].startedAt);save();
    console.log(JSON.stringify({ completed: key, concurrency, elapsedMs: state.cycles[key].elapsedMs, transactions: Object.keys(state.transactions).length }));
    if (process.env.SOAK_ONCE === "1") { state.status = "checkpoint_after_cycle"; save(); return; }
  }
  // Cover the last scheduled interval without falsely shortening a 24h soak.
  await waitUntil(Date.parse(state.stopAt));
  assert(Object.values(state.cycles).every((c: any) => c.status === "completed"), "Unfinished cycle remains");
  assert(Object.values(state.transactions).every((t: any) => t.status === "confirmed"), "Unsettled transaction remains");
  assert.equal(state.lastConservationTxCount, Object.keys(state.transactions).length, "Missing final conservation check");
  assert.equal(outstanding, 0); assert.equal(await pool.activeCount(), 0n);
  state.status = "completed"; state.completedAt = new Date().toISOString(); save();
}
main().catch((e: any) => {
  const failure = { code: String(e.code ?? e.name), message: String(e.shortMessage ?? e.message).replace(/https?:\/\/[^\s)]+/g, "[endpoint]").slice(0, 350) };
  if (lockOwned) { state.status = "needs_attention"; state.failure = failure; save(); }
  console.error(JSON.stringify(failure)); process.exitCode = 1;
}).finally(() => {
  globalThis.fetch = originalFetch;
  for (const s of sdks) s.terminate();
  runState.release();
  process.exit(Number(process.exitCode ?? 0));
});
