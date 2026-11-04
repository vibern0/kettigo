// SPDX-License-Identifier: MIT
// aderyn-fp-next-line(push-zero-opcode,unspecific-solidity-pragma)
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IMorphoBlue} from "./MorphoYieldAdapter.sol";

// Test-only market double; production indexing is owned by the adapter and pool events.
// aderyn-fp-next-line(state-change-without-event)
contract MockMorphoBlue is IMorphoBlue {
  using SafeERC20 for IERC20;
  using SafeCast for uint256;

  error InconsistentInput();
  error InsufficientShares();
  error SharesUnsupported();

  uint256 private constant VIRTUAL_SHARES = 1e6;
  uint256 private constant VIRTUAL_ASSETS = 1;

  mapping(bytes32 id => MarketParams params) private _params;
  mapping(bytes32 id => Market marketState) private _markets;
  mapping(bytes32 id => mapping(address user => Position userPosition)) private _positions;
  mapping(bytes32 id => uint128 assets) private _queuedYield;

  // aderyn-fp-next-line(state-change-without-event)
  function createMarket(MarketParams calldata params) external returns (bytes32 marketId) {
    marketId = id(params);
    _params[marketId] = params;
    _markets[marketId].lastUpdate = uint128(block.timestamp);
  }

  // aderyn-fp-next-line(state-change-without-event)
  function accrueYield(MarketParams calldata params, uint256 assets) external {
    bytes32 marketId = id(params);
    IERC20(params.loanToken).safeTransferFrom(msg.sender, address(this), assets);
    _markets[marketId].totalSupplyAssets += assets.toUint128();
  }

  // aderyn-fp-next-line(state-change-without-event)
  function queueYield(MarketParams calldata params, uint128 assets) external {
    IERC20(params.loanToken).safeTransferFrom(msg.sender, address(this), assets);
    _queuedYield[id(params)] += assets;
  }

  // aderyn-fp-next-line(state-change-without-event)
  function accrueInterest(MarketParams calldata params) public {
    bytes32 marketId = id(params);
    _markets[marketId].totalSupplyAssets += _queuedYield[marketId];
    delete _queuedYield[marketId];
    _markets[marketId].lastUpdate = uint128(block.timestamp);
  }

  // aderyn-fp-next-line(state-change-without-event)
  function supply(
    MarketParams calldata params,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    bytes calldata
  ) external returns (uint256 suppliedAssets, uint256 suppliedShares) {
    if (shares != 0) revert SharesUnsupported();

    accrueInterest(params);
    bytes32 marketId = id(params);
    Market storage m = _markets[marketId];
    suppliedAssets = assets;
    suppliedShares =
      (assets * (uint256(m.totalSupplyShares) + VIRTUAL_SHARES)) /
      (uint256(m.totalSupplyAssets) + VIRTUAL_ASSETS);

    IERC20(params.loanToken).safeTransferFrom(msg.sender, address(this), assets);
    m.totalSupplyAssets += suppliedAssets.toUint128();
    m.totalSupplyShares += suppliedShares.toUint128();
    _positions[marketId][onBehalf].supplyShares += suppliedShares;
  }

  // aderyn-fp-next-line(state-change-without-event)
  function withdraw(
    MarketParams calldata params,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    address receiver
  ) external returns (uint256 withdrawnAssets, uint256 withdrawnShares) {
    if ((assets == 0) == (shares == 0)) revert InconsistentInput();

    accrueInterest(params);
    bytes32 marketId = id(params);
    Market storage m = _markets[marketId];
    Position storage p = _positions[marketId][onBehalf];

    withdrawnShares =
      shares == 0 ? _toSharesUp(assets, m.totalSupplyAssets, m.totalSupplyShares) : shares;
    withdrawnAssets =
      assets == 0
        ? (withdrawnShares * (uint256(m.totalSupplyAssets) + VIRTUAL_ASSETS)) /
          (uint256(m.totalSupplyShares) + VIRTUAL_SHARES)
        : assets;
    if (withdrawnShares > p.supplyShares) revert InsufficientShares();

    p.supplyShares -= withdrawnShares;
    m.totalSupplyAssets -= withdrawnAssets.toUint128();
    m.totalSupplyShares -= uint128(withdrawnShares);
    IERC20(params.loanToken).safeTransfer(receiver, withdrawnAssets);
  }

  function idToMarketParams(bytes32 marketId) external view returns (MarketParams memory) {
    return _params[marketId];
  }

  function market(bytes32 marketId) external view returns (Market memory) {
    return _markets[marketId];
  }

  function position(bytes32 marketId, address user) external view returns (Position memory) {
    return _positions[marketId][user];
  }

  function id(MarketParams memory params) public pure returns (bytes32) {
    return keccak256(abi.encode(params));
  }

  function _toSharesUp(
    uint256 assets,
    uint256 totalAssets,
    uint256 totalShares
  ) private pure returns (uint256) {
    if (assets == 0 || totalShares == 0) return 0;
    return
      (assets * (totalShares + VIRTUAL_SHARES) + totalAssets + VIRTUAL_ASSETS - 1) /
      (totalAssets + VIRTUAL_ASSETS);
  }
}
