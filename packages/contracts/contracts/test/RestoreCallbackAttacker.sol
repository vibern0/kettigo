// SPDX-License-Identifier: MIT
// aderyn-fp-next-line(push-zero-opcode,unspecific-solidity-pragma)
pragma solidity ^0.8.28;

/// @dev Test-only callback target used to exercise the Morpho withdrawal boundary.
// aderyn-fp-next-line(state-change-without-event)
contract RestoreCallbackAttacker {
  address private immutable _pool;
  address private immutable _adapter;

  bool public poolRestoreSucceeded;
  bool public adapterRestoreSucceeded;

  constructor(address pool_, address adapter_) {
    _pool = pool_;
    _adapter = adapter_;
  }

  // aderyn-fp-next-line(state-change-without-event)
  function onMorphoWithdraw(uint256 assets) external {
    // solhint-disable-next-line avoid-low-level-calls
    // aderyn-fp-next-line(reentrancy-state-change)
    (poolRestoreSucceeded, ) = _pool.call(
      abi.encodeWithSignature("restoreMorphoPrincipal(uint256)", assets)
    );
    // solhint-disable-next-line avoid-low-level-calls
    // aderyn-fp-next-line(reentrancy-state-change)
    (adapterRestoreSucceeded, ) = _adapter.call(
      abi.encodeWithSignature("restorePrincipalToPool(uint256)", assets)
    );
  }
}
