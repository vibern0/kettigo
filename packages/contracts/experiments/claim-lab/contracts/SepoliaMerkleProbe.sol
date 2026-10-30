// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Isolated Sepolia research only, with liquid test-token backing.
/// No deterministic draw, sparse fixture, plaintext reveal, ZK mode, or admin
/// withdrawal. Owner closes draws. Not the production protocol or yield pool.
contract SepoliaMerkleProbe is ZamaEthereumConfig, ReentrancyGuard {
    struct Node { bytes32 hash; euint64 sum; }
    struct Draw { bytes32 rootHash; euint64 sum; euint64 ticket; euint64 prize; euint64 remaining; uint256 count; }
    IERC7984 public immutable token;
    address public immutable owner;
    uint8 public immutable depth;
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
    error InvalidProof(); error NotEligible(); error AlreadyChecked(); error OnlyToken(); error OnlyOwner();
    event NodeUpdated(uint256 level, uint256 index, bytes32 hash, euint64 sum);
    event Closed(uint256 indexed id, bytes32 rootHash, euint64 sum, euint64 ticket);

    constructor(address token_, uint8 depth_) {
        require(block.chainid == 11155111 || block.chainid == 31337, "Research network only");
        require(depth_ > 0 && depth_ <= 48);
        token = IERC7984(token_); depth = depth_; owner = msg.sender;
        zero = FHE.asEuint64(0); FHE.allowThis(zero); reserve = zero;
        emptyHash[0] = _leaf(address(0), zero);
        for (uint256 l; l < depth_; l++) { Node memory e = Node(emptyHash[l], zero); emptyHash[l + 1] = _parent(e, e); }
    }
    function getNode(uint256 l, uint256 i) public view returns (Node memory n) {
        n = nodes[l][i]; if (euint64.unwrap(n.sum) == bytes32(0)) n = Node(emptyHash[l], zero);
    }
    function principalOf(address account) public view returns (euint64) { uint256 p = indexPlusOne[account]; return p == 0 ? zero : getNode(0, p - 1).sum; }
    function total() public view returns (euint64) { return getNode(depth, 0).sum; }
    function _leaf(address account, euint64 balance) private pure returns (bytes32) { return keccak256(abi.encode(uint8(0), account, balance)); }
    function _parent(Node memory a, Node memory b) private pure returns (bytes32) { return keccak256(abi.encode(uint8(1), a.hash, a.sum, b.hash, b.sum)); }
    function onConfidentialTransferReceived(address, address from, euint64 amount, bytes calldata data) external nonReentrant returns (ebool valid) {
        if (msg.sender != address(token)) revert OnlyToken();
        (bool funding, uint256 unused) = abi.decode(data, (bool, uint256)); require(unused == 0);
        if (funding) {
            euint64 next = FHE.add(reserve, amount); valid = FHE.ge(next, reserve);
            reserve = FHE.select(valid, next, reserve); FHE.allowThis(reserve);
        } else {
            euint64 oldBalance = principalOf(from); euint64 next = FHE.add(oldBalance, amount);
            valid = FHE.and(FHE.and(FHE.ge(next, oldBalance), FHE.le(next, 1_000_000_000)), FHE.ge(FHE.add(total(), amount), total()));
            euint64 accepted = FHE.select(valid, amount, zero);
            if (indexPlusOne[from] == 0) { require(participantCount < (uint256(1) << depth)); indexPlusOne[from] = ++participantCount; }
            _update(from, accepted, true);
        }
        FHE.allowTransient(valid, msg.sender);
    }
    function _store(uint256 l, uint256 i, Node memory n) private {
        if (euint64.unwrap(nodes[l][i].sum) == bytes32(0)) storedNodeCount++;
        FHE.allowThis(n.sum); nodes[l][i] = n; emit NodeUpdated(l, i, n.hash, n.sum);
    }
    function _update(address account, euint64 delta, bool add) private {
        uint256 i = indexPlusOne[account] - 1;
        euint64 balance = add ? FHE.add(getNode(0, i).sum, delta) : FHE.sub(getNode(0, i).sum, delta);
        _store(0, i, Node(_leaf(account, balance), balance)); FHE.allow(balance, account);
        for (uint256 l = 1; l <= depth; l++) {
            i >>= 1;
            euint64 sum = add ? FHE.add(getNode(l, i).sum, delta) : FHE.sub(getNode(l, i).sum, delta);
            _store(l, i, Node(_parent(getNode(l - 1, i * 2), getNode(l - 1, i * 2 + 1)), sum));
        }
    }
    function withdraw(externalEuint64 input, bytes calldata inputProof) external nonReentrant {
        if (indexPlusOne[msg.sender] == 0) revert NotEligible();
        euint64 amount = FHE.min(FHE.fromExternal(input, inputProof), principalOf(msg.sender));
        _update(msg.sender, amount, false); FHE.allowTransient(amount, address(token)); token.confidentialTransfer(msg.sender, amount);
    }
    function closeDraw() external {
        if (msg.sender != owner) revert OnlyOwner();
        Node memory root = getNode(depth, 0);
        euint128 product = FHE.mul(FHE.asEuint128(FHE.randEuint64()), FHE.asEuint128(root.sum));
        euint64 ticket = FHE.asEuint64(FHE.shr(product, 64));
        euint64 prize = FHE.select(FHE.gt(root.sum, 0), reserve, zero);
        reserve = FHE.sub(reserve, prize); FHE.allowThis(reserve); FHE.allowThis(ticket); FHE.allowThis(prize);
        draws[++drawCount] = Draw(root.hash, root.sum, ticket, prize, prize, participantCount);
        emit Closed(drawCount, root.hash, root.sum, ticket);
    }
    function claimMerkle(uint256 id, address account, uint256 index, euint64 balance, bytes32[] calldata hashes, euint64[] calldata sums, euint64[] calldata parents) external nonReentrant {
        if (id == 0 || id > drawCount || indexPlusOne[account] != index + 1 || index >= draws[id].count) revert NotEligible();
        if (checked[id][account]) revert AlreadyChecked();
        if (hashes.length != depth || sums.length != depth || parents.length != depth) revert InvalidProof();
        Node memory n = Node(_leaf(account, balance), balance);
        for (uint256 l; l < depth; l++) { Node memory s = Node(hashes[l], sums[l]); n.hash = ((index >> l) & 1) == 0 ? _parent(n, s) : _parent(s, n); n.sum = parents[l]; }
        Draw storage d = draws[id];
        if (n.hash != d.rootHash || euint64.unwrap(n.sum) != euint64.unwrap(d.sum)) revert InvalidProof();
        euint64[] memory terms = new euint64[](depth); uint256 count;
        for (uint256 l; l < depth; l++) if (((index >> l) & 1) == 1) terms[count++] = sums[l];
        while (count > 1) { uint256 next; for (uint256 i; i < count; i += 2) terms[next++] = i + 1 < count ? FHE.add(terms[i], terms[i + 1]) : terms[i]; count = next; }
        euint64 start = count == 0 ? zero : terms[0];
        ebool winner = FHE.and(FHE.ge(d.ticket, start), FHE.lt(d.ticket, FHE.add(start, balance)));
        euint64 award = FHE.select(winner, d.prize, zero);
        checked[id][account] = true; d.remaining = FHE.sub(d.remaining, award); FHE.allowThis(d.remaining);
        awardOf[id][account] = award; FHE.allowThis(award); FHE.allow(award, account);
        FHE.allowTransient(award, address(token)); token.confidentialTransfer(account, award);
    }
}
