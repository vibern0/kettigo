import assert from "node:assert/strict";
import test from "node:test";

import { resolveKeeperRpcUrls } from "../src/lib/keeper-rpc.ts";

test("keeper RPCs can split reads from transaction submission", () => {
  assert.deepEqual(
    resolveKeeperRpcUrls("https://read.example", "https://write.example"),
    {
      readRpcUrl: "https://read.example",
      writeRpcUrl: "https://write.example",
    },
  );
});

test("keeper RPCs use the read endpoint for writes by default", () => {
  assert.deepEqual(resolveKeeperRpcUrls("https://rpc.example"), {
    readRpcUrl: "https://rpc.example",
    writeRpcUrl: "https://rpc.example",
  });
  assert.deepEqual(resolveKeeperRpcUrls("https://rpc.example", ""), {
    readRpcUrl: "https://rpc.example",
    writeRpcUrl: "https://rpc.example",
  });
});
