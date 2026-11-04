// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Research probe only: liquid test-token backing, public positive-bit
/// admission, reusable slots and historical, beneficiary-bound prize checks.
/// No production integration, yield, claim expiry or automatic admission keeper.
contract ReusableMerkleProbe is ZamaEthereumConfig, ReentrancyGuard {
    struct Node { bytes32 hash; euint64 sum; }
    struct Pending { euint64 balance; uint256 nonce; ebool marker; bool requested; }
    struct Draw { bytes32 rootHash; euint64 sum; euint64 ticket; euint64 prize; euint64 remaining; uint256 upperBound; }
    IERC7984 public immutable token;
    address public immutable owner;
    uint8 public immutable depth;
    euint64 public zero;
    euint64 public reserve;
    euint64 private principalTotal;
    euint64 private pendingTotal;
    mapping(uint256 => bytes32) public emptyHash;
    mapping(uint256 => mapping(uint256 => Node)) private nodes;
    mapping(address => Pending) private pending;
    mapping(address => uint256) public indexPlusOne;
    mapping(uint256 => uint64) public generationOf;
    mapping(uint256 => Draw) public draws;
    mapping(uint256 => mapping(address => bool)) public checked;
    mapping(uint256 => mapping(address => euint64)) public awardOf;
    uint256[] private freeSlots;
    uint256 public nextIndex;
    uint256 public activeCount;
    uint256 public drawCount;
    error InvalidProof(); error NotEligible(); error AlreadyChecked();
    error OnlyToken(); error OnlyOwner(); error StaleAdmission(); error TreeFull();
    event AdmissionRequested(address indexed account, uint256 nonce, ebool marker);
    event SlotAssigned(address indexed account, uint256 indexed index, uint64 generation);
    event SlotReleased(address indexed account, uint256 indexed index, uint64 generation);
    event NodeUpdated(uint256 level, uint256 index, bytes32 hash, euint64 sum);
    event Closed(uint256 indexed id, bytes32 rootHash, euint64 sum, euint64 ticket, uint256 upperBound);

    constructor(address token_, uint8 depth_) {
        require(block.chainid == 11155111 || block.chainid == 31337, "Research network only");
        require(depth_ > 0 && depth_ <= 48);
        token = IERC7984(token_); depth = depth_; owner = msg.sender;
        zero = FHE.asEuint64(0); FHE.allowThis(zero);
        reserve = zero; principalTotal = zero; pendingTotal = zero;
        emptyHash[0] = _leaf(address(0), 0, zero);
        for (uint256 l; l < depth_; l++) { Node memory e = Node(emptyHash[l], zero); emptyHash[l + 1] = _parent(e, e); }
    }
    function getNode(uint256 l, uint256 i) public view returns (Node memory n) {
        n = nodes[l][i]; if (euint64.unwrap(n.sum) == bytes32(0)) n = Node(emptyHash[l], zero);
    }
    function pendingAdmissionOf(address account) external view returns (Pending memory p) {
        p = pending[account]; if (euint64.unwrap(p.balance) == bytes32(0)) p.balance = zero;
    }
    function principalOf(address account) public view returns (euint64) {
        uint256 p = indexPlusOne[account];
        if (p != 0) return getNode(0, p - 1).sum;
        euint64 b = pending[account].balance;
        return euint64.unwrap(b) == bytes32(0) ? zero : b;
    }
    function totalPrincipal() external view returns (euint64) { return principalTotal; }
    function totalPending() external view returns (euint64) { return pendingTotal; }
    function activeTotal() external view returns (euint64) { return getNode(depth, 0).sum; }
    function freeSlotCount() external view returns (uint256) { return freeSlots.length; }
    function _leaf(address account, uint64 generation, euint64 balance) private pure returns (bytes32) {
        return keccak256(abi.encode(uint8(0), account, generation, balance));
    }
    function _parent(Node memory a, Node memory b) private pure returns (bytes32) {
        return keccak256(abi.encode(uint8(1), a.hash, a.sum, b.hash, b.sum));
    }
    function _request(address account, euint64 balance) private {
        Pending storage p = pending[account];
        p.balance = balance; FHE.allowThis(balance); FHE.allow(balance, account);
        p.nonce++; p.marker = FHE.gt(balance, 0); p.requested = true;
        FHE.allowThis(p.marker); FHE.makePubliclyDecryptable(p.marker);
        emit AdmissionRequested(account, p.nonce, p.marker);
    }
    function _cancel(address account) private {
        Pending storage p = pending[account];
        p.balance = zero; p.nonce++; p.marker = ebool.wrap(bytes32(0)); p.requested = false;
        FHE.allow(zero, account);
    }
    function onConfidentialTransferReceived(address, address from, euint64 amount, bytes calldata data) external nonReentrant returns (ebool valid) {
        if (msg.sender != address(token)) revert OnlyToken();
        (bool funding, uint256 unused) = abi.decode(data, (bool, uint256)); require(unused == 0);
        if (funding) {
            euint64 next = FHE.add(reserve, amount); valid = FHE.ge(next, reserve);
            reserve = FHE.select(valid, next, reserve); FHE.allowThis(reserve);
        } else {
            euint64 oldBalance = principalOf(from); euint64 next = FHE.add(oldBalance, amount);
            euint64 nextTotal = FHE.add(principalTotal, amount);
            valid = FHE.and(FHE.and(FHE.ge(next, oldBalance), FHE.le(next, 1_000_000_000)), FHE.ge(nextTotal, principalTotal));
            euint64 accepted = FHE.select(valid, amount, zero);
            principalTotal = FHE.add(principalTotal, accepted); FHE.allowThis(principalTotal);
            uint256 p = indexPlusOne[from];
            if (p != 0) _update(from, p - 1, accepted, true, false);
            else {
                pendingTotal = FHE.add(pendingTotal, accepted); FHE.allowThis(pendingTotal);
                _request(from, FHE.add(oldBalance, accepted));
            }
        }
        FHE.allowTransient(valid, msg.sender);
    }
    /// Anyone may relay a proof for the stored marker. Its one public bit is
    /// permanent; proofs never authorize transfers or choose a beneficiary.
    function finalizeAdmission(address account, uint256 nonce, bool positive, bytes calldata proof) external nonReentrant {
        Pending storage p = pending[account];
        if (indexPlusOne[account] != 0 || !p.requested || p.nonce != nonce) revert StaleAdmission();
        bytes32[] memory handles = new bytes32[](1); handles[0] = ebool.unwrap(p.marker);
        FHE.checkSignatures(handles, abi.encode(positive), proof);
        euint64 balance = p.balance;
        _cancel(account);
        pendingTotal = FHE.sub(pendingTotal, balance); FHE.allowThis(pendingTotal);
        if (!positive) return;
        uint256 index;
        if (freeSlots.length != 0) { index = freeSlots[freeSlots.length - 1]; freeSlots.pop(); }
        else { if (nextIndex >= uint256(1) << depth) revert TreeFull(); index = nextIndex++; }
        uint64 generation = ++generationOf[index]; // checked overflow, never reset
        indexPlusOne[account] = index + 1; activeCount++;
        emit SlotAssigned(account, index, generation);
        _update(account, index, balance, true, false);
    }
    function _store(uint256 l, uint256 i, Node memory n) private {
        FHE.allowThis(n.sum); nodes[l][i] = n; emit NodeUpdated(l, i, n.hash, n.sum);
    }
    function _update(address account, uint256 index, euint64 delta, bool addition, bool clearLeaf) private {
        euint64 balance = clearLeaf ? zero : (addition ? FHE.add(getNode(0, index).sum, delta) : FHE.sub(getNode(0, index).sum, delta));
        _store(0, index, Node(clearLeaf ? emptyHash[0] : _leaf(account, generationOf[index], balance), balance));
        FHE.allow(balance, account);
        for (uint256 l = 1; l <= depth; l++) {
            index >>= 1;
            euint64 sum = addition ? FHE.add(getNode(l, index).sum, delta) : FHE.sub(getNode(l, index).sum, delta);
            _store(l, index, Node(_parent(getNode(l - 1, index * 2), getNode(l - 1, index * 2 + 1)), sum));
        }
    }
    function _send(address account, euint64 amount) private {
        FHE.allowTransient(amount, address(token)); token.confidentialTransfer(account, amount);
    }
    function withdraw(externalEuint64 input, bytes calldata inputProof) external nonReentrant {
        euint64 amount = FHE.min(FHE.fromExternal(input, inputProof), principalOf(msg.sender));
        principalTotal = FHE.sub(principalTotal, amount); FHE.allowThis(principalTotal);
        uint256 p = indexPlusOne[msg.sender];
        if (p != 0) _update(msg.sender, p - 1, amount, false, false);
        else {
            pendingTotal = FHE.sub(pendingTotal, amount); FHE.allowThis(pendingTotal);
            _request(msg.sender, FHE.sub(principalOf(msg.sender), amount));
        }
        _send(msg.sender, amount);
    }
    /// Explicit intent allows releasing a slot without revealing its balance.
    /// Principal withdrawal needs neither the indexer nor a decryption proof.
    function withdrawAllAndExit() external nonReentrant {
        euint64 amount = principalOf(msg.sender);
        principalTotal = FHE.sub(principalTotal, amount); FHE.allowThis(principalTotal);
        uint256 p = indexPlusOne[msg.sender];
        if (p != 0) {
            uint256 index = p - 1;
            _update(msg.sender, index, amount, false, true);
            delete indexPlusOne[msg.sender]; activeCount--; freeSlots.push(index);
            emit SlotReleased(msg.sender, index, generationOf[index]);
        } else { pendingTotal = FHE.sub(pendingTotal, amount); FHE.allowThis(pendingTotal); }
        _cancel(msg.sender); _send(msg.sender, amount);
    }
    function closeDraw() external nonReentrant {
        if (msg.sender != owner) revert OnlyOwner();
        Node memory root = getNode(depth, 0);
        euint128 product = FHE.mul(FHE.asEuint128(FHE.randEuint64()), FHE.asEuint128(root.sum));
        euint64 ticket = FHE.asEuint64(FHE.shr(product, 64));
        euint64 prize = FHE.select(FHE.gt(root.sum, 0), reserve, zero);
        reserve = FHE.sub(reserve, prize); FHE.allowThis(reserve); FHE.allowThis(ticket); FHE.allowThis(prize);
        draws[++drawCount] = Draw(root.hash, root.sum, ticket, prize, prize, nextIndex);
        emit Closed(drawCount, root.hash, root.sum, ticket, nextIndex);
    }
    function claimMerkle(uint256 id, address account, uint256 index, uint64 generation, euint64 balance, bytes32[] calldata hashes, euint64[] calldata sums, euint64[] calldata parents) external nonReentrant {
        if (id == 0 || id > drawCount || account == address(0) || generation == 0 || index >= draws[id].upperBound) revert NotEligible();
        if (checked[id][account]) revert AlreadyChecked();
        if (hashes.length != depth || sums.length != depth || parents.length != depth) revert InvalidProof();
        Node memory n = Node(_leaf(account, generation, balance), balance);
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
        _send(account, award);
    }
}
