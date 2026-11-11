/**
 * Plays Wren off-chain against an opponent who never bluffs, many rounds, with full knowledge of both cups,
 * and reports how readable she is: how often a bid is a lie when she taps her cup and when she doesn't,
 * and how a trusting player's win rate moves when they call every tap.
 *
 * npx ts-node --transpile-only bot/sim/simulate.ts [rounds]
 */
import { type Bid, countFor, decide, DICE, FACES, type Persona, seeded, WREN } from "../brain";

/** An opponent that never bluffs and believes most bids (calls a lie only below a 25% belief). */
export const TRUSTING: Persona = { ...WREN, bluffRate: 0, tellOnBluff: 0, tellOnHonest: 0, challengeBelow: 0.25 };

export type Report = {
  rounds: number;
  opponentWinRate: number;
  bluffRate: number;
  lieWhenTapped: number;
  lieWhenNotTapped: number;
};

export function simulate(
  rounds: number,
  callTaps: boolean,
  seed = 1,
  wren: Persona = WREN,
  opponent: Persona = TRUSTING,
): Report {
  const rng = seeded(seed);
  const roll = () => Array.from({ length: DICE }, () => Math.floor(rng() * FACES));
  let oppWins = 0,
    bids = 0,
    bluffs = 0,
    tapped = 0,
    tappedLies = 0,
    plain = 0,
    plainLies = 0;

  for (let i = 0; i < rounds; i++) {
    const wrenCup = roll();
    const oppCup = roll();
    const holds = (b: Bid) => countFor(wrenCup, b.face) + countFor(oppCup, b.face) >= b.quantity;
    let standing: Bid | null = null;
    let wrenTurn = i % 2 === 0;
    let tell = false;
    let oppWon: boolean;
    for (;;) {
      if (wrenTurn) {
        const d = decide(wrenCup, standing, rng, wren);
        if (d.kind === "challenge") {
          oppWon = holds(standing!);
          break;
        }
        standing = { quantity: d.quantity, face: d.face };
        tell = d.tell;
        const lie = !holds(standing);
        bids++;
        if (d.bluff) bluffs++;
        if (tell) {
          tapped++;
          tappedLies += +lie;
        } else {
          plain++;
          plainLies += +lie;
        }
      } else {
        if (callTaps && tell) {
          oppWon = !holds(standing!);
          break;
        }
        const d = decide(oppCup, standing, rng, opponent);
        if (d.kind === "challenge") {
          oppWon = !holds(standing!);
          break;
        }
        standing = { quantity: d.quantity, face: d.face };
        tell = false;
      }
      wrenTurn = !wrenTurn;
    }
    if (oppWon) oppWins++;
  }
  return {
    rounds,
    opponentWinRate: oppWins / rounds,
    bluffRate: bluffs / bids,
    lieWhenTapped: tappedLies / Math.max(1, tapped),
    lieWhenNotTapped: plainLies / Math.max(1, plain),
  };
}

if (require.main === module) {
  const n = Number(process.argv[2] ?? 20000);
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const ignores = simulate(n, false);
  const reads = simulate(n, true);
  console.log(`${n} rounds each, against a player who never bluffs and believes most bids`);
  console.log(`Wren bluffs on ${pct(ignores.bluffRate)} of her bids`);
  console.log(
    `when she taps her cup her bid is a lie ${pct(ignores.lieWhenTapped)} of the time; otherwise ${pct(ignores.lieWhenNotTapped)}`,
  );
  console.log(
    `that player wins ${pct(ignores.opponentWinRate)} of rounds ignoring her hands, ${pct(reads.opponentWinRate)} calling every tap`,
  );
}
