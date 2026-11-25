import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

type SnapshotOptions = { batchId?: bigint; drawId?: bigint; tree?: boolean };

export function readUint64(
  clearValues: Readonly<Record<`0x${string}`, unknown>>,
  handle: string,
): bigint {
  const value = clearValues[handle as `0x${string}`];
  if (typeof value !== "bigint") throw new Error("Expected an euint64 clear value");
  return value;
}

export async function wrapperBalance(wrapper: any, user: any) {
  return fhevm.userDecryptEuint(
    FhevmType.euint64,
    await wrapper.confidentialBalanceOf(user.address),
    await wrapper.getAddress(),
    user,
  );
}

async function snapshotAccounting(usdc: any, namespace: any, account: string) {
  const { pool, wrapper, adapter } = namespace;
  return {
    pool: await pool.getAddress(),
    wrapper: await wrapper.getAddress(),
    adapter: await adapter.getAddress(),
    adapterPool: await adapter.prizePool(),
    adapterWrapper: await adapter.confidentialUsdc(),
    wrapperUsdc: await usdc.balanceOf(await wrapper.getAddress()),
    poolUsdc: await usdc.balanceOf(await pool.getAddress()),
    adapterUsdc: await usdc.balanceOf(await adapter.getAddress()),
    adapterSupplied: await adapter.suppliedPrincipal(),
    adapterIdle: await adapter.idlePrincipal(),
    adapterAvailable: await adapter.availablePrincipalAssets(),
    principal: await pool.encryptedPrincipalOf(account),
    totalPrincipal: await pool.encryptedTotalPrincipal(),
    prizeReserve: await pool.encryptedPrizeReserve(),
    winnings: await pool.encryptedWinningsOf(account),
    pendingMorpho: await pool.encryptedPendingMorphoPrincipal(),
    publicPrizeReserve: await pool.publicPrizeReserve(),
  };
}

async function snapshotBatch(pool: any, account: string, batchId: bigint) {
  return {
    status: await pool.withdrawalBatchStatus(batchId),
    funded: await pool.withdrawalBatchFunded(batchId),
    hasClaim: await pool.hasWithdrawalClaim(batchId, account),
    requestCount: await pool.withdrawalBatchRequestCount(batchId),
    claimantCount: await pool.withdrawalBatchClaimantCount(batchId),
    restored: await pool.withdrawalBatchRestoredAmount(batchId),
    total: await pool.encryptedWithdrawalBatchTotal(batchId),
    restore: await pool.encryptedWithdrawalBatchMorphoRestore(batchId),
    claim: await pool.encryptedWithdrawalClaimOf(batchId, account),
  };
}

async function snapshotDrawTree(pool: any, account: string, drawId?: bigint, tree = false) {
  const snapshot: any = {};
  if (drawId !== undefined) {
    snapshot.draw = {
      values: Array.from(await pool.draws(drawId)),
      checked: await pool.checked(drawId, account),
      award: await pool.encryptedAwardOf(drawId, account),
    };
  }
  if (drawId !== undefined || tree) {
    snapshot.tree = Array.from(await pool.membershipNode(32n, 0n));
    snapshot.memberIndex = await pool.membershipIndexOf(account);
    snapshot.activeMembers = await pool.activeMemberCount();
    snapshot.pendingAdmissionPrincipal = await pool.encryptedPendingAdmissionPrincipal();
  }
  return snapshot;
}

export async function snapshotNamespace(
  usdc: any,
  namespace: any,
  account: string,
  options: SnapshotOptions = {},
) {
  const accounting = await snapshotAccounting(usdc, namespace, account);
  const batch =
    options.batchId === undefined
      ? {}
      : { batch: await snapshotBatch(namespace.pool, account, options.batchId) };
  const drawTree = await snapshotDrawTree(namespace.pool, account, options.drawId, options.tree);
  return { ...accounting, ...batch, ...drawTree };
}

export function expectNamespaceUnchanged(before: any, after: any) {
  expect(after).to.deep.equal(before);
}

export async function deposit(wrapper: any, pool: any, user: any, amount: bigint, data = "0x") {
  const input = await fhevm
    .createEncryptedInput(await wrapper.getAddress(), user.address)
    .add64(amount)
    .encrypt();
  const userWrapper = wrapper.connect(user);
  await userWrapper["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
    await pool.getAddress(),
    input.handles[0],
    input.inputProof,
    data,
  );
}

export async function admit(pool: any, account: string) {
  const pending = await pool.pendingAdmissionOf(account);
  const decrypted = await fhevm.publicDecrypt([pending.marker]);
  await pool.finalizeAdmission(account, pending.nonce, true, decrypted.decryptionProof);
}

export async function usdcDepositForV2(fresh: any, user: any, amount: bigint) {
  const usdc = await ethers.getContractAt("MockUSDC", await fresh.wrapper.underlying());
  await usdc.connect(user).faucet(user.address, amount);
  await usdc.connect(user).approve(await fresh.wrapper.getAddress(), amount);
  await fresh.wrapper.connect(user).wrap(user.address, amount);
  await deposit(fresh.wrapper, fresh.pool, user, amount);
  await admit(fresh.pool, user.address);
}

export async function settleClosed(pool: any, batchId: bigint) {
  const total = await pool.encryptedWithdrawalBatchTotal(batchId);
  const restore = await pool.encryptedWithdrawalBatchMorphoRestore(batchId);
  const decrypted = await fhevm.publicDecrypt([total, restore]);
  await pool.settleWithdrawalBatch(
    batchId,
    readUint64(decrypted.clearValues, total),
    readUint64(decrypted.clearValues, restore),
    decrypted.decryptionProof,
  );
}
