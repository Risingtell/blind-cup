/**
 * Replays a finished match from the contract's own events, for anyone without a wallet. It shows exactly what
 * the chain shows: who bid what, who called, and the one-word verdict. The dice were never revealed, so the
 * replay can't show them either. Every step links to its transaction.
 *
 * Finished featured matches ship as files exported from the chain (scripts/export-match.ts), because public
 * nodes drop old logs. Any other recent table is read live.
 */
import { Interface, toBeHex, zeroPadValue } from "ethers";

import ABI from "../../bot/BlindCup.abi.json";
import { Phase, reader, type TableState } from "./chain";
import { BLINDCUP } from "./config";
import type { View } from "./match";

export type RecordedEvent = { name: string; block: number; tx: string; args: Record<string, string | boolean> };
export type Recorded = { table: string; events: RecordedEvent[] };

const EVENTS = ["TableOpened", "PlayerJoined", "CupsRolled", "BidPlaced", "Challenged", "RoundResolved", "MatchWon"];
const DEPLOY_BLOCK = 12_108_007;
const SPAN = 9_000;
const iface = new Interface(ABI);

/** Reads a recent table's events straight from the chain, newest blocks first, until the table's opening. */
async function liveEvents(id: bigint): Promise<RecordedEvent[]> {
  const topics = [EVENTS.map((n) => iface.getEvent(n)!.topicHash), zeroPadValue(toBeHex(id), 32)];
  const latest = (await reader.getBlockNumber()) - 3;
  const found = [];
  for (let end = latest, i = 0; end >= DEPLOY_BLOCK && i < 30; end -= SPAN + 1, i++) {
    const logs = await reader.getLogs({
      address: BLINDCUP,
      topics,
      fromBlock: Math.max(DEPLOY_BLOCK, end - SPAN),
      toBlock: end,
    });
    found.push(...logs);
    if (logs.some((l) => iface.parseLog(l)?.name === "TableOpened")) break;
  }
  return found
    .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
    .map((l) => {
      const e = iface.parseLog(l)!;
      const args: Record<string, string | boolean> = {};
      e.fragment.inputs.forEach(
        (input, i) => (args[input.name] = typeof e.args[i] === "boolean" ? e.args[i] : String(e.args[i])),
      );
      return { name: e.name, block: l.blockNumber, tx: l.transactionHash, args };
    });
}

export async function loadMatch(id: bigint): Promise<Recorded> {
  const file = await fetch(`/matches/${id}.json`).catch(() => null);
  if (file?.ok && file.headers.get("content-type")?.includes("json")) return (await file.json()) as Recorded;
  const events = await liveEvents(id);
  if (!events.some((e) => e.name === "MatchWon")) throw new Error(`Table ${id} has no finished match to replay yet.`);
  return { table: id.toString(), events };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export class Replay extends EventTarget {
  view: View;
  private stopped = false;
  private names: [string, string] = ["HOST", "GUEST"];

  constructor(
    private readonly rec: Recorded,
    private readonly wren: string | null,
  ) {
    super();
    this.view = this.blank();
  }

  stop() {
    this.stopped = true;
  }

  private blank(): View {
    return {
      table: null,
      mySeat: null,
      opponent: "friend",
      myDice: null,
      status: "",
      busy: false,
      myTurn: false,
      names: this.names,
    };
  }

  private set(patch: Partial<View>) {
    this.view = { ...this.view, ...patch };
    this.dispatchEvent(new Event("change"));
  }

  private nameOf(addr: unknown) {
    const t = this.view.table;
    if (t && same(addr, t.players[0])) return this.names[0];
    if (t && same(addr, t.players[1])) return this.names[1];
    return short(String(addr));
  }

  async play(): Promise<void> {
    this.stopped = false;
    this.view = this.blank();
    const id = BigInt(this.rec.table);
    let t: TableState = {
      id,
      players: ["", ""],
      phase: Phase.Open,
      round: 0,
      turn: 0,
      wins: [0, 0],
      moves: 0,
      bid: null,
      bidder: "",
      deadline: 0,
      verdictHandle: "",
      winner: "",
      block: 0,
    };
    const step = async (patch: Partial<View>, ms: number) => {
      if (this.stopped) throw new Error("stopped");
      this.set(patch);
      await sleep(ms);
    };

    try {
      for (const e of this.rec.events) {
        const a = e.args;
        const tx = { lastTx: e.tx };
        switch (e.name) {
          case "TableOpened": {
            t = { ...t, players: [String(a.host), ""] };
            this.names = [this.wren && same(a.host, this.wren) ? "WREN" : "HOST", "GUEST"];
            await step(
              {
                table: t,
                names: this.names,
                status: `Table ${id} opens. ${this.names[0]} is ${short(String(a.host))}.`,
                ...tx,
              },
              1600,
            );
            break;
          }
          case "PlayerJoined": {
            t = { ...t, players: [t.players[0], String(a.guest)] };
            const isWren = this.wren && same(a.guest, this.wren);
            this.names = [this.names[0], isWren ? "WREN" : "GUEST"];
            await step(
              { table: t, names: this.names, status: `${this.names[1]} (${short(String(a.guest))}) sits down.`, ...tx },
              1400,
            );
            break;
          }
          case "CupsRolled": {
            t = { ...t, phase: Phase.Bidding, round: Number(a.round), bid: null };
            await step(
              {
                table: t,
                reveal: undefined,
                status: `Round ${a.round}: ten dice rolled, encrypted, on chain. Nobody can see them, not even the game.`,
                ...tx,
              },
              2400,
            );
            break;
          }
          case "BidPlaced": {
            t = { ...t, bid: { quantity: Number(a.quantity), face: Number(a.face) }, bidder: String(a.bidder) };
            await step(
              { table: t, status: `${this.nameOf(a.bidder)} bids ${a.quantity} × ${Number(a.face) + 1}s.`, ...tx },
              1900,
            );
            break;
          }
          case "Challenged": {
            const bid = t.bid!;
            t = { ...t, phase: Phase.Revealing };
            await step(
              {
                table: t,
                reveal: { stage: "sealed", bid, challengerIsMe: false },
                status: `${this.nameOf(a.challenger)} calls it a lie. Both cups stay sealed; the contract counts all ten dice blind.`,
                ...tx,
              },
              1500,
            );
            await step({ reveal: { stage: "counting", bid, challengerIsMe: false }, status: "counting..." }, 2200);
            break;
          }
          case "RoundResolved": {
            const seat = same(a.roundWinner, t.players[0]) ? 0 : 1;
            const wins: [number, number] = [...t.wins];
            wins[seat]++;
            const held = Boolean(a.bidHeld);
            t = { ...t, wins };
            await step(
              {
                table: t,
                reveal: { stage: "word", held, bid: t.bid!, challengerIsMe: false },
                status: `${held ? "HELD: the bid was true." : "LIAR: the bid was false."} ${this.nameOf(a.roundWinner)} takes round ${a.round}. The proof was checked on chain.`,
                ...tx,
              },
              2800,
            );
            break;
          }
          case "MatchWon": {
            const seat = same(a.winner, t.players[0]) ? 0 : 1;
            t = { ...t, phase: Phase.Done, winner: String(a.winner) };
            await step(
              {
                table: t,
                reveal: undefined,
                status: `${this.names[seat]} wins the match, ${t.wins[seat]} to ${t.wins[1 - seat]}. Not one die was ever shown.`,
                retry: { label: "Watch again", run: () => this.play() },
                ...tx,
              },
              0,
            );
            break;
          }
        }
      }
    } catch (e) {
      if (!(e instanceof Error && e.message === "stopped")) throw e;
    }
  }
}
