import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { BlindCup, BlindCup__factory } from "../types";

const DICE = 5;

describe("BlindCup", function () {
  let host: HardhatEthersSigner;
  let guest: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let cup: BlindCup;
  let cupAddress: string;

  before(async function () {
    [, host, guest, stranger] = await ethers.getSigners();
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

  /** Test-only oracle: what the blind count should be. The contract never sees these values. */
  async function trueCount(tableId: bigint, face: number): Promise<number> {
    let n = 0;
    for (const seat of [0, 1]) {
      const dice = await cup.cupOf(tableId, seat);
      for (const handle of dice) {
        const d = Number(await fhevm.debugger.decryptEuint(FhevmType.euint8, handle));
        if (d === face || (face !== 0 && d === 0)) n++;
      }
    }
    return n;
  }

  async function settle(tableId: bigint) {
    const t = await cup.tableOf(tableId);
    const result = await fhevm.publicDecrypt([t.verdictHandle]);
    const bidHeld = result.clearValues[t.verdictHandle as `0x${string}`] as boolean;
    await (await cup.connect(stranger).resolve(tableId, bidHeld, result.decryptionProof)).wait();
    return bidHeld;
  }

  it("rolls five encrypted dice per cup, faces 1 to 6, each readable only by its owner", async function () {
    const tableId = await seatedTable();
    const hostDice = await cup.cupOf(tableId, 0);
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
    const face = 3;
    const quantity = Math.max(1, await trueCount(tableId, face));
    await (await cup.connect(host).placeBid(tableId, quantity, face)).wait();
    await (await cup.connect(guest).challenge(tableId)).wait();

    expect(await settle(tableId)).to.eq(true);
    const t = await cup.tableOf(tableId);
    expect(t.winner).to.eq(host.address);
    expect(t.phase).to.eq(3n);
  });

  it("settles a lie for the challenger", async function () {
    const tableId = await seatedTable();
    const face = 4;
    const quantity = (await trueCount(tableId, face)) + 1;
    await (await cup.connect(host).placeBid(tableId, quantity, face)).wait();
    await (await cup.connect(guest).challenge(tableId)).wait();

    expect(await settle(tableId)).to.eq(false);
    expect((await cup.tableOf(tableId)).winner).to.eq(guest.address);
  });

  it("counts ones as wild, except when ones themselves are bid", async function () {
    const tableId = await seatedTable();
    const withWilds = await trueCount(tableId, 2);
    const onesOnly = await trueCount(tableId, 0);
    const bid = Math.max(1, withWilds);
    await (await cup.connect(host).placeBid(tableId, bid, 2)).wait();
    await (await cup.connect(guest).challenge(tableId)).wait();
    expect(await settle(tableId)).to.eq(withWilds >= bid);

    const second = await seatedTable();
    const ones = await trueCount(second, 0);
    if (ones < 2 * DICE) {
      await (await cup.connect(host).placeBid(second, ones + 1, 0)).wait();
      await (await cup.connect(guest).challenge(second)).wait();
      expect(await settle(second)).to.eq(false);
    }
    expect(onesOnly).to.be.lte(withWilds);
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
    const guestDice = await cup.cupOf(tableId, 1);
    await expect(fhevm.publicDecrypt([guestDice[0]])).to.be.rejected;
    await expect(fhevm.userDecryptEuint(FhevmType.euint8, guestDice[0], cupAddress, host)).to.be.rejected;
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

