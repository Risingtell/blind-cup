/**
 * Hidden stakes in Zama's test cUSDT (ERC-7984). The purse sits beside the game: each player may put in a hidden
 * amount before the cups are rolled, the table plays for the smaller stake, and anyone can pay out a finished
 * table. Amounts are only ever decrypted for the player they belong to.
 */
import { Contract } from "ethers";

import PURSE_ABI from "../../bot/CupPurse.abi.json";
import { knownErrors, reader, type Wallet } from "./chain";
import { CUSDT, CUSDT_UNIT, PURSE, USDT_MOCK } from "./config";

const fheModule = () => import("./fhe");

export const purse = new Contract(PURSE, PURSE_ABI, reader);
knownErrors.push(purse.interface);

const token = new Contract(
  CUSDT,
  [
    "function wrap(address to, uint256 amount) returns (bytes32)",
    "function setOperator(address operator, uint48 until)",
    "function isOperator(address holder, address spender) view returns (bool)",
    "function confidentialBalanceOf(address account) view returns (bytes32)",
  ],
  reader,
);
const usdt = new Contract(
  USDT_MOCK,
  ["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount)"],
  reader,
);

const EMPTY = /^0x0*$/;
const FOREVER = 2n ** 48n - 1n;

/** Formats a token amount (6 decimals) for people: 5, 2.5, 0.75. */
export const show = (units: bigint) => {
  const whole = units / CUSDT_UNIT;
  const frac = (units % CUSDT_UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

async function decrypt(w: Wallet, contract: string, handle: string): Promise<bigint> {
  if (EMPTY.test(handle)) return 0n;
  const [v] = await (await fheModule()).readOwn(w.signer, contract, [handle]);
  return v;
}

/** Your confidential cUSDT balance, decrypted for you alone. */
export async function balanceOf(w: Wallet): Promise<bigint> {
  return decrypt(w, CUSDT, await token.confidentialBalanceOf(w.address));
}

/** Free test cUSDT: mint test USDT, let the wrapper take it, wrap it into confidential cUSDT. Three transactions. */
export async function getTestCusdt(w: Wallet, whole: bigint, onStep: (s: string) => void) {
  const amount = whole * CUSDT_UNIT;
  onStep(`Minting ${whole} free test USDT (1 of 3). Confirm in your wallet.`);
  await w.sendTo(usdt, "mint", w.address, amount);
  onStep("Letting the cUSDT wrapper take it (2 of 3). Confirm in your wallet.");
  await w.sendTo(usdt, "approve", CUSDT, amount);
  onStep("Wrapping it into confidential cUSDT (3 of 3). Confirm in your wallet.");
  await w.sendTo(token, "wrap", w.address, amount);
}

/** Puts a hidden stake on a table that is still open. Lets the purse move your cUSDT first, once. */
export async function stakeOn(w: Wallet, tableId: bigint, whole: bigint, onStep: (s: string) => void) {
  if (!(await token.isOperator(w.address, PURSE))) {
    onStep("Letting the purse move your cUSDT (once). Confirm in your wallet.");
    await w.sendTo(token, "setOperator", PURSE, FOREVER);
  }
  onStep("Encrypting your stake. Nobody else will see the amount.");
  const { handle, proof } = await (await fheModule()).encryptAmount(PURSE, w.address, whole * CUSDT_UNIT);
  onStep("Putting your hidden stake in the purse. Confirm in your wallet.");
  await w.sendTo(purse, "stake", tableId, handle, proof);
}

export const hasStake = (tableId: bigint, who: string): Promise<boolean> => purse.hasStake(tableId, who);
export const isSettled = (tableId: bigint): Promise<boolean> => purse.settled(tableId);

/** Your own stake on a table (only you can read it). */
export async function myStake(w: Wallet, tableId: bigint): Promise<bigint> {
  return decrypt(w, PURSE, await purse.stakeOf(tableId, w.address));
}

/** What the table plays for: the smaller stake. Readable by the host and that guest only. */
export async function tableStake(w: Wallet, tableId: bigint, guest: string): Promise<bigint | null> {
  const h: string = await purse.tableStakeOf(tableId, guest);
  return EMPTY.test(h) ? null : decrypt(w, PURSE, h);
}

/** Pays out a finished table. Anyone may do it. */
export async function payOut(w: Wallet, tableId: bigint) {
  await w.sendTo(purse, "settle", tableId);
}
