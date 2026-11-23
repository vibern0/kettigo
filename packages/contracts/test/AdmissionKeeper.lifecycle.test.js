const { expect } = require("chai");
const { ethers, fhevm, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { createPublicClient, createWalletClient, custom } = require("viem");
const { hardhat } = require("viem/chains");
const { deposit } = require("./MigrationV1V2.helpers");
const { captureMembershipProof } = require("./proofHelper");
const { createLocalPasskeySafe } = require("./helpers/local-passkey-safe");

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
  const { runAdmissionPass } = await import("../../web/scripts/admission-keeper.mjs");
  const { confidentialPrizePoolAbi: abi } = await import("../../protocol/src/index.ts");
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

describe("Candidate savings with background keepers", function () {
  this.timeout(120_000);
  let passkey;

  before(async function () {
    if (network.name !== "hardhat" || !fhevm.isMock) this.skip();
    if (process.env.LOCAL_VIRTUAL_PASSKEY === "1") {
      const { createVirtualPasskey } =
        await import("../../web/scripts/test-support/virtual-passkey.mjs");
      passkey = await createVirtualPasskey();
    }
  });
  after(async function () {
    await passkey?.close();
  });

  it("admits a deposit in the background, closes a funded draw and delivers the claimed savings to USDC", async function () {
    const [sponsor, localSigner, keeper, readDelegate] = await ethers.getSigners();
    const saver = passkey
      ? await createLocalPasskeySafe(passkey, localSigner)
      : {
          address: localSigner.address,
          nonce: () => ethers.provider.getTransactionCount(localSigner.address),
          async send(calls) {
            for (const call of calls)
              expect((await (await localSigner.sendTransaction(call)).wait()).status).to.equal(1);
          },
        };
    const { usdc, wrapper, pool } = await deploySavings(sponsor);
    const transport = custom(network.provider);
    const publicClient = createPublicClient({ chain: hardhat, transport, cacheTime: 0 });
    const writer = createWalletClient({ chain: hardhat, transport, account: keeper.address });
    // The deployed keepers select Sepolia on each write. Only the in-process chain can receive these calls.
    const walletClient = {
      writeContract: (request) => writer.writeContract({ ...request, chain: hardhat }),
    };
    const clients = { pool: pool.target, account: keeper.address, publicClient, walletClient };
    function call(contract, method, args) {
      return { to: contract.target, data: contract.interface.encodeFunctionData(method, args) };
    }
    const { calls: readCalls, decrypt: decryptAmount } = await createReadSession(
      saver,
      readDelegate,
      pool,
      wrapper,
    );

    await fundDraw({ usdc, wrapper, pool }, sponsor);
    await usdc.faucet(saver.address, principal);
    const encrypted = await fhevm
      .createEncryptedInput(wrapper.target, saver.address)
      .add64(principal)
      .encrypt();
    const wrap = wrapper.interface.encodeFunctionData("wrap", [saver.address, principal]);
    const transfer = wrapper.interface.encodeFunctionData(
      "confidentialTransferAndCall(address,bytes32,bytes,bytes)",
      [pool.target, encrypted.handles[0], encrypted.inputProof, "0x"],
    );
    await saver.send([
      ...readCalls,
      call(usdc, "approve", [wrapper.target, principal]),
      call(wrapper, "multicall", [[wrap, transfer]]),
    ]);
    expect(await usdc.balanceOf(saver.address)).to.equal(0n);
    expect(await decryptAmount(pool.encryptedPrincipalOf(saver.address))).to.equal(principal);
    expect((await pool.pendingAdmissionOf(saver.address)).requested).to.equal(true);
    expect(await pool.membershipIndexOf(saver.address)).to.equal(0n);

    const nonceBeforeKeeper = await saver.nonce();
    const admissionHash = await runAdmission(pool, clients);
    expect(
      (await publicClient.getTransaction({ hash: admissionHash })).from.toLowerCase(),
    ).to.equal(keeper.address.toLowerCase());
    expect((await pool.pendingAdmissionOf(saver.address)).requested).to.equal(false);
    expect(await pool.membershipIndexOf(saver.address)).to.equal(1n);
    const proof = await captureMembershipProof(pool, saver.address);
    await time.increaseTo(await pool.nextDrawAt());
    const { runDrawKeeper } = await import("../../web/netlify/functions/draw-keeper.ts");
    const draw = await runDrawKeeper({ ...clients, minimumPrize: prize });
    expect(draw.status).to.equal("submitted");
    expect((await publicClient.waitForTransactionReceipt({ hash: draw.hash })).status).to.equal(
      "success",
    );
    expect(await saver.nonce()).to.equal(nonceBeforeKeeper);
    const drawId = await pool.drawId();
    expect(await pool.checked(drawId, saver.address)).to.equal(false);
    await saver.send([
      call(pool, "checkPrize", [
        drawId,
        saver.address,
        proof.index,
        proof.generation,
        proof.balance,
        proof.siblingHashes,
        proof.siblingSums,
        proof.parentSums,
      ]),
    ]);
    expect(await pool.checked(drawId, saver.address)).to.equal(true);
    expect(await decryptAmount(pool.encryptedAwardOf(drawId, saver.address))).to.equal(prize);
    await saver.send([call(pool, "claimPrizeToSavings", [])]);
    expect(await decryptAmount(pool.encryptedWinningsOf(saver.address))).to.equal(0n);
    expect(await decryptAmount(pool.encryptedPrincipalOf(saver.address))).to.equal(
      principal + prize,
    );

    const withdrawal = await fhevm
      .createEncryptedInput(pool.target, saver.address)
      .add64(principal + prize)
      .encrypt();
    await saver.send([
      call(pool, "requestWithdrawal", [withdrawal.handles[0], withdrawal.inputProof]),
    ]);
    const batch = await pool.currentWithdrawalBatchId();
    expect(await decryptAmount(pool.encryptedPrincipalOf(saver.address))).to.equal(0n);
    const nonceBeforeDelivery = await saver.nonce();
    await time.increaseTo(await pool.withdrawalBatchClosesAt(batch));
    const { runWithdrawalKeeper } =
      await import("../../web/netlify/functions/withdrawal-keeper.ts");
    const response = await runWithdrawalKeeper({
      ...clients,
      decrypt: (handles) => fhevm.publicDecrypt(handles),
    });
    const { transactions, pending } = await response.json();
    expect(pending).to.deep.equal([]);
    expect(transactions.map((tx) => tx.action)).to.deep.equal([
      "close",
      "settle",
      "payout",
      "deliver",
    ]);
    expect(await usdc.balanceOf(saver.address)).to.equal(principal + prize);
    expect(await saver.nonce()).to.equal(nonceBeforeDelivery);
    if (passkey) expect(await saver.nonce()).to.equal(4n);
  });
});
