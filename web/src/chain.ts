/**
 * Chain access. Reads go to a public RPC pinned to the block of our last transaction (load-balanced nodes
 * lag); writes go through the player's own wallet with a low tip, so a whole match costs pennies of test ETH.
 */
import {
  BrowserProvider,
  Contract,
  type ContractTransactionReceipt,
  type Eip1193Provider,
  JsonRpcProvider,
  parseUnits,
  type Signer,
} from "ethers";

import ABI from "../../bot/BlindCup.abi.json";
import { BLINDCUP, CHAIN_HEX, CHAIN_ID, READ_RPC, TIP_GWEI } from "./config";

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { on?: (e: string, f: (...a: unknown[]) => void) => void };
  }
}

export const reader = new JsonRpcProvider(READ_RPC, CHAIN_ID, { staticNetwork: true });
export const readCup = new Contract(BLINDCUP, ABI, reader);

export const Phase = { Open: 0, Bidding: 1, Revealing: 2, Done: 3 } as const;

export type TableState = {
  id: bigint;
  players: [string, string];
  phase: number;
  round: number;
  turn: number;
  wins: [number, number];
  moves: number;
  bid: { quantity: number; face: number } | null;
  bidder: string;
  deadline: number;
  verdictHandle: string;
  winner: string;
  block: number;
};

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
export const isZero = (a: string) => a === ZERO_ADDR;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries reads that fail because a lagging node has not seen `block` yet. */
export async function retry<T>(fn: () => Promise<T>, tries = 12, waitMs = 2500): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(waitMs);
    }
  }
}

export async function tableAt(id: bigint, block?: number): Promise<TableState> {
  return retry(async () => {
    const tag = block ?? (await reader.getBlockNumber());
    const t = await readCup.tableOf(id, { blockTag: tag });
    return {
      id,
      players: [t.players[0], t.players[1]],
      phase: Number(t.phase),
      round: Number(t.round),
      turn: Number(t.turn),
      wins: [Number(t.wins[0]), Number(t.wins[1])],
      moves: Number(t.moves),
      bid: Number(t.bidQuantity) === 0 ? null : { quantity: Number(t.bidQuantity), face: Number(t.bidFace) },
      bidder: t.bidder,
      deadline: Number(t.deadline),
      verdictHandle: t.verdictHandle,
      winner: t.winner,
      block: tag,
    };
  });
}

export async function cupHandles(id: bigint, round: number, seat: number, block: number): Promise<string[]> {
  return retry(async () => {
    const h: string[] = await readCup.cupOf(id, round, seat, { blockTag: block });
    if (h.some((x) => /^0x0+$/.test(x))) throw new Error("node behind");
    return [...h];
  });
}

export class Wallet {
  private constructor(
    readonly signer: Signer,
    readonly address: string,
  ) {}

  /**
   * Local development only: a test key served by the dev server (see vite.config.ts), so a whole match can
   * be played and checked without a browser extension. Never part of a production build.
   */
  static async devWallet(): Promise<Wallet | null> {
    if (!import.meta.env.DEV || !new URLSearchParams(location.search).has("devwallet")) return null;
    const { key } = (await (await fetch("/api/dev-wallet")).json()) as { key: string };
    const { Wallet: KeyWallet } = await import("ethers");
    const w = new KeyWallet(key, reader);
    return new Wallet(w, w.address);
  }

  static available() {
    return Boolean(window.ethereum);
  }

  static async connect(): Promise<Wallet> {
    const dev = await Wallet.devWallet();
    if (dev) return dev;
    if (!window.ethereum) throw new Error("No wallet found. Install MetaMask or Rabby, then reload.");
    await window.ethereum.request({ method: "eth_requestAccounts" });
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: CHAIN_HEX,
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: [READ_RPC],
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      });
    }
    const provider = new BrowserProvider(window.ethereum, CHAIN_ID);
    const signer = await provider.getSigner();
    return new Wallet(signer, await signer.getAddress());
  }

  async balance() {
    return reader.getBalance(this.address);
  }

  /** Sends a BlindCup call with a low tip and waits for it. Returns the receipt. */
  async send(method: string, ...args: unknown[]): Promise<ContractTransactionReceipt> {
    const cup = new Contract(BLINDCUP, ABI, this.signer);
    const base = (await reader.getBlock("latest"))?.baseFeePerGas ?? 0n;
    const tip = parseUnits(TIP_GWEI, "gwei");
    const tx = await cup.getFunction(method)(...args, {
      maxPriorityFeePerGas: tip,
      maxFeePerGas: base * 4n + tip * 2n,
    });
    const receipt = (await tx.wait()) as ContractTransactionReceipt | null;
    if (!receipt || receipt.status !== 1) throw new Error(`${method} failed on chain`);
    return receipt;
  }
}

/** Reads a named event from a receipt (the receipt is the source of truth; nodes lag). */
export function eventIn(receipt: ContractTransactionReceipt, name: string) {
  for (const log of receipt.logs) {
    try {
      const parsed = readCup.interface.parseLog(log);
      if (parsed?.name === name) return parsed.args;
    } catch {
      // a log from another contract
    }
  }
  return null;
}

/** Every move ever made at a table, for the replay. */
export async function history(id: bigint) {
  const filters = ["TableOpened", "PlayerJoined", "CupsRolled", "BidPlaced", "Challenged", "RoundResolved", "MatchWon"];
  const latest = await reader.getBlockNumber();
  const logs = await readCup.queryFilter(readCup.filters.TableOpened(id), latest - 49_000, latest);
  const from = logs[0]?.blockNumber ?? latest - 49_000;
  const all = [];
  for (const name of filters) {
    const f = readCup.filters[name](id);
    all.push(...(await readCup.queryFilter(f, from, latest)));
  }
  return all.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
}
