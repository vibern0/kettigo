// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";

/// @notice Fixed-depth encrypted sum tree. Hashes bind encrypted handles and ownership metadata.
library EncryptedSnapshotTree {
  uint8 public constant DEPTH = 32;
  struct Node {
    bytes32 hash;
    euint64 sum;
  }
  struct Tree {
    euint64 zero;
    mapping(uint256 level => bytes32 hash) emptyHash;
    mapping(uint256 level => mapping(uint256 index => Node node)) nodes;
  }
  event NodeUpdated(uint256 indexed level, uint256 indexed index, bytes32 hash, euint64 sum);
  function initialize(Tree storage self, euint64 zero) internal {
    self.zero = zero;
    FHE.allowThis(zero);
    self.emptyHash[0] = leaf(address(0), 0, zero);
    for (uint256 level; level < DEPTH; ++level) {
      Node memory empty = Node(self.emptyHash[level], zero);
      self.emptyHash[level + 1] = parent(empty, empty);
    }
  }
  function leaf(
    address account,
    uint64 generation,
    euint64 balance
  ) internal pure returns (bytes32) {
    return keccak256(abi.encode(uint8(0), account, generation, balance));
  }
  function parent(Node memory left, Node memory right) internal pure returns (bytes32) {
    return keccak256(abi.encode(uint8(1), left.hash, left.sum, right.hash, right.sum));
  }
  function get(
    Tree storage self,
    uint256 level,
    uint256 index
  ) internal view returns (Node memory node) {
    node = self.nodes[level][index];
    if (euint64.unwrap(node.sum) == bytes32(0)) {
      node = Node(self.emptyHash[level], self.zero);
    }
  }
  function root(Tree storage self) internal view returns (Node memory) {
    return get(self, DEPTH, 0);
  }
  function store(Tree storage self, uint256 level, uint256 index, Node memory node) internal {
    FHE.allowThis(node.sum);
    self.nodes[level][index] = node;
    emit NodeUpdated(level, index, node.hash, node.sum);
  }
  function update(
    Tree storage self,
    address account,
    uint256 index,
    uint64 generation,
    euint64 balance,
    euint64 delta,
    bool addition,
    bool clear
  ) internal {
    store(
      self,
      0,
      index,
      Node(clear ? self.emptyHash[0] : leaf(account, generation, balance), balance)
    );
    for (uint256 level = 1; level <= DEPTH; ++level) {
      index >>= 1;
      Node memory left = get(self, level - 1, index * 2);
      Node memory right = get(self, level - 1, index * 2 + 1);
      euint64 sum =
        addition
          ? FHE.add(get(self, level, index).sum, delta)
          : FHE.sub(get(self, level, index).sum, delta);
      store(self, level, index, Node(parent(left, right), sum));
    }
  }
}
