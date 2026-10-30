// Read-only metadata check. Never sends a transaction or loads a signer.
import { JsonRpcProvider, Contract, getAddress } from "ethers";
import { writeFileSync } from "node:fs";

const provider = new JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111, { staticNetwork: true });
try {
  const executorAddress = getAddress("0x92C920834Ec8941d2C77D188936E1f7A6f49c127");
  const executor = new Contract(executorAddress, [
    "function getHCULimitAddress() view returns (address)",
    "function getVersion() view returns (string)",
  ], provider);
  const block = await provider.getBlockNumber();
  const [hcuAddress, executorVersion] = await Promise.all([
    executor.getHCULimitAddress({ blockTag: block }), executor.getVersion({ blockTag: block }),
  ]);
  const hcu = new Contract(getAddress(hcuAddress), ["function getVersion() view returns (string)"], provider);
  const result = {
    date: "2026-10-19", network: "Sepolia", chainId: 11155111, block,
    executorAddress, executorVersion, hcuAddress: getAddress(hcuAddress),
    hcuVersion: await hcu.getVersion({ blockTag: block }),
    scope: "Read-only metadata; no deployment, live FHE computation, or limit measurement",
  };
  writeFileSync(new URL("network-check.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  provider.destroy();
}
