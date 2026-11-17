import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { BlindCup, CupPurse, TestChips } from "../types";

const DICE = 5;
const START = 1000n;

describe("CupPurse (hidden stakes)", function () {
  let host: HardhatEthersSigner;
  let guest: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let cup: BlindCup;
  let chips: TestChips;
  let purse: CupPurse;
  let purseAddress: string;
  let chipsAddress: string;

  before(async function () {
    [, host, guest, stranger] = await ethers.getSigners();
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    cup = (await (await ethers.getContractFactory("BlindCup")).deploy()) as BlindCup;
    chips = (await (await ethers.getContractFactory("TestChips")).deploy()) as TestChips;
    chipsAddress = await chips.getAddress();
    purse = (await (
      await ethers.getContractFactory("CupPurse")
    ).deploy(await cup.getAddress(), chipsAddress)) as CupPurse;
    purseAddress = await purse.getAddress();
    const until = 2n ** 48n - 1n;
    for (const p of [host, guest]) await (await chips.mint(p.address, START)).wait();
    for (const p of [host, guest, stranger]) await (await chips.connect(p).setOperator(purseAddress, until)).wait();
  });

  async function balance(p: HardhatEthersSigner): Promise<bigint> {
    const h = await chips.confidentialBalanceOf(p.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, h, chipsAddress, p);
  }

  async function stake(p: HardhatEthersSigner, tableId: bigint, amount: bigint) {
    const input = await fhevm.createEncryptedInput(purseAddress, p.address).add64(amount).encrypt();
    await (await purse.connect(p).stake(tableId, input.handles[0], input.inputProof)).wait();
  }

  async function open(): Promise<bigint> {
    await (await cup.connect(host).openTable()).wait();
    return cup.tableCount();
  }

  async function counts(tableId: bigint): Promise<number[]> {
    const t = await cup.tableOf(tableId);
    const dice: number[] = [];
    for (const seat of [0, 1]) {
      for (const h of await cup.cupOf(tableId, t.round, seat)) {
        dice.push(Number(await fhevm.debugger.decryptEuint(FhevmType.euint8, h)));
      }
    }
    return [0, 1, 2, 3, 4, 5].map((f) => dice.filter((d) => d === f || (f !== 0 && d === 0)).length);
  }

  /** Plays rounds until `winner` has taken the match; `seated` are the two players. */
  async function playMatchFor(tableId: bigint, winner: HardhatEthersSigner, seated = [host, guest]) {
    const [a, b] = seated;
    while ((await cup.tableOf(tableId)).phase !== 3n) {
      const t = await cup.tableOf(tableId);
      const opener = t.players[Number(t.turn)] === a.address ? a : b;
      const other = opener === a ? b : a;
      const c = await counts(tableId);
      if (opener === winner) {
        const best = c.indexOf(Math.max(...c));
        await (await cup.connect(opener).placeBid(tableId, c[best], best)).wait();
      } else {
        const face = c.findIndex((n) => n < 2 * DICE);
        await (await cup.connect(opener).placeBid(tableId, c[face] + 1, face)).wait();
      }
      await (await cup.connect(other).challenge(tableId)).wait();
      const v = (await cup.tableOf(tableId)).verdictHandle;
      const r = await fhevm.publicDecrypt([v]);
      await (await cup.resolve(tableId, r.clearValues[v as `0x${string}`] as boolean, r.decryptionProof)).wait();
    }
  }

  it("pays the winner their stake plus the table stake, and returns the loser's excess", async function () {
    const id = await open();
    await stake(host, id, 100n);
    await stake(guest, id, 60n);
    await (await cup.connect(guest).joinTable(id)).wait();
    await playMatchFor(id, host);
    await (await purse.connect(stranger).settle(id)).wait();
    expect([await balance(host), await balance(guest)]).to.deep.eq([START + 60n, START - 60n]);
  });

  it("plays for the smaller stake when the smaller staker wins", async function () {
    const id = await open();
    await stake(host, id, 100n);
    await stake(guest, id, 60n);
    await (await cup.connect(guest).joinTable(id)).wait();
    await playMatchFor(id, guest);
    await (await purse.settle(id)).wait();
    expect([await balance(host), await balance(guest)]).to.deep.eq([START - 60n, START + 60n]);
  });

  it("keeps stakes hidden: each player reads only their own, and both read what the table plays for", async function () {
    const id = await open();
    await stake(host, id, 100n);
    await stake(guest, id, 60n);
    const own = await purse.stakeOf(id, host.address);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, own, purseAddress, host)).to.eq(100n);
    await expect(fhevm.userDecryptEuint(FhevmType.euint64, own, purseAddress, guest)).to.be.rejected;
    await expect(fhevm.publicDecrypt([own])).to.be.rejected;
    const atPlay = await purse.tableStakeOf(id, guest.address);
    for (const p of [host, guest]) {
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, atPlay, purseAddress, p)).to.eq(60n);
    }
    await expect(fhevm.userDecryptEuint(FhevmType.euint64, atPlay, purseAddress, stranger)).to.be.rejected;
  });

  it("an empty purse plays for nothing and wins nothing", async function () {
    // The stranger holds no chips: the transfer moves zero, so the table plays for zero.
    const id = await open();
    await stake(host, id, 100n);
    await stake(stranger, id, 500n);
    await (await cup.connect(stranger).joinTable(id)).wait();
    const t = await cup.tableOf(id);
    expect(t.players[1]).to.eq(stranger.address);
    await playMatchFor(id, stranger, [host, stranger]);
    await (await purse.settle(id)).wait();
    expect(await balance(host)).to.eq(START);
    expect(await balance(stranger)).to.eq(0n);
  });

  it("only takes stakes before the cups are rolled, and lets a stake leave only while it is not in play", async function () {
    const id = await open();
    await stake(host, id, 100n);
    await stake(stranger, id, 10n); // would-be guest who never sits
    await stake(guest, id, 60n);
    await expect(stake(host, id, 1n)).to.be.revertedWithCustomError(purse, "AlreadyStaked");
    await (await cup.connect(guest).joinTable(id)).wait();

    await expect(stake(guest, id, 1n)).to.be.revertedWithCustomError(purse, "NotOpen");
    const other = await open();
    await (await cup.connect(guest).joinTable(other)).wait();
    await expect(stake(host, other, 1n)).to.be.revertedWithCustomError(purse, "NotOpen");

    await expect(purse.connect(host).withdraw(id)).to.be.revertedWithCustomError(purse, "InPlay");
    await expect(purse.connect(guest).withdraw(id)).to.be.revertedWithCustomError(purse, "InPlay");
    await (await purse.connect(stranger).withdraw(id)).wait();
    await expect(purse.connect(stranger).withdraw(id)).to.be.revertedWithCustomError(purse, "NothingStaked");
  });

  it("lets the host take a stake back before anyone sits", async function () {
    const id = await open();
    await stake(host, id, 100n);
    expect(await balance(host)).to.eq(START - 100n);
    await (await purse.connect(host).withdraw(id)).wait();
    expect(await balance(host)).to.eq(START);
  });

  it("settles only a finished table, and only once", async function () {
    const id = await open();
    await stake(host, id, 100n);
    await (await cup.connect(guest).joinTable(id)).wait();
    await expect(purse.settle(id)).to.be.revertedWithCustomError(purse, "NotFinished");
    await playMatchFor(id, guest);
    await (await purse.settle(id)).wait();
    await expect(purse.settle(id)).to.be.revertedWithCustomError(purse, "AlreadySettled");
    // The guest staked nothing, so the host's stake simply comes back.
    expect([await balance(host), await balance(guest)]).to.deep.eq([START, START]);
  });
});
