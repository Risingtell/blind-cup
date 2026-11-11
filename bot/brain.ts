/**
 * The bot's mind. Pure functions: it sees only its own five dice and the standing bid, exactly what a
 * human at the table sees. It cannot see the other cup because the Zama ACL never lets it decrypt one.
 *
 * Faces are 0..5 on chain and shown 1..6. Face 0 (a shown "1") is wild unless ones were bid.
 */

export const DICE = 5;
export const FACES = 6;
export const TOTAL = 2 * DICE;

export type Bid = { quantity: number; face: number };

export type Decision =
  | { kind: "bid"; quantity: number; face: number; bluff: boolean; tell: boolean }
  | { kind: "challenge" };

/** A character: how she plays, and how often her hands give her away. */
export type Persona = {
  /** Calls a lie when she believes the standing bid holds with less than this chance. */
  challengeBelow: number;
  /** How often she bluffs when an honest raise was available. */
  bluffRate: number;
  /** Her lies: raises she believes hold with at least `bluffFloor` and below `bluffCeiling`. */
  bluffFloor: number;
  bluffCeiling: number;
  /** How much she believes the other player's bid tells her about their cup (0..1). */
  trust: number;
  /** Chance her tell shows when she bids something she believes is false. */
  tellOnBluff: number;
  /** Chance the same tell shows on an honest bid, so it is a tell and not a giveaway. */
  tellOnHonest: number;
};

/** Tuned with bot/sim/simulate.ts: her tapped bids are lies about 7 times in 10, her other bids about 3 in 10. */
export const WREN: Persona = {
  challengeBelow: 0.4,
  bluffRate: 0.3,
  bluffFloor: 0.1,
  bluffCeiling: 0.35,
  trust: 0.5,
  tellOnBluff: 0.8,
  tellOnHonest: 0.03,
};

export function countFor(dice: readonly number[], face: number): number {
  return dice.filter((d) => d === face || (face !== 0 && d === 0)).length;
}

/** Chance one unseen die matches the face, ones wild. */
const pFace = (face: number) => (face === 0 ? 1 / 6 : 1 / 3);

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** P(X >= k) for X ~ Binomial(n, p). */
export function binomTail(n: number, p: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let s = 0;
  for (let i = k; i <= n; i++) s += choose(n, i) * p ** i * (1 - p) ** (n - i);
  return s;
}

/**
 * Her belief that a bid holds, from her own cup plus the five dice she cannot see.
 * When the bid is on the face the other player last bid, she partly believes they hold one of it.
 */
export function belief(dice: readonly number[], bid: Bid, standing: Bid | null, persona: Persona): number {
  const need = bid.quantity - countFor(dice, bid.face);
  const p = pFace(bid.face);
  const blind = binomTail(DICE, p, need);
  if (!standing || standing.face !== bid.face) return blind;
  const credited = binomTail(DICE - 1, p, need - 1);
  return persona.trust * credited + (1 - persona.trust) * blind;
}

export function isRaise(standing: Bid | null, next: Bid): boolean {
  if (next.quantity < 1 || next.quantity > TOTAL || next.face < 0 || next.face >= FACES) return false;
  if (!standing) return true;
  return next.quantity > standing.quantity || (next.quantity === standing.quantity && next.face > standing.face);
}

export function legalRaises(standing: Bid | null): Bid[] {
  const out: Bid[] = [];
  for (let quantity = 1; quantity <= TOTAL; quantity++) {
    for (let face = 0; face < FACES; face++) if (isRaise(standing, { quantity, face })) out.push({ quantity, face });
  }
  return out;
}

/** The face she holds most of, ones counting toward every other face. Ties go to the higher face. */
export function bestFace(dice: readonly number[]): number {
  let best = 1;
  for (let f = 1; f < FACES; f++) if (countFor(dice, f) >= countFor(dice, best)) best = f;
  return best;
}

/** Smallest raise first; among equal sizes, the one she believes most. */
const byCheapest = (dice: readonly number[], standing: Bid | null, persona: Persona) => (a: Bid, b: Bid) =>
  a.quantity - b.quantity || belief(dice, b, standing, persona) - belief(dice, a, standing, persona);

/**
 * One move. `rng` returns uniform numbers in [0, 1); the service seeds it from the table state so the
 * same position always gets the same answer and a player cannot fish for a weaker move.
 *
 * Her habit: she always opens on the face she holds most. Her tell: when she bids what she
 * believes is false, she usually taps her cup (and rarely does it on an honest bid).
 */
export function decide(
  dice: readonly number[],
  standing: Bid | null,
  rng: () => number,
  persona: Persona = WREN,
): Decision {
  if (dice.length !== DICE) throw new Error(`expected ${DICE} dice`);
  const tellFor = (bluff: boolean) => rng() < (bluff ? persona.tellOnBluff : persona.tellOnHonest);

  if (!standing) {
    const face = bestFace(dice);
    const quantity = countFor(dice, face) + (rng() < 0.5 ? 1 : 2);
    return { kind: "bid", quantity, face, bluff: false, tell: tellFor(false) };
  }

  const raises = legalRaises(standing);
  if (raises.length === 0) return { kind: "challenge" };

  const standingBelief = belief(dice, standing, standing, persona);
  if (standingBelief < persona.challengeBelow) return { kind: "challenge" };

  const order = byCheapest(dice, standing, persona);
  const honest = raises.filter((b) => belief(dice, b, standing, persona) >= 0.5).sort(order);
  const wantsBluff = honest.length === 0 || rng() < persona.bluffRate;

  if (!wantsBluff) {
    const b = honest[0];
    return { kind: "bid", quantity: b.quantity, face: b.face, bluff: false, tell: tellFor(false) };
  }

  // Out of honest raises and the standing bid still looks true: calling would likely lose, so bluff.
  // Otherwise a deliberate bluff. Either way, a believable lie: small, and not hopeless.
  if (honest.length === 0 && standingBelief < 0.5) return { kind: "challenge" };
  const lies = raises.filter((b) => {
    const p = belief(dice, b, standing, persona);
    return p < persona.bluffCeiling && p >= persona.bluffFloor;
  });
  const pool = (lies.length ? lies : raises.filter((b) => belief(dice, b, standing, persona) < 0.5)).sort(order);
  if (pool.length === 0) {
    const b = honest[0];
    return { kind: "bid", quantity: b.quantity, face: b.face, bluff: false, tell: tellFor(false) };
  }
  const smallest = pool.filter((b) => b.quantity === pool[0].quantity);
  const b = smallest[Math.floor(rng() * smallest.length)];
  return { kind: "bid", quantity: b.quantity, face: b.face, bluff: true, tell: tellFor(true) };
}

/** A small seeded generator (mulberry32). Same seed, same stream. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
