// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice THROWAWAY scaling probe. Not a funded pool and NEVER suitable for deployment.
/// Test-only minting, deterministic draws, and synthetic population are deliberately unrestricted.
contract SnapshotTreeProbe is ZamaEthereumConfig {
    uint64 public constant MAX_USER_PRINCIPAL = 1_000_000_000;

    struct Node {
        uint256 left;
        uint256 right;
        euint64 sum;
    }

    struct Draw {
        uint256 root;
        uint256 depth;
        uint256 count;
        euint64 ticket;
        euint64 prize;
        euint64 remaining;
    }

    Node[] private _nodes;
    mapping(uint256 => Draw) private _draws;
    mapping(address => uint256) public indexPlusOne;
    mapping(uint256 => mapping(address => bool)) public checked;
    mapping(address => euint64) private _winnings;
    mapping(address => euint64) private _paid;
    uint256 public root;
    uint256 public depth;
    uint256 public participantCount;
    uint256 public drawCount;
    euint64 private _reserve;

    error AlreadyChecked();
    error NotEligible();
    error InvalidFixture();

    constructor() {
        _nodes.push(Node(0, 0, FHE.asEuint64(0)));
        FHE.allowThis(_nodes[0].sum);
    }

    function deposit(externalEuint64 input, bytes calldata proof) external {
        _deposit(msg.sender, FHE.fromExternal(input, proof));
    }

    function withdraw(externalEuint64 input, bytes calldata proof) external {
        euint64 requested = FHE.fromExternal(input, proof);
        _withdraw(msg.sender, requested);
    }

    function depositForTest(address account, uint64 amount) external {
        _deposit(account, FHE.asEuint64(amount));
    }

    function withdrawForTest(address account, uint64 amount) external {
        _withdraw(account, FHE.asEuint64(amount));
    }

    function _deposit(address account, euint64 amount) private {
        euint64 balance = principalOf(account);
        euint64 nextBalance = FHE.add(balance, amount);
        euint64 total = _nodes[root].sum;
        euint64 nextTotal = FHE.add(total, amount);
        // Unlike the old 32-address bound, aggregate overflow is explicitly checked.
        ebool valid = FHE.and(
            FHE.and(FHE.ge(nextBalance, balance), FHE.le(nextBalance, MAX_USER_PRINCIPAL)),
            FHE.ge(nextTotal, total)
        );
        euint64 accepted = FHE.select(valid, amount, FHE.asEuint64(0));
        _register(account);
        root = _update(root, depth, indexPlusOne[account] - 1, accepted, true);
        _allow(principalOf(account), account);
    }

    function _withdraw(address account, euint64 requested) private {
        if (indexPlusOne[account] == 0) revert NotEligible();
        euint64 accepted = FHE.min(requested, principalOf(account));
        root = _update(root, depth, indexPlusOne[account] - 1, accepted, false);
        _allow(principalOf(account), account);
    }

    function _register(address account) private {
        if (indexPlusOne[account] != 0) return;
        if (participantCount == (uint256(1) << depth)) {
            root = _newNode(root, 0, _nodes[root].sum);
            depth++;
        }
        indexPlusOne[account] = ++participantCount;
    }

    function _update(uint256 id, uint256 level, uint256 index, euint64 delta, bool addition)
        private returns (uint256)
    {
        Node memory old = _nodes[id];
        // Each ancestor applies the same validated delta independently. Recomputing
        // parents from newly computed children would unnecessarily serialize FHE.
        euint64 sum = addition ? FHE.add(old.sum, delta) : FHE.sub(old.sum, delta);
        if (level == 0) return _newNode(0, 0, sum);
        if (((index >> (level - 1)) & 1) == 0) {
            return _newNode(_update(old.left, level - 1, index, delta, addition), old.right, sum);
        }
        return _newNode(old.left, _update(old.right, level - 1, index, delta, addition), sum);
    }

    function _newNode(uint256 left, uint256 right, euint64 sum) private returns (uint256 id) {
        FHE.allowThis(sum);
        id = _nodes.length;
        _nodes.push(Node(left, right, sum));
    }

    function fundForTest(uint64 amount) external {
        _reserve = FHE.add(_reserve, amount);
        FHE.allowThis(_reserve);
    }

    function closeDraw() external {
        _close(FHE.randEuint64());
    }

    function closeWithRandomForTest(uint64 word) external {
        _close(FHE.asEuint64(word));
    }

    function _close(euint64 word) private {
        euint64 total = _nodes[root].sum;
        euint128 product = FHE.mul(FHE.asEuint128(word), FHE.asEuint128(total));
        euint64 ticket = FHE.asEuint64(FHE.shr(product, 64));
        euint64 prize = FHE.select(FHE.gt(total, 0), _reserve, FHE.asEuint64(0));
        _reserve = FHE.sub(_reserve, prize);
        FHE.allowThis(_reserve);
        FHE.allowThis(ticket);
        FHE.allowThis(prize);
        _draws[++drawCount] = Draw(root, depth, participantCount, ticket, prize, prize);
    }

    function settle(uint256 drawId) external {
        Draw storage draw = _draws[drawId];
        uint256 position = indexPlusOne[msg.sender];
        if (drawId == 0 || drawId > drawCount || position == 0 || position > draw.count) revert NotEligible();
        if (checked[drawId][msg.sender]) revert AlreadyChecked();
        checked[drawId][msg.sender] = true;

        (euint64 start, euint64 weight) = _interval(draw.root, draw.depth, position - 1);
        euint64 end = FHE.add(start, weight);
        ebool selected = FHE.and(FHE.ge(draw.ticket, start), FHE.lt(draw.ticket, end));
        euint64 award = FHE.select(selected, draw.prize, FHE.asEuint64(0));
        draw.remaining = FHE.sub(draw.remaining, award);
        FHE.allowThis(draw.remaining);
        _winnings[msg.sender] = FHE.add(_winnings[msg.sender], award);
        _allow(_winnings[msg.sender], msg.sender);
    }

    function _interval(uint256 id, uint256 level, uint256 index) private returns (euint64, euint64) {
        euint64[] memory terms = new euint64[](level);
        uint256 count;
        while (level != 0) {
            Node memory node = _nodes[id];
            if (((index >> (level - 1)) & 1) == 0) {
                id = node.left;
            } else {
                terms[count++] = _nodes[node.left].sum;
                id = node.right;
            }
            level--;
        }
        // A balanced reduction avoids a linear FHE dependency chain for the
        // last participant, whose prefix includes a left sibling at every level.
        while (count > 1) {
            uint256 next;
            for (uint256 i; i < count; i += 2) {
                terms[next++] = i + 1 < count ? FHE.add(terms[i], terms[i + 1]) : terms[i];
            }
            count = next;
        }
        return (count == 0 ? FHE.asEuint64(0) : terms[0], _nodes[id].sum);
    }

    function claimForTest() external {
        euint64 amount = _winnings[msg.sender];
        _winnings[msg.sender] = FHE.asEuint64(0);
        _paid[msg.sender] = FHE.add(_paid[msg.sender], amount);
        _allow(_winnings[msg.sender], msg.sender);
        _allow(_paid[msg.sender], msg.sender);
    }

    function reinvestForTest() external {
        euint64 before = principalOf(msg.sender);
        euint64 amount = _winnings[msg.sender];
        _deposit(msg.sender, amount);
        euint64 accepted = FHE.sub(principalOf(msg.sender), before);
        _winnings[msg.sender] = FHE.sub(amount, accepted);
        _allow(_winnings[msg.sender], msg.sender);
    }

    function principalOf(address account) public view returns (euint64) {
        uint256 position = indexPlusOne[account];
        if (position == 0) return _nodes[0].sum;
        uint256 id = root;
        for (uint256 level = depth; level != 0; level--) {
            id = (((position - 1) >> (level - 1)) & 1) == 0 ? _nodes[id].left : _nodes[id].right;
        }
        return _nodes[id].sum;
    }

    function _allow(euint64 value, address account) private {
        FHE.allowThis(value);
        FHE.allow(value, account);
    }

    function winningsOf(address account) external view returns (euint64) { return _winnings[account]; }
    function paidOf(address account) external view returns (euint64) { return _paid[account]; }
    function total() external view returns (euint64) { return _nodes[root].sum; }
    function reserve() external view returns (euint64) { return _reserve; }
    function draw(uint256 id) external view returns (Draw memory) { return _draws[id]; }
    function nodeCount() external view returns (uint256) { return _nodes.length; }

    /// @dev Represents 2^level equal-weight leaves with shared immutable subtrees.
    /// This exercises exact path depth, NOT actual onboarding of that many wallets.
    function seedUniformForTest(uint256 level, uint64 weight, address account, uint256 index) external {
        if (participantCount != 0 || level > 48 || index >= (uint256(1) << level)) revert InvalidFixture();
        if (uint256(weight) << level > type(uint64).max) revert InvalidFixture();
        uint256 id = _newNode(0, 0, FHE.asEuint64(weight));
        for (uint256 i = 1; i <= level; i++) {
            id = _newNode(id, id, FHE.asEuint64(uint64(uint256(weight) << i)));
        }
        root = id;
        depth = level;
        participantCount = uint256(1) << level;
        indexPlusOne[account] = index + 1;
        _allow(principalOf(account), account);
    }
}
