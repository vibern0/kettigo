// SPDX-License-Identifier: MIT
// aderyn-fp-next-line(push-zero-opcode,unspecific-solidity-pragma)
pragma solidity ^0.8.28;

interface IRestoreCallbackPool {
  function restoreMorphoPrincipal(uint256 assets) external returns (uint256);
  function closeDraw() external returns (bytes32);
  function settleWithdrawalBatch(
    uint256 batchId,
    uint64 cleartextTotal,
    uint64 cleartextMorphoRestore,
    bytes calldata decryptionProof
  ) external returns (uint256);
  function requestWithdrawal(
    bytes32 encryptedAmount,
    bytes calldata inputProof
  ) external returns (uint256);
}

interface IRestoreCallbackAdapter {
  function restorePrincipalToPool(uint256 assets) external returns (uint256);
  function harvestYieldToPrizePool(uint256 maxAssets) external returns (uint256);
}

/// @dev Test-only callback target used to exercise the Morpho withdrawal boundary.
// aderyn-fp-next-line(state-change-without-event)
contract RestoreCallbackAttacker {
  address private immutable _pool;
  address private immutable _adapter;

  bool public poolRestoreSucceeded;
  bool public adapterRestoreSucceeded;
  bool public adapterHarvestSucceeded;
  bool public closeDrawSucceeded;
  bool public settleWithdrawalSucceeded;
  bool public requestWithdrawalSucceeded;

  bytes public poolRestoreRevertData;
  bytes public adapterRestoreRevertData;
  bytes public adapterHarvestRevertData;
  bytes public closeDrawRevertData;
  bytes public settleWithdrawalRevertData;
  bytes public requestWithdrawalRevertData;
  bytes32 private _withdrawalHandle;
  bytes private _withdrawalProof;

  constructor(address pool_, address adapter_) {
    _pool = pool_;
    _adapter = adapter_;
  }

  // aderyn-fp-next-line(state-change-without-event)
  function configureWithdrawal(bytes32 encryptedAmount, bytes calldata inputProof) external {
    _withdrawalHandle = encryptedAmount;
    _withdrawalProof = inputProof;
  }

  // aderyn-fp-next-line(state-change-without-event)
  function onMorphoWithdraw(uint256 assets) external {
    IRestoreCallbackPool pool = IRestoreCallbackPool(_pool);
    IRestoreCallbackAdapter adapter = IRestoreCallbackAdapter(_adapter);
    // aderyn-fp-next-line(reentrancy-state-change)
    try pool.restoreMorphoPrincipal(assets) {
      poolRestoreSucceeded = true;
    } catch (bytes memory reason) {
      poolRestoreRevertData = reason;
    }
    // aderyn-fp-next-line(reentrancy-state-change)
    try adapter.restorePrincipalToPool(assets) {
      adapterRestoreSucceeded = true;
    } catch (bytes memory reason) {
      adapterRestoreRevertData = reason;
    }
    // aderyn-fp-next-line(reentrancy-state-change)
    try adapter.harvestYieldToPrizePool(0) {
      adapterHarvestSucceeded = true;
    } catch (bytes memory reason) {
      adapterHarvestRevertData = reason;
    }
    // aderyn-fp-next-line(reentrancy-state-change)
    try pool.closeDraw() {
      closeDrawSucceeded = true;
    } catch (bytes memory reason) {
      closeDrawRevertData = reason;
    }
    // aderyn-fp-next-line(reentrancy-state-change)
    try pool.settleWithdrawalBatch(0, 0, 0, "") {
      settleWithdrawalSucceeded = true;
    } catch (bytes memory reason) {
      settleWithdrawalRevertData = reason;
    }
    // aderyn-fp-next-line(reentrancy-state-change)
    try pool.requestWithdrawal(_withdrawalHandle, _withdrawalProof) {
      requestWithdrawalSucceeded = true;
    } catch (bytes memory reason) {
      requestWithdrawalRevertData = reason;
    }
  }
}
