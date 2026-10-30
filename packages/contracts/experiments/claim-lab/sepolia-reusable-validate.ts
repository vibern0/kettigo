import { ethers } from "hardhat";
import { ZamaSDK, memoryStorage } from "@zama-fhe/sdk";
import { sepolia } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/ethers";
import { node } from "@zama-fhe/sdk/node";
import { ProofArchive } from "./indexer/ProofArchive";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

// New isolated research pool, reusing ONLY the prior validated research token
// and research wallets. No production addresses, account funding, or new keys.
const file = path.join(__dirname, "sepolia-reusable-results.json");
const state: any = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { status: "starting", transactions: {}, checks: {}, latencyMs: {} };
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
const sdks: ZamaSDK[] = [];
async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  assert.equal(chainId, 11155111n, "Sepolia only");
  const previous = JSON.parse(fs.readFileSync(path.join(__dirname, "sepolia-results.json"), "utf8"));
  assert.equal(previous.status, "passed"); assert.equal(previous.chainId, "11155111");
  assert(process.env.PRIVATE_KEY && process.env.SEPOLIA_RPC_URL, "Use the configured research signer and RPC");
  const owner = new ethers.Wallet(process.env.PRIVATE_KEY, ethers.provider);
  assert.equal(owner.address, previous.owner, "Only the existing research owner");
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "cache/sepolia-research-wallets.json"), "utf8"))
    .map((key: string) => new ethers.Wallet(key, ethers.provider));
  assert.deepEqual(wallets.map((w: any) => w.address), previous.participants);
  const [alice, bob] = wallets;
  const tokenAddress = ethers.getAddress(previous.contracts.token);
  assert.equal(ethers.keccak256(await ethers.provider.getCode(tokenAddress)), previous.runtimeCodeHashes.token);
  const token: any = await ethers.getContractAt("ConfidentialUSDC", tokenAddress, owner);
  assert.equal(await token.underlying(), ethers.getAddress(previous.contracts.usdc));
  const budget = ethers.parseEther("0.0001"), gasPrice = BigInt(process.env.RESEARCH_GAS_PRICE_WEI ?? "100000");
  const block = await ethers.provider.getBlock("latest");
  assert(gasPrice > 0n && gasPrice <= 100000n && gasPrice > block!.baseFeePerGas!);
  state.chainId = String(chainId); state.owner = owner.address; state.token = tokenAddress;
  state.participants = wallets.map((w: any) => w.address);
  state.feePolicy = { budgetWei: String(budget), explicitGasPriceWei: String(gasPrice) };
  if (state.failure) { (state.incidents ??= []).push(state.failure); delete state.failure; }
  state.status = "running"; save();
  const spent = () => Object.values(state.transactions).reduce((n: bigint, t: any) => n + BigInt(t.costWei ?? 0), 0n);
  async function receipt(label: string) {
    const item = state.transactions[label];
    const tx = await ethers.provider.getTransaction(item.hash); assert(tx, "Saved transaction missing; reconcile manually");
    let r;
    try { r = await tx.wait(1, 180000); }
    catch (e: any) { if (e.receipt) r = e.receipt; else throw e; }
    assert(r);
    state.transactions[label] = { ...item, status: r.status === 1 ? "confirmed" : "reverted", block: r.blockNumber, gasUsed: String(r.gasUsed), costWei: String(r.fee) }; save();
    assert.equal(r.status, 1, "Saved research transaction reverted; stop and reconcile");
    return r;
  }
  for (const label of Object.keys(state.transactions)) await receipt(label);
  async function send(label: string, signer: any, prepare: () => Promise<any>) {
    if (state.transactions[label]) return receipt(label);
    const request = await prepare();
    const gasLimit = ((await signer.estimateGas(request)) * 12n + 9n) / 10n;
    assert(spent() + gasLimit * gasPrice <= budget, "Maximum research fee budget exceeded");
    assert(await ethers.provider.getBalance(signer.address) >= gasLimit * gasPrice + BigInt(request.value ?? 0), "Insufficient existing research gas");
    const nonce = Number(BigInt(await ethers.provider.send("eth_getTransactionCount", [signer.address, "pending"])));
    const raw = await signer.signTransaction({ ...request, chainId, nonce, gasLimit, gasPrice, type: 0 });
    state.transactions[label] = { hash: ethers.keccak256(raw), sender: signer.address, nonce, status: "pending" }; save();
    await ethers.provider.broadcastTransaction(raw);
    const r = await receipt(label); assert(r.gasPrice <= gasPrice);
    console.log(JSON.stringify({ step: label, ...state.transactions[label] })); return r;
  }
  const factory = await ethers.getContractFactory("ReusableMerkleProbe", owner);
  const deployment = await factory.getDeployTransaction(tokenAddress, 32);
  const r = await send("deploy", owner, () => factory.getDeployTransaction(tokenAddress, 32));
  assert(r.contractAddress);
  const address = ethers.getAddress(r.contractAddress);
  assert.equal((await ethers.provider.getTransaction(r.hash))!.data, deployment.data, "Deployment provenance mismatch");
  const runtimeHash = ethers.keccak256(await ethers.provider.getCode(address));
  if (state.runtimeHash) assert.equal(runtimeHash, state.runtimeHash);
  state.pool = address; state.runtimeHash = runtimeHash; save();
  const pool: any = await ethers.getContractAt("ReusableMerkleProbe", address, owner);
  assert.equal(await pool.owner(), owner.address); assert.equal(await pool.token(), tokenAddress); assert.equal(await pool.depth(), 32n);
  // External verifier reverts are not included in the pool artifact's ABI.
  const kmsErrors = new ethers.Interface(["error KMSInvalidSigner(address invalidSigner)"]);
  async function contractError(action: () => Promise<any>, allowed: string[]) {
    try { await action(); }
    catch (e: any) {
      const parsed = typeof e.data === "string" ? pool.interface.parseError(e.data) ?? kmsErrors.parseError(e.data) : null;
      assert(parsed && allowed.includes(parsed.name), `Expected ${allowed.join("/")}, got ${parsed?.name ?? e.code}`);
      delete state.lastNegativeErrorShape;
      return parsed.name;
    }
    assert.fail(`Expected ${allowed.join("/")}`);
  }
  const sdkFor = (signer: any) => {
    const chain = { ...sepolia, network: process.env.SEPOLIA_RPC_URL! };
    const sdk = new ZamaSDK(createConfig({ chains: [chain], signer, storage: memoryStorage, relayers: { [chain.id]: node({ timeout: 120000 }) } }));
    sdks.push(sdk); return sdk;
  };
  const sdk = sdkFor(owner), aSdk = sdkFor(alice), bSdk = sdkFor(bob);
  async function own(s: ZamaSDK, contract: string, handle: string) {
    const value = await s.decryption.decryptValues([{ contractAddress: ethers.getAddress(contract) as `0x${string}`, encryptedValue: handle as `0x${string}` }]);
    return BigInt(value[handle as `0x${string}`] as any);
  }
  if (!state.initialBalances) {
    const initialBalances: string[] = [];
    for (const [i, signer] of [owner, alice, bob].entries()) {
      initialBalances.push(String(await own([sdk, aSdk, bSdk][i], tokenAddress, await token.confidentialBalanceOf(signer.address))));
    }
    state.initialBalances = initialBalances; save();
  }
  async function deposit(label: string, signer: any, s: ZamaSDK, amount: bigint, funding = false) {
    if (state.transactions[label]) return;
    const input = await s.encrypt({ contractAddress: tokenAddress as `0x${string}`, userAddress: signer.address as `0x${string}`, values: [{ type: "euint64", value: amount }] });
    await send(label, signer, () => token.connect(signer)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"].populateTransaction(
      address, input.encryptedValues[0], input.inputProof, ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint256"], [funding, 0])));
  }
  async function admit(label: string, signer: any, positive: boolean) {
    if (state.transactions[label]) return;
    const pending = await pool.pendingAdmissionOf(signer.address), start = performance.now();
    const proof = await sdk.decryption.decryptPublicValues([pending.marker]);
    assert.equal(proof.clearValues[pending.marker], positive);
    state.latencyMs[label] = Math.round(performance.now() - start); save();
    const rejected = await contractError(() => pool.finalizeAdmission.staticCall(signer.address, pending.nonce, !positive, proof.decryptionProof), ["KMSInvalidSigner", "InvalidKMSSignatures"]);
    state.checks[`${label}-alteredBooleanRejected`] = rejected; save();
    await send(label, owner, () => pool.finalizeAdmission.populateTransaction(signer.address, pending.nonce, positive, proof.decryptionProof));
  }
  await deposit("zero-deposit", alice, aSdk, 0n); await admit("zero-admission", alice, false);
  if (!state.transactions["positive-admission"]) assert.equal(await pool.nextIndex(), 0n);
  state.checks.zeroDidNotAllocateSlot = true;
  await deposit("alice-deposit", alice, aSdk, 3n); await admit("positive-admission", alice, true);
  await deposit("prize-funding", owner, sdk, 11n, true);
  await send("close", owner, () => pool.closeDraw.populateTransaction());
  await send("alice-exit", alice, () => pool.connect(alice).withdrawAllAndExit.populateTransaction());
  await deposit("bob-deposit", bob, bSdk, 7n); await admit("reused-admission", bob, true);
  assert.equal(await pool.nextIndex(), 1n); assert.equal(await pool.generationOf(0), 2n);
  assert.equal(await pool.indexPlusOne(alice.address), 0n);
  if (!state.transactions["bob-exit"]) assert.equal(await pool.indexPlusOne(bob.address), 1n);
  state.checks.slotReused = true;
  const archivePath = path.join(__dirname, "cache/sepolia-reusable.sqlite");
  const options = { path: archivePath, chainId: "11155111", pool: address, depth: 32, zero: await pool.zero(),
    emptyHashes: await Promise.all(Array.from({ length: 33 }, (_, l) => pool.emptyHash(l))) };
  let archive = new ProofArchive(options);
  try {
    const logs = await ethers.provider.getLogs({ address, fromBlock: state.transactions.deploy.block, toBlock: "latest" });
    const supported = new Set(["NodeUpdated", "SlotAssigned", "SlotReleased", "Closed"]);
    archive.ingest(logs.flatMap(log => {
      const p = pool.interface.parseLog(log); if (!p || !supported.has(p.name)) return [];
      return [{ blockNumber: log.blockNumber, blockHash: log.blockHash, logIndex: log.index, name: p.name,
        args: Object.fromEntries(p.fragment.inputs.map((v: any, i: number) => [v.name, p.args[i]])) }];
    }));
    archive.close(); archive = new ProofArchive(options);
    const draw = await pool.draws(1), p = archive.proof(1, alice.address, { rootHash: draw.rootHash, rootSum: draw.sum });
    assert.equal(p.index, 0n); assert.equal(p.generation, 1n);
    const args = [1, alice.address, p.index, p.generation, p.balance, p.siblingHashes, p.siblingSums, p.parentSums];
    await contractError(() => pool.claimMerkle.staticCall(1, bob.address, p.index, p.generation, p.balance, p.siblingHashes, p.siblingSums, p.parentSums), ["InvalidProof"]);
    state.checks.redirectRejected = true;
    await send("alice-old-check", owner, () => pool.claimMerkle.populateTransaction(...args));
    assert.equal(await pool.checked(1, bob.address), false);
    assert.equal(await own(aSdk, address, await pool.awardOf(1, alice.address)), 11n);
    state.checks.userOnlyOldClaimAfterReuseAndRestart = true;
    await contractError(() => pool.claimMerkle.staticCall(...args), ["AlreadyChecked"]); state.checks.duplicateRejected = true;
    let denied = false;
    try { await own(bSdk, address, await pool.awardOf(1, alice.address)); }
    catch (e: any) { if (e.code === "NOT_ENTITLED") denied = true; else throw e; }
    assert(denied); state.checks.otherAwardDecryptionDenied = true;
  } finally { archive.close(); }
  await send("bob-exit", bob, () => pool.connect(bob).withdrawAllAndExit.populateTransaction());
  // Also rerunnable after a prior lifecycle: pin the exact onchain signature
  // error instead of accepting an unrelated RPC failure as a negative result.
  await deposit("signature-probe-deposit", bob, bSdk, 0n);
  await admit("signature-probe-clear", bob, false);
  assert.equal(await pool.activeCount(), 0n); assert.equal(await pool.freeSlotCount(), 1n);
  for (const [i, signer] of [owner, alice, bob].entries()) {
    const current = await own([sdk, aSdk, bSdk][i], tokenAddress, await token.confidentialBalanceOf(signer.address));
    assert.equal(current, BigInt(state.initialBalances[i]) + (i === 0 ? -11n : i === 1 ? 11n : 0n));
  }
  state.checks.backingAndPrincipalRoundTrip = true;
  state.totalFeeWei = String(spent()); state.status = "passed"; save();
  console.log(JSON.stringify({ status: state.status, pool: state.pool, checks: state.checks, totalFeeWei: state.totalFeeWei }));
}
main().catch((e: any) => {
  state.status = "failed"; state.failure = { code: e.code ?? e.name, message: String(e.shortMessage ?? e.message).replace(/https?:\/\/[^\s)]+/g, "[endpoint]").slice(0, 500) }; save();
  console.error(JSON.stringify(state.failure)); process.exitCode = 1;
}).finally(() => { for (const sdk of sdks) sdk.terminate(); process.exit(Number(process.exitCode ?? 0)); });
