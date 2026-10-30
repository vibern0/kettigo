// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
// Compile the unchanged production token fixtures in this isolated project.
import {MockUSDC} from "../../../contracts/MockUSDC.sol";
import {ConfidentialUSDC} from "../../../contracts/ConfidentialUSDC.sol";

interface IP2 { function poseidon(uint256[2] calldata) external view returns (uint256); }
interface IP3 { function poseidon(uint256[3] calldata) external view returns (uint256); }
interface IP4 { function poseidon(uint256[4] calldata) external view returns (uint256); }
interface IP6 { function poseidon(uint256[6] calldata) external view returns (uint256); }
interface IV8 { function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[8] calldata) external view returns (bool); }
interface IV73 { function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[73] calldata) external view returns (bool); }

/// @notice LOCAL SECURITY EXPERIMENT ONLY. Mode 0 deliberately demonstrates an
/// unsound commitment-only integration; deterministic draws are unrestricted.
/// No production deployment, audit, timing/keeper policy, or yield integration.
contract ClaimLabPool is ZamaEthereumConfig, ReentrancyGuard {
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    struct Node { bytes32 hash; euint64 sum; }
    struct Draw {
        bytes32 rootHash; euint64 sum; euint64 ticket; euint64 prize;
        euint64 remaining; uint256 count; uint64 clearTicket; uint64 clearTotal; bool revealed;
    }
    IERC7984 public immutable token;
    uint8 public immutable mode;
    uint8 public immutable depth;
    IP2 immutable p2; IP3 immutable p3; IP4 immutable p4; IP6 immutable p6;
    address immutable verifier;
    euint64 public zero;
    euint64 public reserve;
    mapping(uint256 => bytes32) public emptyHash;
    mapping(uint256 => mapping(uint256 => Node)) private nodes;
    mapping(address => uint256) public indexPlusOne;
    mapping(uint256 => Draw) public draws;
    mapping(uint256 => mapping(address => bool)) public checked;
    mapping(uint256 => mapping(address => euint64)) public awardOf;
    uint256 public participantCount;
    uint256 public drawCount;
    uint256 public storedNodeCount;

    error InvalidProof(); error NotEligible(); error AlreadyChecked(); error WrongMode(); error OnlyToken();
    event NodeUpdated(uint256 level, uint256 index, bytes32 hash, euint64 sum);
    event Closed(uint256 indexed id, bytes32 rootHash, euint64 sum, euint64 ticket);

    constructor(address token_, uint8 mode_, uint8 depth_, address h2, address h3, address h4, address h6, address verifier_) {
        require(mode_ <= 2 && depth_ > 0 && depth_ <= 48);
        require(mode_ != 0 || depth_ == 8);
        require(mode_ != 1 || depth_ == 32);
        token = IERC7984(token_); mode = mode_; depth = depth_;
        p2 = IP2(h2); p3 = IP3(h3); p4 = IP4(h4); p6 = IP6(h6); verifier = verifier_;
        zero = FHE.asEuint64(0); FHE.allowThis(zero); reserve = zero;
        emptyHash[0] = _leaf(address(0), zero, 0);
        for (uint256 l; l < depth_; l++) {
            Node memory empty = Node(emptyHash[l], zero);
            emptyHash[l + 1] = _parent(empty, empty);
        }
    }
    function getNode(uint256 l, uint256 i) public view returns (Node memory n) {
        n = nodes[l][i];
        if (euint64.unwrap(n.sum) == bytes32(0)) n = Node(emptyHash[l], zero);
    }
    function principalOf(address account) public view returns (euint64) {
        uint256 position = indexPlusOne[account];
        return position == 0 ? zero : getNode(0, position - 1).sum;
    }
    function total() public view returns (euint64) { return getNode(depth, 0).sum; }
    function _leaf(address account, euint64 balance, uint256 commitment) private view returns (bytes32) {
        uint256 h = uint256(euint64.unwrap(balance));
        if (mode == 0) return bytes32(p4.poseidon([uint256(uint160(account)), uint256(uint128(h)), h >> 128, commitment]));
        if (mode == 1) return bytes32(p3.poseidon([uint256(uint160(account)), uint256(uint128(h)), h >> 128]));
        return keccak256(abi.encode(uint8(0), account, balance));
    }
    function _parent(Node memory a, Node memory b) private view returns (bytes32) {
        if (mode == 0) return bytes32(p2.poseidon([uint256(a.hash), uint256(b.hash)]));
        if (mode == 1) {
            uint256 x = uint256(euint64.unwrap(a.sum)); uint256 y = uint256(euint64.unwrap(b.sum));
            return bytes32(p6.poseidon([uint256(a.hash), uint256(uint128(x)), x >> 128, uint256(b.hash), uint256(uint128(y)), y >> 128]));
        }
        return keccak256(abi.encode(uint8(1), a.hash, a.sum, b.hash, b.sum));
    }
    function onConfidentialTransferReceived(address, address from, euint64 amount, bytes calldata data) external nonReentrant returns (ebool valid) {
        if (msg.sender != address(token)) revert OnlyToken();
        (bool funding, uint256 commitment) = abi.decode(data, (bool, uint256));
        if (mode == 0 && commitment >= FIELD) revert InvalidProof();
        if (funding) {
            euint64 next = FHE.add(reserve, amount);
            valid = FHE.ge(next, reserve);
            reserve = FHE.select(valid, next, reserve); FHE.allowThis(reserve);
        } else {
            euint64 oldBalance = principalOf(from);
            euint64 next = FHE.add(oldBalance, amount);
            valid = FHE.and(FHE.and(FHE.ge(next, oldBalance), FHE.le(next, 1_000_000_000)), FHE.ge(FHE.add(total(), amount), total()));
            euint64 accepted = FHE.select(valid, amount, zero);
            if (indexPlusOne[from] == 0) {
                require(participantCount < (uint256(1) << depth));
                indexPlusOne[from] = ++participantCount;
            }
            _update(from, accepted, true, commitment);
        }
        FHE.allowTransient(valid, msg.sender);
    }
    function _store(uint256 l, uint256 i, Node memory n) private {
        if (euint64.unwrap(nodes[l][i].sum) == bytes32(0)) storedNodeCount++;
        FHE.allowThis(n.sum); nodes[l][i] = n;
        emit NodeUpdated(l, i, n.hash, n.sum);
    }
    function _update(address account, euint64 delta, bool add, uint256 commitment) private {
        uint256 i = indexPlusOne[account] - 1;
        euint64 balance = add ? FHE.add(getNode(0, i).sum, delta) : FHE.sub(getNode(0, i).sum, delta);
        _store(0, i, Node(_leaf(account, balance, commitment), balance));
        FHE.allow(balance, account);
        // Independent delta updates avoid a linear FHE dependency chain.
        for (uint256 l = 1; l <= depth; l++) {
            i >>= 1;
            Node memory a = getNode(l - 1, i * 2); Node memory b = getNode(l - 1, i * 2 + 1);
            euint64 sum = add ? FHE.add(getNode(l, i).sum, delta) : FHE.sub(getNode(l, i).sum, delta);
            _store(l, i, Node(_parent(a, b), sum));
        }
    }
    function withdraw(externalEuint64 input, bytes calldata inputProof) external nonReentrant {
        if (indexPlusOne[msg.sender] == 0) revert NotEligible();
        euint64 amount = FHE.min(FHE.fromExternal(input, inputProof), principalOf(msg.sender));
        _update(msg.sender, amount, false, 0);
        FHE.allowTransient(amount, address(token));
        token.confidentialTransfer(msg.sender, amount);
    }
    function closeDraw() external {
        euint128 product = FHE.mul(FHE.asEuint128(FHE.randEuint64()), FHE.asEuint128(total()));
        _close(FHE.asEuint64(FHE.shr(product, 64)));
    }
    /// @dev TEST ONLY. This method must never be carried into production.
    function closeAtForTest(uint64 ticket) external { _close(FHE.asEuint64(ticket)); }
    /// @dev TEST ONLY: position two real accounts at opposite ends of a sparse
    /// tree to exercise 32 prefix terms. This is not a population benchmark.
    function assignSparseIndexForTest(address account, uint256 index) external {
        require(indexPlusOne[account] == 0 && index >= participantCount && index < (uint256(1) << depth));
        indexPlusOne[account] = index + 1; participantCount = index + 1;
    }
    function _close(euint64 ticket) private {
        Node memory root = getNode(depth, 0);
        euint64 prize = FHE.select(FHE.gt(root.sum, 0), reserve, zero);
        reserve = FHE.sub(reserve, prize);
        FHE.allowThis(reserve); FHE.allowThis(ticket); FHE.allowThis(prize);
        draws[++drawCount] = Draw(root.hash, root.sum, ticket, prize, prize, participantCount, 0, 0, false);
        emit Closed(drawCount, root.hash, root.sum, ticket);
    }
    function scope(uint256 id) public view returns (uint256) { return uint256(keccak256(abi.encode(block.chainid, address(this), id))) % FIELD; }
    function _eligible(uint256 id, address account, uint256 index) private view {
        if (id == 0 || id > drawCount || indexPlusOne[account] != index + 1 || index >= draws[id].count) revert NotEligible();
        if (checked[id][account]) revert AlreadyChecked();
    }
    function _settle(uint256 id, address account, uint256 index, euint64 balance, euint64[] memory siblings) private {
        euint64[] memory terms = new euint64[](depth); uint256 count;
        for (uint256 l; l < depth; l++) if (((index >> l) & 1) == 1) terms[count++] = siblings[l];
        while (count > 1) {
            uint256 next;
            for (uint256 i; i < count; i += 2) terms[next++] = i + 1 < count ? FHE.add(terms[i], terms[i + 1]) : terms[i];
            count = next;
        }
        euint64 start = count == 0 ? zero : terms[0];
        Draw storage d = draws[id];
        ebool winner = FHE.and(FHE.ge(d.ticket, start), FHE.lt(d.ticket, FHE.add(start, balance)));
        _pay(id, account, FHE.select(winner, d.prize, zero));
    }
    function _pay(uint256 id, address account, euint64 award) private {
        checked[id][account] = true;
        Draw storage d = draws[id]; d.remaining = FHE.sub(d.remaining, award); FHE.allowThis(d.remaining);
        awardOf[id][account] = award; FHE.allowThis(award); FHE.allow(award, account);
        FHE.allowTransient(award, address(token)); token.confidentialTransfer(account, award);
    }
    function claimMerkle(uint256 id, address account, uint256 index, euint64 balance, bytes32[] calldata hashes, euint64[] calldata sums, euint64[] calldata parents) external nonReentrant {
        if (mode != 2) revert WrongMode(); _eligible(id, account, index);
        if (hashes.length != depth || sums.length != depth || parents.length != depth) revert InvalidProof();
        Node memory n = Node(_leaf(account, balance, 0), balance);
        for (uint256 l; l < depth; l++) {
            Node memory sibling = Node(hashes[l], sums[l]);
            n.hash = ((index >> l) & 1) == 0 ? _parent(n, sibling) : _parent(sibling, n);
            n.sum = parents[l];
        }
        if (n.hash != draws[id].rootHash || euint64.unwrap(n.sum) != euint64.unwrap(draws[id].sum)) revert InvalidProof();
        _settle(id, account, index, balance, sums);
    }
    function claimZk(uint256 id, uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[73] calldata s) external nonReentrant {
        if (mode != 1) revert WrongMode();
        address account = address(uint160(s[5])); _eligible(id, account, s[6]);
        uint256 rootSum = uint256(euint64.unwrap(draws[id].sum));
        if (s[1] != uint256(draws[id].rootHash) || s[2] != uint128(rootSum) || s[3] != rootSum >> 128 || s[4] != scope(id)) revert InvalidProof();
        if (!IV73(verifier).verifyProof(a, b, c, s)) revert InvalidProof();
        euint64[] memory siblings = new euint64[](32);
        for (uint256 l; l < 32; l++) siblings[l] = euint64.wrap(bytes32(s[9 + l] | (s[41 + l] << 128)));
        _settle(id, account, s[6], euint64.wrap(bytes32(s[7] | (s[8] << 128))), siblings);
    }
    function publishRangeInputs(uint256 id) external {
        if (mode != 0 || id == 0 || id > drawCount) revert WrongMode();
        FHE.makePubliclyDecryptable(draws[id].ticket); FHE.makePubliclyDecryptable(draws[id].sum);
    }
    function revealRangeInputs(uint256 id, uint64 ticket, uint64 sum, bytes calldata proof) external {
        if (mode != 0 || id == 0 || id > drawCount) revert WrongMode();
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = euint64.unwrap(draws[id].ticket); handles[1] = euint64.unwrap(draws[id].sum);
        FHE.checkSignatures(handles, abi.encode(ticket, sum), proof);
        draws[id].clearTicket = ticket; draws[id].clearTotal = sum; draws[id].revealed = true;
    }
    function claimRange(uint256 id, uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[8] calldata s) external nonReentrant {
        if (mode != 0 || !draws[id].revealed) revert WrongMode();
        address account = address(uint160(s[3]));
        if (id == 0 || id > drawCount || indexPlusOne[account] == 0 || indexPlusOne[account] > draws[id].count) revert NotEligible();
        if (checked[id][account]) revert AlreadyChecked();
        Draw storage d = draws[id];
        if (s[1] != uint256(d.rootHash) || s[2] != scope(id) || s[6] != d.clearTicket || s[7] != d.clearTotal) revert InvalidProof();
        if (!IV8(verifier).verifyProof(a, b, c, s)) revert InvalidProof();
        // Deliberately UNSOUND: this verifier proves a committed interval, but
        // never establishes that interval length equals the encrypted receipt.
        _pay(id, account, FHE.min(d.prize, d.remaining));
    }
}
