import assert from "node:assert/strict";
import test from "node:test";

import {
  scopeHref,
  isAlternateSavingsOrigin,
  switchDocumentScope,
} from "../src/lib/scope-navigation.ts";

test("scopeHref preserves unrelated query values and hash while replacing only savings", () => {
  assert.equal(
    scopeHref("/draw?filter=recent&savings=legacy-e65&tab=history#round-2", "candidate-v2"),
    "/draw?filter=recent&savings=candidate-v2&tab=history#round-2",
  );
});

test("the earlier-savings link is limited to a noncanonical browser origin", () => {
  assert.equal(isAlternateSavingsOrigin("https://candidate.workers.dev"), true);
  assert.equal(isAlternateSavingsOrigin("https://kettigo.xyz"), false);
});

test("scopeHref keeps the selected legacy namespace through normal links", () => {
  assert.equal(
    scopeHref("/savings?tab=withdraw", "legacy-9c"),
    "/savings?tab=withdraw&savings=legacy-9c",
  );
});

test("scopeHref carries unrelated current query values to a normal page link", () => {
  assert.equal(
    scopeHref("/draw", "legacy-9c", "https://kettigo.example/savings?tab=withdraw&filter=recent"),
    "/draw?tab=withdraw&filter=recent&savings=legacy-9c",
  );
});

test("scopeHref carries repeated unrelated query values without dropping them", () => {
  assert.equal(
    scopeHref("/draw", "legacy-9c", "https://kettigo.example/savings?tag=one&tag=two"),
    "/draw?tag=one&tag=two&savings=legacy-9c",
  );
});

test("switchDocumentScope delegates the selected URL to document navigation", () => {
  const assigned = [];
  const location = {
    href: "https://kettigo.example/draw?view=all&savings=legacy-e65#latest",
    assign(href) {
      assigned.push(href);
    },
  };

  switchDocumentScope("candidate-v2", location);

  assert.deepEqual(assigned, ["/draw?view=all&savings=candidate-v2#latest"]);
});
