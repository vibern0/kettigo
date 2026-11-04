// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ConfidentialPrizePool} from "../../../contracts/ConfidentialPrizePool.sol";

/// @notice Test-only callback driver for the UNMODIFIED existing pool.
/// No tokens move: this isolates the existing draw's exact FHE/gas cost.
contract LegacyDepositDriver is ZamaEthereumConfig {
    function depositForTest(ConfidentialPrizePool pool, address account, uint64 amount) external {
        euint64 value = FHE.asEuint64(amount);
        FHE.allowTransient(value, address(pool));
        pool.onConfidentialTransferReceived(address(this), account, value, "");
    }

    function fundForTest(ConfidentialPrizePool pool, uint64 amount) external {
        euint64 value = FHE.asEuint64(amount);
        FHE.allowTransient(value, address(pool));
        pool.onConfidentialTransferReceived(
            address(this), msg.sender, value, abi.encodePacked(pool.PRIZE_FUNDING_DATA(), abi.encode(amount))
        );
    }
}
