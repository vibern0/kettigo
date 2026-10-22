import { spawn } from "node:child_process";

let child;
let stopped = false;
let wake;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
    child?.kill(signal);
    wake?.();
  });
}

async function run(name) {
  await new Promise((resolve) => {
    child = spawn(process.execPath, [
      "--no-warnings", "--experimental-strip-types",
      "--import", new URL("./register-ts-loader.mjs", import.meta.url).href,
      new URL("./run-web-keeper.mjs", import.meta.url).pathname, name,
    ], { stdio: "inherit" });
    child.on("error", (error) => { console.error(error.message); resolve(); });
    child.on("exit", (code) => {
      if (code && !stopped) console.error(`${name} keeper exited ${code}; retrying next cycle`);
      resolve();
    });
  });
  child = undefined;
}

while (!stopped) {
  await run("morpho");
  if (!stopped) await run("withdrawal");
  if (!stopped) await run("draw");
  if (!stopped) await new Promise((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    wake = () => { clearTimeout(timer); resolve(); };
  });
}
