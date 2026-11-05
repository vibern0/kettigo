import { randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmod, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

function fail(message) {
  throw new Error(`candidate journal: ${message}`);
}

export async function persist(path, state, failPublish) {
  if (failPublish) fail("persist failed");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    if (failPublish === "after-rename") fail("persist failed after publication");
    await chmod(path, 0o600);
    const directory = await open(join(path, ".."), "r");
    await directory.sync();
    await directory.close();
  } catch (error) {
    if (handle) await handle.close();
    await unlink(temporary).catch(() => {});
    fail(`persist failed: ${error.message}`);
  }
}

export async function acquireLease(path, token) {
  try {
    await writeFile(path, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") fail("unable to acquire lease");
    fail("active or foreign lease; manual recovery required");
  }
}

export async function assertLease(path, token) {
  let current;
  try {
    current = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("writer lease unavailable");
  }
  if (!equalToken(current.token, token)) fail("writer lease lost");
}

export async function releaseLease(path, token) {
  try {
    const current = JSON.parse(await readFile(path, "utf8"));
    if (equalToken(current.token, token)) await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function equalToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
