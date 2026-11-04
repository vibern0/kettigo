// SPDX-License-Identifier: MIT
// aderyn-fp-next-line(push-zero-opcode,unspecific-solidity-pragma)
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice ERC-7984 wrapper for USDC on Sepolia, or MockUSDC in local tests.
contract ConfidentialUSDC is ZamaEthereumConfig, ERC7984ERC20Wrapper, Multicall {
  /// @notice Creates the cUSDC wrapper around the configured ERC-20.
  constructor(
    IERC20 underlying
  )
    ERC7984("Confidential USDC", "cUSDC", "https://kettigo.local/cusdc")
    ERC7984ERC20Wrapper(underlying)
  {}
}
