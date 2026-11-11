/**
 * Exercises Wren's endpoint against Sepolia: opens a table, asks her to join, bids, asks her to move, and
 * relays each signed answer. By default it calls the handler in-process (with her key from Hardhat vars);
 * with WREN_URL set it calls the hosted endpoint instead.
 *
 * npx hardhat run --network sepolia scripts/smoke-wren-api.ts
 * WREN_URL=https://blindcup.onepeg.app/api/wren npx hardhat run --network sepolia scripts/smoke-wren-api.ts
 */
import { deployments, ethers, network } from "hardhat";
import { vars } from "hardhat/config";

async function main() {
  const at = (await deployments.get("BlindCup")).address;
  const remote = process.env.WREN_URL;
  let GET: () => Promise<Response>;
  let POST: (r: Request) => Promise<Response>;
  if (remote) {
    GET = () => fetch(remote);
    POST = (r) =>
      fetch(remote, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: r.body,
        duplex: "half",
      } as RequestInit);
  } else {
    // Her key stays in this process and is never printed.
    process.env.WREN_PRIVATE_KEY = vars.get("WREN_PRIVATE_KEY");
    process.env.BLINDCUP_ADDRESS = at;
    process.env.SEPOLIA_RPC_URL = (network.config as { url: string }).url;
    ({ GET, POST } = await import("../api/wren"));
  }
  console.log(remote ? `calling ${remote}` : "calling the handler in-process");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Answer = any;
  const call = async (body: object): Promise<Answer> => {
    const r = await POST(new Request("http://local/api/wren", { method: "POST", body: JSON.stringify(body) }));
    const j: Answer = await r.json();
    console.log(`  POST ${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
    return j;
  };

  const card: Answer = await (await GET()).json();
  console.log(`GET -> ${card.name} at ${card.address}: "${card.habit}"`);

  const [host] = await ethers.getSigners();
  const cup = await ethers.getContractAt("BlindCup", at);
  const base = (await ethers.provider.getBlock("latest"))!.baseFeePerGas ?? 0n;
  const tip = ethers.parseUnits("0.01", "gwei");
  const fees = { maxPriorityFeePerGas: tip, maxFeePerGas: base * 4n + tip * 2n };

  const open = await (await cup.connect(host).openTable(fees)).wait();
  const tableId = await cup.tableCount({ blockTag: open!.blockNumber });
  console.log(`table ${tableId} opened`);

  await call({ tableId: "x", action: "join" });
  await call({ tableId: Number(tableId), action: "move", block: open!.blockNumber });
  const join = await call({ tableId: Number(tableId), action: "join", block: open!.blockNumber });
  const joined = await (await cup.connect(host).joinTableBySig(tableId, join.signature, fees)).wait();
  console.log(`  relayed her join: block ${joined!.blockNumber}`);

  const bid = await (await cup.connect(host).placeBid(tableId, 2, 3, fees)).wait();
  const m = await call({ tableId: tableId.toString(), action: "move", block: bid!.blockNumber });
  const again = await call({ tableId: tableId.toString(), action: "move", block: bid!.blockNumber });
  if (again.signature !== m.signature) throw new Error("asked twice, got two different moves");
  if ("bluff" in m.play) throw new Error("the response leaks whether she is bluffing");
  const tx =
    m.play.kind === "challenge"
      ? await cup.connect(host).challengeBySig(tableId, m.signature, fees)
      : await cup.connect(host).placeBidBySig(tableId, m.play.quantity, m.play.face, m.signature, fees);
  const r = await tx.wait();
  console.log(`  relayed her ${m.play.kind}: https://sepolia.etherscan.io/tx/${r!.hash}`);
  console.log(
    "smoke test passed: the endpoint joins, refuses bad input and out-of-turn asks, and signs moves that the chain accepts",
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
