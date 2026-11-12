/**
 * One match, start to finish. Rendering-free: it holds the view and emits "change"; the scene and the
 * controls draw from it. Against Wren, her signed moves are relayed by the player's wallet. Against a
 * friend, both browsers watch the same table and each plays their own seat.
 */
import type { TransactionReceipt } from "ethers";

import { cupHandles, eventIn, isZero, Phase, tableAt, type TableState, Wallet } from "./chain";
import { line } from "../../bot/persona";
import { readOwnDice, readVerdict } from "./fhe";
import { wrenCard, wrenJoin, wrenMove } from "./wren";

export type Reveal = {
  stage: "sealed" | "counting" | "word";
  held?: boolean;
  bid: { quantity: number; face: number };
  challengerIsMe: boolean;
};

export type View = {
  table: TableState | null;
  mySeat: number | null;
  opponent: "wren" | "friend" | null;
  myDice: number[] | null;
  status: string;
  busy: boolean;
  myTurn: boolean;
  wren?: { says: string; tell: boolean; seq: number };
  reveal?: Reveal;
  lastTx?: string;
  error?: string;
  /** Set when a step needs the player to press something again (a rejected wallet prompt, a stalled seat). */
  retry?: { label: string; run: () => Promise<void> };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export class Match extends EventTarget {
  view: View = { table: null, mySeat: null, opponent: null, myDice: null, status: "", busy: false, myTurn: false };
  private diceRound = 0;
  private settling = false;
  private wrenSeq = 0;
  private polling = false;
  private stopped = false;

  constructor(readonly wallet: Wallet) {
    super();
  }

  private set(patch: Partial<View>) {
    this.view = { ...this.view, ...patch };
    this.dispatchEvent(new Event("change"));
  }

  stop() {
    this.stopped = true;
  }

  /** Runs a step, turning failures into a message and a retry button instead of a dead table. */
  private async guard(label: string, run: () => Promise<void>) {
    this.set({ busy: true, error: undefined, retry: undefined });
    try {
      await run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rejected = /user rejected|denied|ACTION_REJECTED/i.test(msg);
      this.set({
        error: rejected ? "You declined in your wallet." : msg.slice(0, 200),
        retry: { label, run: () => this.guard(label, run) },
      });
    } finally {
      this.set({ busy: false });
    }
  }

  // ---------------------------------------------------------------- starting

  playWren() {
    return this.guard("Try again", async () => {
      this.set({ opponent: "wren", status: "Opening a table. Confirm in your wallet." });
      const open = await this.wallet.send("openTable");
      const id = eventIn(open, "TableOpened")!.tableId as bigint;
      this.set({ status: `Table ${id} is open. Wren is signing her seat...`, lastTx: open.hash });
      await this.seatWren(id, open.blockNumber);
    });
  }

  private async seatWren(id: bigint, block: number) {
    const { signature } = await wrenJoin(id, block);
    this.set({
      status: "Wren signed her seat. Confirm in your wallet to bring her to the table (this rolls both cups).",
    });
    const join = await this.wallet.send("joinTableBySig", id, signature);
    this.set({ lastTx: join.hash });
    await this.after(id, join);
  }

  openForFriend() {
    return this.guard("Try again", async () => {
      this.set({ opponent: "friend", status: "Opening a table. Confirm in your wallet." });
      const open = await this.wallet.send("openTable");
      const id = eventIn(open, "TableOpened")!.tableId as bigint;
      this.set({ lastTx: open.hash });
      await this.after(id, open);
    });
  }

  joinFriend(id: bigint) {
    return this.guard("Try again", async () => {
      this.set({ opponent: "friend", status: `Taking the empty seat at table ${id}. Confirm in your wallet.` });
      const join = await this.wallet.send("joinTable", id);
      this.set({ lastTx: join.hash });
      await this.after(id, join);
    });
  }

  /** Opens an existing table: as a player if you sit there, otherwise not at all. */
  resume(id: bigint) {
    return this.guard("Try again", async () => {
      const t = await tableAt(id);
      const wren = await wrenCard().catch(() => null);
      const opp = t.players.find((p) => !same(p, this.wallet.address));
      this.set({ opponent: wren && same(opp, wren.address) ? "wren" : "friend" });
      if (t.phase === Phase.Open && !t.players.some((p) => same(p, this.wallet.address))) return this.joinFriend(id);
      await this.sync(t);
    });
  }

  // ---------------------------------------------------------------- moves

  bid(quantity: number, face: number) {
    const t = this.view.table!;
    return this.guard("Place the bid again", async () => {
      this.set({ status: `Bidding ${quantity} x ${face + 1}s. Confirm in your wallet.` });
      const r = await this.wallet.send("placeBid", t.id, quantity, face);
      this.set({ lastTx: r.hash });
      await this.after(t.id, r);
    });
  }

  call() {
    const t = this.view.table!;
    return this.guard("Call it again", async () => {
      this.set({ status: "Calling the bid a lie. Confirm in your wallet." });
      const r = await this.wallet.send("challenge", t.id);
      this.set({ lastTx: r.hash });
      await this.after(t.id, r);
    });
  }

  claimTimeout() {
    const t = this.view.table!;
    return this.guard("Claim again", async () => {
      const r = await this.wallet.send("claimTimeout", t.id);
      this.set({ lastTx: r.hash });
      await this.after(t.id, r);
    });
  }

  // ---------------------------------------------------------------- the loop

  private async after(id: bigint, receipt: TransactionReceipt) {
    await this.sync(await tableAt(id, receipt.blockNumber));
  }

  /** Brings the view up to a table state and does whatever that state asks of this seat. */
  private async sync(t: TableState): Promise<void> {
    if (this.stopped) return;
    const mySeat = t.players.findIndex((p) => same(p, this.wallet.address));
    this.set({ table: t, mySeat: mySeat < 0 ? null : mySeat });
    if (mySeat < 0) return this.set({ status: "You are not seated at this table.", myTurn: false });

    if (t.phase === Phase.Open) {
      this.set({
        status: `Table ${t.id} is open. Send your friend the link; the cups roll when they sit.`,
        myTurn: false,
      });
      return this.watch(t);
    }

    if (t.round !== this.diceRound && t.phase !== Phase.Done) {
      this.set({
        status: `Round ${t.round}: lifting your cup. Your wallet asks once per visit to let you see your own dice.`,
        myDice: null,
      });
      const handles = await cupHandles(t.id, t.round, mySeat, t.block);
      const dice = await readOwnDice(this.wallet.signer, handles);
      this.diceRound = t.round;
      this.set({ myDice: dice, reveal: undefined });
    }

    if (t.phase === Phase.Done) {
      const won = same(t.winner, this.wallet.address);
      const name = this.view.opponent === "wren" ? "Wren" : "Your friend";
      if (this.view.opponent === "wren") this.wrenSays(line(won ? "loseMatch" : "winMatch", Math.random), false);
      await sleep(this.view.reveal ? 1500 : 0);
      return this.set({
        reveal: undefined,
        myTurn: false,
        status: won
          ? `You win the match, ${t.wins[mySeat]} to ${t.wins[1 - mySeat]}.`
          : `${name} wins the match, ${t.wins[1 - mySeat]} to ${t.wins[mySeat]}.`,
        retry: {
          label: this.view.opponent === "wren" ? "Play Wren again" : "Open a new table",
          run: () => (this.view.opponent === "wren" ? this.playWren() : this.openForFriend()),
        },
      });
    }

    if (t.phase === Phase.Revealing) return this.reveal(t);

    const myTurn = t.turn === mySeat;
    if (myTurn) {
      return this.set({
        myTurn: true,
        status: t.bid ? "Your move: raise the bid, or call it a lie." : "Your move: open the bidding.",
      });
    }
    this.set({ myTurn: false });
    if (this.view.opponent === "wren") return this.wrenTurn(t);
    this.set({ status: "Waiting for your friend's move..." });
    return this.watch(t);
  }

  private async wrenTurn(t: TableState) {
    this.set({ status: "Wren is thinking..." });
    const [m] = await Promise.all([wrenMove(t.id, t.block), sleep(1200)]);
    this.wrenSays(m.says, m.tell);
    const what = m.play.kind === "challenge" ? "calls your bid a lie" : `bids ${m.play.quantity} x ${m.play.face + 1}s`;
    this.set({ status: `Wren ${what}. Confirm in your wallet to put her signed move on the table.` });
    const r =
      m.play.kind === "challenge"
        ? await this.wallet.send("challengeBySig", t.id, m.signature)
        : await this.wallet.send("placeBidBySig", t.id, m.play.quantity, m.play.face, m.signature);
    this.set({ lastTx: r.hash });
    await this.after(t.id, r);
  }

  /** The theatre: both cups sealed, "counting...", one word. Then the verdict is settled on chain with its proof. */
  private async reveal(t: TableState) {
    const bid = t.bid!;
    const challengerIsMe = !same(t.bidder, this.wallet.address); // the caller is whoever did not make the bid
    this.set({
      myTurn: false,
      reveal: { stage: "sealed", bid, challengerIsMe },
      status: "Both cups stay sealed. The contract counted them blind.",
    });
    await sleep(1400);
    this.set({ reveal: { stage: "counting", bid, challengerIsMe }, status: "counting..." });
    const [{ held, proof }] = await Promise.all([readVerdict(t.verdictHandle), sleep(2200)]);
    this.set({ reveal: { stage: "word", held, bid, challengerIsMe }, status: held ? "HELD" : "LIAR" });
    if (this.view.opponent === "wren") {
      const iWon = held !== challengerIsMe; // a bid that held wins for its bidder
      await sleep(900);
      this.wrenSays(line(iWon ? "loseRound" : "winRound", Math.random), false);
    }
    await sleep(1600);

    // In a friend game, the player who called settles; the other waits and can take over if they don't.
    const iSettle = this.view.opponent === "wren" || challengerIsMe;
    if (!iSettle) {
      this.set({ status: "Waiting for the caller to settle the round on chain..." });
      return this.watch(t);
    }
    if (this.settling) return;
    this.settling = true;
    try {
      this.set({
        status:
          "Settle the round on chain with the Zama proof. Confirm in your wallet (this also rolls the next cups).",
      });
      const r = await this.wallet.send("resolve", t.id, held, proof);
      this.set({ lastTx: r.hash });
      await this.after(t.id, r);
    } finally {
      this.settling = false;
    }
  }

  private wrenSays(says: string, tell: boolean) {
    this.set({ wren: { says, tell, seq: ++this.wrenSeq } });
  }

  /** Polls the table until it changes, then syncs. Used while the other human is moving. */
  private async watch(t: TableState): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (;;) {
        await sleep(4000);
        if (this.stopped) return;
        const now = await tableAt(t.id).catch(() => null);
        if (!now) continue;
        if (now.moves !== t.moves || now.phase !== t.phase || now.round !== t.round) {
          this.polling = false;
          return this.sync(now);
        }
        const stalled = now.phase === Phase.Bidding && now.deadline > 0 && Date.now() / 1000 > now.deadline + 15;
        if (stalled && now.turn !== this.view.mySeat && !this.view.retry) {
          this.set({ retry: { label: "Claim the win (they ran out of time)", run: () => this.claimTimeout() } });
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

export const opponentLabel = (o: View["opponent"]) => (o === "wren" ? "Wren" : "Your friend");
export { isZero };
