import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { D1Archive } from "../../../proof-service/src/archive.ts";
import { SqliteD1 } from "../../../proof-service/tools/retained-support.mts";
import { createRpc } from "../../../proof-service/src/rpc.ts";
import { handle } from "../../../proof-service/src/server.ts";
import {
  initializeArchiveForTick,
  drainScheduledSlices,
} from "../../../proof-service/src/worker.ts";

export async function openLocalProofArchive(pool, provider) {
  const depth = Number(await pool.membershipTreeDepth());
  const ns = {
    chainId: BigInt(await provider.request({ method: "eth_chainId", params: [] })).toString(),
    pool: pool.target,
    depth,
    zero: await pool.membershipZero(),
    emptyHashes: await Promise.all(
      Array.from({ length: depth + 1 }, (_, level) => pool.emptyHash(level)),
    ),
    deploymentBlock: (await pool.deploymentTransaction().wait()).blockNumber,
  };
  const sqlite = new DatabaseSync(":memory:");
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks));
    let reply;
    try {
      assert.match(method, /^eth_(call|get[A-Z]|blockNumber|chainId)/);
      const result = await provider.request({ method, params });
      reply = { result };
    } catch (error) {
      // Hardhat reports its missing bulk-receipts method with -32004.
      // Expose standard "method not found" to exercise the real per-receipt fallback.
      const code = method === "eth_getBlockReceipts" && error.code === -32004 ? -32601 : error.code;
      reply = { error: { code: code ?? -32000, message: error.message } };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
  });
  try {
    const migrations = new URL("../../../proof-service/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
      sqlite.exec(await readFile(new URL(name, migrations), "utf8"));
    }
    const db = new SqliteD1(sqlite);
    const archive = new D1Archive(db);
    await new Promise((resolve, reject) =>
      server.once("error", reject).listen(0, "127.0.0.1", resolve),
    );
    const localRpc = `http://127.0.0.1:${server.address().port}`;
    const rpc = createRpc(localRpc, localRpc, ns, 0);
    const env = {
      PROOF_DB: { withSession: () => db },
      CHAIN_ID: ns.chainId,
      POOL_ADDRESS: ns.pool,
      TREE_DEPTH: String(ns.depth),
      ZERO_HANDLE: ns.zero,
      EMPTY_HASHES_JSON: JSON.stringify(ns.emptyHashes),
      DEPLOYMENT_BLOCK: String(ns.deploymentBlock),
      PRIMARY_RPC_URL: localRpc,
      HISTORICAL_RPC_URL: localRpc,
      CONFIRMATIONS: "0",
    };
    return {
      async indexThrough(blockNumber) {
        await rpc.withSource(async (source) => {
          await initializeArchiveForTick(archive, ns, source);
          let state = await archive.status(ns);
          while (state.nextBlock <= blockNumber) {
            const previous = state.nextBlock;
            state = await drainScheduledSlices(archive, ns, source, 2);
            assert.ok(
              state.nextBlock > previous,
              state.disabledReason ?? "Archive did not advance",
            );
          }
        });
      },
      fetch: (url) => handle(new Request(url), env),
      close() {
        server.closeAllConnections();
        server.close();
        sqlite.close();
      },
    };
  } catch (error) {
    server.close();
    sqlite.close();
    throw error;
  }
}
