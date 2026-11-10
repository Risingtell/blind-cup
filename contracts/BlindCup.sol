// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint16} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title Blind Cup: liar's dice where the referee is blind too
/// @notice Each player's dice are rolled and stored encrypted. Only the owner of a cup can decrypt it.
///         When a bid is challenged, the contract counts every die without decrypting any of them and
///         publishes exactly one bit: whether the bid held. The cups themselves are never revealed.
/// @dev Faces are stored 0..5 and shown as 1..6. Face 0 (a shown "1") is wild unless ones were bid.
contract BlindCup is ZamaEthereumConfig {
    uint8 public constant SEATS = 2;
    uint8 public constant DICE = 5;
    uint8 public constant FACES = 6;

    enum Phase {
        Open, // waiting for the second player
        Bidding, // cups rolled, players bid in turn
        Revealing, // a bid was challenged; waiting for the verdict's decryption proof
        Done
    }

    struct Bid {
        uint8 quantity; // how many dice show the face, across both cups
        uint8 face; // 0..5
        address bidder;
    }

    struct Table {
        address[SEATS] players;
        Phase phase;
        uint8 turn; // seat index whose move it is
        Bid bid;
        address challenger;
        ebool bidHolds; // encrypted verdict, made publicly decryptable on challenge
        address winner;
    }

    uint256 public tableCount;
    mapping(uint256 => Table) private _tables;
    mapping(uint256 => mapping(uint8 => euint8[DICE])) private _cups; // table => seat => dice

    event TableOpened(uint256 indexed tableId, address indexed host);
    event CupsRolled(uint256 indexed tableId, address seat0, address seat1);
    event BidPlaced(uint256 indexed tableId, address indexed bidder, uint8 quantity, uint8 face);
    event Challenged(uint256 indexed tableId, address indexed challenger, bytes32 verdictHandle);
    event Resolved(uint256 indexed tableId, bool bidHeld, address indexed winner);

    error NotOpen();
    error NotBidding();
    error NotRevealing();
    error NotYourTurn();
    error SeatTaken();
    error BadBid();
    error NoBidToChallenge();

    /// @notice Open a table and take seat 0.
    function openTable() external returns (uint256 tableId) {
        tableId = ++tableCount;
        Table storage t = _tables[tableId];
        t.players[0] = msg.sender;
        emit TableOpened(tableId, msg.sender);
    }

    /// @notice Take seat 1. Both cups are rolled in the same transaction from onchain encrypted randomness.
    function joinTable(uint256 tableId) external {
        Table storage t = _tables[tableId];
        if (t.phase != Phase.Open || t.players[0] == address(0)) revert NotOpen();
        if (t.players[1] != address(0) || t.players[0] == msg.sender) revert SeatTaken();
        t.players[1] = msg.sender;

        for (uint8 seat = 0; seat < SEATS; seat++) {
            for (uint8 i = 0; i < DICE; i++) {
                euint8 die = _rollDie();
                FHE.allowThis(die);
                FHE.allow(die, t.players[seat]);
                _cups[tableId][seat][i] = die;
            }
        }
        t.phase = Phase.Bidding;
        t.turn = 0;
        emit CupsRolled(tableId, t.players[0], t.players[1]);
    }

    /// @notice Raise the bid: more dice, or the same number of dice on a higher face.
    function placeBid(uint256 tableId, uint8 quantity, uint8 face) external {
        Table storage t = _tables[tableId];
        if (t.phase != Phase.Bidding) revert NotBidding();
        if (t.players[t.turn] != msg.sender) revert NotYourTurn();
        if (face >= FACES || quantity == 0 || quantity > SEATS * DICE) revert BadBid();
        Bid memory prev = t.bid;
        if (prev.quantity != 0 && !(quantity > prev.quantity || (quantity == prev.quantity && face > prev.face))) {
            revert BadBid();
        }
        t.bid = Bid(quantity, face, msg.sender);
        t.turn = 1 - t.turn;
        emit BidPlaced(tableId, msg.sender, quantity, face);
    }

    /// @notice Call the standing bid a lie. The contract counts every die blind and seals a one-bit verdict.
    function challenge(uint256 tableId) external {
        Table storage t = _tables[tableId];
        if (t.phase != Phase.Bidding) revert NotBidding();
        if (t.players[t.turn] != msg.sender) revert NotYourTurn();
        if (t.bid.quantity == 0) revert NoBidToChallenge();

        uint8 face = t.bid.face;
        euint8 one = FHE.asEuint8(1);
        euint8 zero = FHE.asEuint8(0);
        euint8 count = zero;
        for (uint8 seat = 0; seat < SEATS; seat++) {
            for (uint8 i = 0; i < DICE; i++) {
                euint8 die = _cups[tableId][seat][i];
                ebool hit = FHE.eq(die, face);
                if (face != 0) hit = FHE.or(hit, FHE.eq(die, uint8(0))); // ones are wild
                count = FHE.add(count, FHE.select(hit, one, zero));
            }
        }
        ebool holds = FHE.ge(count, t.bid.quantity);
        FHE.allowThis(holds);
        FHE.makePubliclyDecryptable(holds);

        t.bidHolds = holds;
        t.challenger = msg.sender;
        t.phase = Phase.Revealing;
        emit Challenged(tableId, msg.sender, FHE.toBytes32(holds));
    }

    /// @notice Settle the challenge with the verdict and its threshold-decryption proof. Anyone may call it.
    function resolve(uint256 tableId, bool bidHeld, bytes calldata decryptionProof) external {
        Table storage t = _tables[tableId];
        if (t.phase != Phase.Revealing) revert NotRevealing();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(t.bidHolds);
        FHE.checkSignatures(handles, abi.encode(bidHeld), decryptionProof);

        t.winner = bidHeld ? t.bid.bidder : t.challenger;
        t.phase = Phase.Done;
        emit Resolved(tableId, bidHeld, t.winner);
    }

    /// @notice The encrypted dice in one seat's cup. Only that player can decrypt them.
    function cupOf(uint256 tableId, uint8 seat) external view returns (euint8[DICE] memory) {
        return _cups[tableId][seat];
    }

    function tableOf(
        uint256 tableId
    )
        external
        view
        returns (
            address[SEATS] memory players,
            Phase phase,
            uint8 turn,
            uint8 bidQuantity,
            uint8 bidFace,
            address bidder,
            address challenger,
            bytes32 verdictHandle,
            address winner
        )
    {
        Table storage t = _tables[tableId];
        return (
            t.players,
            t.phase,
            t.turn,
            t.bid.quantity,
            t.bid.face,
            t.bid.bidder,
            t.challenger,
            FHE.toBytes32(t.bidHolds),
            t.winner
        );
    }

    /// @dev A fair-enough die: 16 random bits reduced mod 6. 65536 = 6 * 10922 + 4, so faces 0..3 each
    ///      carry one extra outcome in 65536: a bias of at most 1/65536 per face.
    function _rollDie() private returns (euint8) {
        euint16 r = FHE.rem(FHE.randEuint16(), uint16(FACES));
        return FHE.asEuint8(r);
    }
}
