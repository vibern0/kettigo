import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lab = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(lab, "zk/artifacts");
const generated = path.join(lab, "contracts/generated");
const cli = path.join(lab, "node_modules/snarkjs/cli.js");
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(generated, { recursive: true });
const circuits = [["range-claim", "RangeClaimVerifier"], ["snapshot-membership", "SnapshotMembershipVerifier"]];
const sourceHash = createHash("sha256").update(circuits.map(([name]) => fs.readFileSync(path.join(lab, `zk/${name}.circom`))).join("\n")).digest("hex");
if (fs.existsSync(path.join(output, "build.json"))) {
  const cached = JSON.parse(fs.readFileSync(path.join(output, "build.json"), "utf8"));
  if (cached.sourceHash === sourceHash && circuits.every(([name, contract]) => [
    path.join(output, `${name}.zkey`),
    path.join(output, `${name}.r1cs`),
    path.join(output, `${name}.vkey.json`),
    path.join(output, `${name}_js/${name}.wasm`),
    path.join(generated, `${contract}.sol`),
  ].every(file => fs.existsSync(file)))) {
    console.log("Reusing local research proving keys for unchanged circuits.");
    process.exit(0);
  }
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: lab, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const snark = (...args) => run(process.execPath, [cli, ...args]);
const info = [];
for (const [name] of circuits) {
  console.log(`Compiling ${name}...`);
  console.log(run(path.join(lab, ".tools/circom"), [path.join(lab, `zk/${name}.circom`), "--r1cs", "--wasm", "--sym", "-l", path.join(lab, "node_modules"), "-o", output]));
  const details = snark("r1cs", "info", path.join(output, `${name}.r1cs`)).replace(/\x1b\[[0-9;]*m/g, "");
  const constraints = Number(details.match(/# of Constraints:\s*(\d+)/)?.[1]);
  const publicInputs = Number(details.match(/# of Public Inputs:\s*(\d+)/)?.[1]);
  if (!Number.isInteger(constraints)) throw new Error(`Cannot read circuit statistics: ${details}`);
  console.log(details);
  info.push({ name, constraints, publicInputs });
}
const power = Math.ceil(Math.log2(Math.max(...info.map(x => x.constraints + x.publicInputs + 2))));
const initial = path.join(output, `tau-${power}-initial.ptau`);
const contributed = path.join(output, `tau-${power}-contributed.ptau`);
const prepared = path.join(output, `tau-${power}-prepared.ptau`);
if (!fs.existsSync(prepared)) {
  console.log(`Generating local TEST-ONLY powers of tau, power ${power}...`);
  snark("powersoftau", "new", "bn128", String(power), initial);
  snark("powersoftau", "contribute", initial, contributed, "--name=Local research only", "-e=" + randomBytes(64).toString("hex"));
  console.log("Preparing phase 2...");
  snark("powersoftau", "prepare", "phase2", contributed, prepared);
}
for (const [name, contract] of circuits) {
  const first = path.join(output, `${name}-initial.zkey`);
  const key = path.join(output, `${name}.zkey`);
  console.log(`Setting up ${name}...`);
  snark("groth16", "setup", path.join(output, `${name}.r1cs`), prepared, first);
  snark("zkey", "contribute", first, key, "--name=Local research only", "-e=" + randomBytes(64).toString("hex"));
  snark("zkey", "export", "verificationkey", key, path.join(output, `${name}.vkey.json`));
  const verifier = path.join(generated, `${contract}.sol`);
  snark("zkey", "export", "solidityverifier", key, verifier);
  fs.writeFileSync(verifier, fs.readFileSync(verifier, "utf8").replace("contract Groth16Verifier", `contract ${contract}`));
}
fs.writeFileSync(path.join(output, "build.json"), JSON.stringify({
  sourceHash, compiler: "circom 2.2.3", snarkjs: "0.7.6", power,
  setup: "Fresh local test setup; not a production ceremony", circuits: info,
}, null, 2) + "\n");
console.log("Circuits and Solidity verifiers ready.");
