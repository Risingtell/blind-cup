/**
 * The bot at the table. It reads the table from the chain (never from the caller), decrypts only its own
 * cup, decides, and signs the move with EIP-712. It never sends a transaction: the human relays the
 * signed move and pays the gas.
 *
 * Every signed move commits to the table's `moves` counter, and the choice is seeded from the bot's secret
 * plus that same position, so asking twice returns the same move and a used signature never replays.
 */
import { AbiCoder, keccak256, type Signer } from "ethers";

import type { BlindCup } from "../types";
import { decide, seeded, WREN, type Persona } from "./brain";
import { line, type Moment } from "./persona";

export const JOIN_TYPES = { Join: [{ name: "tableId", type: "uint256" }] };
export const BID_TYPES = {
  Bid: [
    { name: "tableId", type: "uint256" },
    { name: "move", type: "uint32" },
    { name: "quantity", type: "uint8" },
    { name: "face", type: "uint8" },
  ],
};
export const CHALLENGE_TYPES = {
  Challenge: [
    { name: "tableId", type: "uint256" },
    { name: "move", type: "uint32" },
  ],
};

const PHASE = { Open: 0n, Bidding: 1n, Revealing: 2n, Done: 3n };

export type BotContext = {
  cup: BlindCup;
  /** The bot's key. It only signs. */
  signer: Signer;
  /** 32-byte hex secret that seeds the bot's choices. Keep it private, or players can predict her. */
  secret: string;
  /** Decrypts the bot's own five dice (faces 0..5). Any other cup is refused by the Zama ACL. */
  readOwnCup: (handles: string[]) => Promise<number[]>;
  persona?: Persona;
};

export type BotMove = {
  tableId: bigint;
  move: number;
  /** Only what the table will see. Whether she believes her own bid never leaves the service. */
  play: Play;
  signature: string;
  /** What she says. Chosen independently of whether she is bluffing. */
  says: string;
  /** Her hands: true when she taps her cup. */
  tell: boolean;
};

export type Play = { kind: "bid"; quantity: number; face: number } | { kind: "challenge" };

export class NotMyTurn extends Error {}

async function domainOf(ctx: BotContext) {
  const net = await ctx.cup.runner!.provider!.getNetwork();
  return { name: "BlindCup", version: "1", chainId: net.chainId, verifyingContract: await ctx.cup.getAddress() };
}

/** Deterministic per position: same secret, chain, contract, table and move number give the same stream. */
export function rngFor(secret: string, chainId: bigint, at: string, tableId: bigint, move: number) {
  const h = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "address", "uint256", "uint32"], [secret, chainId, at, tableId, move]));
  return seeded(parseInt(h.slice(2, 10), 16));
}

/** Signs a Join for an open table. Anyone may submit it; the bot takes seat 1. */
export async function signJoin(ctx: BotContext, tableId: bigint, blockTag?: number) {
  const t = await ctx.cup.tableOf(tableId, blockTag ? { blockTag } : {});
  if (t.phase !== PHASE.Open) throw new NotMyTurn(`table ${tableId} is not open`);
  const signature = await ctx.signer.signTypedData(await domainOf(ctx), JOIN_TYPES, { tableId });
  return { tableId, signature };
}

/**
 * Decides and signs the bot's next move. Pass `blockTag` (the block of the last move) when the RPC may lag,
 * so the move counter it signs is the current one.
 */
export async function nextMove(ctx: BotContext, tableId: bigint, blockTag?: number): Promise<BotMove> {
  const at = await ctx.cup.getAddress();
  const me = await ctx.signer.getAddress();
  const opts = blockTag ? { blockTag } : {};
  const t = await ctx.cup.tableOf(tableId, opts);
  if (t.phase !== PHASE.Bidding) throw new NotMyTurn(`table ${tableId} is not in a bidding round`);
  const seat = t.players.findIndex((p) => p.toLowerCase() === me.toLowerCase());
  if (seat < 0) throw new NotMyTurn(`the bot is not seated at table ${tableId}`);
  if (Number(t.turn) !== seat) throw new NotMyTurn(`it is not the bot's turn at table ${tableId}`);

  const handles: string[] = await ctx.cup.cupOf(tableId, t.round, seat, opts);
  const dice = await ctx.readOwnCup(handles);
  const move = Number(t.moves);
  const domain = await domainOf(ctx);
  const rng = rngFor(ctx.secret, domain.chainId, at, tableId, move);

  const standing = t.bidQuantity === 0n ? null : { quantity: Number(t.bidQuantity), face: Number(t.bidFace) };
  const decision = decide(dice, standing, rng, ctx.persona ?? WREN);

  let signature: string;
  let moment: Moment;
  if (decision.kind === "challenge") {
    signature = await ctx.signer.signTypedData(domain, CHALLENGE_TYPES, { tableId, move });
    moment = "challenge";
  } else {
    signature = await ctx.signer.signTypedData(domain, BID_TYPES, { tableId, move, quantity: decision.quantity, face: decision.face });
    moment = standing ? "raise" : "open";
  }
  const play: Play = decision.kind === "bid" ? { kind: "bid", quantity: decision.quantity, face: decision.face } : { kind: "challenge" };
  const tell = decision.kind === "bid" && decision.tell;
  return { tableId, move, play, signature, says: line(moment, rng), tell };
}
