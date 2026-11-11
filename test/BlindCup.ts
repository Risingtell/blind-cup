import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { BlindCup, BlindCup__factory } from "../types";

const DICE = 5;
const Phase = { Open: 0n, Bidding: 1n, Revealing: 2n, Done: 3n };

describe("BlindCup", function () {
  let host: HardhatEthersSigner;
  let guest: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let bot: HardhatEthersSigner;
  let cup: BlindCup;
  let cupAddress: string;

  before(async function () {
    [, host, guest, stranger, bot] = await ethers.getSigners();
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      this.skip();
    }
    const factory = (await ethers.getContractFactory("BlindCup")) as BlindCup__factory;
    cup = (await factory.deploy()) as BlindCup;
    cupAddress = await cup.getAddress();
  });

  async function seatedTable(): Promise<bigint> {
    await (await cup.connect(host).openTable()).wait();
    const tableId = await cup.tableCount();
    await (await cup.connect(guest).joinTable(tableId)).wait();
    return tableId;
  }

  /** Test-only oracle: per-face blind counts (ones wild except for face 0). The contract never sees these. */
  async function counts(tableId: bigint, round?: bigint): Promise<number[]> {
    const r = round ?? (await cup.tableOf(tableId)).round;
    const dice: number[] = [];
    for (const seat of [0, 1]) {
      for (const handle of await cup.cupOf(tableId, r, seat)) {
        dice.push(Number(await fhevm.debugger.decryptEuint(FhevmType.euint8, handle)));
      }
    }
    return [0, 1, 2, 3, 4, 5].map((f) => dice.filter((d) => d === f || (f !== 0 && d === 0)).length);
  }

  async function settle(tableId: bigint, by: HardhatEthersSigner = stranger) {
    const t = await cup.tableOf(tableId);
    const result = await fhevm.publicDecrypt([t.verdictHandle]);
    const bidHeld = result.clearValues[t.verdictHandle as `0x${string}`] as boolean;
    await (await cup.connect(by).resolve(tableId, bidHeld, result.decryptionProof)).wait();
    return bidHeld;
  }

  /** Plays one round so that `winner` takes it: the seat on turn bids true (to win) or one too many (to lose). */
  async function playRoundFor(tableId: bigint, winner: HardhatEthersSigner) {
    const t = await cup.tableOf(tableId);
    const opener = t.players[Number(t.turn)] === host.address ? host : guest;
    const other = opener === host ? guest : host;
    const c = await counts(tableId);
    if (opener === winner) {
      const best = c.indexOf(Math.max(...c));
      await (await cup.connect(opener).placeBid(tableId, c[best], best)).wait();
    } else {
      const face = c.findIndex((n) => n < 2 * DICE);
      await (await cup.connect(opener).placeBid(tableId, c[face] + 1, face)).wait();
    }
    await (await cup.connect(other).challenge(tableId)).wait();
    await settle(tableId);
  }

  async function sign(
    signer: HardhatEthersSigner,
    primaryType: "Join" | "Bid" | "Challenge",
    value: Record<string, unknown>,
  ) {
    const domain = {
      name: "BlindCup",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: cupAddress,
    };
    const types = {
      Join: [{ name: "tableId", type: "uint256" }],
      Bid: [
        { name: "tableId", type: "uint256" },
        { name: "move", type: "uint32" },
        { name: "quantity", type: "uint8" },
        { name: "face", type: "uint8" },
      ],
      Challenge: [
        { name: "tableId", type: "uint256" },
        { name: "move", type: "uint32" },
      ],
    };
    return signer.signTypedData(domain, { [primaryType]: types[primaryType] }, value);
  }

  it("rolls five encrypted dice per cup, faces 1 to 6, each readable only by its owner", async function () {
    const tableId = await seatedTable();
    const hostDice = await cup.cupOf(tableId, 1, 0);
    expect(hostDice.length).to.eq(DICE);
    for (const handle of hostDice) {
      const face = await fhevm.userDecryptEuint(FhevmType.euint8, handle, cupAddress, host);
      expect(face).to.be.gte(0n).and.lte(5n);
    }
    await expect(fhevm.userDecryptEuint(FhevmType.euint8, hostDice[0], cupAddress, guest)).to.be.rejected;
    await expect(fhevm.publicDecrypt([hostDice[0]])).to.be.rejected;
  });

  it("settles a true bid for the bidder from the blind count alone", async function () {
    const tableId = await seatedTable();
    const c = await counts(tableId);
    const best = c.indexOf(Math.max(...c));
    await (await cup.connect(host).placeBid(tableId, c[best], best)).wait();
    await (await cup.connect(guest).challenge(tableId)).wait();

    expect(await settle(tableId)).to.eq(true);
    expect((await cup.tableOf(tableId)).wins[0]).to.eq(1n);
  });

  it("settles a lie for the challenger, and the loser opens the next round", async function () {
    const tableId = await seatedTable();
    const c = await counts(tableId);
    await (await cup.connect(host).placeBid(tableId, c[4] + 1, 4)).wait();
    await expect(cup.connect(guest).challenge(tableId)).to.emit(cup, "Challenged");

    expect(await settle(tableId)).to.eq(false);
    const t = await cup.tableOf(tableId);
    expect(t.wins[1]).to.eq(1n);
    expect(t.round).to.eq(2n);
    expect(t.phase).to.eq(Phase.Bidding);
    expect(t.players[Number(t.turn)]).to.eq(host.address);
    expect(t.bidQuantity).to.eq(0n);
  });

  it("counts ones as wild, except when ones themselves are bid", async function () {
    const tableId = await seatedTable();
    const c = await counts(tableId);
    expect(c[0]).to.be.lte(c[2]);
    const bid = Math.max(1, c[2]);
    await (await cup.connect(host).placeBid(tableId, bid, 2)).wait();
    await (await cup.connect(guest).challenge(tableId)).wait();
    expect(await settle(tableId)).to.eq(c[2] >= bid);

    const second = await seatedTable();
    const ones = (await counts(second))[0];
    if (ones < 2 * DICE) {
      await (await cup.connect(host).placeBid(second, ones + 1, 0)).wait();
      await (await cup.connect(guest).challenge(second)).wait();
      expect(await settle(second)).to.eq(false);
    }
  });

  it("rejects a forged verdict: the proof is bound to the true answer", async function () {
    const tableId = await seatedTable();
    await (await cup.connect(host).placeBid(tableId, 1, 5)).wait();
    await (await cup.connect(guest).challenge(tableId)).wait();
    const t = await cup.tableOf(tableId);
    const result = await fhevm.publicDecrypt([t.verdictHandle]);
    const truth = result.clearValues[t.verdictHandle as `0x${string}`] as boolean;

    await expect(cup.connect(stranger).resolve(tableId, !truth, result.decryptionProof)).to.be.reverted;
    await (await cup.connect(stranger).resolve(tableId, truth, result.decryptionProof)).wait();
    await expect(cup.connect(stranger).resolve(tableId, truth, result.decryptionProof)).to.be.revertedWithCustomError(
      cup,
      "NotRevealing",
    );
  });

  it("keeps the cups sealed after the verdict", async function () {
    const tableId = await seatedTable();
    await (await cup.connect(host).placeBid(tableId, 2, 1)).wait();
    await (await cup.connect(guest).challenge(tableId)).wait();
    await settle(tableId);
    const guestDice = await cup.cupOf(tableId, 1, 1);
    await expect(fhevm.publicDecrypt([guestDice[0]])).to.be.rejected;
    await expect(fhevm.userDecryptEuint(FhevmType.euint8, guestDice[0], cupAddress, host)).to.be.rejected;
  });

  it("plays best of three: fresh cups each round, two round wins take the match", async function () {
    const tableId = await seatedTable();
    const round1 = await cup.cupOf(tableId, 1, 0);
    await playRoundFor(tableId, guest);
    expect((await cup.cupOf(tableId, 2, 0))[0]).to.not.eq(round1[0]);
    expect((await cup.tableOf(tableId)).winner).to.eq(ethers.ZeroAddress);

    await playRoundFor(tableId, host);
    let t = await cup.tableOf(tableId);
    expect([t.wins[0], t.wins[1], t.round]).to.deep.eq([1n, 1n, 3n]);

    await playRoundFor(tableId, guest);
    const won = await cup.queryFilter(cup.filters.MatchWon(tableId));
    expect(won.map((e) => [e.args.winner, e.args.byForfeit])).to.deep.eq([[guest.address, false]]);
    t = await cup.tableOf(tableId);
    expect(t.phase).to.eq(Phase.Done);
    expect(t.winner).to.eq(guest.address);
    expect(t.wins[1]).to.eq(2n);
    await expect(cup.connect(host).placeBid(tableId, 1, 1)).to.be.revertedWithCustomError(cup, "NotBidding");
  });

  it("carries signed moves: the bot never sends a transaction, the human pays", async function () {
    await (await cup.connect(host).openTable()).wait();
    const tableId = await cup.tableCount();
    const botNonce = await ethers.provider.getTransactionCount(bot.address);

    await (await cup.connect(host).joinTableBySig(tableId, await sign(bot, "Join", { tableId }))).wait();
    let t = await cup.tableOf(tableId);
    expect(t.players[1]).to.eq(bot.address);
    const botDie = (await cup.cupOf(tableId, 1, 1))[0];
    expect(await fhevm.userDecryptEuint(FhevmType.euint8, botDie, cupAddress, bot)).to.be.lte(5n);
    await expect(fhevm.userDecryptEuint(FhevmType.euint8, botDie, cupAddress, host)).to.be.rejected;

    await (await cup.connect(host).placeBid(tableId, 2, 2)).wait();
    t = await cup.tableOf(tableId);
    const bidSig = await sign(bot, "Bid", { tableId, move: t.moves, quantity: 3, face: 2 });
    await expect(cup.connect(host).placeBidBySig(tableId, 3, 2, bidSig))
      .to.emit(cup, "BidPlaced")
      .withArgs(tableId, 1, bot.address, 3, 2);

    // replaying a signature once the state has moved on recovers no seated player
    await (await cup.connect(host).placeBid(tableId, 4, 2)).wait();
    await expect(cup.connect(host).placeBidBySig(tableId, 3, 2, bidSig)).to.be.revertedWithCustomError(
      cup,
      "NotYourTurn",
    );
    // a stranger cannot move for the bot
    t = await cup.tableOf(tableId);
    const forged = await sign(stranger, "Challenge", { tableId, move: t.moves });
    await expect(cup.connect(host).challengeBySig(tableId, forged)).to.be.revertedWithCustomError(cup, "NotYourTurn");
    // a signature over one bid does not authorise a different one
    const other = await sign(bot, "Bid", { tableId, move: t.moves, quantity: 5, face: 2 });
    await expect(cup.connect(host).placeBidBySig(tableId, 6, 2, other)).to.be.revertedWithCustomError(
      cup,
      "NotYourTurn",
    );
    // the contract's digest helper agrees with what the bot signs
    const expected = ethers.TypedDataEncoder.hash(
      {
        name: "BlindCup",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: cupAddress,
      },
      {
        Challenge: [
          { name: "tableId", type: "uint256" },
          { name: "move", type: "uint32" },
        ],
      },
      { tableId, move: t.moves },
    );
    expect(await cup.challengeDigest(tableId, t.moves)).to.eq(expected);

    await (
      await cup.connect(host).challengeBySig(tableId, await sign(bot, "Challenge", { tableId, move: t.moves }))
    ).wait();
    expect((await cup.tableOf(tableId)).phase).to.eq(Phase.Revealing);
    await settle(tableId, host);

    expect(await ethers.provider.getTransactionCount(bot.address)).to.eq(botNonce);
  });

  it("forfeits a seat that stalls past the move timeout", async function () {
    const tableId = await seatedTable();
    await expect(cup.connect(guest).claimTimeout(tableId)).to.be.revertedWithCustomError(cup, "TooEarly");
    await (await cup.connect(host).placeBid(tableId, 1, 1)).wait();

    await time.increase(10 * 60 + 1);
    await expect(cup.connect(stranger).claimTimeout(tableId))
      .to.emit(cup, "MatchWon")
      .withArgs(tableId, host.address, true);
    expect((await cup.tableOf(tableId)).phase).to.eq(Phase.Done);
    await expect(cup.connect(guest).challenge(tableId)).to.be.revertedWithCustomError(cup, "NotBidding");
  });

  it("enforces turns, rising bids and seating", async function () {
    await (await cup.connect(host).openTable()).wait();
    const tableId = await cup.tableCount();
    await expect(cup.connect(host).joinTable(tableId)).to.be.revertedWithCustomError(cup, "SeatTaken");
    await expect(cup.connect(host).placeBid(tableId, 1, 1)).to.be.revertedWithCustomError(cup, "NotBidding");
    await (await cup.connect(guest).joinTable(tableId)).wait();
    await expect(cup.connect(stranger).joinTable(tableId)).to.be.revertedWithCustomError(cup, "NotOpen");

    await expect(cup.connect(guest).placeBid(tableId, 1, 1)).to.be.revertedWithCustomError(cup, "NotYourTurn");
    await expect(cup.connect(host).challenge(tableId)).to.be.revertedWithCustomError(cup, "NoBidToChallenge");
    await expect(cup.connect(host).placeBid(tableId, 1, 6)).to.be.revertedWithCustomError(cup, "BadBid");
    await expect(cup.connect(host).placeBid(tableId, 11, 1)).to.be.revertedWithCustomError(cup, "BadBid");
    await (await cup.connect(host).placeBid(tableId, 3, 2)).wait();
    await expect(cup.connect(guest).placeBid(tableId, 3, 2)).to.be.revertedWithCustomError(cup, "BadBid");
    await expect(cup.connect(guest).placeBid(tableId, 2, 5)).to.be.revertedWithCustomError(cup, "BadBid");
    await (await cup.connect(guest).placeBid(tableId, 3, 3)).wait();
    await (await cup.connect(host).placeBid(tableId, 4, 0)).wait();
    await expect(cup.connect(host).challenge(tableId)).to.be.revertedWithCustomError(cup, "NotYourTurn");
  });
});
