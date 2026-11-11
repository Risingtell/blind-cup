/** Talks to Wren's hosted seat. She answers with signed moves; the player's wallet carries them to the chain. */

export type WrenCard = { name: string; blurb: string; habit: string; tell: string; address: string };
export type WrenMove = {
  move: number;
  play: { kind: "bid"; quantity: number; face: number } | { kind: "challenge" };
  signature: string;
  says: string;
  tell: boolean;
};

async function call<T>(body?: object): Promise<T> {
  for (let i = 1; ; i++) {
    const r = await fetch(
      "/api/wren",
      body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
    );
    const j = await r.json().catch(() => ({ error: `Wren's seat answered ${r.status}` }));
    if (r.ok) return j as T;
    // 409: her node hasn't seen our last block yet; 503: a hiccup. Both clear up in a moment.
    if ((r.status === 409 || r.status === 503) && i < 8) {
      await new Promise((res) => setTimeout(res, 2500));
      continue;
    }
    throw new Error(j.error ?? `Wren's seat answered ${r.status}`);
  }
}

let card: Promise<WrenCard> | undefined;
export const wrenCard = () => (card ??= call<WrenCard>());
export const wrenJoin = (tableId: bigint, block: number) =>
  call<{ signature: string }>({ tableId: tableId.toString(), action: "join", block });
export const wrenMove = (tableId: bigint, block: number) =>
  call<WrenMove>({ tableId: tableId.toString(), action: "move", block });
