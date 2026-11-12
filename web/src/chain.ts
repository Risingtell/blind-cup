/**
 * Chain access. Reads go to a public RPC pinned to the block of our last transaction (load-balanced nodes
 * lag). The player's wallet only signs and broadcasts: gas, fees and receipts all come from our own node,
 * because some wallets' Sepolia nodes fail plain reads. A low tip keeps a whole match to pennies of test ETH.
 */
import {
  BrowserProvider,
  Contract,
  type ContractTransactionReceipt,
  type Eip1193Provider,
  JsonRpcProvider,
  parseUnits,
  type Signer,
  toQuantity,
  type TransactionReceipt,
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

/** Puts the wallet on Sepolia, adding the network if the wallet has never seen it. */
async function useSepolia(eth: Eip1193Provider) {
  if (Number(await eth.request({ method: "eth_chainId" })) === CHAIN_ID) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await eth.request({
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
}

/** Wallets reject with plain objects; ethers adds a short message to contract reverts. Make both readable. */
function asError(e: unknown): Error {
  const x = e as { shortMessage?: string; message?: string; revert?: { name?: string }; data?: string };
  let refused = x?.revert?.name;
  if (!refused && typeof x?.data === "string") {
    try {
      refused = readCup.interface.parseError(x.data)?.name;
    } catch {
      // not one of the contract's errors
    }
  }
  if (refused) return new Error(`The table refused that move (${refused}).`);
  if (/insufficient funds/i.test(`${x?.shortMessage ?? ""} ${x?.message ?? ""}`)) {
    return new Error("Your wallet doesn't have enough test ETH for this move. Top it up free, then try again.");
  }
  if (e instanceof Error) return new Error(x.shortMessage ?? e.message);
  return new Error(x?.message ?? String(e));
}

export class Wallet {
  private constructor(
    readonly signer: Signer,
    readonly address: string,
    private readonly injected?: Eip1193Provider,
  ) {}

  /**
   * Local development only: a test key served by the dev server (see vite.config.ts), so a whole match can
   * be played and checked without a browser extension. Never part of a production build.
   */
  static async devWallet(): Promise<Wallet | null> {
    const which = new URLSearchParams(location.search).get("devwallet");
    if (!import.meta.env.DEV || which === null) return null;
    const { key } = (await (await fetch(`/api/dev-wallet${which === "2" ? "?n=2" : ""}`)).json()) as { key: string };
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
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await useSepolia(window.ethereum);
      const provider = new BrowserProvider(window.ethereum, CHAIN_ID);
      const signer = await provider.getSigner();
      return new Wallet(signer, await signer.getAddress(), window.ethereum);
    } catch (e) {
      throw asError(e);
    }
  }

  async balance() {
    return reader.getBalance(this.address);
  }

  /** Sends a BlindCup call with a low tip and waits for it. Returns the receipt. */
  async send(method: string, ...args: unknown[]): Promise<TransactionReceipt> {
    let receipt: TransactionReceipt | null;
    try {
      const base = (await reader.getBlock("latest"))?.baseFeePerGas ?? 0n;
      const tip = parseUnits(TIP_GWEI, "gwei");
      // A node accepts a transaction only if the wallet holds gas limit x max fee, so keep the cap close to the real
      // price: room for the base fee to triple, plus the tip. Sepolia's base fee is near zero.
      const fees = { maxPriorityFeePerGas: tip, maxFeePerGas: base * 3n + tip };
      if (!this.injected) {
        // The local test key: ethers signs and sends through our own node.
        const tx = await new Contract(BLINDCUP, ABI, this.signer).getFunction(method)(...args, fees);
        receipt = (await tx.wait()) as ContractTransactionReceipt | null;
      } else {
        // Estimating on our node also stops a move the contract would refuse before the wallet opens.
        const fn = readCup.getFunction(method);
        // A lagging node may not have seen our last move yet, so a refusal is only believed after a few tries.
        const gas = await retry(() => fn.estimateGas(...args, { from: this.address }), 5, 2500);
        const { data } = await fn.populateTransaction(...args);
        await useSepolia(this.injected);
        const hash = (await this.injected.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: this.address,
              to: BLINDCUP,
              data,
              value: "0x0",
              gas: toQuantity((gas * 5n) / 4n),
              maxFeePerGas: toQuantity(fees.maxFeePerGas),
              maxPriorityFeePerGas: toQuantity(fees.maxPriorityFeePerGas),
              chainId: CHAIN_HEX,
            },
          ],
        })) as string;
        receipt = await reader.waitForTransaction(hash, 1, 10 * 60_000);
      }
    } catch (e) {
      throw asError(e);
    }
    if (!receipt || receipt.status !== 1) throw new Error(`${method} failed on chain`);
    return receipt;
  }
}

/** Reads a named event from a receipt (the receipt is the source of truth; nodes lag). */
export function eventIn(receipt: TransactionReceipt, name: string) {
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
