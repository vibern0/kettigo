import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { deploymentChain } from "./local-chain.mjs";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import loadTailwindConfig from "tailwindcss/loadConfig.js";
import { readFile } from "node:fs/promises";

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const serviceOrigin = "https://local-saver.invalid";

export async function openSaverPage(passkey, { config, rpc, bindings, archive }) {
  const chainId = Number(BigInt(await rpc({ method: "eth_chainId", params: [] })));
  assert.equal(chainId, deploymentChain.id, "The saver browser requires the local Hardhat chain");
  const bundle = await build({
    root: file("../../.."),
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    css: {
      postcss: {
        plugins: [
          tailwindcss({
            ...loadTailwindConfig(file("../../../tailwind.config.ts")),
            content: [file("../../../src/**/*.{ts,tsx}")],
          }),
        ],
      },
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    resolve: {
      alias: [
        { find: /^.*\/deployment-chain\.ts$/, replacement: file("./local-chain.mjs") },
        { find: "@/lib/zama", replacement: file("./zama.mjs") },
        { find: "@/lib/wallet-context", replacement: file("./wallet.jsx") },
        { find: "@", replacement: file("../../../src") },
      ],
    },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: file("./app.jsx"),
        name: "SaverTest",
        formats: ["iife"],
        fileName: () => "app.js",
      },
    },
  });
  const script = bundle[0].output.find((item) => item.isEntry).code;
  const stylesheet = bundle[0].output.find((item) => item.fileName.endsWith(".css")).source;
  const logo = await readFile(file("../../../public/kettigo-mark-header.svg"));
  const { page, origin } = passkey;
  const pageErrors = [];
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
    console.error("Savings UI error:", err.stack);
  });
  await page.addInitScript(
    (config) => {
      window.saverConfig = config;
      window.__KETTIGO_CONFIG__ = { selectedPoolScope: config };
      window.process = { env: { NODE_ENV: "production" } };
    },
    {
      ...config,
      id: "candidate-v2",
      onboardingEnabled: true,
      mode: "v2",
      chainId,
      rpcUrl: serviceOrigin + "/rpc",
      proofServiceUrl: serviceOrigin + "/",
      proofNamespace: "local",
    },
  );
  for (const [name, fn] of Object.entries(bindings)) await page.exposeFunction(name, fn);
  // This document, its RPC and its proof archive are entirely local interception.
  // No page request may reach a host or a real transaction endpoint.
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (![origin, serviceOrigin].includes(url.origin)) {
      pageErrors.push(`Unexpected browser request to ${url.origin}`);
      return route.abort();
    }
    if (url.origin === origin && url.pathname === "/passkey.js") return route.continue();
    if (url.pathname === "/app.css")
      return route.fulfill({ contentType: "text/css", body: stylesheet });
    if (url.pathname === "/kettigo-mark-header.svg")
      return route.fulfill({ contentType: "image/svg+xml", body: logo });
    if (url.pathname === "/app.js")
      return route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script });
    if (url.pathname === "/rpc") {
      const { id, method, params } = req.postDataJSON();
      try {
        if (!/^eth_(call|get[A-Z]|blockNumber|chainId)/.test(method))
          throw new Error("Read-only RPC");
        const result = await rpc({ method, params });
        return route.fulfill({ json: { jsonrpc: "2.0", id, result } });
      } catch (error) {
        return route.fulfill({
          json: { jsonrpc: "2.0", id, error: { code: -32000, message: error.message } },
        });
      }
    }
    if (url.origin === serviceOrigin && url.pathname.startsWith("/v1/")) {
      const response = await archive(url.href);
      return route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: await response.text(),
      });
    }
    if (!["/savings", "/draw"].includes(url.pathname)) return route.abort();
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>',
    });
  });
  return { page, origin, pageErrors };
}
