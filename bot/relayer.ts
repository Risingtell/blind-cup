/**
 * How the bot reads its own cup on a real network: a user decryption through the Zama relayer, authorised
 * by the bot's own EIP-712 signature. The KMS returns plaintext only for handles the ACL lets the bot
 * read, so asking for the other player's dice fails. This is the path the hosted bot uses; Hardhat's
 * plugin is not involved.
 */
import { createInstance, type FhevmInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";
import { keccak256, type Signer, toUtf8Bytes } from "ethers";

const instances = new Map<string, Promise<FhevmInstance>>();

export function sepoliaInstance(rpcUrl: string): Promise<FhevmInstance> {
  let i = instances.get(rpcUrl);
  if (!i) {
    i = createInstance({ ...SepoliaConfig, network: rpcUrl });
    i.catch(() => instances.delete(rpcUrl));
    instances.set(rpcUrl, i);
  }
  return i;
}

/** Decrypts handles the signer is allowed to read, in the order given. Values are faces 0..5. */
export async function userDecryptDice(instance: FhevmInstance, signer: Signer, contractAddress: string, handles: string[]): Promise<number[]> {
  const { publicKey, privateKey } = instance.generateKeypair();
  const start = Math.floor(Date.now() / 1000); // a validity window for the request, not a stored time
  const days = 1;
  const eip712 = instance.createEIP712(publicKey, [contractAddress], start, days);
  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: [...eip712.types.UserDecryptRequestVerification] },
    eip712.message as unknown as Record<string, unknown>,
  );
  const clear = await instance.userDecrypt(
    handles.map((handle) => ({ handle, contractAddress })),
    privateKey,
    publicKey,
    signature,
    [contractAddress],
    await signer.getAddress(),
    start,
    days,
  );
  return handles.map((h) => Number(clear[h as `0x${string}`]));
}

/**
 * The bot's private seed, derived from its key so the service needs one secret, not two.
 * The bot signs only game moves and decryption requests, never this text for anyone else.
 */
export async function deriveSecret(signer: Signer): Promise<string> {
  return keccak256(toUtf8Bytes(await signer.signMessage("Blind Cup: Wren's private seed, v1")));
}
