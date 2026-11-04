// SPDX-License-Identifier: MIT
// aderyn-fp-next-line(push-zero-opcode,unspecific-solidity-pragma)
pragma solidity ^0.8.27;

import {FHE, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ConfidentialPrizePool} from "../ConfidentialPrizePool.sol";

contract ConfidentialPrizePoolHarness is ConfidentialPrizePool {
  constructor(
    IERC7984 token_,
    uint256 drawInterval_,
    uint256 withdrawalBatchInterval_
  ) ConfidentialPrizePool(token_, drawInterval_, withdrawalBatchInterval_) {}

  function scaledRandomTicket(
    externalEuint64 encryptedRandomWord,
    externalEuint64 encryptedTotalPrincipal,
    bytes calldata inputProof
  ) external returns (euint128) {
    euint64 randomWord = FHE.fromExternal(encryptedRandomWord, inputProof);
    euint64 totalPrincipal = FHE.fromExternal(encryptedTotalPrincipal, inputProof);
    euint128 ticket = _scaledRandomTicket(randomWord, totalPrincipal);

    FHE.allowThis(ticket);
    return ticket;
  }

  /// @dev Test-only harness hook for exercising production overflow guards.
  function seedTotalPrincipal(externalEuint64 encryptedTotal, bytes calldata inputProof) external {
    _totalPrincipal = FHE.fromExternal(encryptedTotal, inputProof);
    FHE.allowThis(_totalPrincipal);
  }
}
