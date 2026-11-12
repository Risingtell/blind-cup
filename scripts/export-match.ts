/**
 * Exports one table's full event history from Sepolia to web/public/matches/<id>.json, so the site can replay
 * it for anyone without a wallet. Public nodes drop old logs after a while; the export keeps the match while
 * every step stays checkable on Etherscan through its transaction hash.
 *
 * npx ts-node --transpile-only scripts/export-match.ts <tableId> [fromBlock]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Interface, JsonRpcProvider, toBeHex, zeroPadValue } from "ethers";

const ADDRESS = process.env.BLINDCUP_ADDRESS ?? "0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB";
const RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const DEPLOY_BLOCK = 12_108_007;
const SPAN = 9_000; // public nodes cap a log query at 10,000 blocks
const EVENTS = ["TableOpened", "PlayerJoined", "CupsRolled", "BidPlaced", "Challenged", "RoundResolved", "MatchWon"];

async function main() {
  const id = BigInt(process.argv[2] ?? "");
  const from = Number(process.argv[3] ?? DEPLOY_BLOCK);
  const iface = new Interface(JSON.parse(readFileSync(join(__dirname, "../bot/BlindCup.abi.json"), "utf8")));
  const provider = new JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
  const topics = [EVENTS.map((n) => iface.getEvent(n)!.topicHash), zeroPadValue(toBeHex(id), 32)];
  const latest = (await provider.getBlockNumber()) - 3;

  const logs = [];
  for (let start = from; start <= latest; start += SPAN + 1) {
    logs.push(
      ...(await provider.getLogs({
        address: ADDRESS,
        topics,
        fromBlock: start,
        toBlock: Math.min(latest, start + SPAN),
      })),
    );
  }
  if (!logs.some((l) => iface.parseLog(l)?.name === "MatchWon"))
    throw new Error(`table ${id} has no finished match in range`);

  const events = logs
    .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
    .map((l) => {
      const e = iface.parseLog(l)!;
      const args: Record<string, string | boolean> = {};
      e.fragment.inputs.forEach((input, i) => {
        const v = e.args[i];
        args[input.name] = typeof v === "boolean" ? v : String(v);
      });
      return { name: e.name, block: l.blockNumber, tx: l.transactionHash, args };
    });

  const out = { chainId: 11155111, contract: ADDRESS, table: id.toString(), events };
  const dir = join(__dirname, "../web/public/matches");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`table ${id}: ${events.length} events -> web/public/matches/${id}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
