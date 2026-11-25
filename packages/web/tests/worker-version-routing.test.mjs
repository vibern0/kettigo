import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.ts";

globalThis.HTMLRewriter = class {
  on(selector, handler) {
    this.selector = selector;
    this.handler = handler;
    return this;
  }

  transform(response) {
    const insertion = {
      value: "",
      prepend(value) {
        this.value = value;
      },
    };
    this.handler.element(insertion);
    return new Response(`<html><head>${insertion.value}</head><body>App</body></html>`, {
      status: response.status,
      headers: response.headers,
    });
  }
};

const env = {
  ASSETS: {
    async fetch(request) {
      if (new URL(request.url).pathname === "/_next/static/app.js") {
        return new Response("asset", {
          headers: { "cache-control": "public, max-age=31536000", etag: "asset-tag" },
        });
      }
      return new Response("<html><head><title>Kettigo</title></head><body>App</body></html>", {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": "text/html; charset=utf-8",
          "content-length": "67",
          etag: "html-tag",
          digest: "sha-256=old",
        },
      });
    },
  },
  DB: {
    prepare() {
      throw new Error("not used");
    },
  },
  GITHUB_WORKFLOW_AUTH: "test-token",
  NEXT_PUBLIC_RPC_URL: "https://rpc.example",
  NEXT_PUBLIC_USDC_ADDRESS: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
};

test("emits matching selected bootstrap bytes in HTML and config responses", async () => {
  const config = await worker.fetch(
    new Request("https://app.example/config.js?savings=legacy-9c"),
    env,
  );
  const html = await worker.fetch(
    new Request("https://app.example/savings?savings=legacy-9c"),
    env,
  );

  const script = await config.text();
  const body = await html.text();
  assert.ok(body.includes(`<script>${script}</script>`));
  assert.equal(config.headers.get("cache-control"), "no-store");
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.equal(html.headers.get("content-length"), null);
  assert.equal(html.headers.get("etag"), null);
  assert.equal(html.headers.get("digest"), null);
});

test("uses E65 for a bare config request without replacing a selected response", async () => {
  const response = await worker.fetch(new Request("https://app.example/config.js"), env);

  assert.match(await response.text(), /"id":"legacy-e65"/);
});

test("fails closed before serving bootstrap for invalid selectors and preserves static headers", async () => {
  let assetFetches = 0;
  const rejectEnv = {
    ...env,
    ASSETS: {
      async fetch() {
        assetFetches += 1;
        return new Response("unexpected", { headers: { "content-type": "text/html" } });
      },
    },
  };
  const rejected = await worker.fetch(
    new Request("https://app.example/savings?savings=legacy-e65&savings=legacy-9c"),
    rejectEnv,
  );
  const asset = await worker.fetch(new Request("https://app.example/_next/static/app.js"), env);

  assert.equal(rejected.status, 400);
  assert.doesNotMatch(await rejected.text(), /__KETTIGO_CONFIG__/);
  assert.equal(assetFetches, 0);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000");
  assert.equal(asset.headers.get("etag"), "asset-tag");
});

test("does not allow a conditional HTML asset response to reuse an earlier bootstrap", async () => {
  let htmlRequest;
  const conditionalEnv = {
    ...env,
    ASSETS: {
      async fetch(request) {
        htmlRequest = request;
        return new Response("<html><head></head><body>App</body></html>", {
          headers: { "content-type": "text/html", etag: "fresh-html" },
        });
      },
    },
  };

  const response = await worker.fetch(
    new Request("https://app.example/savings?savings=legacy-9c", {
      headers: { "if-none-match": "old-html", "if-modified-since": "yesterday" },
    }),
    conditionalEnv,
  );

  assert.equal(htmlRequest.headers.get("if-none-match"), null);
  assert.equal(htmlRequest.headers.get("if-modified-since"), null);
  assert.match(await response.text(), /"id":"legacy-9c"/);
});
