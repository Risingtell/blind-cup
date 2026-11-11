/**
 * Wren's seat, hosted. POST { tableId, action: "join" | "move", block? } and she answers with a signed move
 * for the caller to relay. She never sends a transaction, so she never needs gas.
 *
 * Env: WREN_PRIVATE_KEY (her key, testnet only), BLINDCUP_ADDRESS, SEPOLIA_RPC_URL.
 */
import { Contract, JsonRpcProvider, Wallet } from "ethers";

import ABI from "../bot/BlindCup.abi.json";
import { CARD } from "../bot/persona";
import { type BotContext, nextMove, NotMyTurn, signJoin } from "../bot/service";
import { deriveSecret, sepoliaInstance, userDecryptDice } from "../bot/relayer";
import type { BlindCup } from "../types";

const json = (body: unknown, status = 200) =>
  new Response(
    JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    },
  );

let ctxPromise: Promise<BotContext> | undefined;

function context(): Promise<BotContext> {
  ctxPromise ??= (async () => {
    const key = process.env.WREN_PRIVATE_KEY;
    const at = process.env.BLINDCUP_ADDRESS;
    const rpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
    if (!key || !at) throw new Error("WREN_PRIVATE_KEY and BLINDCUP_ADDRESS must be set");
    const provider = new JsonRpcProvider(rpc, 11155111, { staticNetwork: true });
    const signer = new Wallet(key, provider);
    const cup = new Contract(at, ABI, provider) as unknown as BlindCup;
    const instance = sepoliaInstance(rpc);
    return {
      cup,
      signer,
      secret: await deriveSecret(signer),
      readOwnCup: async (handles) => userDecryptDice(await instance, signer, at, handles),
    };
  })();
  ctxPromise.catch(() => (ctxPromise = undefined));
  return ctxPromise;
}

export async function GET(): Promise<Response> {
  const ctx = await context();
  return json({ ...CARD, address: await ctx.signer.getAddress() });
}

export async function POST(request: Request): Promise<Response> {
  let body: { tableId?: unknown; action?: unknown; block?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "send JSON: { tableId, action, block? }" }, 400);
  }
  const { tableId, action, block } = body;
  if (typeof tableId !== "string" && typeof tableId !== "number") return json({ error: "tableId is required" }, 400);
  if (block !== undefined && (typeof block !== "number" || !Number.isInteger(block) || block < 0))
    return json({ error: "block must be a block number" }, 400);
  let id: bigint;
  try {
    id = BigInt(tableId);
  } catch {
    return json({ error: "tableId must be a whole number" }, 400);
  }

  try {
    const ctx = await context();
    if (action === "join") return json(await signJoin(ctx, id, block));
    if (action === "move") return json(await nextMove(ctx, id, block));
    return json({ error: 'action must be "join" or "move"' }, 400);
  } catch (e) {
    if (e instanceof NotMyTurn) return json({ error: e.message }, 409);
    console.error(e);
    return json({ error: "Wren could not answer just now. Try again in a moment." }, 503);
  }
}
