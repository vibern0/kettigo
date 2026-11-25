import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, getAddress, http, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { confidentialPrizePoolAbi as abi } from "@kettigo/protocol";
import manifest from "../../../docs/releases/merkle-fhe-v2-candidate-manifest.json" with { type: "json" };
import { decryptPublicHandles } from "../src/lib/zama-node.ts";
import { resolveKeeperRpcUrls } from "../src/lib/keeper-rpc.ts";

const HISTORY_PAGE = 2_000n;
const HISTORY_PAGES_PER_PASS = 64n;
const RECENT_BLOCKS = 128n;
const ACCOUNTS_PER_PASS = 12;

export function admissionStartBlock(pool, override) {
  if (override !== undefined && override !== "") {
    if (!/^\d+$/.test(override)) throw new Error("Invalid ADMISSION_KEEPER_START_BLOCK");
    return BigInt(override);
  }
  const candidate = manifest.contracts.confidentialPrizePool;
  return getAddress(pool) === getAddress(candidate.address) ? BigInt(candidate.deploymentBlock) : undefined;
}

async function finalizeIfPending({ readPending, decrypt, finalize }, beneficiary) {
  const pending = await readPending(beneficiary);
  if (!pending.requested) return;
  const { clearValues, decryptionProof } = await decrypt([pending.marker]);
  const positive = clearValues[pending.marker];
  if (typeof positive !== "boolean" || !isHex(decryptionProof) || decryptionProof === "0x") {
    throw new Error("Invalid admission proof response");
  }
  const latest = await readPending(beneficiary);
  if (!latest.requested) return;
  if (latest.nonce !== pending.nonce || latest.marker !== pending.marker) {
    throw new Error("Admission changed during proof generation");
  }
  return finalize(beneficiary, pending.nonce, positive, decryptionProof);
}

export async function runAdmissionPass({ startBlock, state, latest, finalized, discover, ...operations }) {
  const accounts = new Set(state.accounts.map(address => getAddress(address)));
  const recentStart = latest - RECENT_BLOCKS + 1n;
  async function collect(from, to) {
    if (from > to) return;
    for (const address of await discover(from, to)) accounts.add(getAddress(address));
  }
  await collect(recentStart > startBlock ? recentStart : startBlock, latest);
  let next = BigInt(state.next);
  const passEnd = next + HISTORY_PAGE * HISTORY_PAGES_PER_PASS - 1n;
  const end = passEnd < finalized ? passEnd : finalized;
  if (next <= end) {
    // Older history progresses from deployment, with the newest accounts in each pass first.
    for (let to = end; to >= next; to -= HISTORY_PAGE) {
      const from = to - HISTORY_PAGE + 1n;
      await collect(from > next ? from : next, to);
    }
    next = end + 1n;
  }

  const transactions = [];
  const retrying = [];
  for (const address of [...accounts].slice(0, ACCOUNTS_PER_PASS)) {
    accounts.delete(address);
    try {
      const hash = await finalizeIfPending(operations, address);
      if (hash) transactions.push(hash);
    } catch (error) {
      accounts.add(address);
      retrying.push({ address, reason: error instanceof Error ? error.name : "Error" });
    }
  }
  return { state: { next: String(next), accounts: [...accounts] }, transactions, retrying };
}

export default async function run() {
  const env = process.env;
  const pool = getAddress(env.CONFIDENTIAL_PRIZE_POOL_ADDRESS || env.NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS);
  const startBlock = admissionStartBlock(pool, env.ADMISSION_KEEPER_START_BLOCK);
  if (startBlock === undefined) {
    console.log(JSON.stringify({ admission: "disabled", pool }));
    return;
  }
  const { readRpcUrl, writeRpcUrl } = resolveKeeperRpcUrls(env.SEPOLIA_RPC_URL || env.NEXT_PUBLIC_RPC_URL, env.SEPOLIA_WRITE_RPC_URL);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(readRpcUrl) });
  const key = env.KEEPER_PRIVATE_KEY;
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  const wallet = createWalletClient({ chain: sepolia, transport: http(writeRpcUrl), account });
  const cache = new URL("../../keeper/cache/", import.meta.url);
  const file = new URL(`admission-${sepolia.id}-${pool}-${startBlock}.json`, cache);
  await mkdir(cache, { recursive: true });
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = { next: String(startBlock), accounts: [] };
  }
  const [latest, finalized] = await Promise.all([publicClient.getBlockNumber(), publicClient.getBlock({ blockTag: "finalized" })]);
  const result = await runAdmissionPass({
    startBlock, state, latest, finalized: finalized.number,
    async discover(fromBlock, toBlock) {
      const logs = await publicClient.getContractEvents({ address: pool, abi, eventName: "AdmissionRequested", fromBlock, toBlock, strict: true });
      return logs.map(log => log.args.account);
    },
    readPending: beneficiary => publicClient.readContract({ address: pool, abi, functionName: "pendingAdmissionOf", args: [beneficiary] }),
    decrypt: handles => decryptPublicHandles(handles, readRpcUrl),
    async finalize(beneficiary, nonce, positive, proof) {
      const hash = await wallet.writeContract({ address: pool, abi, functionName: "finalizeAdmission", args: [beneficiary, nonce, positive, proof] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Admission transaction reverted");
      return hash;
    },
  });
  const temp = new URL(`${file.href}.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(result.state));
  await rename(temp, file);
  console.log(JSON.stringify({ admission: "processed", pool, transactions: result.transactions, retrying: result.retrying, queued: result.state.accounts.length }));
  if (result.retrying.length) throw new Error("Pending admissions will retry on the next pass");
}
