const { expect } = require("chai");
const { ethers, fhevm } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deposit } = require("../MigrationV1V2.helpers");

const principal = 3_000_000n;
const prize = 1_000_000n;

async function deploySavings(owner) {
  const usdc = await ethers.deployContract("MockUSDC");
  const wrapper = await ethers.deployContract("ConfidentialUSDC", [usdc.target]);
  const pool = await ethers.deployContract("ConfidentialPrizePool", [wrapper.target, 900, 300]);
  const morpho = await ethers.deployContract("MockMorphoBlue");
  const market = [
    usdc.target,
    owner.address,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    945_000_000_000_000_000n,
  ];
  await morpho.createMarket(market);
  const adapter = await ethers.deployContract("MorphoYieldAdapter", [
    usdc.target,
    wrapper.target,
    pool.target,
    morpho.target,
    market,
  ]);
  await pool.setMorphoYieldAdapter(adapter.target, 300);
  return { usdc, wrapper, pool };
}

async function fundDraw({ usdc, wrapper, pool }, sponsor) {
  await usdc.faucet(sponsor.address, prize);
  await usdc.connect(sponsor).approve(wrapper.target, prize);
  await wrapper.connect(sponsor).wrap(sponsor.address, prize);
  const data = ethers.concat([
    await pool.PRIZE_FUNDING_DATA(),
    ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [prize]),
  ]);
  await deposit(wrapper, pool, sponsor, prize, data);
}

async function runAdmission(pool, clients) {
  const { runAdmissionPass } = await import("../../../web/scripts/admission-keeper.mjs");
  const { confidentialPrizePoolAbi: abi } = await import("../../../protocol/src/index.ts");
  const { publicClient, walletClient } = clients;
  const address = pool.target;
  const startBlock = BigInt((await pool.deploymentTransaction().wait()).blockNumber);
  const latest = await publicClient.getBlockNumber();
  const operations = {
    startBlock,
    latest,
    finalized: latest,
    discover: async (fromBlock, toBlock) => {
      const logs = await publicClient.getContractEvents({
        address,
        abi,
        eventName: "AdmissionRequested",
        strict: true,
        fromBlock,
        toBlock,
      });
      return logs.map((log) => log.args.account);
    },
    readPending: (beneficiary) =>
      publicClient.readContract({
        address,
        abi,
        functionName: "pendingAdmissionOf",
        args: [beneficiary],
      }),
    decrypt: (handles) => fhevm.publicDecrypt(handles),
    async finalize(beneficiary, nonce, positive, proof) {
      const hash = await walletClient.writeContract({
        address,
        abi,
        functionName: "finalizeAdmission",
        args: [beneficiary, nonce, positive, proof],
      });
      expect((await publicClient.waitForTransactionReceipt({ hash })).status).to.equal("success");
      return hash;
    },
  };
  const first = await runAdmissionPass({
    ...operations,
    state: { next: String(startBlock), accounts: [] },
  });
  expect(first.retrying).to.deep.equal([]);
  expect(first.transactions).to.have.length(1);
  const second = await runAdmissionPass({ ...operations, state: first.state });
  expect(second.retrying).to.deep.equal([]);
  expect(second.transactions).to.deep.equal([]);
  return first.transactions[0];
}

async function createReadSession(saver, delegate, pool, wrapper) {
  const { ACLAddress } = await fhevm.getCoprocessorConfig(pool.target);
  const acl = new ethers.Interface([
    "function delegateForUserDecryption(address delegate,address contractAddress,uint64 expirationDate)",
  ]);
  const contracts = [wrapper.target, pool.target];
  const start = Math.floor(Date.now() / 1000);
  const expiry = (await time.latest()) + 86_400;
  const key = fhevm.generateKeypair();
  const authorization = fhevm.createDelegatedUserDecryptEIP712(
    key.publicKey,
    contracts,
    saver.address,
    start,
    1,
  );
  const types = { [authorization.primaryType]: authorization.types[authorization.primaryType] };
  const signature = await delegate.signTypedData(
    authorization.domain,
    types,
    authorization.message,
  );
  return {
    calls: contracts.map((contract) => ({
      to: ACLAddress,
      data: acl.encodeFunctionData("delegateForUserDecryption", [
        delegate.address,
        contract,
        expiry,
      ]),
    })),
    async decrypt(handlePromise) {
      const handle = await handlePromise;
      const result = await fhevm.delegatedUserDecrypt(
        [{ handle, contractAddress: pool.target }],
        key.privateKey,
        key.publicKey,
        signature,
        contracts,
        saver.address,
        delegate.address,
        start,
        1,
      );
      return result[handle];
    },
  };
}

module.exports = { principal, prize, deploySavings, fundDraw, runAdmission, createReadSession };
