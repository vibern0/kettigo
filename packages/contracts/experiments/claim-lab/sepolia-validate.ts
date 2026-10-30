import { ethers, artifacts } from "hardhat";
import { ZamaSDK, memoryStorage } from "@zama-fhe/sdk";
import { sepolia } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/ethers";
import { node } from "@zama-fhe/sdk/node";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { snapshot, merkleClaim } from "./test/helpers";

// Resume only this isolated research deployment. Never attach production env
// token/pool addresses. The only supported chain is Ethereum Sepolia.
const output = path.join(__dirname, "sepolia-results.json");
let state: any = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : { status: "starting", network: "Sepolia", transactions: {}, latency: {}, checks: {} };
const save = () => fs.writeFileSync(output, JSON.stringify(state, null, 2) + "\n");
const sdks: ZamaSDK[] = [];
const budget = ethers.parseEther("0.0047"); // includes the recorded initial fee-floor incident
async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  assert.equal(chainId, 11155111n, "Sepolia only");
  assert(process.env.PRIVATE_KEY, "Configure the existing signer");
  const owner = new ethers.Wallet(process.env.PRIVATE_KEY, ethers.provider);
  if (state.failure) { (state.incidents ??= []).push(state.failure); delete state.failure; }
  state.status = "running";
  if (state.owner) assert.equal(state.owner, owner.address, "Resume signer differs");
  state.owner = owner.address; state.chainId = String(chainId);
  const executor = new ethers.Contract("0x92C920834Ec8941d2C77D188936E1f7A6f49c127", ["function getVersion() view returns(string)", "function getHCULimitAddress() view returns(address)"], ethers.provider);
  const hcuAddress = ethers.getAddress(await executor.getHCULimitAddress());
  const hcu = new ethers.Contract(hcuAddress, ["function getVersion() view returns(string)", "function getMaxHCUPerTx() view returns(uint256)", "function getMaxHCUDepthPerTx() view returns(uint256)", "function getGlobalHCUCapPerBlock() view returns(uint256)"], ethers.provider);
  const latest = await ethers.provider.getBlock("latest");
  const gasPrice = BigInt(process.env.RESEARCH_GAS_PRICE_WEI ?? "100000");
  assert(gasPrice > latest!.baseFeePerGas!, "Research gas price is below the current base fee");
  state.feePolicy = { explicitGasPriceWei: String(gasPrice), totalFeeBudgetWei: String(budget), initialFeeFloorIncidentWei: "3699856000000000" };
  state.liveNetwork = { block: latest!.number, blockGasLimit: String(latest!.gasLimit), executor: await executor.getAddress(), executorVersion: await executor.getVersion(), hcu: hcuAddress, hcuVersion: await hcu.getVersion(), transactionHcuLimit: String(await hcu.getMaxHCUPerTx()), transactionDepthLimit: String(await hcu.getMaxHCUDepthPerTx()), blockHcuLimit: String(await hcu.getGlobalHCUCapPerBlock()) }; save();

  const spent = () => Object.values(state.transactions).reduce((n: bigint, t: any) => n + BigInt(t.costWei ?? 0), 0n);
  async function reconcile(label: string) {
    const item = state.transactions[label];
    const tx = await ethers.provider.getTransaction(item.hash);
    assert(tx, `Saved ${label} transaction is missing; reconcile before resuming`);
    const receipt = await tx.wait(1, 180_000); assert(receipt); assert.equal(receipt.status, 1);
    state.transactions[label] = { ...item, block: receipt.blockNumber, gasUsed: String(receipt.gasUsed), gasPrice: String(receipt.gasPrice), costWei: String(receipt.fee), status: "confirmed" }; save();
    return receipt;
  }
  for (const label of Object.keys(state.transactions)) await reconcile(label);
  assert(spent() < budget, "Previously spent fees exceed total research budget");
  async function confirmed(label: string, signer: any, prepare: () => Promise<any>) {
    if (state.transactions[label]) return reconcile(label);
    const request = await prepare();
    const estimate = await signer.estimateGas(request), gasLimit = (estimate * 12n + 9n) / 10n;
    assert(spent() + gasLimit * gasPrice <= budget, "Next transaction exceeds remaining fee budget");
    assert(await ethers.provider.getBalance(signer.address) >= gasLimit * gasPrice + BigInt(request.value ?? 0), "Signer needs more gas funding");
    // Explicit fresh pending nonce avoids provider cache and the shared signer's
    // Hardhat fee floor. Save the signed hash before broadcasting, never keys.
    const nonce = Number(BigInt(await ethers.provider.send("eth_getTransactionCount", [signer.address, "pending"])));
    const raw = await signer.signTransaction({ ...request, gasPrice, gasLimit, nonce, chainId, type: 0 });
    const hash = ethers.keccak256(raw), start = performance.now();
    state.transactions[label] = { hash, nonce, sender: signer.address, quotedMaxFeeWei: String(gasLimit * gasPrice), status: "pending" }; save();
    await ethers.provider.broadcastTransaction(raw);
    const receipt = await reconcile(label);
    assert(receipt.gasPrice <= gasPrice, "Unexpected transaction fee override");
    state.transactions[label].elapsedMs = Math.round(performance.now() - start); save();
    console.log(JSON.stringify({ step: label, ...state.transactions[label] })); return receipt;
  }
  async function deploy(label: string, name: string, args: any[]) {
    const factory = await ethers.getContractFactory(name, owner);
    const request = await factory.getDeployTransaction(...args);
    const receipt = await confirmed(`deploy-${label}`, owner, () => factory.getDeployTransaction(...args));
    const address = receipt.contractAddress;
    assert(address); (state.contracts ??= {})[label] = ethers.getAddress(address);
    const tx = await ethers.provider.getTransaction(receipt.hash);
    assert.equal(tx!.data, request.data, "Deployment input differs from compiled artifact/constructor");
    assert.equal(tx!.from, owner.address);
    const code = await ethers.provider.getCode(address); assert.notEqual(code, "0x");
    const hash = ethers.keccak256(code);
    if (state.runtimeCodeHashes?.[label]) assert.equal(hash, state.runtimeCodeHashes[label], "Deployed runtime changed");
    (state.runtimeCodeHashes ??= {})[label] = hash; save(); return ethers.getContractAt(name, address, owner);
  }
  const usdc: any = await deploy("usdc", "MockUSDC", []);
  const token: any = await deploy("token", "ConfidentialUSDC", [await usdc.getAddress()]);
  const pool: any = await deploy("pool", "SepoliaMerkleProbe", [await token.getAddress(), 32]);
  const address = ethers.getAddress(await pool.getAddress()), tokenAddress = ethers.getAddress(await token.getAddress());
  const artifact = await artifacts.readArtifact("SepoliaMerkleProbe"); state.compiledRuntimeTemplateHash = ethers.keccak256(artifact.deployedBytecode); delete state.candidateBytecodeHash; save();
  assert.equal(await pool.owner(), owner.address); assert.equal(await pool.token(), tokenAddress); assert.equal(await pool.depth(), 32n); assert.equal(await token.underlying(), await usdc.getAddress());
  const walletFile = path.join(__dirname, "cache/sepolia-research-wallets.json"); fs.mkdirSync(path.dirname(walletFile), { recursive: true });
  if (!fs.existsSync(walletFile)) {
    const keys = [ethers.Wallet.createRandom().privateKey, ethers.Wallet.createRandom().privateKey];
    fs.writeFileSync(walletFile, JSON.stringify(keys), { mode: 0o600 });
  }
  const wallets = JSON.parse(fs.readFileSync(walletFile, "utf8")).map((key: string) => new ethers.Wallet(key, ethers.provider));
  state.participants = wallets.map((w: any) => w.address); save();
  const sdkFor = (signer: any) => {
    const chain = { ...sepolia, network: process.env.SEPOLIA_RPC_URL! };
    const sdk = new ZamaSDK(createConfig({ chains: [chain], signer, storage: memoryStorage, relayers: { [chain.id]: node({ timeout: 120_000 }) } }));
    sdks.push(sdk); return sdk;
  };
  const ownerSdk = sdkFor(owner), walletSdks = wallets.map(sdkFor);
  const encrypt = async (sdk: ZamaSDK, contractAddress: string, account: string, amount: bigint, label: string) => {
    const start = performance.now();
    const input = await sdk.encrypt({ contractAddress: ethers.getAddress(contractAddress) as `0x${string}`, userAddress: ethers.getAddress(account) as `0x${string}`, values: [{ type: "euint64", value: amount }] });
    state.latency[label] = Math.round(performance.now() - start); save();
    return { handle: input.encryptedValues[0], proof: input.inputProof };
  };
  const decrypt = async (sdk: ZamaSDK, pairs: { encryptedValue: `0x${string}`, contractAddress: `0x${string}` }[], label: string) => {
    const start = performance.now(); const result = await sdk.decryption.decryptValues(pairs);
    state.latency[label] = Math.round(performance.now() - start); save(); return result;
  };
  const wrapped = 1_000_000n;
  for (const [i, signer] of [owner, ...wallets].entries()) {
    if (i > 0) await confirmed(`gas-${i}`, owner, async () => ({ to: signer.address, value: ethers.parseEther("0.00001") }));
    await confirmed(`mint-${i}`, owner, () => usdc.faucet.populateTransaction(signer.address, wrapped));
    await confirmed(`approve-${i}`, signer, () => usdc.connect(signer).approve.populateTransaction(tokenAddress, wrapped));
    await confirmed(`wrap-${i}`, signer, () => token.connect(signer).wrap.populateTransaction(signer.address, wrapped));
    const label = `deposit-${i}`;
    if (!state.transactions[label]) {
      const amount = i === 0 ? 11n : i === 1 ? 3n : 7n;
      const sdk = i === 0 ? ownerSdk : walletSdks[i - 1];
      const input = await encrypt(sdk, tokenAddress, signer.address, amount, `encrypt-${label}`);
      await confirmed(label, signer, () => token.connect(signer)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"].populateTransaction(address, input.handle, input.proof, ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint256"], [i === 0, 0])));
    }
  }
  assert.equal(await pool.participantCount(), 2n);
  const principalHandles = await Promise.all(wallets.map((w: any) => pool.principalOf(w.address)));
  state.snapshotPrincipalHandles ??= principalHandles; save();
  for (let i = 0; i < 2; i++) {
    const values = await decrypt(walletSdks[i], [{ encryptedValue: principalHandles[i], contractAddress: address as `0x${string}` }], `own-principal-${i}`);
    const expected = i === 0 && state.transactions["batch-two-deposits"] && !state.transactions["batch-withdraw"] ? 2n : state.transactions[`withdraw-${i}`] ? 0n : i === 0 ? 3n : 7n;
    assert.equal(BigInt(values[principalHandles[i]] as any), expected);
  }
  await confirmed("close", owner, () => pool.closeDraw.populateTransaction());
  // Mutate after the frozen draw; recover historical eligibility from logs later.
  if (!state.transactions["withdraw-0"]) {
    const input = await encrypt(walletSdks[0], address, wallets[0].address, 3n, "encrypt-withdraw-0");
    await confirmed("withdraw-0", wallets[0], () => pool.connect(wallets[0]).withdraw.populateTransaction(input.handle, input.proof));
  }
  const f: any = { pool, token, address, depth: 32, mode: 2, admin: owner, deploymentBlock: state.transactions["deploy-pool"].block };
  const archived = await snapshot(f, 1, { pageSize: 1000 });
  state.archive = { nodeEventsReplayed: archived.logs.length, draw: 1, rootHash: archived.root.hash, rootSum: archived.root.sum }; save();
  async function exactError(action: () => Promise<any>, name: string) {
    try { await action(); assert.fail(`Expected ${name}`); }
    catch (e: any) { const parsed = e.data ? pool.interface.parseError(e.data) : null; assert.equal(parsed?.name, name, `Expected exact ${name} error`); }
  }
  const p = await archived.path(wallets[1]);
  await exactError(() => pool.claimMerkle.staticCall(1, wallets[0].address, p.index, p.leaf.sum, p.siblings.map((n: any) => n.hash), p.siblings.map((n: any) => n.sum), p.parents.map((n: any) => n.sum)), "NotEligible");
  state.checks.redirectRejected = true;
  for (let i = 0; i < 2; i++) {
    const path = await archived.path(wallets[i]);
    await confirmed(`claim-${i}`, owner, () => pool.claimMerkle.populateTransaction(1, wallets[i].address, path.index, path.leaf.sum, path.siblings.map((n: any) => n.hash), path.siblings.map((n: any) => n.sum), path.parents.map((n: any) => n.sum)));
  }
  const awards = [];
  for (let i = 0; i < 2; i++) {
    const handle = await pool.awardOf(1, wallets[i].address);
    const values = await decrypt(walletSdks[i], [{ encryptedValue: handle, contractAddress: address as `0x${string}` }], `own-award-${i}`);
    awards.push(BigInt(values[handle] as any));
  }
  assert.equal(awards[0] + awards[1], 11n);
  state.checks.exactlyOneAward = true; state.researchAmounts = { deposits: ["3", "7"], prize: "11", awards: awards.map(String) }; save();
  const draw = await pool.draws(1);
  for (const [label, handle] of [["other-principal", state.snapshotPrincipalHandles[1]], ["ticket", draw.ticket], ["root-sum", draw.sum]]) {
    let denied = false;
    try { await decrypt(walletSdks[0], [{ encryptedValue: handle as `0x${string}`, contractAddress: address as `0x${string}` }], `forbidden-${label}`); }
    catch (e: any) { if (e.code === "NOT_ENTITLED") denied = true; else throw e; }
    assert(denied, `Unauthorized ${label} decryption unexpectedly succeeded`); state.checks[`denied-${label}`] = true; save();
  }
  await exactError(() => pool.claimMerkle.staticCall(1, wallets[1].address, p.index, p.leaf.sum, p.siblings.map((n: any) => n.hash), p.siblings.map((n: any) => n.sum), p.parents.map((n: any) => n.sum)), "AlreadyChecked");
  state.checks.duplicateRejected = true;
  if (!state.transactions["withdraw-1"]) {
    const input = await encrypt(walletSdks[1], address, wallets[1].address, 7n, "encrypt-withdraw-1");
    await confirmed("withdraw-1", wallets[1], () => pool.connect(wallets[1]).withdraw.populateTransaction(input.handle, input.proof));
  }
  // Test the host transaction ceiling independently of participant count.
  if (!state.transactions["batch-two-deposits"]) {
    const input = await encrypt(walletSdks[0], tokenAddress, wallets[0].address, 1n, "encrypt-batch-limit");
    const call = token.interface.encodeFunctionData("confidentialTransferAndCall(address,bytes32,bytes,bytes)", [address, input.handle, input.proof, ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint256"], [false, 0])]);
    await token.connect(wallets[0]).multicall.staticCall([call, call]);
    let rejected = false;
    try { await token.connect(wallets[0]).multicall.staticCall([call, call, call]); }
    catch (e: any) {
      const errors = new ethers.Interface(["error HCUTransactionLimitExceeded()", "error HCUTransactionDepthLimitExceeded()"]);
      const decoded = e.data ? errors.parseError(e.data) : null;
      assert.equal(decoded?.name, "HCUTransactionLimitExceeded", "Expected exact transaction HCU limit");
      rejected = true; state.checks.threeDepositBatchRejectedByHcu = true;
    }
    assert(rejected, "Three deposits unexpectedly fit the transaction budget"); save();
    await confirmed("batch-two-deposits", wallets[0], () => token.connect(wallets[0]).multicall.populateTransaction([call, call]));
  }
  if (!state.transactions["batch-withdraw"]) {
    const h = await pool.principalOf(wallets[0].address);
    const values = await decrypt(walletSdks[0], [{ encryptedValue: h, contractAddress: address as `0x${string}` }], "batch-principal");
    assert.equal(BigInt(values[h] as any), 2n);
    const input = await encrypt(walletSdks[0], address, wallets[0].address, 2n, "encrypt-batch-withdraw");
    await confirmed("batch-withdraw", wallets[0], () => pool.connect(wallets[0]).withdraw.populateTransaction(input.handle, input.proof));
    state.checks.twoDepositBatchAndWithdrawal = true; save();
  }
  const zeroHandle = await pool.total();
  // Pool aggregate remains unavailable; verify backing through both users' own
  // token balances and principal. Do not grant the operator global decryption.
  for (let i = 0; i < 2; i++) {
    const balance = await token.confidentialBalanceOf(wallets[i].address), principal = await pool.principalOf(wallets[i].address);
    const values = await decrypt(walletSdks[i], [{ encryptedValue: balance, contractAddress: tokenAddress as `0x${string}` }, { encryptedValue: principal, contractAddress: address as `0x${string}` }], `final-wallet-${i}`);
    assert.equal(BigInt(values[principal] as any), 0n); assert.equal(BigInt(values[balance] as any), wrapped + awards[i]);
  }
  const funderBalance = await token.confidentialBalanceOf(owner.address);
  const funderValues = await decrypt(ownerSdk, [{ encryptedValue: funderBalance, contractAddress: tokenAddress as `0x${string}` }], "final-funder");
  assert.equal(BigInt(funderValues[funderBalance] as any), wrapped - 11n);
  assert.equal(await usdc.balanceOf(tokenAddress), wrapped * 3n);
  state.checks.backingConserved = true;
  state.checks.principalRoundTrip = true; state.checks.poolTotalHandleAfterWithdrawal = zeroHandle;
  state.status = "passed"; save(); console.log(JSON.stringify({ status: state.status, contracts: state.contracts, checks: state.checks }));
}
main().catch((e: any) => {
  state.status = "failed"; state.failure = { code: e.code ?? e.name, message: String(e.shortMessage ?? e.message).replace(/https?:\/\/[^\s)]+/g, "[endpoint]").slice(0, 500) }; save(); console.error(JSON.stringify(state.failure)); process.exitCode = 1;
}).finally(() => { for (const sdk of sdks) sdk.terminate(); process.exit(Number(process.exitCode ?? 0)); });
