// SPDX-License-Identifier: MIT
// aderyn-fp-next-line(push-zero-opcode,unspecific-solidity-pragma)
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/interfaces/IERC7984ERC20Wrapper.sol";
import {IERC7984Receiver} from "@openzeppelin/confidential-contracts/interfaces/IERC7984Receiver.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {EncryptedSnapshotTree} from "./libraries/EncryptedSnapshotTree.sol";

interface IERC7984ERC20WrapperInternalAmount is IERC7984ERC20Wrapper {
  /// @notice Starts an unwrap from confidential tokens back to the underlying token.
  function unwrap(address from, address to, euint64 amount) external returns (bytes32);
}

interface IMorphoPrizeYieldAdapter {
  function accruedYieldAssets() external view returns (uint256);
  function supplyPoolPrincipal(uint256 assets) external returns (uint256 shares);
  function supplyAvailablePrincipal()
    external
    returns (uint256 assetsSupplied, uint256 sharesSupplied);
  function availablePrincipalAssets() external view returns (uint256);
  function harvestYieldToPrizePool(uint256 maxAssets) external returns (uint256 harvestedAssets);
  function restorePrincipalToPool(uint256 assets) external returns (uint256 restoredAssets);
}

/// @notice Confidential principal accounting, public mocked prize funding, and no-loss withdrawal.
contract ConfidentialPrizePool is ZamaEthereumConfig, IERC7984Receiver {
  using EncryptedSnapshotTree for EncryptedSnapshotTree.Tree;
  uint64 public constant MAX_USER_PRINCIPAL = 1e9;
  bytes4 public constant PRIZE_FUNDING_DATA = bytes4(keccak256("Kettigo.prize"));

  IERC7984 public immutable token;
  address public immutable owner;
  uint256 public immutable drawInterval;
  uint256 public immutable withdrawalBatchInterval;
  uint256 public nextDrawAt;
  IMorphoPrizeYieldAdapter public morphoYieldAdapter;
  uint256 public morphoUnwrapInterval;
  uint256 public lastMorphoUnwrapAt;
  uint256 public morphoPendingDepositCount;
  uint256 private _unfundedWithdrawalBatchCount;
  uint256 public currentWithdrawalBatchId = 1;

  mapping(address account => euint64 principal) private _principal;
  struct PendingAdmission {
    euint64 balance;
    uint256 nonce;
    ebool marker;
    bool requested;
  }
  mapping(address account => PendingAdmission pending) private _pendingAdmissions;
  mapping(address account => uint256 indexPlusOne) private _membershipIndexPlusOne;
  mapping(uint256 index => uint64 generation) private _generationOf;
  mapping(address account => address delegate) private _decryptDelegate;
  mapping(address account => euint64 winnings) private _winnings;
  address[] private _participants;
  mapping(address account => uint256 indexPlusOne) private _activeParticipantIndexPlusOne;
  uint256[] private _freeSlots;
  uint256 internal _nextMembershipIndex;
  EncryptedSnapshotTree.Tree private _membershipTree;
  euint64 internal _totalPrincipal;
  euint64 private _pendingAdmissionPrincipal;
  euint64 private _prizeReserve;
  euint64 private _pendingMorphoPrincipal;
  uint64 public publicPrizeReserve;
  uint256 private _drawId;
  struct Draw {
    bytes32 rootHash;
    euint64 rootSum;
    euint128 ticket;
    euint64 prize;
    euint64 remaining;
    uint64 upperBound;
    uint256 closeBlockNumber;
  }
  mapping(uint256 drawId_ => Draw draw) public draws;
  mapping(uint256 drawId_ => mapping(address beneficiary => bool wasChecked)) public checked;
  mapping(uint256 drawId_ => mapping(address beneficiary => euint64 award)) private _awardOf;
  enum WithdrawalBatchStatus {
    Open,
    Closed,
    Funded
  }

  mapping(uint256 batchId => euint64 total) private _withdrawalBatchTotal;
  mapping(uint256 batchId => euint64 morphoRestore) private _withdrawalBatchMorphoRestore;
  mapping(uint256 batchId => WithdrawalBatchStatus status) private _withdrawalBatchStatus;
  mapping(uint256 batchId => uint256 closesAt) private _withdrawalBatchClosesAt;
  mapping(uint256 batchId => uint64 restoredAmount) private _withdrawalBatchRestoredAmount;
  mapping(uint256 batchId => uint256 count) private _withdrawalBatchRequestCount;
  mapping(uint256 batchId => uint256 count) private _withdrawalBatchClaimantCount;
  mapping(uint256 batchId => mapping(address account => euint64 claim)) private _withdrawalClaims;
  mapping(uint256 batchId => mapping(address account => bool hasClaim)) private _hasWithdrawalClaim;
  mapping(uint256 batchId => address[] accounts) private _withdrawalAccounts;
  mapping(uint256 batchId => mapping(address account => bytes32 requestId))
    public withdrawalUnwrapRequest;

  function withdrawalAccounts(uint256 batchId) external view returns (address[] memory) {
    return _withdrawalAccounts[batchId];
  }

  event ConfidentialDeposit(address indexed account, euint64 indexed amount);
  event PrizeFunded(address indexed account, euint64 indexed amount, uint64 publicAmount);
  event DrawStarted(uint256 indexed drawId, uint256 nextDrawAt);
  event DrawClosed(
    uint256 indexed drawId,
    euint128 indexed randomTicket,
    euint64 indexed prizeAmount
  );
  event DrawSnapshotClosed(
    uint256 indexed drawId,
    bytes32 rootHash,
    euint64 rootSum,
    euint128 ticket,
    euint64 prize,
    euint64 remaining,
    uint64 upperBound,
    uint256 closeBlockNumber
  );
  event PrizeClaimed(address indexed account, euint64 indexed amount);
  event PrizeChecked(uint256 indexed drawId, address indexed beneficiary);
  event PrizeAddedToSavings(address indexed account, euint64 indexed amount);
  event ConfidentialWithdrawal(address indexed account, euint64 indexed amount);
  event ConfidentialWithdrawalToUsdc(
    address indexed account,
    address indexed to,
    euint64 indexed amount,
    bytes32 unwrapRequestId
  );
  event DecryptDelegateUpdated(address indexed account, address indexed delegate);
  event MorphoYieldAdapterUpdated(address indexed adapter, uint256 unwrapInterval);
  event MorphoPrincipalUnwrapRequested(bytes32 indexed unwrapRequestId, uint256 depositCount);
  event MorphoPrincipalSupplied(uint256 assets, uint256 shares);
  event MorphoYieldHarvested(uint256 assets);
  event MorphoPrincipalRestored(uint256 assets);
  event WithdrawalBatchOpened(uint256 indexed batchId, uint256 closesAt);
  event WithdrawalRequested(
    address indexed account,
    uint256 indexed batchId,
    euint64 indexed amount
  );
  event WithdrawalBatchClosed(uint256 indexed batchId, euint64 total, euint64 morphoRestoreTotal);
  event WithdrawalBatchFunded(uint256 indexed batchId, uint64 total, uint64 morphoRestored);
  event WithdrawalClaimedToUsdc(
    address indexed account,
    uint256 indexed batchId,
    address indexed to,
    euint64 amount,
    bytes32 unwrapRequestId
  );
  event AdmissionRequested(address indexed account, uint256 nonce, ebool marker);
  event SlotAssigned(address indexed account, uint256 indexed index, uint64 generation);
  event SlotReleased(address indexed account, uint256 indexed index, uint64 generation);

  error OnlyConfidentialToken();
  error OnlyOwner();
  error DrawNotReady(uint256 nextDrawAt);
  error StaleAdmission();
  error TreeFull();
  error InvalidPrizeFundingData();
  error MorphoYieldAdapterNotSet();
  error MorphoUnwrapNotReady(uint256 readyAt);
  error NoPendingMorphoPrincipal();
  error QueuedWithdrawalsOnly();
  error WithdrawalBatchNotOpen(uint256 batchId);
  error WithdrawalBatchNotClosed(uint256 batchId);
  error WithdrawalBatchNotFunded(uint256 batchId);
  error WithdrawalBatchAlreadyFunded(uint256 batchId);
  error WithdrawalBatchNotReady(uint256 readyAt);
  error WithdrawalBatchEmpty(uint256 batchId);
  error InvalidWithdrawalBatchAmounts(uint64 total, uint64 morphoRestore);
  error WithdrawalRestorationMismatch(uint256 expected, uint256 actual);
  error NoWithdrawalClaim(uint256 batchId, address account);
  error InvalidWithdrawalReceiver();
  error ManualMorphoRestoreBlocked();
  error InvalidMorphoRestoreAmount(uint256 assets);
  error InvalidDrawProof();
  error InvalidDrawClaim();
  error DrawAlreadyChecked(uint256 drawId, address beneficiary);

  /// @notice Creates a pool for one confidential token and starts the first draw.
  constructor(IERC7984 token_, uint256 drawInterval_, uint256 withdrawalBatchInterval_) {
    token = token_;
    drawInterval = drawInterval_;
    withdrawalBatchInterval = withdrawalBatchInterval_;
    nextDrawAt = block.timestamp + drawInterval_;
    owner = msg.sender;
    _membershipTree.initialize(FHE.asEuint64(0));
    _pendingAdmissionPrincipal = _membershipTree.zero;
    FHE.allowThis(_pendingAdmissionPrincipal);

    emit DrawStarted(_drawId + 1, nextDrawAt);
    _openWithdrawalBatch(1);
  }

  /// @notice Receives confidential deposits or sponsor prize funding from the token.
  function onConfidentialTransferReceived(
    address,
    address from,
    euint64 amount,
    bytes calldata data
  ) external returns (ebool) {
    if (msg.sender != address(token)) {
      revert OnlyConfidentialToken();
    }

    if (bytes4(data) == PRIZE_FUNDING_DATA) {
      uint64 publicAmount = _decodePrizeFundingAmount(data);
      _prizeReserve = FHE.add(_prizeReserve, amount);
      publicPrizeReserve += publicAmount;
      FHE.allowThis(_prizeReserve);

      ebool funded = FHE.asEbool(true);
      FHE.allowTransient(funded, msg.sender);

      emit PrizeFunded(from, amount, publicAmount);
      return funded;
    }

    address decryptDelegate = _decodeDecryptDelegate(data);
    if (decryptDelegate != address(0) && _decryptDelegate[from] != decryptDelegate) {
      _decryptDelegate[from] = decryptDelegate;
      emit DecryptDelegateUpdated(from, decryptDelegate);
    }

    euint64 nextPrincipal = FHE.add(_principal[from], amount);
    euint64 nextTotal = FHE.add(_totalPrincipal, amount);
    ebool success = FHE.and(
      FHE.and(FHE.le(nextPrincipal, MAX_USER_PRINCIPAL), FHE.ge(nextPrincipal, _principal[from])),
      FHE.ge(nextTotal, _totalPrincipal)
    );
    euint64 acceptedAmount = FHE.select(success, amount, FHE.asEuint64(0));

    _principal[from] = FHE.add(_principal[from], acceptedAmount);
    _totalPrincipal = FHE.add(_totalPrincipal, acceptedAmount);
    _pendingMorphoPrincipal = FHE.add(_pendingMorphoPrincipal, acceptedAmount);
    ++morphoPendingDepositCount;
    if (_membershipIndexPlusOne[from] == 0) {
      PendingAdmission storage pending = _pendingAdmissions[from];
      pending.balance = _principal[from];
      _pendingAdmissionPrincipal = FHE.add(_pendingAdmissionPrincipal, acceptedAmount);
      FHE.allowThis(_pendingAdmissionPrincipal);
      _refreshAdmission(from, pending);
    } else {
      _updateMemberLeaf(from, acceptedAmount, true, false);
    }

    _allowAccount(_principal[from], from);
    FHE.allowThis(_totalPrincipal);
    FHE.allowThis(_pendingMorphoPrincipal);

    FHE.allowTransient(success, msg.sender);

    emit ConfidentialDeposit(from, acceptedAmount);
    return success;
  }

  /// @notice Closes the ready draw without scanning members; historical members check their own proofs.
  function closeDraw() external returns (euint128) {
    if (block.timestamp < nextDrawAt) {
      revert DrawNotReady(nextDrawAt);
    }

    _harvestAccruedMorphoYield();

    EncryptedSnapshotTree.Node memory root = _membershipTree.root();
    euint128 randomTicket = _scaledRandomTicket(FHE.randEuint64(), root.sum);
    euint64 prize = FHE.select(FHE.gt(root.sum, 0), _prizeReserve, FHE.asEuint64(0));
    _prizeReserve = FHE.sub(_prizeReserve, prize);
    // The public mirror tracks newly funded amount only; encrypted carry remains in _prizeReserve.
    publicPrizeReserve = 0;
    FHE.allowThis(_prizeReserve);
    FHE.allowThis(randomTicket);

    ++_drawId;
    Draw storage draw = draws[_drawId];
    draw.rootHash = root.hash;
    draw.rootSum = root.sum;
    draw.ticket = randomTicket;
    draw.prize = prize;
    draw.remaining = prize;
    draw.upperBound = uint64(_nextMembershipIndex);
    draw.closeBlockNumber = block.number;
    FHE.allowThis(draw.rootSum);
    FHE.allowThis(draw.ticket);
    FHE.allowThis(draw.prize);
    FHE.allowThis(draw.remaining);
    nextDrawAt = block.timestamp + drawInterval;
    emit DrawClosed(_drawId, randomTicket, prize);
    emit DrawSnapshotClosed(
      _drawId,
      root.hash,
      root.sum,
      randomTicket,
      prize,
      prize,
      draw.upperBound,
      block.number
    );
    emit DrawStarted(_drawId + 1, nextDrawAt);
    return randomTicket;
  }

  function checkPrize(
    uint256 drawId_,
    address beneficiary,
    uint256 index,
    uint64 generation,
    bytes32 balanceHandle,
    bytes32[] calldata siblingHashes,
    bytes32[] calldata siblingSums,
    bytes32[] calldata parentSums
  ) external {
    if (
      drawId_ == 0 ||
      drawId_ > _drawId ||
      beneficiary == address(0) ||
      generation == 0 ||
      index >= draws[drawId_].upperBound
    ) revert InvalidDrawClaim();
    if (checked[drawId_][beneficiary]) {
      revert DrawAlreadyChecked(drawId_, beneficiary);
    }
    if (
      siblingHashes.length != EncryptedSnapshotTree.DEPTH ||
      siblingSums.length != EncryptedSnapshotTree.DEPTH ||
      parentSums.length != EncryptedSnapshotTree.DEPTH
    ) revert InvalidDrawProof();

    euint64 balance = euint64.wrap(balanceHandle);
    EncryptedSnapshotTree.Node memory node = EncryptedSnapshotTree.Node(
      EncryptedSnapshotTree.leaf(beneficiary, generation, balance),
      balance
    );
    for (uint256 level = 0; level < EncryptedSnapshotTree.DEPTH; ++level) {
      EncryptedSnapshotTree.Node memory sibling = EncryptedSnapshotTree.Node(
        siblingHashes[level],
        euint64.wrap(siblingSums[level])
      );
      node.hash =
        ((index >> level) & 1) == 0
          ? EncryptedSnapshotTree.parent(node, sibling)
          : EncryptedSnapshotTree.parent(sibling, node);
      node.sum = euint64.wrap(parentSums[level]);
    }
    Draw storage draw = draws[drawId_];
    if (node.hash != draw.rootHash || euint64.unwrap(node.sum) != euint64.unwrap(draw.rootSum)) {
      revert InvalidDrawProof();
    }

    euint64 start = _prefixBefore(index, siblingSums);
    euint128 end = FHE.add(FHE.asEuint128(start), FHE.asEuint128(balance));
    ebool winner = FHE.and(FHE.ge(draw.ticket, FHE.asEuint128(start)), FHE.lt(draw.ticket, end));
    euint64 award = FHE.select(winner, draw.prize, FHE.asEuint64(0));
    checked[drawId_][beneficiary] = true;
    _awardOf[drawId_][beneficiary] = award;
    draw.remaining = FHE.sub(draw.remaining, award);
    _winnings[beneficiary] = FHE.add(_winnings[beneficiary], award);
    FHE.allowThis(draw.remaining);
    _allowAccount(award, beneficiary);
    _allowAccount(_winnings[beneficiary], beneficiary);
    emit PrizeChecked(drawId_, beneficiary);
  }

  /// @dev Reduces left siblings in a balanced tree; depth-32 proof work stays logarithmic.
  function _prefixBefore(uint256 index, bytes32[] calldata siblingSums) internal returns (euint64) {
    euint64[] memory terms = new euint64[](EncryptedSnapshotTree.DEPTH);
    uint256 count = 0;
    for (uint256 level = 0; level < EncryptedSnapshotTree.DEPTH; ++level) {
      if (((index >> level) & 1) == 1) {
        terms[count++] = euint64.wrap(siblingSums[level]);
      }
    }
    while (count > 1) {
      uint256 next = 0;
      for (uint256 i = 0; i < count; i += 2) {
        terms[next++] = i + 1 < count ? FHE.add(terms[i], terms[i + 1]) : terms[i];
      }
      count = next;
    }
    return count == 0 ? _membershipTree.zero : terms[0];
  }

  /// @notice Maps a uniform 64-bit encrypted word into `[0, totalPrincipal)`.
  function _scaledRandomTicket(
    euint64 randomWord,
    euint64 totalPrincipal
  ) internal returns (euint128) {
    euint128 product = FHE.mul(FHE.asEuint128(randomWord), FHE.asEuint128(totalPrincipal));
    return FHE.shr(product, 64);
  }

  /// @notice Moves the caller's prize winnings from the pool to their cUSDC balance.
  function claimPrize() external returns (euint64) {
    euint64 amount = _winnings[msg.sender];
    _winnings[msg.sender] = FHE.asEuint64(0);

    _allowAccount(_winnings[msg.sender], msg.sender);
    FHE.allowThis(amount);
    FHE.allow(amount, address(token));

    token.confidentialTransfer(msg.sender, amount);

    emit PrizeClaimed(msg.sender, amount);
    return amount;
  }

  /// @notice Moves the caller's prize winnings directly into their active pool savings.
  function claimPrizeToSavings() external returns (euint64) {
    euint64 amount = _winnings[msg.sender];
    euint64 nextPrincipal = FHE.add(_principal[msg.sender], amount);
    euint64 nextTotal = FHE.add(_totalPrincipal, amount);
    ebool accepted = FHE.and(
      FHE.and(
        FHE.le(nextPrincipal, MAX_USER_PRINCIPAL),
        FHE.ge(nextPrincipal, _principal[msg.sender])
      ),
      FHE.ge(nextTotal, _totalPrincipal)
    );
    euint64 credited = FHE.select(accepted, amount, FHE.asEuint64(0));
    _winnings[msg.sender] = FHE.sub(amount, credited);

    _principal[msg.sender] = FHE.add(_principal[msg.sender], credited);
    _totalPrincipal = FHE.add(_totalPrincipal, credited);
    _pendingMorphoPrincipal = FHE.add(_pendingMorphoPrincipal, credited);
    ++morphoPendingDepositCount;
    if (_membershipIndexPlusOne[msg.sender] == 0) {
      PendingAdmission storage pending = _pendingAdmissions[msg.sender];
      pending.balance = _principal[msg.sender];
      _pendingAdmissionPrincipal = FHE.add(_pendingAdmissionPrincipal, credited);
      FHE.allowThis(_pendingAdmissionPrincipal);
      _refreshAdmission(msg.sender, pending);
    } else {
      _updateMemberLeaf(msg.sender, credited, true, false);
    }

    _allowAccount(_winnings[msg.sender], msg.sender);
    _allowAccount(_principal[msg.sender], msg.sender);
    FHE.allowThis(_totalPrincipal);
    FHE.allowThis(_pendingMorphoPrincipal);

    emit PrizeAddedToSavings(msg.sender, amount);
    return amount;
  }

  /// @notice Lets another address decrypt the caller's pool balance and winnings.
  function setDecryptDelegate(address delegate) external {
    _decryptDelegate[msg.sender] = delegate;
    _allowAccount(_principal[msg.sender], msg.sender);
    _allowAccount(_winnings[msg.sender], msg.sender);

    emit DecryptDelegateUpdated(msg.sender, delegate);
  }

  /// @notice Configures optional timed Morpho principal routing.
  function setMorphoYieldAdapter(
    IMorphoPrizeYieldAdapter adapter,
    uint256 unwrapInterval
  ) external {
    _onlyOwner();
    if (unwrapInterval > 0 && address(adapter) == address(0)) {
      revert MorphoYieldAdapterNotSet();
    }

    morphoYieldAdapter = adapter;
    morphoUnwrapInterval = unwrapInterval;
    lastMorphoUnwrapAt = block.timestamp;

    emit MorphoYieldAdapterUpdated(address(adapter), unwrapInterval);
  }

  /// @notice Supplies finalized USDC batch principal from the adapter into Morpho.
  function supplyFinalizedMorphoPrincipal(uint256 assets) external returns (uint256 shares) {
    _onlyOwner();
    IMorphoPrizeYieldAdapter adapter = _requireMorphoYieldAdapter();

    shares = adapter.supplyPoolPrincipal(assets);
    emit MorphoPrincipalSupplied(assets, shares);
  }

  /// @notice Supplies all finalized USDC principal currently held by the adapter.
  function supplyAvailableMorphoPrincipal()
    external
    returns (uint256 assetsSupplied, uint256 sharesSupplied)
  {
    IMorphoPrizeYieldAdapter adapter = _requireMorphoYieldAdapter();

    (assetsSupplied, sharesSupplied) = adapter.supplyAvailablePrincipal();
    emit MorphoPrincipalSupplied(assetsSupplied, sharesSupplied);
  }

  function _harvestAccruedMorphoYield() internal returns (uint256 harvestedAssets) {
    IMorphoPrizeYieldAdapter adapter = morphoYieldAdapter;
    if (address(adapter) == address(0)) {
      return 0;
    }

    harvestedAssets = adapter.harvestYieldToPrizePool(0);
    if (harvestedAssets > 0) {
      emit MorphoYieldHarvested(harvestedAssets);
    }
  }

  /// @notice Restores Morpho principal as cUSDC liquidity in the pool.
  // Owner-only entry reaches an immutable pool-bound adapter protected by onlyPrizePool and nonReentrant.
  // aderyn-fp-next-line(reentrancy-state-change)
  function restoreMorphoPrincipal(uint256 assets) external returns (uint256 restoredAssets) {
    _onlyOwner();
    if (_unfundedWithdrawalBatchCount != 0) {
      revert ManualMorphoRestoreBlocked();
    }
    if (assets > type(uint64).max) {
      revert InvalidMorphoRestoreAmount(assets);
    }
    IMorphoPrizeYieldAdapter adapter = _requireMorphoYieldAdapter();

    restoredAssets = adapter.restorePrincipalToPool(assets); // aderyn-fp(reentrancy-state-change)
    if (restoredAssets != assets) {
      revert WithdrawalRestorationMismatch(assets, restoredAssets);
    }
    _pendingMorphoPrincipal = FHE.add(
      _pendingMorphoPrincipal,
      FHE.asEuint64(uint64(restoredAssets))
    );
    ++morphoPendingDepositCount;
    FHE.allowThis(_pendingMorphoPrincipal);
    emit MorphoPrincipalRestored(restoredAssets);
  }

  /// @notice Withdraws up to the requested amount back to the caller as cUSDC.
  function withdraw(externalEuint64, bytes calldata) external pure returns (euint64) {
    revert QueuedWithdrawalsOnly();
  }

  /// @notice Withdraws up to the requested amount and unwraps it to USDC for `to`.
  function withdrawToUsdc(
    externalEuint64,
    bytes calldata,
    address
  ) external pure returns (bytes32) {
    revert QueuedWithdrawalsOnly();
  }

  /// @notice Queues up to the requested principal amount for asynchronous withdrawal settlement.
  function requestWithdrawal(
    externalEuint64 encryptedAmount,
    bytes calldata inputProof
  ) external returns (uint256 batchId) {
    euint64 requested = FHE.fromExternal(encryptedAmount, inputProof);
    return _queueWithdrawal(msg.sender, requested, false);
  }

  function _queueWithdrawal(
    address account,
    euint64 requested,
    bool clearMembership
  ) internal returns (uint256 batchId) {
    _requireMorphoYieldAdapter();
    _rollExpiredWithdrawalBatch();
    (euint64 accepted, euint64 morphoPortion) = _movePrincipalToWithdrawal(
      account,
      requested,
      clearMembership
    );

    batchId = currentWithdrawalBatchId;
    if (_withdrawalBatchStatus[batchId] != WithdrawalBatchStatus.Open) {
      revert WithdrawalBatchNotOpen(batchId);
    }

    if (!_hasWithdrawalClaim[batchId][account]) {
      ++_withdrawalBatchClaimantCount[batchId];
      _withdrawalAccounts[batchId].push(account);
    }
    if (_withdrawalBatchRequestCount[batchId] == 0) {
      ++_unfundedWithdrawalBatchCount;
    }
    _withdrawalClaims[batchId][account] = FHE.add(_withdrawalClaims[batchId][account], accepted);
    _hasWithdrawalClaim[batchId][account] = true;
    _withdrawalBatchTotal[batchId] = FHE.add(_withdrawalBatchTotal[batchId], accepted);
    _withdrawalBatchMorphoRestore[batchId] = FHE.add(
      _withdrawalBatchMorphoRestore[batchId],
      morphoPortion
    );
    ++_withdrawalBatchRequestCount[batchId];

    _allowAccount(_withdrawalClaims[batchId][account], account);
    FHE.allowThis(_withdrawalBatchTotal[batchId]);
    FHE.allowThis(_withdrawalBatchMorphoRestore[batchId]);

    emit WithdrawalRequested(account, batchId, accepted);
  }

  /// @notice Closes an expired nonempty batch and publishes its aggregate handles for settlement.
  function closeWithdrawalBatch(uint256 batchId) external {
    _closeWithdrawalBatch(batchId);
  }

  /// @notice Verifies aggregate clear amounts and restores exactly the Morpho-backed shortfall.
  function settleWithdrawalBatch(
    uint256 batchId,
    uint64 cleartextTotal,
    uint64 cleartextMorphoRestore,
    bytes calldata decryptionProof
  ) external returns (uint256 restoredAssets) {
    if (_withdrawalBatchStatus[batchId] == WithdrawalBatchStatus.Funded) {
      revert WithdrawalBatchAlreadyFunded(batchId);
    }
    if (_withdrawalBatchStatus[batchId] != WithdrawalBatchStatus.Closed) {
      revert WithdrawalBatchNotClosed(batchId);
    }
    if (cleartextMorphoRestore > cleartextTotal) {
      revert InvalidWithdrawalBatchAmounts(cleartextTotal, cleartextMorphoRestore);
    }

    bytes32[] memory handles = new bytes32[](2);
    handles[0] = euint64.unwrap(_withdrawalBatchTotal[batchId]);
    handles[1] = euint64.unwrap(_withdrawalBatchMorphoRestore[batchId]);
    FHE.checkSignatures(
      handles,
      abi.encode(cleartextTotal, cleartextMorphoRestore),
      decryptionProof
    );

    if (cleartextMorphoRestore > 0) {
      // The adapter accepts calls only from this pool and serializes its state with nonReentrant.
      // aderyn-fp-next-line(reentrancy-state-change)
      restoredAssets = _requireMorphoYieldAdapter().restorePrincipalToPool(cleartextMorphoRestore);
      if (restoredAssets != cleartextMorphoRestore) {
        revert WithdrawalRestorationMismatch(cleartextMorphoRestore, restoredAssets);
      }
      emit MorphoPrincipalRestored(restoredAssets);
    }

    _withdrawalBatchStatus[batchId] = WithdrawalBatchStatus.Funded;
    _withdrawalBatchRestoredAmount[batchId] = cleartextMorphoRestore;
    --_unfundedWithdrawalBatchCount;

    emit WithdrawalBatchFunded(batchId, cleartextTotal, cleartextMorphoRestore);
  }

  /// @notice Claims a funded queued withdrawal into the wrapper's USDC finalization flow.
  function claimWithdrawalToUsdc(
    uint256 batchId,
    address to
  ) external returns (bytes32 unwrapRequestId) {
    return _claimWithdrawalToUsdc(batchId, msg.sender, to);
  }

  /// @notice Anyone may progress a withdrawal, but only its owner can receive the funds.
  function processWithdrawal(
    uint256 batchId,
    address account
  ) external returns (bytes32 unwrapRequestId) {
    return _claimWithdrawalToUsdc(batchId, account, account);
  }

  function _claimWithdrawalToUsdc(
    uint256 batchId,
    address account,
    address to
  ) internal returns (bytes32 unwrapRequestId) {
    if (_withdrawalBatchStatus[batchId] != WithdrawalBatchStatus.Funded) {
      revert WithdrawalBatchNotFunded(batchId);
    }
    if (!_hasWithdrawalClaim[batchId][account]) {
      revert NoWithdrawalClaim(batchId, account);
    }
    if (to == address(0)) {
      revert InvalidWithdrawalReceiver();
    }

    euint64 amount = _withdrawalClaims[batchId][account];

    _withdrawalClaims[batchId][account] = FHE.asEuint64(0);
    _hasWithdrawalClaim[batchId][account] = false;
    --_withdrawalBatchClaimantCount[batchId];
    _allowAccount(_withdrawalClaims[batchId][account], account);
    FHE.allowTransient(amount, address(token));

    unwrapRequestId = IERC7984ERC20WrapperInternalAmount(address(token)).unwrap(
      address(this),
      to,
      amount
    );
    withdrawalUnwrapRequest[batchId][account] = unwrapRequestId;

    emit WithdrawalClaimedToUsdc(account, batchId, to, amount, unwrapRequestId);
  }

  function _movePrincipalToWithdrawal(
    address account,
    euint64 requested,
    bool clearMembership
  ) internal returns (euint64 accepted, euint64 morphoPortion) {
    euint64 available = _principal[account];
    accepted = FHE.min(requested, available);
    euint64 liquidPortion = FHE.min(accepted, _pendingMorphoPrincipal);
    morphoPortion = FHE.sub(accepted, liquidPortion);

    _principal[account] = FHE.sub(available, accepted);
    _totalPrincipal = FHE.sub(_totalPrincipal, accepted);
    _pendingMorphoPrincipal = FHE.sub(_pendingMorphoPrincipal, liquidPortion);

    if (_membershipIndexPlusOne[account] == 0) {
      PendingAdmission storage pending = _pendingAdmissions[account];
      pending.balance = _principal[account];
      _pendingAdmissionPrincipal = FHE.sub(_pendingAdmissionPrincipal, accepted);
      FHE.allowThis(_pendingAdmissionPrincipal);
      _refreshAdmission(account, pending);
    } else {
      _updateMemberLeaf(account, accepted, false, clearMembership);
    }

    _allowAccount(_principal[account], account);
    FHE.allowThis(_totalPrincipal);
    FHE.allowThis(_pendingMorphoPrincipal);
  }

  function _rollExpiredWithdrawalBatch() internal {
    uint256 batchId = currentWithdrawalBatchId;
    if (_withdrawalBatchStatus[batchId] != WithdrawalBatchStatus.Open) {
      return;
    }
    if (block.timestamp < _withdrawalBatchClosesAt[batchId]) {
      return;
    }

    if (_withdrawalBatchRequestCount[batchId] == 0) {
      currentWithdrawalBatchId = batchId + 1;
      _openWithdrawalBatch(currentWithdrawalBatchId);
      return;
    }

    _closeWithdrawalBatch(batchId);
  }

  function _closeWithdrawalBatch(uint256 batchId) internal {
    if (_withdrawalBatchStatus[batchId] != WithdrawalBatchStatus.Open) {
      revert WithdrawalBatchNotOpen(batchId);
    }
    uint256 closesAt = _withdrawalBatchClosesAt[batchId];
    if (block.timestamp < closesAt) {
      revert WithdrawalBatchNotReady(closesAt);
    }
    if (_withdrawalBatchRequestCount[batchId] == 0) {
      revert WithdrawalBatchEmpty(batchId);
    }

    _withdrawalBatchStatus[batchId] = WithdrawalBatchStatus.Closed;
    FHE.makePubliclyDecryptable(_withdrawalBatchTotal[batchId]);
    FHE.makePubliclyDecryptable(_withdrawalBatchMorphoRestore[batchId]);

    emit WithdrawalBatchClosed(
      batchId,
      _withdrawalBatchTotal[batchId],
      _withdrawalBatchMorphoRestore[batchId]
    );

    if (batchId == currentWithdrawalBatchId) {
      currentWithdrawalBatchId = batchId + 1;
      _openWithdrawalBatch(currentWithdrawalBatchId);
    }
  }

  function _openWithdrawalBatch(uint256 batchId) internal {
    _withdrawalBatchStatus[batchId] = WithdrawalBatchStatus.Open;
    _withdrawalBatchClosesAt[batchId] = block.timestamp + withdrawalBatchInterval;
    emit WithdrawalBatchOpened(batchId, _withdrawalBatchClosesAt[batchId]);
  }

  /// @notice Reads an optional decrypt delegate address from deposit callback data.
  function _decodeDecryptDelegate(bytes calldata data) internal pure returns (address) {
    if (data.length != 32) {
      return address(0);
    }
    return abi.decode(data, (address));
  }

  /// @notice Requests a timed pending-principal unwrap for Morpho keepers.
  function requestMorphoPrincipalUnwrap() external returns (bytes32 unwrapRequestId) {
    if (morphoPendingDepositCount == 0) {
      revert NoPendingMorphoPrincipal();
    }

    uint256 readyAt = lastMorphoUnwrapAt + morphoUnwrapInterval;
    if (block.timestamp < readyAt) {
      revert MorphoUnwrapNotReady(readyAt);
    }

    return _requestMorphoPrincipalUnwrap();
  }

  function _requestMorphoPrincipalUnwrap() internal returns (bytes32 unwrapRequestId) {
    if (address(morphoYieldAdapter) == address(0) || morphoUnwrapInterval == 0) {
      revert MorphoYieldAdapterNotSet();
    }

    euint64 amount = _pendingMorphoPrincipal;
    uint256 depositCount = morphoPendingDepositCount;

    _pendingMorphoPrincipal = FHE.asEuint64(0);
    morphoPendingDepositCount = 0;
    lastMorphoUnwrapAt = block.timestamp;
    FHE.allowThis(_pendingMorphoPrincipal);
    FHE.allow(amount, address(token));

    unwrapRequestId = IERC7984ERC20WrapperInternalAmount(address(token)).unwrap(
      address(this),
      address(morphoYieldAdapter),
      amount
    );

    emit MorphoPrincipalUnwrapRequested(unwrapRequestId, depositCount);
  }

  /// @notice Reads the public prize amount carried with sponsor funding data.
  function _decodePrizeFundingAmount(bytes calldata data) internal pure returns (uint64) {
    if (data.length != 36) {
      revert InvalidPrizeFundingData();
    }
    return abi.decode(data[4:], (uint64));
  }

  /// @notice Grants the pool, account, and optional delegate access to an encrypted value.
  function _allowAccount(euint64 value, address account) internal {
    FHE.allowThis(value);
    FHE.allow(value, account);

    address delegate = _decryptDelegate[account];
    if (delegate != address(0)) {
      FHE.allow(value, delegate);
    }
  }

  function _refreshAdmission(address account, PendingAdmission storage pending) internal {
    ++pending.nonce;
    pending.marker = FHE.gt(pending.balance, 0);
    pending.requested = true;
    FHE.allowThis(pending.balance);
    _allowAccount(pending.balance, account);
    FHE.allowThis(pending.marker);
    FHE.makePubliclyDecryptable(pending.marker);
    emit AdmissionRequested(account, pending.nonce, pending.marker);
  }

  /// @notice Verifies the latest positive-balance proof before allocating a draw slot.
  function finalizeAdmission(
    address account,
    uint256 nonce,
    bool positive,
    bytes calldata proof
  ) external {
    PendingAdmission storage pending = _pendingAdmissions[account];
    if (_membershipIndexPlusOne[account] != 0 || !pending.requested || pending.nonce != nonce) {
      revert StaleAdmission();
    }
    bytes32[] memory handles = new bytes32[](1);
    handles[0] = ebool.unwrap(pending.marker);
    FHE.checkSignatures(handles, abi.encode(positive), proof);
    euint64 balance = pending.balance;
    pending.balance = FHE.asEuint64(0);
    pending.requested = false;
    ++pending.nonce;
    _pendingAdmissionPrincipal = FHE.sub(_pendingAdmissionPrincipal, balance);
    FHE.allowThis(_pendingAdmissionPrincipal);
    if (!positive) {
      return;
    }

    uint256 index;
    if (_freeSlots.length != 0) {
      index = _freeSlots[_freeSlots.length - 1];
      _freeSlots.pop();
    } else {
      if (_nextMembershipIndex >= (uint256(1) << EncryptedSnapshotTree.DEPTH)) {
        revert TreeFull();
      }
      index = _nextMembershipIndex++;
    }
    uint64 generation = ++_generationOf[index];
    _membershipIndexPlusOne[account] = index + 1;
    _activeParticipantIndexPlusOne[account] = _participants.length + 1;
    _participants.push(account);
    _membershipTree.update(account, index, generation, balance, balance, true, false);
    emit SlotAssigned(account, index, generation);
  }

  /// @notice Queues the full balance for settlement, then releases its draw slot.
  function exitMembership() external {
    uint256 membershipPosition = _membershipIndexPlusOne[msg.sender];
    if (membershipPosition == 0) {
      return;
    }
    _queueWithdrawal(msg.sender, _principal[msg.sender], true);
    uint256 index = membershipPosition - 1;
    uint64 generation = _generationOf[index];
    delete _membershipIndexPlusOne[msg.sender];
    uint256 memberPosition = _activeParticipantIndexPlusOne[msg.sender] - 1;
    uint256 last = _participants.length - 1;
    if (memberPosition != last) {
      address replacement = _participants[last];
      _participants[memberPosition] = replacement;
      _activeParticipantIndexPlusOne[replacement] = memberPosition + 1;
    }
    _participants.pop();
    delete _activeParticipantIndexPlusOne[msg.sender];
    _freeSlots.push(index);
    emit SlotReleased(msg.sender, index, generation);
  }

  function _updateMemberLeaf(address account, euint64 delta, bool addition, bool clear) internal {
    uint256 position = _membershipIndexPlusOne[account];
    _membershipTree.update(
      account,
      position - 1,
      _generationOf[position - 1],
      _principal[account],
      delta,
      addition,
      clear
    );
  }

  /// @notice Restricts keeper/admin helpers to the deployer owner.
  function _onlyOwner() internal view {
    if (msg.sender != owner) {
      revert OnlyOwner();
    }
  }

  /// @notice Returns the configured Morpho adapter or reverts if disabled.
  function _requireMorphoYieldAdapter() internal view returns (IMorphoPrizeYieldAdapter adapter) {
    adapter = morphoYieldAdapter;
    if (address(adapter) == address(0)) {
      revert MorphoYieldAdapterNotSet();
    }
  }

  /// @notice Encrypted principal currently deposited by an account.
  function encryptedPrincipalOf(address account) external view returns (euint64) {
    return _principal[account];
  }

  function pendingAdmissionOf(
    address account
  ) external view returns (PendingAdmission memory pending) {
    pending = _pendingAdmissions[account];
    if (euint64.unwrap(pending.balance) == bytes32(0)) {
      pending.balance = _membershipTree.zero;
    }
  }

  function membershipIndexOf(address account) external view returns (uint256) {
    return _membershipIndexPlusOne[account];
  }

  function generationOf(uint256 index) external view returns (uint64) {
    return _generationOf[index];
  }

  function activeMemberCount() external view returns (uint256) {
    return _participants.length;
  }

  function membershipTreeDepth() external pure returns (uint8) {
    return EncryptedSnapshotTree.DEPTH;
  }

  /// @notice Canonical zero encrypted handle used by every empty tree node.
  function membershipZero() external view returns (euint64) {
    return _membershipTree.zero;
  }

  function emptyHash(uint256 level) external view returns (bytes32) {
    return _membershipTree.emptyHash[level];
  }

  function membershipNode(
    uint256 level,
    uint256 index
  ) external view returns (bytes32 hash, euint64 sum) {
    EncryptedSnapshotTree.Node memory node = _membershipTree.get(level, index);
    return (node.hash, node.sum);
  }

  /// @notice Encrypted unclaimed winnings for an account.
  function encryptedWinningsOf(address account) external view returns (euint64) {
    return _winnings[account];
  }

  /// @notice Immutable outcome for one checked draw, independent of later claims or reinvestment.
  function encryptedAwardOf(uint256 drawId_, address beneficiary) external view returns (euint64) {
    return _awardOf[drawId_][beneficiary];
  }

  /// @notice Address allowed to decrypt an account's pool values.
  function decryptDelegateOf(address account) external view returns (address) {
    return _decryptDelegate[account];
  }

  /// @notice Encrypted total principal held by the pool.
  function encryptedTotalPrincipal() external view returns (euint64) {
    return _totalPrincipal;
  }

  function encryptedPendingAdmissionPrincipal() external view returns (euint64) {
    return _pendingAdmissionPrincipal;
  }

  /// @notice Encrypted prize reserve available for future draws.
  function encryptedPrizeReserve() external view returns (euint64) {
    return _prizeReserve;
  }

  /// @notice Encrypted principal waiting to be included in a Morpho batch.
  function encryptedPendingMorphoPrincipal() external view returns (euint64) {
    return _pendingMorphoPrincipal;
  }

  /// @notice Public accrued Morpho surplus available to harvest as a prize.
  function morphoAccruedYieldAssets() external view returns (uint256) {
    if (address(morphoYieldAdapter) == address(0)) {
      return 0;
    }
    return morphoYieldAdapter.accruedYieldAssets();
  }

  /// @notice Public USDC principal finalized into the adapter and ready to supply.
  function morphoAvailablePrincipalAssets() external view returns (uint256) {
    if (address(morphoYieldAdapter) == address(0)) {
      return 0;
    }
    return morphoYieldAdapter.availablePrincipalAssets();
  }

  /// @notice Number of known participants in the bounded draw list.
  function participantCount() external view returns (uint256) {
    return _participants.length;
  }

  /// @notice Participant address at a draw-list index.
  function participantAt(uint256 index) external view returns (address) {
    return _participants[index];
  }

  /// @notice Number of draws already closed.
  function drawId() external view returns (uint256) {
    return _drawId;
  }

  function encryptedWithdrawalBatchTotal(uint256 batchId) external view returns (euint64) {
    return _withdrawalBatchTotal[batchId];
  }

  function encryptedWithdrawalBatchMorphoRestore(uint256 batchId) external view returns (euint64) {
    return _withdrawalBatchMorphoRestore[batchId];
  }

  function encryptedWithdrawalClaimOf(
    uint256 batchId,
    address account
  ) external view returns (euint64) {
    return _withdrawalClaims[batchId][account];
  }

  function withdrawalBatchFunded(uint256 batchId) external view returns (bool) {
    return _withdrawalBatchStatus[batchId] == WithdrawalBatchStatus.Funded;
  }

  function withdrawalBatchStatus(uint256 batchId) external view returns (WithdrawalBatchStatus) {
    return _withdrawalBatchStatus[batchId];
  }

  function withdrawalBatchClosesAt(uint256 batchId) external view returns (uint256) {
    return _withdrawalBatchClosesAt[batchId];
  }

  function withdrawalBatchRestoredAmount(uint256 batchId) external view returns (uint64) {
    return _withdrawalBatchRestoredAmount[batchId];
  }

  function withdrawalBatchRequestCount(uint256 batchId) external view returns (uint256) {
    return _withdrawalBatchRequestCount[batchId];
  }

  function withdrawalBatchClaimantCount(uint256 batchId) external view returns (uint256) {
    return _withdrawalBatchClaimantCount[batchId];
  }

  function hasWithdrawalClaim(uint256 batchId, address account) external view returns (bool) {
    return _hasWithdrawalClaim[batchId][account];
  }
}
