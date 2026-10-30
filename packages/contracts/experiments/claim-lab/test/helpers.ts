import fs from "node:fs";
import path from "node:path";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
const { poseidonContract, buildPoseidon } = require("../node_modules/circomlibjs");
const { groth16 } = require("../node_modules/snarkjs");
const lab = path.resolve(__dirname, "..");
export const metrics: Record<string, any> = {
  environment: { node: process.version, platform: `${process.platform}-${process.arch}`, fheExecution: "local Hardhat mock backend", snark: "real Groth16 proof and Solidity verification; fresh local test setup" },
};
export const saveResults = () => fs.writeFileSync(path.join(lab, "results.json"), JSON.stringify(metrics, null, 2) + "\n");
export const clear = (handle: string) => fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
export const limbs = (value: string | bigint) => [BigInt(value) & ((1n << 128n) - 1n), BigInt(value) >> 128n];
let common: any;
const proofCache = new Map<string, any>();

export async function fixture(mode: number, depth: number) {
  if (!fhevm.isMock) throw new Error("Local-only lab: do not run against a deployed network");
  const [admin, ...users] = await ethers.getSigners();
  if (!common) {
    const hashers: any = {};
    for (const n of [2, 3, 4, 6]) {
      hashers[n] = await new ethers.ContractFactory(poseidonContract.generateABI(n), poseidonContract.createCode(n), admin).deploy();
      await hashers[n].waitForDeployment();
    }
    const range = await (await ethers.getContractFactory("RangeClaimVerifier")).deploy();
    const membership = await (await ethers.getContractFactory("SnapshotMembershipVerifier")).deploy();
    const poseidon = await buildPoseidon();
    common = { hashers, range, membership, hash: (values: bigint[]) => poseidon.F.toObject(poseidon(values)) as bigint };
  }
  const usdc: any = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const token: any = await (await ethers.getContractFactory("ConfidentialUSDC")).deploy(await usdc.getAddress());
  const pool: any = await (await ethers.getContractFactory("ClaimLabPool")).deploy(await token.getAddress(), mode, depth,
    await common.hashers[2].getAddress(), await common.hashers[3].getAddress(), await common.hashers[4].getAddress(), await common.hashers[6].getAddress(),
    mode === 0 ? await common.range.getAddress() : await common.membership.getAddress());
  const f: any = { ...common, admin, users, usdc, token, pool, mode, depth, address: await pool.getAddress() };
  f.wrap = async (user: any) => {
    await usdc.faucet(user.address, 1_000_000n);
    await usdc.connect(user).approve(await token.getAddress(), 1_000_000n);
    await token.connect(user).wrap(user.address, 1_000_000n);
  };
  f.measure = async (tx: any) => {
    const receipt = await tx.wait();
    const hcu = await fhevm.computeTransactionHCU(receipt);
    return { gas: receipt.gasUsed.toString(), globalHCU: String(hcu.globalHCU), maxHCUDepth: String(hcu.maxHCUDepth), calldataBytes: (tx.data.length - 2) / 2 };
  };
  for (const user of [admin, ...users.slice(0, 3)]) await f.wrap(user);
  return f;
}

export async function deposit(f: any, user: any, amount: bigint, range?: bigint[], fund = false) {
  const input = await fhevm.createEncryptedInput(await f.token.getAddress(), user.address).add64(amount).encrypt();
  const commitment = range ? f.hash(range) : 0n;
  const data = ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint256"], [fund, commitment]);
  return f.token.connect(user)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](f.address, input.handles[0], input.inputProof, data);
}
export async function withdraw(f: any, user: any, amount: bigint) {
  const input = await fhevm.createEncryptedInput(f.address, user.address).add64(amount).encrypt();
  return f.pool.connect(user).withdraw(input.handles[0], input.inputProof);
}

type Node = { hash: string, sum: string };
export async function snapshot(f: any, drawId?: number, options: { pageSize?: number, logs?: any[], fromBlock?: number } = {}) {
  const nodes = new Map<string, Node>();
  const first = options.fromBlock ?? f.deploymentBlock ?? 0;
  const closed = drawId === undefined ? undefined : (await f.pool.queryFilter(f.pool.filters.Closed(drawId), first, "latest"))[0];
  if (drawId !== undefined && !closed) throw new Error("Draw has no canonical close event");
  if (closed && (await ethers.provider.getBlock(closed.blockNumber))?.hash !== closed.blockHash) throw new Error("Noncanonical close event");
  const end = closed?.blockNumber ?? Number(await ethers.provider.send("eth_blockNumber", []));
  const logs = options.logs ? [...options.logs] : [];
  if (!options.logs) {
    const size = options.pageSize ?? 512;
    if (!Number.isInteger(size) || size < 1) throw new Error("Invalid archive page size");
    for (let from = first; from <= end; from += size) logs.push(...await f.pool.queryFilter(f.pool.filters.NodeUpdated(), from, Math.min(end, from + size - 1)));
  }
  logs.sort((a: any, b: any) => a.blockNumber - b.blockNumber || a.index - b.index);
  const seen = new Set<string>();
  for (const log of logs) {
    if (log.removed) throw new Error("Noncanonical removed log");
    if (closed && (log.blockNumber > end || (log.blockNumber === end && log.index >= closed.index))) continue;
    const key = `${log.blockHash}:${log.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.set(`${log.args.level}:${log.args.index}`, { hash: log.args.hash, sum: log.args.sum });
  }
  const zeros: Node[] = [];
  const zero = await f.pool.zero();
  for (let l = 0; l <= f.depth; l++) zeros.push({ hash: await f.pool.emptyHash(l), sum: zero });
  const get = (l: number, i: bigint): Node => nodes.get(`${l}:${i}`) ?? zeros[l];
  const root = get(f.depth, 0n);
  const draw = drawId === undefined ? undefined : await f.pool.draws(drawId);
  if (closed && (root.hash !== closed.args.rootHash || root.sum !== closed.args.sum || root.hash !== draw.rootHash || root.sum !== draw.sum)) throw new Error("Incomplete or noncanonical archive root");
  return { root, get, logs, count: draw?.count ?? await f.pool.participantCount(),
    path: async (user: any) => {
      const index = (await f.pool.indexPlusOne(user.address)) - 1n;
      const siblings = [], parents = [];
      for (let l = 0; l < f.depth; l++) {
        siblings.push(get(l, (index >> BigInt(l)) ^ 1n));
        parents.push(get(l + 1, index >> BigInt(l + 1)));
      }
      const leaf = get(0, index);
      if (f.mode === 2) {
        const coder = ethers.AbiCoder.defaultAbiCoder();
        let hash = ethers.keccak256(coder.encode(["uint8", "address", "bytes32"], [0, user.address, leaf.sum]));
        let sum = leaf.sum;
        for (let l = 0; l < f.depth; l++) {
          const n = siblings[l];
          hash = ethers.keccak256(coder.encode(["uint8", "bytes32", "bytes32", "bytes32", "bytes32"], ((index >> BigInt(l)) & 1n) === 0n ? [1, hash, sum, n.hash, n.sum] : [1, n.hash, n.sum, hash, sum]));
          sum = parents[l].sum;
        }
        if (hash !== root.hash || sum !== root.sum) throw new Error("Incomplete or forged archive path");
      }
      return { index, leaf, siblings, parents };
    } };
}

export async function merkleClaim(f: any, snap: any, user: any, round: number, caller?: any, corrupt?: string) {
  const p = await snap.path(user);
  const siblingHashes = p.siblings.map((n: Node) => n.hash);
  const siblingSums = p.siblings.map((n: Node) => n.sum);
  const parentSums = p.parents.map((n: Node) => n.sum);
  let balance = p.leaf.sum, account = user.address, index = p.index;
  if (corrupt === "balance") balance = await f.pool.zero();
  if (corrupt === "siblingHash") siblingHashes[0] = ethers.ZeroHash;
  if (corrupt === "siblingSum") siblingSums[0] = await f.pool.zero();
  if (corrupt === "parentSum") parentSums[f.depth - 1] = await f.pool.zero();
  if (corrupt === "beneficiary") account = f.admin.address;
  if (corrupt === "index") index ^= 1n;
  return f.pool.connect(caller ?? user).claimMerkle(round, account, index, balance, siblingHashes, siblingSums, parentSums);
}

async function prove(name: string, input: any) {
  const key = name + JSON.stringify(input, (_, v) => typeof v === "bigint" ? v.toString() : v);
  if (proofCache.has(key)) return proofCache.get(key);
  const start = performance.now();
  const { proof, publicSignals } = await groth16.fullProve(input,
    path.join(lab, `zk/artifacts/${name}_js/${name}.wasm`), path.join(lab, `zk/artifacts/${name}.zkey`), undefined, undefined, { singleThread: true });
  const vkey = JSON.parse(fs.readFileSync(path.join(lab, `zk/artifacts/${name}.vkey.json`), "utf8"));
  const valid = await groth16.verify(vkey, publicSignals, proof, undefined, { singleThread: true });
  if (!valid) throw new Error("Actual Groth16 verification failed");
  const [a, b, c, signals] = JSON.parse(`[${await groth16.exportSolidityCallData(proof, publicSignals)}]`);
  const result = { a, b, c, signals };
  (metrics.proofs ??= []).push({ name, publicSignals: signals.length, proveAndVerifyMs: Math.round(performance.now() - start) });
  proofCache.set(key, result);
  return result;
}
export async function proveRange(f: any, snap: any, user: any, start: bigint, end: bigint, secret: bigint, ticket: bigint, total: bigint) {
  const p = await snap.path(user), [receiptLo, receiptHi] = limbs(p.leaf.sum);
  return prove("range-claim", { root: BigInt(snap.root.hash), scope: await f.pool.scope(1), account: BigInt(user.address), receiptLo, receiptHi, ticket, total, start, end, secret, index: p.index, siblings: p.siblings.map((n: Node) => BigInt(n.hash)) });
}
export async function proveMembership(f: any, snap: any, user: any, round: number, override: Record<string, any> = {}) {
  const p = await snap.path(user), [rootLo, rootHi] = limbs(snap.root.sum), [balanceLo, balanceHi] = limbs(p.leaf.sum);
  return prove("snapshot-membership", { rootHash: BigInt(snap.root.hash), rootLo, rootHi, scope: await f.pool.scope(round), account: BigInt(user.address), index: p.index, balanceLo, balanceHi,
    siblingLo: p.siblings.map((n: Node) => limbs(n.sum)[0]), siblingHi: p.siblings.map((n: Node) => limbs(n.sum)[1]), siblingHash: p.siblings.map((n: Node) => BigInt(n.hash)),
    parentLo: p.parents.map((n: Node) => limbs(n.sum)[0]), parentHi: p.parents.map((n: Node) => limbs(n.sum)[1]), ...override });
}
