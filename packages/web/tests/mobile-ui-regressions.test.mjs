import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const accessGate = await readFile(
  new URL("../src/components/AccessGate.tsx", import.meta.url),
  "utf8",
);
const toast = await readFile(
  new URL("../src/components/Toast.tsx", import.meta.url),
  "utf8",
);
const drawPage = await readFile(
  new URL("../src/app/draw/page.tsx", import.meta.url),
  "utf8",
);

test("starts access gate content near the top on mobile", () => {
  assert.match(accessGate, /justify-start[\s\S]*md:justify-center/);
});

test("keeps toast messages on an opaque readable surface", () => {
  assert.doesNotMatch(toast, /bg-(success|danger|white)\/10|bg-white\/35/);
  assert.match(toast, /glass-surface[\s\S]*toneClass\[toast\.tone\]/);
});

test("shows the testnet warning before the next draw details", () => {
  assert.match(
    drawPage,
    /<TestnetWarning\s*\/>[\s\S]*<p className="label">Next draw<\/p>/,
  );
});
