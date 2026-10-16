import assert from "node:assert/strict";
import test from "node:test";
import { fitOverlayToViewport } from "../src/lib/visual-viewport.ts";

test("keeps the overlay flush with the visible viewport as the keyboard opens and closes", () => {
  const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 });
  const element = { style: {} };
  const cleanup = fitOverlayToViewport(element, viewport);

  assert.equal(element.style.top, "0px");
  assert.equal(element.style.height, "700px");
  assert.equal(element.style.bottom, "auto");

  viewport.height = 420;
  viewport.dispatchEvent(new Event("resize"));
  assert.equal(element.style.height, "420px");

  viewport.offsetTop = 48;
  viewport.dispatchEvent(new Event("scroll"));
  assert.equal(element.style.top, "48px");
  assert.equal(parseFloat(element.style.top) + parseFloat(element.style.height), 468);

  viewport.height = 700;
  viewport.offsetTop = 0;
  viewport.dispatchEvent(new Event("resize"));
  assert.equal(element.style.top, "0px");
  assert.equal(element.style.height, "700px");

  cleanup();
  viewport.height = 300;
  viewport.offsetTop = 30;
  viewport.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("scroll"));
  assert.equal(element.style.height, "700px");
  assert.equal(element.style.top, "0px");
});

test("preserves CSS positioning when the Visual Viewport API is unavailable", () => {
  const element = { style: {} };
  const cleanup = fitOverlayToViewport(element, null);
  assert.deepEqual(element.style, {});
  assert.doesNotThrow(cleanup);
});
