import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

export const KEEPER_NAMES = ["morpho", "withdrawal", "draw"];

export async function runAllKeepers(run) {
  const results = [];
  for (const name of KEEPER_NAMES) {
    try {
      await run(name);
      results.push({ name, ok: true });
    } catch (error) {
      results.push({
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function runChild(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--no-warnings",
      "--experimental-strip-types",
      "--import",
      new URL("./register-ts-loader.mjs", import.meta.url).href,
      fileURLToPath(new URL("./run-web-keeper.mjs", import.meta.url)),
      name,
    ], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} keeper exited ${code ?? signal ?? "unknown"}`));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await runAllKeepers(runChild);
  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    console.error(JSON.stringify({ status: "failed", failures }));
    process.exitCode = 1;
  }
}
