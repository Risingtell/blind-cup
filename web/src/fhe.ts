/**
 * Zama in the browser. Two jobs:
 * - read your own cup: a user decryption the KMS answers only for handles the ACL lets you read, so it
 *   can't show you the other cup; you sign one request per session.
 * - read a verdict: the one bit the contract made public, with the KMS proof the contract checks.
 */
import { createInstance, type FhevmInstance, initSDK, SepoliaConfig } from "@zama-fhe/relayer-sdk/web";
import type { Signer } from "ethers";

import { BLINDCUP, CUSDT, PURSE, READ_RPC } from "./config";

/** One permit covers everything a player may read: their dice, their stake, their token balance. */
const READABLE = [BLINDCUP, PURSE, CUSDT];

let instance: Promise<FhevmInstance> | undefined;

export function fhe(): Promise<FhevmInstance> {
  instance ??= (async () => {
    await initSDK();
    return createInstance({ ...SepoliaConfig, network: READ_RPC });
  })();
  instance.catch(() => (instance = undefined));
  return instance;
}

type Permit = { publicKey: string; privateKey: string; signature: string; start: number; days: number; user: string };
let permit: Permit | undefined;

/** One wallet signature per session lets you decrypt your own values for a day; it lives only in this tab. */
async function permitFor(signer: Signer): Promise<Permit> {
  const user = await signer.getAddress();
  if (permit && permit.user === user) return permit;
  const inst = await fhe();
  const { publicKey, privateKey } = inst.generateKeypair();
  const start = Math.floor(Date.now() / 1000); // the request's validity window, checked by the KMS
  const days = 1;
  const eip712 = inst.createEIP712(publicKey, READABLE, start, days);
  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: [...eip712.types.UserDecryptRequestVerification] },
    eip712.message as unknown as Record<string, unknown>,
  );
  permit = { publicKey, privateKey, signature, start, days, user };
  return permit;
}

export async function readOwnDice(signer: Signer, handles: string[]): Promise<number[]> {
  return (await readOwn(signer, BLINDCUP, handles)).map(Number);
}

/** Decrypts values the signer may read, held by `contract` (the game, the purse or the token). */
export async function readOwn(signer: Signer, contract: string, handles: string[]): Promise<bigint[]> {
  const p = await permitFor(signer);
  const inst = await fhe();
  for (let i = 1; ; i++) {
    try {
      const clear = await inst.userDecrypt(
        handles.map((handle) => ({ handle, contractAddress: contract })),
        p.privateKey,
        p.publicKey,
        p.signature,
        READABLE,
        p.user,
        p.start,
        p.days,
      );
      return handles.map((h) => BigInt(clear[h as `0x${string}`] as bigint | number | boolean));
    } catch (e) {
      if (i >= 8) throw e;
      await new Promise((r) => setTimeout(r, 3000)); // fresh ciphertexts take a few seconds to reach the relayer
    }
  }
}

export async function readVerdict(handle: string): Promise<{ held: boolean; proof: string }> {
  const inst = await fhe();
  for (let i = 1; ; i++) {
    try {
      const r = await inst.publicDecrypt([handle]);
      return { held: Boolean(r.clearValues[handle as `0x${string}`]), proof: r.decryptionProof };
    } catch (e) {
      if (i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** Encrypts an amount for `contract`, bound to `user`: only that contract can take it in, only from that user. */
export async function encryptAmount(contract: string, user: string, amount: bigint) {
  const inst = await fhe();
  const out = await inst.createEncryptedInput(contract, user).add64(amount).encrypt();
  return { handle: out.handles[0], proof: out.inputProof };
}
