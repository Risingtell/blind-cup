// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint8} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Blind Cup: liar's dice where the referee is blind too
/// @author Rising Technology
/// @notice Each player's dice are rolled and stored encrypted. Only the owner of a cup can decrypt it.
///         When a bid is challenged, the contract counts every die without decrypting any of them and
///         publishes exactly one bit: whether the bid held. The cups themselves are never revealed.
///         A match is best of three rounds, with fresh cups each round.
/// @dev Faces are stored 0..5 and shown as 1..6. Face 0 (a shown "1") is wild unless ones were bid.
///      Every move can also be signed off-chain (EIP-712) and submitted by anyone, so one player can
///      carry the other's moves: the bot opponent signs, the human's transaction pays. A signed move is
///      bound to the table and its move counter, so it is valid exactly once, at exactly that state.
contract BlindCup is ZamaEthereumConfig, EIP712 {
    /// @notice Players per table.
    uint8 public constant SEATS = 2;
    /// @notice Dice per cup.
    uint8 public constant DICE = 5;
    /// @notice Faces per die.
    uint8 public constant FACES = 6;
    /// @notice Round wins that take the match (best of three).
    uint8 public constant ROUNDS_TO_WIN = 2;
    /// @notice How long the seat on turn has to move before the other seat can claim the match.
    uint64 public constant MOVE_TIMEOUT = 10 minutes;

    /// @notice EIP-712 type of a signed Join.
    bytes32 public constant JOIN_TYPEHASH = keccak256("Join(uint256 tableId)");
    /// @notice EIP-712 type of a signed Bid, bound to the table's move counter.
    bytes32 public constant BID_TYPEHASH = keccak256("Bid(uint256 tableId,uint32 move,uint8 quantity,uint8 face)");
    /// @notice EIP-712 type of a signed Challenge, bound to the table's move counter.
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

    /// @notice Number of tables opened so far; table ids start at 1.
    uint256 public tableCount;
    mapping(uint256 tableId => Table table) private _tables;
    mapping(uint256 tableId => mapping(uint8 round => mapping(uint8 seat => euint8[DICE] dice))) private _cups;

    /// @notice A table was opened.
    /// @param tableId The new table.
    /// @param host The player in seat 0.
    event TableOpened(uint256 indexed tableId, address indexed host);
    /// @notice The second seat was taken.
    /// @param tableId The table.
    /// @param guest The player in seat 1.
    event PlayerJoined(uint256 indexed tableId, address indexed guest);
    /// @notice Both cups were rolled, encrypted, for a round.
    /// @param tableId The table.
    /// @param round The round now being played.
    event CupsRolled(uint256 indexed tableId, uint8 round);
    /// @notice A bid was raised.
    /// @param tableId The table.
    /// @param round The round.
    /// @param bidder Who bid.
    /// @param quantity How many dice the bid claims.
    /// @param face The face claimed, 0..5 (shown 1..6).
    event BidPlaced(uint256 indexed tableId, uint8 round, address indexed bidder, uint8 quantity, uint8 face);
    /// @notice The standing bid was called a lie and counted blind.
    /// @param tableId The table.
    /// @param round The round.
    /// @param challenger Who called it.
    /// @param verdictHandle Handle of the sealed one-bit verdict, publicly decryptable.
    event Challenged(uint256 indexed tableId, uint8 round, address indexed challenger, bytes32 verdictHandle);
    /// @notice A challenge was settled with a verified decryption proof.
    /// @param tableId The table.
    /// @param round The round that ended.
    /// @param bidHeld True if the bid was true.
    /// @param roundWinner Who took the round.
    event RoundResolved(uint256 indexed tableId, uint8 round, bool bidHeld, address indexed roundWinner);
    /// @notice The match is over.
    /// @param tableId The table.
    /// @param winner Who won the match.
    /// @param byForfeit True if it was won because the other seat ran out of time.
    event MatchWon(uint256 indexed tableId, address indexed winner, bool byForfeit);

    /// @notice The table is not waiting for a second player.
    error NotOpen();
    /// @notice The table is not in a bidding round.
    error NotBidding();
    /// @notice The table is not waiting for a verdict.
    error NotRevealing();
    /// @notice The caller (or signer) is not the seat on turn.
    error NotYourTurn();
    /// @notice The seat is taken, or the host tried to join their own table.
    error SeatTaken();
    /// @notice The bid is out of range or does not raise the standing bid.
    error BadBid();
    /// @notice There is no standing bid to call.
    error NoBidToChallenge();
    /// @notice The seat on turn still has time to move.
    error TooEarly();

    constructor() EIP712("BlindCup", "1") {}

    // ------------------------------------------------------------------ seating

    /// @notice Open a table and take seat 0.
    /// @return tableId The new table's id.
    function openTable() external returns (uint256 tableId) {
        tableId = ++tableCount;
        _tables[tableId].players[0] = msg.sender;
        emit TableOpened(tableId, msg.sender);
    }

    /// @notice Take seat 1. Both cups are rolled in the same transaction from onchain encrypted randomness.
    /// @param tableId The table to join.
    function joinTable(uint256 tableId) external {
        _join(tableId, msg.sender);
    }

    /// @notice Seat the player who signed a Join for this table. The submitter pays for the roll.
    /// @param tableId The table to join.
    /// @param signature The joining player's EIP-712 Join signature.
    function joinTableBySig(uint256 tableId, bytes calldata signature) external {
        address player = _signer(keccak256(abi.encode(JOIN_TYPEHASH, tableId)), signature);
        _join(tableId, player);
    }

    // ------------------------------------------------------------------ moves

    /// @notice Raise the bid: more dice, or the same number of dice on a higher face.
    /// @param tableId The table.
    /// @param quantity How many dice, among all ten, show the face (ones wild).
    /// @param face The face, 0..5 (shown 1..6).
    function placeBid(uint256 tableId, uint8 quantity, uint8 face) external {
        _bid(tableId, msg.sender, quantity, face);
    }

    /// @notice Place a bid signed by the seat on turn. Anyone may submit it and pay.
    /// @param tableId The table.
    /// @param quantity The signed quantity.
    /// @param face The signed face.
    /// @param signature The bidder's EIP-712 Bid signature over the current move counter.
    function placeBidBySig(uint256 tableId, uint8 quantity, uint8 face, bytes calldata signature) external {
        bytes32 structHash = keccak256(abi.encode(BID_TYPEHASH, tableId, _tables[tableId].moves, quantity, face));
        _bid(tableId, _signer(structHash, signature), quantity, face);
    }

    /// @notice Call the standing bid a lie. The contract counts every die blind and seals a one-bit verdict.
    /// @param tableId The table.
    function challenge(uint256 tableId) external {
        _challenge(tableId, msg.sender);
    }

    /// @notice Call the bid a lie with a challenge signed by the seat on turn. Anyone may submit it and pay.
    /// @param tableId The table.
    /// @param signature The challenger's EIP-712 Challenge signature over the current move counter.
    function challengeBySig(uint256 tableId, bytes calldata signature) external {
        bytes32 structHash = keccak256(abi.encode(CHALLENGE_TYPEHASH, tableId, _tables[tableId].moves));
        _challenge(tableId, _signer(structHash, signature));
    }

    /// @notice Settle the challenge with the verdict and its threshold-decryption proof. Anyone may call it.
    ///         If the match isn't over, the next round's cups are rolled in this same transaction.
    /// @param tableId The table.
    /// @param bidHeld The decrypted verdict.
    /// @param decryptionProof The KMS signatures over that verdict, checked onchain.
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
    /// @param tableId The table.
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
    /// @param tableId The table.
    /// @param round The round.
    /// @param seat The seat, 0 or 1.
    /// @return The five encrypted dice.
    function cupOf(uint256 tableId, uint8 round, uint8 seat) external view returns (euint8[DICE] memory) {
        return _cups[tableId][round][seat];
    }

    /// @notice Everything a client needs to render a table, in one call.
    /// @param tableId The table.
    /// @return v The table's public state; `bidder` is an address and `verdictHandle` the sealed verdict.
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

    /// @notice The EIP-712 digest a player signs to join, so clients and bots needn't rebuild it.
    /// @param tableId The table.
    /// @return The digest.
    function joinDigest(uint256 tableId) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(JOIN_TYPEHASH, tableId)));
    }

    /// @notice The EIP-712 digest a player signs for a bid.
    /// @param tableId The table.
    /// @param move The table's move counter at the time of the bid.
    /// @param quantity The quantity.
    /// @param face The face.
    /// @return The digest.
    function bidDigest(uint256 tableId, uint32 move, uint8 quantity, uint8 face) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(BID_TYPEHASH, tableId, move, quantity, face)));
    }

    /// @notice The EIP-712 digest a player signs for a challenge.
    /// @param tableId The table.
    /// @param move The table's move counter at the time of the challenge.
    /// @return The digest.
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
