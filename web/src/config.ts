export const CHAIN_ID = 11155111;
export const CHAIN_HEX = "0xaa36a7";
export const BLINDCUP =
  (import.meta.env.VITE_BLINDCUP_ADDRESS as string | undefined) ?? "0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB";
export const READ_RPC =
  (import.meta.env.VITE_SEPOLIA_RPC_URL as string | undefined) ?? "https://ethereum-sepolia-rpc.publicnode.com";
export const EXPLORER = "https://sepolia.etherscan.io";
export const FAUCET = "https://cloud.google.com/application/web3/faucet/ethereum/sepolia";
export const REPO = "https://github.com/Risingtell/blind-cup";

/** Sepolia's base fee is near zero, so the tip is the cost. 0.01 gwei gets mined and a match costs about 0.0001 test ETH. */
export const TIP_GWEI = "0.01";

export const show = (face: number) => face + 1; // stored 0..5, shown 1..6
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;
