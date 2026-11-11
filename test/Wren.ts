import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { type Bid, bestFace, countFor, decide, DICE, FACES, isRaise, seeded, TOTAL, WREN } from "../bot/brain";
import { type BotContext, nextMove, NotMyTurn, signJoin } from "../bot/service";
import { simulate, TRUSTING } from "../bot/sim/simulate";
import { BlindCup, BlindCup__factory } from "../types";

const SECRET = "0x" + "ab".repeat(32);

function randomPosition(rng: () => number): { dice: number[]; standing: Bid | null } {
  const dice = Array.from({ length: DICE }, () => Math.floor(rng() * FACES));
  const standing = rng() < 0.2 ? null : { quantity: 1 + Math.floor(rng() * TOTAL), face: Math.floor(rng() * FACES) };
  return { dice, standing };
}

describe("Wren (the bot's mind)", function () {
  // Loops collect problems and assert once: a chai assertion per iteration is slow under ts-node.
  it("always makes a legal move", function () {
    const rng = seeded(42);
    const bad: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const { dice, standing } = randomPosition(rng);
      const d = decide(dice, standing, rng);
      if (d.kind === "challenge" ? standing === null : !isRaise(standing, d))
        bad.push(`${dice} vs ${JSON.stringify(standing)}: ${JSON.stringify(d)}`);
    }
    expect(bad).to.deep.equal([]);
  });

  it("habit: always opens honestly on the face she holds most", function () {
    const rng = seeded(7);
    const bad: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const dice = Array.from({ length: DICE }, () => Math.floor(rng() * FACES));
      const d = decide(dice, null, rng);
      const ok =
        d.kind === "bid" &&
        d.face === bestFace(dice) &&
        !d.bluff &&
        [1, 2].includes(d.quantity - countFor(dice, d.face));
      if (!ok) bad.push(`${dice}: ${JSON.stringify(d)}`);
    }
    expect(bad).to.deep.equal([]);
  });

  it("never calls a bid her own cup already proves, always calls an impossible one", function () {
    const rng = seeded(9);
    const bad: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const dice = Array.from({ length: DICE }, () => Math.floor(rng() * FACES));
      const face = Math.floor(rng() * FACES);
      const mine = countFor(dice, face);
      if (mine > 0 && decide(dice, { quantity: mine, face }, rng).kind !== "bid")
        bad.push(`called a proven ${mine}x${face} holding ${dice}`);
      if (mine + DICE < TOTAL && decide(dice, { quantity: mine + DICE + 1, face }, rng).kind !== "challenge")
        bad.push(`let an impossible bid stand holding ${dice}`);
    }
    expect(bad).to.deep.equal([]);
  });

  it("the same position and seed always give the same move", function () {
    const rng = seeded(1);
    const bad: string[] = [];
    for (let i = 0; i < 500; i++) {
      const { dice, standing } = randomPosition(rng);
      const seed = Math.floor(rng() * 2 ** 32);
      if (JSON.stringify(decide(dice, standing, seeded(seed))) !== JSON.stringify(decide(dice, standing, seeded(seed))))
        bad.push(`${dice} seed ${seed}`);
    }
    expect(bad).to.deep.equal([]);
  });

  it("tell: her tapped bids are far more often lies than her other bids", function () {
    const r = simulate(10000, false, 5);
    expect(r.bluffRate).to.be.within(0.1, 0.35);
    expect(r.lieWhenTapped).to.be.greaterThan(0.6);
    expect(r.lieWhenNotTapped).to.be.lessThan(0.4);
    expect(r.lieWhenTapped - r.lieWhenNotTapped).to.be.greaterThan(0.25);
  });

  it("is a fair opponent: an honest, trusting player wins between 40% and 60% of rounds", function () {
    const r = simulate(10000, false, 6, WREN, TRUSTING);
    expect(r.opponentWinRate).to.be.within(0.4, 0.6);
  });
});

describe("Wren at the table (mock chain)", function () {
  let host: HardhatEthersSigner;
  let bot: HardhatEthersSigner;
  let cup: BlindCup;
  let at: string;
  let ctx: BotContext;

  before(async function () {
    const signers = await ethers.getSigners();
    host = signers[1];
    bot = signers[4];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    cup = (await ((await ethers.getContractFactory("BlindCup")) as BlindCup__factory).deploy()) as BlindCup;
    at = await cup.getAddress();
    ctx = {
      cup,
      signer: bot,
      secret: SECRET,
      readOwnCup: (handles) => decryptInTurn(handles, bot),
    };
  });

  async function seated() {
    await (await cup.connect(host).openTable()).wait();
    const tableId = await cup.tableCount();
    const { signature } = await signJoin(ctx, tableId);
    await (await cup.connect(host).joinTableBySig(tableId, signature)).wait();
    return tableId;
  }

  /** One at a time: the mock coprocessor reads its event log in order and rejects overlapping reads. */
  async function decryptInTurn(handles: string[], owner: HardhatEthersSigner) {
    const dice: number[] = [];
    for (const h of handles) dice.push(Number(await fhevm.userDecryptEuint(FhevmType.euint8, h, at, owner)));
    return dice;
  }

  async function hostDice(tableId: bigint, round: bigint) {
    return decryptInTurn(await cup.cupOf(tableId, round, 0), host);
  }

  it("plays a full best-of-3 match against a human; she only signs, the human pays every move", async function () {
    const nonce = await ethers.provider.getTransactionCount(bot.address);
    const tableId = await seated();
    const rng = seeded(99);
    let botMoves = 0;
    for (let step = 0; step < 200; step++) {
      const t = await cup.tableOf(tableId);
      if (t.phase === 3n) break;
      if (t.phase === 2n) {
        const result = await fhevm.publicDecrypt([t.verdictHandle]);
        const held = result.clearValues[t.verdictHandle as `0x${string}`] as boolean;
        await (await cup.connect(host).resolve(tableId, held, result.decryptionProof)).wait();
        continue;
      }
      if (t.players[Number(t.turn)] === bot.address) {
        const m = await nextMove(ctx, tableId);
        expect(m.says).to.be.a("string").and.not.equal("");
        expect(m).to.not.have.nested.property("play.bluff");
        if (m.play.kind === "challenge") await (await cup.connect(host).challengeBySig(tableId, m.signature)).wait();
        else await (await cup.connect(host).placeBidBySig(tableId, m.play.quantity, m.play.face, m.signature)).wait();
        botMoves++;
      } else {
        const standing = t.bidQuantity === 0n ? null : { quantity: Number(t.bidQuantity), face: Number(t.bidFace) };
        const d = decide(await hostDice(tableId, t.round), standing, rng, TRUSTING);
        if (d.kind === "challenge") await (await cup.connect(host).challenge(tableId)).wait();
        else await (await cup.connect(host).placeBid(tableId, d.quantity, d.face)).wait();
      }
    }
    const done = await cup.tableOf(tableId);
    expect(done.phase).to.equal(3n);
    expect([host.address, bot.address]).to.include(done.winner);
    expect(Math.max(...done.wins.map(Number))).to.equal(2);
    expect(botMoves).to.be.greaterThan(0);
    expect(await ethers.provider.getTransactionCount(bot.address)).to.equal(nonce);
  });

  it("asking twice in the same position returns the same signed move", async function () {
    const tableId = await seated();
    await (await cup.connect(host).placeBid(tableId, 1, 3)).wait();
    const a = await nextMove(ctx, tableId);
    const b = await nextMove(ctx, tableId);
    expect(b.signature).to.equal(a.signature);
    expect(b.play).to.deep.equal(a.play);
  });

  it("refuses to sign out of turn, and a stale signed move cannot be replayed", async function () {
    const tableId = await seated();
    let err: unknown;
    try {
      await nextMove(ctx, tableId);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(NotMyTurn);

    await (await cup.connect(host).placeBid(tableId, 1, 3)).wait();
    const m = await nextMove(ctx, tableId);
    if (m.play.kind === "challenge") await (await cup.connect(host).challengeBySig(tableId, m.signature)).wait();
    else await (await cup.connect(host).placeBidBySig(tableId, m.play.quantity, m.play.face, m.signature)).wait();
    if (m.play.kind === "bid") {
      await expect(
        cup.connect(host).placeBidBySig(tableId, m.play.quantity, m.play.face, m.signature),
      ).to.be.revertedWithCustomError(cup, "NotYourTurn");
    } else {
      await expect(cup.connect(host).challengeBySig(tableId, m.signature)).to.be.revertedWithCustomError(
        cup,
        "NotBidding",
      );
    }
  });
});
