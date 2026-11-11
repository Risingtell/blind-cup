import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ContractTransactionReceipt, ContractTransactionResponse, Overrides } from "ethers";
import { task, types } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

const TX = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
const show = (face: number) => face + 1; // stored 0..5, shown 1..6
const ZERO = "0x" + "0".repeat(64);

async function retry<T>(label: string, fn: () => Promise<T>, tries = 24, waitMs = 5000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      console.log(`  ${label}: not ready yet, retrying (${i}/${tries})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

const message = (e: unknown) =>
  e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ""}` : String(e);
const isNetworkError = (e: unknown) =>
  /timeout|timed out|ETIMEDOUT|ECONNRESET|UND_ERR|socket hang up|fetch failed|502|503|504/i.test(message(e));

/**
 * Sends a transaction, riding out a flaky public RPC:
 * - a pre-send gas estimate that reverts is retried, because a load-balanced node may not have seen the
 *   previous block yet (nothing is broadcast until the estimate passes);
 * - a timeout or dropped connection is retried too. Every move is bound to the table's state, so if a
 *   timed-out send did land, the retry's estimate reverts instead of moving twice.
 * The receipt wait retries only network errors, never a mined revert.
 */
async function send(fn: () => Promise<ContractTransactionResponse>, tries = 6) {
  for (let i = 1; ; i++) {
    let tx: ContractTransactionResponse;
    try {
      tx = await fn();
    } catch (e) {
      const stale = message(e).includes("execution reverted");
      if (i >= tries || !(stale || isNetworkError(e))) throw e;
      console.log(`  ${stale ? "node behind the chain head" : "RPC timed out"}, retrying the send (${i}/${tries})`);
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    for (let j = 1; ; j++) {
      try {
        return await tx.wait();
      } catch (e) {
        if (j >= tries || !isNetworkError(e)) throw e;
        console.log(`  RPC timed out waiting for the receipt, retrying (${j}/${tries})`);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
}

/**
 * Sepolia's base fee is near zero, so almost all of a transaction's cost is the priority tip, and the
 * default tip of 1 gwei made one match cost about 0.017 test ETH. A 0.01 gwei tip still gets mined and costs
 * a hundredth of that. You pay base fee plus tip, never the cap.
 */
const TIP_GWEI = "0.01";
let FEES: Overrides = {};

async function useLowFees(hre: HardhatRuntimeEnvironment) {
  const block = await hre.ethers.provider.getBlock("latest");
  const tip = hre.ethers.parseUnits(TIP_GWEI, "gwei");
  // Nodes check the wallet can cover gas limit x fee cap, so the cap stays just above what is actually paid:
  // room for the base fee to quadruple, plus twice the tip.
  FEES = { maxPriorityFeePerGas: tip, maxFeePerGas: (block?.baseFeePerGas ?? 0n) * 4n + tip * 2n };
}

function countFor(dice: number[], face: number): number {
  return dice.filter((d) => d === face || (face !== 0 && d === 0)).length;
}

async function contractAt(hre: HardhatRuntimeEnvironment, address?: string) {
  const at = address ?? (await hre.deployments.get("BlindCup")).address;
  return { at, cup: await hre.ethers.getContractAt("BlindCup", at) };
}

type Cup = Awaited<ReturnType<typeof contractAt>>["cup"];

/** Reads a named event from a mined receipt. Public RPCs are load-balanced, so the receipt is the source of truth. */
function eventArgs(cup: Cup, receipt: ContractTransactionReceipt | null, name: string) {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = cup.interface.parseLog(log);
      if (parsed?.name === name) return parsed.args;
    } catch {
      // a log from another contract (ACL, executor): skip it
    }
  }
  throw new Error(`no ${name} event in tx ${receipt?.hash}`);
}

/** Each player decrypts only their own cup, reading handles as of a fixed block so a lagging node can't serve zeros. */
async function readCups(
  hre: HardhatRuntimeEnvironment,
  cup: Cup,
  at: string,
  tableId: bigint,
  round: bigint,
  players: HardhatEthersSigner[],
  blockTag?: number,
) {
  const cups: number[][] = [];
  for (const [seat, player] of players.entries()) {
    const handles = await retry(`cup ${seat} handles`, async () => {
      const h: string[] = await cup.cupOf(tableId, round, seat, blockTag ? { blockTag } : {});
      if (h.some((x) => x === ZERO)) throw new Error("node behind");
      return h;
    });
    const dice: number[] = [];
    for (const h of handles) {
      dice.push(
        Number(
          await retry(`seat ${seat} reading own die`, () =>
            hre.fhevm.userDecryptEuint(FhevmType.euint8, h, at, player),
          ),
        ),
      );
    }
    cups.push(dice);
  }
  return cups;
}

/** Public-decrypts the sealed verdict through the Zama relayer and settles with the KMS proof. Anyone may do this. */
async function settle(
  hre: HardhatRuntimeEnvironment,
  cup: Cup,
  tableId: bigint,
  verdictHandle: string,
  caller: HardhatEthersSigner,
) {
  const result = await retry("verdict decryption", () => hre.fhevm.publicDecrypt([verdictHandle]));
  const bidHeld = result.clearValues[verdictHandle as `0x${string}`] as boolean;
  const receipt = await send(async () => cup.connect(caller).resolve(tableId, bidHeld, result.decryptionProof, FEES));
  const resolved = eventArgs(cup, receipt, "RoundResolved");
  return { bidHeld, winner: resolved.roundWinner as string, hash: receipt!.hash, block: receipt!.blockNumber };
}

/**
 * Plays one full round on the live network with two accounts from the configured mnemonic:
 * open, join (both cups rolled encrypted), each player reads only their own cup, a bid, a challenge,
 * the blind count's one-bit verdict decrypted by the Zama KMS, and settlement with the proof.
 * It then checks the chain's verdict against what the two players' own views imply.
 *
 * With --bot the second account plays as a bot: it only signs (EIP-712) and never sends a transaction;
 * the host's transactions carry its join and its challenge, and the task checks the bot's nonce is unchanged.
 *
 * npx hardhat --network sepolia blindcup:round [--bluff 2] [--bot] [--address 0x...]
 */
task("blindcup:round", "Play one full Blind Cup round on the live network")
  .addOptionalParam("address", "BlindCup address (defaults to the deployment)")
  .addOptionalParam("bluff", "Dice to add on top of the bidder's own count", 2, types.int)
  .addFlag("bot", "Second seat only signs; the host submits its moves and pays")
  .setAction(async (args: { address?: string; bluff: number; bot: boolean }, hre) => {
    const { ethers, fhevm } = hre;
    await fhevm.initializeCLIApi();
    await useLowFees(hre);
    const { at, cup } = await contractAt(hre, args.address);
    const [host, guest] = await ethers.getSigners();
    const name = args.bot ? "bot" : "guest";
    console.log(`BlindCup ${at}\nhost  ${host.address}\n${name.padEnd(5)} ${guest.address}`);
    const domain = {
      name: "BlindCup",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: at,
    };
    const botNonce = await ethers.provider.getTransactionCount(guest.address);

    const guestBalance = await ethers.provider.getBalance(guest.address);
    if (!args.bot && guestBalance < ethers.parseEther("0.005")) {
      const tx = await host.sendTransaction({ to: guest.address, value: ethers.parseEther("0.01"), ...FEES });
      await tx.wait();
      console.log(`funded guest with 0.01 test ETH: ${TX(tx.hash)}`);
    }

    const open = await send(async () => cup.connect(host).openTable(FEES));
    const tableId = eventArgs(cup, open, "TableOpened").tableId as bigint;
    console.log(`\n1. host opened table ${tableId}: ${TX(open!.hash)}`);

    const joinSig = args.bot
      ? await guest.signTypedData(domain, { Join: [{ name: "tableId", type: "uint256" }] }, { tableId })
      : "";
    const join = args.bot
      ? await send(async () => cup.connect(host).joinTableBySig(tableId, joinSig, FEES))
      : await send(async () => cup.connect(guest).joinTable(tableId, FEES));
    const how = args.bot ? "signed a Join and the host submitted it" : "joined";
    console.log(`2. ${name} ${how}; 10 dice rolled encrypted: ${TX(join!.hash)} (gas ${join!.gasUsed})`);

    const cups = await readCups(hre, cup, at, tableId, 1n, [host, guest], join!.blockNumber);
    console.log(`3. host reads own cup (only they can):  ${cups[0].map(show).join(" ")}`);
    console.log(`   ${name.padEnd(5)} reads own cup (only they can): ${cups[1].map(show).join(" ")}`);

    const peek = (await cup.cupOf(tableId, 1, 0, { blockTag: join!.blockNumber }))[0];
    try {
      await fhevm.userDecryptEuint(FhevmType.euint8, peek, at, guest);
      throw new Error("CONFIDENTIALITY BROKEN: guest decrypted a host die");
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("CONFIDENTIALITY")) throw e;
      console.log(`4. ${name} tried to read a host die: refused by the Zama ACL, as it should be`);
    }

    let face = 1;
    for (let f = 0; f < 6; f++) if (countFor(cups[0], f) > countFor(cups[0], face)) face = f;
    const quantity = Math.min(10, Math.max(1, countFor(cups[0], face) + args.bluff));
    const bid = await send(async () => cup.connect(host).placeBid(tableId, quantity, face, FEES));
    console.log(`5. host bids "${quantity} x ${show(face)}s" (ones wild): ${TX(bid!.hash)}`);

    let chal;
    if (args.bot) {
      const move = (await cup.tableOf(tableId, { blockTag: bid!.blockNumber })).moves;
      const types = {
        Challenge: [
          { name: "tableId", type: "uint256" },
          { name: "move", type: "uint32" },
        ],
      };
      chal = await send(async () =>
        cup.connect(host).challengeBySig(tableId, await guest.signTypedData(domain, types, { tableId, move }), FEES),
      );
    } else {
      chal = await send(async () => cup.connect(guest).challenge(tableId, FEES));
    }
    const verdictHandle = eventArgs(cup, chal, "Challenged").verdictHandle as string;
    const signed = args.bot ? " (signed; the host submitted it)" : "";
    console.log(`6. ${name} calls it a lie${signed}; contract counts blind: ${TX(chal!.hash)} (gas ${chal!.gasUsed})`);
    console.log(`   sealed verdict handle ${verdictHandle}`);

    const s = await settle(hre, cup, tableId, verdictHandle, host);
    console.log(`7. KMS verdict: bid ${s.bidHeld ? "HELD" : "was a LIE"}; proof checked onchain: ${TX(s.hash)}`);
    console.log(
      `   round 1 winner: ${s.winner === host.address ? "host" : name} (${s.winner}); round 2 cups rolled in that same tx`,
    );

    const expected = countFor(cups[0], face) + countFor(cups[1], face) >= quantity;
    if (expected !== s.bidHeld) throw new Error(`MISMATCH: players' views imply ${expected}, chain said ${s.bidHeld}`);
    console.log(
      `8. check: the players' own views imply "${expected ? "held" : "lie"}", matching the chain. Cups stay sealed.`,
    );
    if (args.bot) {
      const after = await ethers.provider.getTransactionCount(guest.address);
      if (after !== botNonce) throw new Error(`bot sent ${after - botNonce} transaction(s); it should send none`);
      console.log(
        `9. check: the bot's wallet sent 0 transactions (nonce still ${after}); the host paid for every move.`,
      );
    }
  });

/**
 * Settles a challenged table: decrypts the one-bit verdict and submits it with the KMS proof.
 * When the configured accounts are the table's players it also cross-checks against their own cups.
 *
 * npx hardhat --network sepolia blindcup:settle --table 1
 */
task("blindcup:settle", "Settle a challenged table with the KMS-signed verdict")
  .addParam("table", "Table id", undefined, types.int)
  .addOptionalParam("address", "BlindCup address (defaults to the deployment)")
  .setAction(async (args: { table: number; address?: string }, hre) => {
    await hre.fhevm.initializeCLIApi();
    await useLowFees(hre);
    const { at, cup } = await contractAt(hre, args.address);
    const tableId = BigInt(args.table);
    const t = await retry(
      "table state",
      async () => {
        const x = await cup.tableOf(tableId);
        if (x.phase !== 2n || x.verdictHandle === ZERO)
          throw new Error(`table ${tableId} is not waiting for a verdict (phase ${x.phase})`);
        return x;
      },
      6,
    );
    const signers = await hre.ethers.getSigners();
    console.log(
      `table ${tableId}: bid "${t.bidQuantity} x ${show(Number(t.bidFace))}s", verdict handle ${t.verdictHandle}`,
    );

    const s = await settle(hre, cup, tableId, t.verdictHandle, signers[0]);
    console.log(`KMS verdict: bid ${s.bidHeld ? "HELD" : "was a LIE"}; proof checked onchain: ${TX(s.hash)}`);
    console.log(`round winner: ${s.winner}`);

    const seated = t.players.map((p) => signers.find((s) => s.address === p));
    if (seated.every(Boolean)) {
      const cups = await readCups(hre, cup, at, tableId, t.round, seated as HardhatEthersSigner[]);
      const face = Number(t.bidFace);
      const expected = countFor(cups[0], face) + countFor(cups[1], face) >= Number(t.bidQuantity);
      console.log(`cups (each read by its owner): ${cups[0].map(show).join(" ")} | ${cups[1].map(show).join(" ")}`);
      if (expected !== s.bidHeld)
        throw new Error(`MISMATCH: players' views imply ${expected}, chain said ${s.bidHeld}`);
      console.log(`check: the players' own views imply "${expected ? "held" : "lie"}", matching the chain.`);
    }
  });

/**
 * Plays a full best-of-3 match against Wren on the live network, through the same code the hosted bot runs:
 * Wren reads the table from the chain, decrypts only her own cup through the Zama relayer, decides, and
 * signs. The host relays her signed moves and pays for everything. The host plays an honest, trusting game.
 *
 * npx hardhat --network sepolia blindcup:wren [--address 0x...]
 */
task("blindcup:wren", "Play a full match against Wren, the signing bot, on the live network")
  .addOptionalParam("address", "BlindCup address (defaults to the deployment)")
  .setAction(async (args: { address?: string }, hre) => {
    const { ethers, fhevm } = hre;
    const { decide, seeded } = await import("../bot/brain");
    const { TRUSTING } = await import("../bot/sim/simulate");
    const { nextMove, signJoin } = await import("../bot/service");
    const { deriveSecret, sepoliaInstance, userDecryptDice } = await import("../bot/relayer");
    const { NAME, line } = await import("../bot/persona");

    await fhevm.initializeCLIApi();
    await useLowFees(hre);
    const { at, cup } = await contractAt(hre, args.address);
    const [host, wren] = await ethers.getSigners();
    const rpcUrl = (hre.network.config as { url: string }).url;
    const instance = await sepoliaInstance(rpcUrl);
    const ctx = {
      cup,
      signer: wren,
      secret: await deriveSecret(wren),
      readOwnCup: (handles: string[]) =>
        retry(`${NAME} reading her own cup`, () => userDecryptDice(instance, wren, at, handles)),
    };
    const nonce = await ethers.provider.getTransactionCount(wren.address);
    console.log(
      `BlindCup ${at}\nhost ${host.address} (balance ${ethers.formatEther(await ethers.provider.getBalance(host.address))} ETH)\n${NAME} ${wren.address}`,
    );

    const open = await send(async () => cup.connect(host).openTable(FEES));
    const tableId = eventArgs(cup, open, "TableOpened").tableId as bigint;
    let block = open!.blockNumber;
    const { signature } = await retry("join signature", () => signJoin(ctx, tableId, block), 6);
    const join = await send(async () => cup.connect(host).joinTableBySig(tableId, signature, FEES));
    block = join!.blockNumber;
    console.log(`table ${tableId} opened, ${NAME} signed her seat, host relayed: ${TX(join!.hash)}`);

    const rng = seeded(Number(tableId));
    const hostCups = new Map<bigint, number[]>();
    for (let step = 0; step < 100; step++) {
      const t = await retry("table state", async () => cup.tableOf(tableId, { blockTag: block }), 6);
      if (t.phase === 3n) break;

      if (t.phase === 2n) {
        const s = await settle(hre, cup, tableId, t.verdictHandle, host);
        block = s.block;
        const wrenWon = s.winner === wren.address;
        console.log(
          `   counting... ${s.bidHeld ? "HELD" : "LIAR"}. round ${t.round} to ${wrenWon ? NAME : "host"}: ${TX(s.hash)}`,
        );
        console.log(`   ${NAME}: "${line(wrenWon ? "winRound" : "loseRound", rng)}"`);
        continue;
      }

      if (!hostCups.has(t.round)) {
        const handles: string[] = await cup.cupOf(tableId, t.round, 0, { blockTag: block });
        const dice: number[] = [];
        for (const h of handles)
          dice.push(
            Number(await retry("host reading own die", () => fhevm.userDecryptEuint(FhevmType.euint8, h, at, host))),
          );
        hostCups.set(t.round, dice);
        console.log(`\nround ${t.round}: host's cup ${dice.map(show).join(" ")} (${NAME}'s stays sealed)`);
      }

      let receipt;
      if (t.players[Number(t.turn)] === wren.address) {
        const m = await retry(`${NAME}'s move`, () => nextMove(ctx, tableId, block), 6);
        const hands = m.tell ? " [taps her cup]" : "";
        if (m.play.kind === "challenge") {
          receipt = await send(async () => cup.connect(host).challengeBySig(tableId, m.signature, FEES));
          console.log(`   ${NAME} calls it${hands}: "${m.says}" ${TX(receipt!.hash)}`);
        } else {
          const { quantity, face } = m.play;
          receipt = await send(async () => cup.connect(host).placeBidBySig(tableId, quantity, face, m.signature, FEES));
          console.log(`   ${NAME} bids ${quantity} x ${show(face)}s${hands}: "${m.says}" ${TX(receipt!.hash)}`);
        }
      } else {
        const standing = t.bidQuantity === 0n ? null : { quantity: Number(t.bidQuantity), face: Number(t.bidFace) };
        const d = decide(hostCups.get(t.round)!, standing, rng, TRUSTING);
        if (d.kind === "challenge") {
          receipt = await send(async () => cup.connect(host).challenge(tableId, FEES));
          console.log(`   host calls it: ${TX(receipt!.hash)}`);
        } else {
          receipt = await send(async () => cup.connect(host).placeBid(tableId, d.quantity, d.face, FEES));
          console.log(`   host bids ${d.quantity} x ${show(d.face)}s: ${TX(receipt!.hash)}`);
        }
      }
      block = receipt!.blockNumber;
    }

    const done = await retry(
      "final state",
      async () => {
        const x = await cup.tableOf(tableId, { blockTag: block });
        if (x.phase !== 3n) throw new Error("not done yet");
        return x;
      },
      6,
    );
    const wrenWon = done.winner === wren.address;
    console.log(
      `\nmatch to ${wrenWon ? NAME : "host"} (${done.wins[0]}-${done.wins[1]}). ${NAME}: "${line(wrenWon ? "winMatch" : "loseMatch", rng)}"`,
    );
    const after = await ethers.provider.getTransactionCount(wren.address);
    if (after !== nonce) throw new Error(`${NAME} sent ${after - nonce} transaction(s); she should send none`);
    console.log(`check: ${NAME}'s wallet sent 0 transactions (nonce still ${after}); the host paid for every move.`);
    console.log(`host balance now ${ethers.formatEther(await ethers.provider.getBalance(host.address))} ETH`);
  });
