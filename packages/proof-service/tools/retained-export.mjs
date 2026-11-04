#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [payloadPath, outputPath] = process.argv.slice(2);
if (!payloadPath || !outputPath)
  throw new Error("usage: retained-export.mjs payload.json export.json");
const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
if (!payload.namespace || !Array.isArray(payload.headers) || !Array.isArray(payload.logs))
  throw new Error("invalid retained payload");
const body = JSON.stringify(payload);
writeFileSync(
  outputPath,
  `${JSON.stringify({
    manifest: {
      version: 1,
      namespace: { chainId: payload.namespace.chainId, pool: payload.namespace.pool },
      sha256: createHash("sha256").update(body).digest("hex"),
      headers: payload.headers.length,
      logs: payload.logs.length,
      firstBlock: payload.headers[0]?.number ?? null,
      lastBlock: payload.headers.at(-1)?.number ?? null,
    },
    payload,
  })}\n`,
);
