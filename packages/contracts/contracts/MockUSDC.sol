// SPDX-License-Identifier: MIT
// aderyn-fp-next-line(push-zero-opcode,unspecific-solidity-pragma)
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC — testnet-only USDC stand-in.
/// @notice Anyone can mint to themselves via the faucet. Production replaces this
///         with the real USDC token (or a bridged version).
// This faucet token is intentionally administrator-owned for test setup.
// aderyn-fp-next-line(centralization-risk)
contract MockUSDC is ERC20, Ownable {
  constructor() ERC20("USD Coin", "USDC") Ownable(msg.sender) {}

  function decimals() public pure override returns (uint8) {
    return 6;
  }

  /// @notice Anyone can mint test USDC to themselves for testing.
  function faucet(address to, uint256 amount) external {
    _mint(to, amount);
  }
}
