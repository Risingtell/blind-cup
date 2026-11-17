// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/// @title Test chips: an ERC-7984 token anyone can mint, for tests on the mock chain only
/// @author Rising Technology
/// @notice Stands in for Zama's test cUSDT, which on Sepolia is minted as plain test USDT and wrapped.
contract TestChips is ZamaEthereumConfig, ERC7984 {
    constructor() ERC7984("Test chips", "CHIP", "") {}

    /// @notice Mint chips to an address. Test use only.
    /// @param to Who receives them.
    /// @param amount How many, in the token's smallest unit.
    function mint(address to, uint64 amount) external {
        _mint(to, FHE.asEuint64(amount));
    }
}
