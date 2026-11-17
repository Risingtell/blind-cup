// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

import {BlindCup} from "./BlindCup.sol";

/// @title Cup Purse: hidden stakes for Blind Cup, in a confidential ERC-7984 token
/// @author Rising Technology
/// @notice Before the cups are rolled, each player may put a hidden amount of the token into the purse. Nobody,
///         not even the opponent, learns either amount. The table plays for the smaller of the two stakes. When the
///         match ends, anyone may settle: the winner receives their own stake plus the table stake, and the loser
///         gets back whatever they put in above it. Every amount stays encrypted end to end.
/// @dev A transfer the player cannot cover moves zero (ERC-7984 semantics), and the purse only counts what it
///      actually received, so an empty purse plays for nothing and can win nothing.
contract CupPurse is ZamaEthereumConfig {
    /// @notice The game whose results this purse pays out.
    BlindCup public immutable CUP;
    /// @notice The confidential token staked.
    IERC7984 public immutable TOKEN;

    mapping(uint256 tableId => mapping(address player => euint64 amount)) private _stakes;
    mapping(uint256 tableId => mapping(address guest => euint64 amount)) private _tableStakes;

    /// @notice Whether a player has a stake in the purse for a table.
    mapping(uint256 tableId => mapping(address player => bool staked)) public hasStake;
    /// @notice Whether a finished table has been paid out.
    mapping(uint256 tableId => bool done) public settled;

    /// @notice A player put a hidden stake in for a table.
    /// @param tableId The table.
    /// @param player Who staked.
    event Staked(uint256 indexed tableId, address indexed player);
    /// @notice A stake was taken back before it was in play.
    /// @param tableId The table.
    /// @param player Who took it back.
    event Withdrawn(uint256 indexed tableId, address indexed player);
    /// @notice A finished table was paid out.
    /// @param tableId The table.
    /// @param winner Who won the match.
    event Settled(uint256 indexed tableId, address indexed winner);

    /// @notice The cups have been rolled, or the table does not exist.
    error NotOpen();
    /// @notice This player already has a stake for this table.
    error AlreadyStaked();
    /// @notice This player has no stake for this table.
    error NothingStaked();
    /// @notice The stake is in play: the player is seated and the cups are rolled.
    error InPlay();
    /// @notice The match has not finished.
    error NotFinished();
    /// @notice The table was already paid out.
    error AlreadySettled();

    /// @notice Binds the purse to one game and one token.
    /// @param cup_ The Blind Cup game.
    /// @param token_ The ERC-7984 token to stake.
    constructor(BlindCup cup_, IERC7984 token_) {
        CUP = cup_;
        TOKEN = token_;
    }

    /// @notice Put a hidden stake in for a table that is still waiting for its second player. The host stakes after
    ///         opening; a guest stakes before taking the seat. The purse must be an operator of your token balance.
    /// @param tableId The table.
    /// @param encryptedAmount The stake, encrypted for this contract and the sender.
    /// @param inputProof The proof for the encrypted amount.
    function stake(uint256 tableId, externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        BlindCup.TableView memory t = CUP.tableOf(tableId);
        if (t.phase != BlindCup.Phase.Open || t.players[0] == address(0)) revert NotOpen();
        if (hasStake[tableId][msg.sender]) revert AlreadyStaked();

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        FHE.allowTransient(amount, address(TOKEN));
        euint64 paid = TOKEN.confidentialTransferFrom(msg.sender, address(this), amount);
        FHE.allowThis(paid);
        FHE.allow(paid, msg.sender);
        _stakes[tableId][msg.sender] = paid;
        hasStake[tableId][msg.sender] = true;

        // A guest staking against a host who already staked learns what the table would play for, and so does the host.
        address host = t.players[0];
        if (msg.sender != host && hasStake[tableId][host]) {
            euint64 atPlay = FHE.min(_stakes[tableId][host], paid);
            FHE.allowThis(atPlay);
            FHE.allow(atPlay, msg.sender);
            FHE.allow(atPlay, host);
            _tableStakes[tableId][msg.sender] = atPlay;
        }
        emit Staked(tableId, msg.sender);
    }

    /// @notice Take a stake back while it is not in play: before the cups are rolled, or if you never took the seat.
    /// @param tableId The table.
    function withdraw(uint256 tableId) external {
        if (!hasStake[tableId][msg.sender]) revert NothingStaked();
        BlindCup.TableView memory t = CUP.tableOf(tableId);
        bool seated = msg.sender == t.players[0] || msg.sender == t.players[1];
        if (t.phase != BlindCup.Phase.Open && seated) revert InPlay();

        euint64 amount = _stakes[tableId][msg.sender];
        hasStake[tableId][msg.sender] = false;
        _pay(msg.sender, amount);
        emit Withdrawn(tableId, msg.sender);
    }

    /// @notice Pay out a finished table. Anyone may call it, once.
    /// @param tableId The table.
    function settle(uint256 tableId) external {
        BlindCup.TableView memory t = CUP.tableOf(tableId);
        if (t.phase != BlindCup.Phase.Done) revert NotFinished();
        if (settled[tableId]) revert AlreadySettled();
        settled[tableId] = true;

        address host = t.players[0];
        address guest = t.players[1];
        bool hostIn = hasStake[tableId][host];
        bool guestIn = hasStake[tableId][guest];
        hasStake[tableId][host] = false;
        hasStake[tableId][guest] = false;
        emit Settled(tableId, t.winner);
        if (!hostIn && !guestIn) return;

        euint64 hostStake = hostIn ? _stakes[tableId][host] : FHE.asEuint64(0);
        euint64 guestStake = guestIn ? _stakes[tableId][guest] : FHE.asEuint64(0);
        euint64 atPlay = FHE.min(hostStake, guestStake);
        bool hostWon = t.winner == host;
        euint64 winnerStake = hostWon ? hostStake : guestStake;
        euint64 loserStake = hostWon ? guestStake : hostStake;

        _pay(t.winner, FHE.add(winnerStake, atPlay));
        _pay(hostWon ? guest : host, FHE.sub(loserStake, atPlay));
    }

    /// @notice Your own stake for a table. Only you can decrypt it.
    /// @param tableId The table.
    /// @param player The player.
    /// @return The encrypted stake.
    function stakeOf(uint256 tableId, address player) external view returns (euint64) {
        return _stakes[tableId][player];
    }

    /// @notice What a table plays for: the smaller of the host's and this guest's stakes.
    ///         Only those two players can decrypt it.
    /// @param tableId The table.
    /// @param guest The guest who staked.
    /// @return The encrypted table stake, or an empty handle if the host had not staked when the guest did.
    function tableStakeOf(uint256 tableId, address guest) external view returns (euint64) {
        return _tableStakes[tableId][guest];
    }

    function _pay(address to, euint64 amount) private {
        FHE.allowThis(amount);
        FHE.allowTransient(amount, address(TOKEN));
        TOKEN.confidentialTransfer(to, amount);
    }
}
