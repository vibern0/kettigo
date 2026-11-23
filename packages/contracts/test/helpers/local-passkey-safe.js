const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");
const runtimes = require("../fixtures/passkey-safe/runtimes.json");

// Canonical Safe 1.4.1 and passkey module 0.2.1 runtime hashes.
const deployments = {
  singleton: [
    "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
  ],
  factory: [
    "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
  ],
  multiSend: [
    "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
    "0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939",
  ],
  sharedSigner: [
    "0x94a4F6affBd8975951142c3999aEAB7ecee555c2",
    "0xeaa32d0280053e2feea48a7c3fa15a535cd07c23ff60c9469cfa1999533e9332",
  ],
  verifier: [
    "0xc2b78104907F722DABAc4C69f826a522B2754De4",
    "0x3cd725b6ba67b40b7979190c41a015e82cf21e098eb61832ba623f8538bab7fc",
  ],
};
const safeAbi = [
  "function setup(address[],uint256,address,bytes,address,address,uint256,address)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
];

async function installDeployments() {
  assert.equal(network.name, "hardhat");
  await Promise.all(
    Object.values(deployments).map(async ([address, hash]) => {
      const bytecode = runtimes[address];
      assert.equal(ethers.keccak256(bytecode), hash, `Runtime hash mismatch at ${address}`);
      await network.provider.send("hardhat_setCode", [address, bytecode]);
    }),
  );
}

function makeSafeSignature(signerAddress, { authenticatorData, clientDataFields, r, s }) {
  const webauthn = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes", "string", "uint256", "uint256"],
    [authenticatorData, clientDataFields, r, s],
  );
  return ethers.solidityPacked(
    ["uint256", "uint256", "uint8", "uint256", "bytes"],
    [BigInt(signerAddress), 65n, 0, ethers.dataLength(webauthn), webauthn],
  );
}

async function createLocalPasskeySafe(passkey, relayer) {
  await installDeployments();
  const singleton = deployments.singleton[0];
  const sharedSigner = deployments.sharedSigner[0];
  const factory = new ethers.Contract(
    deployments.factory[0],
    [
      "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
    ],
    relayer,
  );
  const shared = new ethers.Interface([
    "function configure((uint256 x,uint256 y,uint176 verifiers) signer)",
  ]);
  const configure = shared.encodeFunctionData("configure", [
    [passkey.coordinates.x, passkey.coordinates.y, BigInt(deployments.verifier[0])],
  ]);
  const safeInterface = new ethers.Interface(safeAbi);
  const setup = safeInterface.encodeFunctionData("setup", [
    [sharedSigner],
    1,
    sharedSigner,
    configure,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress,
  ]);
  const address = await factory.createProxyWithNonce.staticCall(singleton, setup, 0);
  await (await factory.createProxyWithNonce(singleton, setup, 0)).wait();
  const safe = new ethers.Contract(address, safeAbi, relayer);
  assert.deepEqual([...(await safe.getOwners())], [sharedSigner]);
  const multi = new ethers.Interface(["function multiSend(bytes transactions)"]);
  return {
    address,
    nonce: () => safe.nonce(),
    async send(calls, onSigned) {
      const packed = calls.map(({ to, data }) =>
        ethers.solidityPacked(
          ["uint8", "address", "uint256", "uint256", "bytes"],
          [0, to, 0, ethers.dataLength(data), data],
        ),
      );
      const args =
        calls.length === 1
          ? [calls[0].to, 0, calls[0].data, 0]
          : [
              deployments.multiSend[0],
              0,
              multi.encodeFunctionData("multiSend", [ethers.concat(packed)]),
              1,
            ];
      args.push(0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress);
      const nonce = await safe.nonce();
      const digest = await safe.getTransactionHash(...args, nonce);
      const signature = makeSafeSignature(sharedSigner, await passkey.signDigest(digest));
      await onSigned?.(digest);
      const receipt = await (await safe.execTransaction(...args, signature)).wait();
      const event = receipt.logs.find((log) => log.fragment?.name === "ExecutionSuccess");
      assert.equal(event?.args.txHash, digest);
      assert.equal(await safe.nonce(), nonce + 1n);
      return receipt;
    },
  };
}

module.exports = { createLocalPasskeySafe };
