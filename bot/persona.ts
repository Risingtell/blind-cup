/**
 * Wren, the house player. What she says never depends on whether she is bluffing; only her hands do.
 */

export const NAME = "Wren";

export const CARD = {
  name: NAME,
  blurb: "Plays the river taverns. Never looks at your cup, because she can't.",
  habit: "She always opens on the face she holds most.",
  tell: "Watch her hands.",
};

const LINES = {
  open: ["Let's see what the river gave us.", "I'll start small.", "Easy money, this.", "Your move, friend."],
  raise: ["Higher.", "I'll go one more.", "Still believe me?", "Mm. Up it goes.", "Your turn to sweat."],
  challenge: ["Liar.", "No. Lift them.", "I don't believe a word.", "Count them, then."],
  winRound: ["The cup never lies.", "Pay up.", "Told you."],
  loseRound: ["Hm. Well played.", "Lucky river.", "Again."],
  winMatch: ["Come back when you've practised."],
  loseMatch: ["You read me. Not many do."],
} as const;

export type Moment = keyof typeof LINES;

export function line(moment: Moment, rng: () => number): string {
  const bank = LINES[moment];
  return bank[Math.floor(rng() * bank.length)];
}
