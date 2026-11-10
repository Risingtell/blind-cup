// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint16} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Blind Cup: liar's dice where the referee is blind too
/// @notice Each player's dice are rolled and stored encrypted. Only the owner of a cup can decrypt it.
///         When a bid is challenged, the contract counts every die without decrypting any of them and
///         publishes exactly one bit: whether the bid held. The cups themselves are never revealed.
///         A match is best of three rounds, with fresh cups each round.
/// @dev Faces are stored 0..5 and shown as 1..6. Face 0 (a shown "1") is wild unless ones were bid.
///      Every move can also be signed off-chain (EIP-712) and submitted by anyone, so one player can
///      carry the other's moves: the bot opponent signs, the human's transaction pays. A signed move is
///      bound to the table and its move counter, so it is valid exactly once, at exactly that state.
contract BlindCup is ZamaEthereumConfig, EIP712 {
    uint8 public constant SEATS = 2;
    uint8 public constant DICE = 5;
    uint8 public constant FACES = 6;
    uint8 public constant ROUNDS_TO_WIN = 2;
    uint64 public constant MOVE_TIMEOUT = 10 minutes;

    bytes32 public constant JOIN_TYPEHASH = keccak256("Join(uint256 tableId)");
    bytes32 public constant BID_TYPEHASH = keccak256("Bid(uint256 tableId,uint32 move,uint8 quantity,uint8 face)");
    bytes32 public constant CHALLENGE_TYPEHASH = keccak256("Challenge(uint256 tableId,uint32 move)");

    enum Phase {
        Open, // waiting for the second player
        Bidding, // cups rolled, players bid in turn
        Revealing, // a bid was challenged; waiting for the verdict's decryption proof
        Done
    }

    struct Table {
        address[SEATS] players;
        Phase phase;
        uint8 round; // 1-based once both seats are taken
        uint8 turn; // seat whose move it is
        uint8[SEATS] wins;
        uint32 moves; // bumps on every bid, challenge and new round; signed moves commit to it
        uint8 bidQuantity; // 0 = no standing bid this round
        uint8 bidFace;
        uint8 bidder; // seat of the standing bid
        uint64 deadline; // the seat on turn must move before this, or forfeit
        ebool verdict; // sealed result of the last challenge, made publicly decryptable
        address winner;
    }

    /// @notice Everything a client needs to render a table, in one call.
    struct TableView {
        address[SEATS] players;
        Phase phase;
        uint8 round;
        uint8 turn;
        uint8[SEATS] wins;
        uint32 moves;
        uint8 bidQuantity;
        uint8 bidFace;
        address bidder;
        uint64 deadline;
        bytes32 verdictHandle;
        address winner;
    }

    uint256 public tableCount;
    mapping(uint256 => Table) private _tables;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => euint8[DICE]))) private _cups; // table => round => seat

    event TableOpened(uint256 indexed tableId, address indexed host);
    event PlayerJoined(uint256 indexed tableId, address indexed guest);
    event CupsRolled(uint256 indexed tableId, uint8 round);
    event BidPlaced(uint256 indexed tableId, uint8 round, address indexed bidder, uint8 quantity, uint8 face);
    event Challenged(uint256 indexed tableId, uint8 round, address indexed challenger, bytes32 verdictHandle);
    event RoundResolved(uint256 indexed tableId, uint8 round, bool bidHeld, address indexed roundWinner);
    event MatchWon(uint256 indexed tableId, address indexed winner, bool byForfeit);

    error NotOpen();
    error NotBidding();
    error NotRevealing();
    error NotYourTurn();
    error SeatTaken();
    error BadBid();
    error NoBidToChallenge();
    error TooEarly();

    constructor() EIP712("BlindCup", "1") {}

    // ------------------------------------------------------------------ seating

    /// @notice Open a table and take seat 0.
    function openTable() external returns (uint256 tableId) {
        tableId = ++tableCount;
        _tables[tableId].players[0] = msg.sender;
        emit TableOpened(tableId, msg.sender);
    }

    /// @notice Take seat 1. Both cups are rolled in the same transaction from onchain encrypted randomness.
    function joinTable(uint256 tableId) external {
        _join(tableId, msg.sender);
    }

    /// @notice Seat the player who signed a Join for this table. The submitter pays for the roll.
    function joinTableBySig(uint256 tableId, bytes calldata signature) external {
        address player = _signer(keccak256(abi.encode(JOIN_TYPEHASH, tableId)), signature);
        _join(tableId, player);
    }

    // ------------------------------------------------------------------ moves

    /// @notice Raise the bid: more dice, or the same number of dice on a higher face.
    function placeBid(uint256 tableId, uint8 quantity, uint8 face) external {
        _bid(tableId, msg.sender, quantity, face);
    }

    function placeBidBySig(uint256 tableId, uint8 quantity, uint8 face, bytes calldata signature) external {
        bytes32 structHash = keccak256(abi.encode(BID_TYPEHASH, tableId, _tables[tableId].moves, quantity, face));
        _bid(tableId, _signer(structHash, signature), quantity, face);
    }

    /// @notice Call the standing bid a lie. The contract counts every die blind and seals a one-bit verdict.
    function challenge(uint256 tableId) external {
        _challenge(tableId, msg.sender);
    }

    function challengeBySig(uint256 tableId, bytes calldata signature) external {
        bytes32 structHash = keccak256(abi.encode(CHALLENGE_TYPEHASH, tableId, _tables[tableId].moves));
        _challenge(tableId, _signer(structHash, signature));
    }

    /// @notice Settle the challenge with the verdict and its threshold-decryption proof. Anyone may call it.
    ///         If the match isn't over, the next round's cups are rolled in this same transaction.
    function resolve(uint256 tableId, bool bidHeld, bytes calldata decryptionProof) external {
        Table storage t = _tables[tableId];
        if (t.phase != Phase.Revealing) revert NotRevealing();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(t.verdict);
        FHE.checkSignatures(handles, abi.encode(bidHeld), decryptionProof);

        uint8 roundWinner = bidHeld ? t.bidder : 1 - t.bidder;
        t.wins[roundWinner]++;
        emit RoundResolved(tableId, t.round, bidHeld, t.players[roundWinner]);

        if (t.wins[roundWinner] >= ROUNDS_TO_WIN) {
            t.phase = Phase.Done;
            t.winner = t.players[roundWinner];
            emit MatchWon(tableId, t.winner, false);
            return;
        }
        t.round++;
        t.turn = 1 - roundWinner; // the loser opens the next round
        _startRound(tableId, t);
    }

    /// @notice If the seat on turn has not moved in time, the other seat wins the match. Anyone may call it.
    function claimTimeout(uint256 tableId) external {
        Table storage t = _tables[tableId];
        if (t.phase != Phase.Bidding) revert NotBidding();
        if (block.timestamp <= t.deadline) revert TooEarly();
        t.phase = Phase.Done;
        t.winner = t.players[1 - t.turn];
        emit MatchWon(tableId, t.winner, true);
    }

    // ------------------------------------------------------------------ views

    /// @notice The encrypted dice in one seat's cup for a round. Only that player can decrypt them.
    function cupOf(uint256 tableId, uint8 round, uint8 seat) external view returns (euint8[DICE] memory) {
        return _cups[tableId][round][seat];
    }

    function tableOf(uint256 tableId) external view returns (TableView memory v) {
        Table storage t = _tables[tableId];
        v.players = t.players;
        v.phase = t.phase;
        v.round = t.round;
        v.turn = t.turn;
        v.wins = t.wins;
        v.moves = t.moves;
        v.bidQuantity = t.bidQuantity;
        v.bidFace = t.bidFace;
        v.bidder = t.bidQuantity == 0 ? address(0) : t.players[t.bidder];
        v.deadline = t.deadline;
        v.verdictHandle = FHE.toBytes32(t.verdict);
        v.winner = t.winner;
    }

    /// @notice The EIP-712 digest a player signs for a move, so clients and bots needn't rebuild it.
    function joinDigest(uint256 tableId) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(JOIN_TYPEHASH, tableId)));
    }

    function bidDigest(uint256 tableId, uint32 move, uint8 quantity, uint8 face) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(BID_TYPEHASH, tableId, move, quantity, face)));
    }

    function challengeDigest(uint256 tableId, uint32 move) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CHALLENGE_TYPEHASH, tableId, move)));
    }

    // ------------------------------------------------------------------ internals

    function _join(uint256 tableId, address player) private {
        Table storage t = _tables[tableId];
        if (t.phase != Phase.Open || t.players[0] == address(0)) revert NotOpen();
        if (t.players[1] != address(0) || t.players[0] == player) revert SeatTaken();
        t.players[1] = player;
        emit PlayerJoined(tableId, player);
        t.round = 1;
        t.turn = 0;
        _startRound(tableId, t);
    }

    function _startRound(uint256 tableId, Table storage t) private {
        for (uint8 seat = 0; seat < SEATS; seat++) {
            for (uint8 i = 0; i < DICE; i++) {
                euint8 die = _rollDie();
                FHE.allowThis(die);
                FHE.allow(die, t.players[seat]);
                _cups[tableId][t.round][seat][i] = die;
            }
        }
        t.bidQuantity = 0;
        t.bidFace = 0;
        t.phase = Phase.Bidding;
        _advance(t);
        emit CupsRolled(tableId, t.round);
    }

    function _bid(uint256 tableId, address player, uint8 quantity, uint8 face) private {
        Table storage t = _tables[tableId];
        if (t.phase != Phase.Bidding) revert NotBidding();
        if (t.players[t.turn] != player) revert NotYourTurn();
        if (face >= FACES || quantity == 0 || quantity > SEATS * DICE) revert BadBid();
        if (t.bidQuantity != 0 && !(quantity > t.bidQuantity || (quantity == t.bidQuantity && face > t.bidFace))) {
            revert BadBid();
        }
        t.bidQuantity = quantity;
        t.bidFace = face;
        t.bidder = t.turn;
        t.turn = 1 - t.turn;
        _advance(t);
        emit BidPlaced(tableId, t.round, player, quantity, face);
    }

    function _challenge(uint256 tableId, address player) private {
        Table storage t = _tables[tableId];
        if (t.phase != Phase.Bidding) revert NotBidding();
        if (t.players[t.turn] != player) revert NotYourTurn();
        if (t.bidQuantity == 0) revert NoBidToChallenge();

        uint8 face = t.bidFace;
        euint8 count;
        for (uint8 seat = 0; seat < SEATS; seat++) {
            for (uint8 i = 0; i < DICE; i++) {
                euint8 die = _cups[tableId][t.round][seat][i];
                ebool hit = FHE.eq(die, face);
                if (face != 0) hit = FHE.or(hit, FHE.eq(die, uint8(0))); // ones are wild
                euint8 one = FHE.asEuint8(hit);
                count = (seat == 0 && i == 0) ? one : FHE.add(count, one);
            }
        }
        ebool holds = FHE.ge(count, t.bidQuantity);
        FHE.allowThis(holds);
        FHE.makePubliclyDecryptable(holds);

        t.verdict = holds;
        t.phase = Phase.Revealing;
        t.moves++;
        emit Challenged(tableId, t.round, player, FHE.toBytes32(holds));
    }

    function _advance(Table storage t) private {
        t.moves++;
        t.deadline = uint64(block.timestamp) + MOVE_TIMEOUT;
    }

    function _signer(bytes32 structHash, bytes calldata signature) private view returns (address) {
        return ECDSA.recover(_hashTypedDataV4(structHash), signature);
    }

    /// @dev A fair-enough die: 16 random bits reduced mod 6. 65536 = 6 * 10922 + 4, so faces 0..3 each
    ///      carry one extra outcome in 65536: a bias of at most 1/65536 per face.
    function _rollDie() private returns (euint8) {
        return FHE.asEuint8(FHE.rem(FHE.randEuint16(), uint16(FACES)));
    }
}
