import type { Signer } from "ethers";
import { task, types, vars } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

/** Zama's Sepolia test cUSDT (an ERC-7984 wrapper) and its freely mintable underlying test USDT. */
export const CUSDT = "0x4E7B06D78965594eB5EF5414c357ca21E1554491";
export const USDT_MOCK = "0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0";
const BLINDCUP = process.env.BLINDCUP_ADDRESS ?? "0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB";
const UNIT = 1_000_000n; // both tokens use 6 decimals

const ERC20 = ["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount)"];
const WRAPPER = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function setOperator(address operator, uint48 until)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function confidentialBalanceOf(address account) view returns (bytes32)",
];

type Fees = { maxPriorityFeePerGas: bigint; maxFeePerGas: bigint };

async function lowFees(hre: HardhatRuntimeEnvironment): Promise<Fees> {
  const block = await hre.ethers.provider.getBlock("latest");
  const tip = hre.ethers.parseUnits("0.01", "gwei");
  return { maxPriorityFeePerGas: tip, maxFeePerGas: (block?.baseFeePerGas ?? 0n) * 3n + tip };
}

function wallets(hre: HardhatRuntimeEnvironment) {
  const { ethers } = hre;
  const a = new ethers.Wallet(vars.get("PLAYER_PRIVATE_KEY"), ethers.provider);
  const b = ethers.HDNodeWallet.fromPhrase(vars.get("MNEMONIC")).connect(ethers.provider);
  return { a, b };
}

task("purse:deploy", "Deploy the hidden-stakes purse for the live game and Zama's test cUSDT").setAction(
  async (_, hre) => {
    const { a } = wallets(hre);
    const factory = await hre.ethers.getContractFactory("CupPurse", a);
    const purse = await factory.deploy(BLINDCUP, CUSDT, await lowFees(hre));
    const receipt = await purse.deploymentTransaction()!.wait();
    console.log(`CupPurse ${await purse.getAddress()} (block ${receipt!.blockNumber}, tx ${receipt!.hash})`);
  },
);

task("purse:match", "Play a staked friend match on Sepolia between the two test wallets, then settle the purse")
  .addParam("purse", "CupPurse address")
  .addOptionalParam("hostStake", "Host stake in cUSDT", 5, types.int)
  .addOptionalParam("guestStake", "Guest stake in cUSDT", 3, types.int)
  .addOptionalParam("table", "Resume this already staked table instead of starting a new one", 0, types.int)
  .addOptionalParam("start", "cUSDT each wallet held before staking, when resuming", 20, types.int)
  .setAction(async ({ purse: purseAddress, hostStake, guestStake, table, start }, hre) => {
    const { ethers } = hre;
    await hre.fhevm.initializeCLIApi();
    const { sepoliaInstance, userDecryptDice } = await import("../bot/relayer");
    const { a: host, b: guest } = wallets(hre);
    const fhe = await sepoliaInstance(hre.network.config && "url" in hre.network.config ? hre.network.config.url : "");
    const cup = await ethers.getContractAt("BlindCup", BLINDCUP);
    const purse = await ethers.getContractAt("CupPurse", purseAddress);
    let lastBlock = await ethers.provider.getBlockNumber();
    const send = async (label: string, f: () => Promise<{ wait: () => Promise<unknown> }>) => {
      const tx = await f();
      const r = (await tx.wait()) as { hash: string; blockNumber: number };
      lastBlock = r.blockNumber; // public nodes lag: read state as of our own last transaction
      console.log(`  ${label}: ${r.hash}`);
      return r;
    };
    const fees = await lowFees(hre);

    const balanceOf = async (who: Signer) => {
      const token = new ethers.Contract(CUSDT, WRAPPER, who);
      const h = await token.confidentialBalanceOf(await who.getAddress());
      if (/^0x0+$/.test(h)) return 0n;
      const [v] = await userDecryptDice(fhe, who, CUSDT, [h]);
      return BigInt(v);
    };

    let tableId = BigInt(table);
    let before = [BigInt(start) * UNIT, BigInt(start) * UNIT];
    if (!tableId) {
      // The guest wallet pays its own moves; top it up from the host test wallet if it runs low.
      if ((await ethers.provider.getBalance(guest.address)) < ethers.parseEther("0.002")) {
        await send("fund guest", () =>
          host.sendTransaction({ to: guest.address, value: ethers.parseEther("0.004"), ...fees }),
        );
      }

      // Each player gets free test USDT, wraps it into confidential cUSDT, and lets the purse move it.
      for (const [name, who] of [
        ["host", host],
        ["guest", guest],
      ] as const) {
        const usdt = new ethers.Contract(USDT_MOCK, ERC20, who);
        const token = new ethers.Contract(CUSDT, WRAPPER, who);
        await send(`${name} mints 20 test USDT`, () => usdt.mint(who.address, 20n * UNIT, fees));
        await send(`${name} approves the wrapper`, () => usdt.approve(CUSDT, 20n * UNIT, fees));
        await send(`${name} wraps 20 into cUSDT`, () => token.wrap(who.address, 20n * UNIT, fees));
        if (!(await token.isOperator(who.address, purseAddress))) {
          await send(`${name} lets the purse move cUSDT`, () => token.setOperator(purseAddress, 2n ** 48n - 1n, fees));
        }
      }
      before = [await balanceOf(host), await balanceOf(guest)];
      console.log(`cUSDT before: host ${Number(before[0]) / 1e6}, guest ${Number(before[1]) / 1e6}`);

      const open = await send("host opens a table", () => cup.connect(host).openTable(fees));
      tableId = await cup.tableCount({ blockTag: open.blockNumber });
      console.log(`table ${tableId}`);
      for (const [name, who, amount] of [
        ["host", host, hostStake],
        ["guest", guest, guestStake],
      ] as const) {
        const input = await fhe
          .createEncryptedInput(purseAddress, who.address)
          .add64(BigInt(amount) * UNIT)
          .encrypt();
        await send(`${name} stakes a hidden ${amount}`, () =>
          purse.connect(who).stake(tableId, input.handles[0], input.inputProof, fees),
        );
      }
      await send("guest takes the seat (cups roll)", () => cup.connect(guest).joinTable(tableId, fees));
    }

    // Host overbids (ten of a face), guest calls: the guest takes each round, so the match is decided.
    for (;;) {
      const t = await cup.tableOf(tableId, { blockTag: lastBlock });
      if (t.phase === 3n) break;
      const opener = t.players[Number(t.turn)] === host.address ? host : guest;
      const other = opener === host ? guest : host;
      await send(`round ${t.round}: overbid`, () => cup.connect(opener).placeBid(tableId, 10, 5, fees));
      const c = await send(`round ${t.round}: call`, () => cup.connect(other).challenge(tableId, fees));
      const v = (await cup.tableOf(tableId, { blockTag: c.blockNumber })).verdictHandle;
      let r;
      for (let i = 0; ; i++) {
        try {
          r = await fhe.publicDecrypt([v]);
          break;
        } catch (e) {
          if (i > 10) throw e;
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
      const held = Boolean(r.clearValues[v as `0x${string}`]);
      console.log(`  verdict: ${held ? "HELD" : "LIAR"}`);
      await send(`round ${t.round}: settle`, () => cup.connect(host).resolve(tableId, held, r.decryptionProof, fees));
    }
    const done = await cup.tableOf(tableId, { blockTag: lastBlock });
    console.log(`winner: ${done.winner === host.address ? "host" : "guest"}`);
    await send("purse settles", () => purse.connect(host).settle(tableId, fees));

    const after = [await balanceOf(host), await balanceOf(guest)];
    const delta = after.map((x, i) => Number(x - before[i]) / 1e6);
    console.log(
      `cUSDT after: host ${Number(after[0]) / 1e6} (${delta[0]}), guest ${Number(after[1]) / 1e6} (${delta[1]})`,
    );
  });
