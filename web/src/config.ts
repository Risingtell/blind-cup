export const CHAIN_ID = 11155111;
export const CHAIN_HEX = "0xaa36a7";
export const BLINDCUP =
  (import.meta.env.VITE_BLINDCUP_ADDRESS as string | undefined) ?? "0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB";
export const READ_RPC =
  (import.meta.env.VITE_SEPOLIA_RPC_URL as string | undefined) ?? "https://ethereum-sepolia-rpc.publicnode.com";
export const EXPLORER = "https://sepolia.etherscan.io";
export const FAUCET = "https://cloud.google.com/application/web3/faucet/ethereum/sepolia";
export const REPO = "https://github.com/Risingtell/blind-cup";

/** Hidden stakes: the purse beside the game, Zama's Sepolia test cUSDT (ERC-7984) and its free test USDT. */
export const PURSE =
  (import.meta.env.VITE_PURSE_ADDRESS as string | undefined) ?? "0x6A0e95C1a6dB2cA2BC16fEDad7ad03bCcf61de27";
export const CUSDT = "0x4E7B06D78965594eB5EF5414c357ca21E1554491";
export const USDT_MOCK = "0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0";
export const CUSDT_UNIT = 1_000_000n; // 6 decimals

/** Sepolia's base fee is near zero, so the tip is the cost. 0.01 gwei gets mined and a match costs about 0.0001 test ETH. */
export const TIP_GWEI = "0.01";

export const show = (face: number) => face + 1; // stored 0..5, shown 1..6
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;
