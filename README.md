# Blind Cup

**Liar's dice, rebuilt on Zama FHE. Even the referee is blind.**

Two cups, five dice each, rolled encrypted on chain. You see only your own. When someone calls a lie, the contract
counts every die without seeing a single one and publishes one word: the bid held, or it was a lie. The cups are never
opened, not even after the game.

- Contracts (Sepolia): the game
  [`0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB`](https://sepolia.etherscan.io/address/0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB)
  and its hidden-stakes purse
  [`0x6A0e95C1a6dB2cA2BC16fEDad7ad03bCcf61de27`](https://sepolia.etherscan.io/address/0x6A0e95C1a6dB2cA2BC16fEDad7ad03bCcf61de27),
  staking Zama's test cUSDT (ERC-7984)
- **Play: [blindcup.onepeg.app](https://blindcup.onepeg.app)** (Sepolia; a match costs about 0.0002 test ETH)
- **No wallet? Watch a real match replayed from the chain:**
  [a player against Wren](https://blindcup.onepeg.app/?watch=14#play) or
  [two players, three rounds](https://blindcup.onepeg.app/?watch=15#play)
- 26 tests (the game, the purse, the bot's mind, full matches on the mock chain); statement coverage 97% (game) and 98%
  (purse)
- **Judging? [JUDGE-QUICKSTART.md](JUDGE-QUICKSTART.md)**: watch, play and check every claim in five minutes

> This project is not audited, endorsed or operated by Zama. Use at your own risk.

## How a round works

1. **Rolled encrypted.** When the second player sits down, the contract draws ten dice from Zama's encrypted on-chain
   randomness (`FHE.randEuint16`, reduced mod 6). Each die is stored as a ciphertext, and the ACL lets only that cup's
   owner decrypt it.
2. **Bid.** Players take turns raising the bid ("four 3s"): more dice, or the same number on a higher face. Ones are
   wild unless ones were bid.
3. **Counted blind.** Calling a bid a lie makes the contract compare all ten ciphertexts with the bid's face (`FHE.eq`,
   `FHE.or`, `FHE.add`) and check the total against the bid (`FHE.ge`). The result is one encrypted bit, marked publicly
   decryptable.
4. **One bit out.** Zama's KMS decrypts that bit and signs it. Anyone can submit it to `resolve`, which checks the
   signatures (`FHE.checkSignatures`) before scoring the round. The same transaction rolls the next round's cups.

A match is best of three. A seat that stalls for 10 minutes can be forfeited (`claimTimeout`), and such wins are flagged
`byForfeit`.

## Why not commit-reveal?

Commit-reveal settles a call by making both players open their cups. That breaks liar's dice three ways:

- **The loser can walk.** Whoever sees they are losing never reveals. Here nobody reveals anything: the count runs on
  ciphertexts and anyone can settle it.
- **The bluff dies with the reveal.** Once a cup is open, everyone learns how you bid with it. Here the dice stay sealed
  forever, so a player's style stays private.
- **Someone still picks the dice.** Commitments hide values a player chose. Here the dice come from encrypted on-chain
  randomness that nobody chose.

## Wren, the house player

Wren is a bot you can play any time. She is a character, not a solver:

- **Her habit:** she always opens on the face she holds most.
- **Her tell:** she sometimes taps her cup. In 20,000 simulated rounds, a tapped bid was a lie about 70% of the time,
  and an untapped one about 33% (`npx ts-node --transpile-only bot/sim/simulate.ts`).
- **Her limits:** she reads the table from the chain and decrypts only her own cup through the Zama relayer. The ACL
  refuses her anything else, so she cannot see your dice.
- **She never pays gas.** Every move can be signed with EIP-712 (`joinTableBySig`, `placeBidBySig`, `challengeBySig`)
  and bound to the table's move counter, so it is valid exactly once. Wren signs, and the player's wallet carries her
  move. Her wallet has sent no transactions.
- Asking her twice in the same position returns the same signed move, so nobody can fish for a weaker one.

## Hidden stakes in confidential cUSDT

Two friends can play for Zama's test cUSDT, an ERC-7984 confidential token, through a purse that sits beside the game
([`contracts/CupPurse.sol`](contracts/CupPurse.sol)).

- **Hidden on the way in.** Before the cups are rolled, each player may put in a stake, encrypted in the browser. The
  purse moves it with `confidentialTransferFrom`; nobody, not even the opponent, ever sees the amount.
- **The table plays for the smaller stake.** The purse takes the minimum of the two stakes on ciphertexts (`FHE.min`)
  and lets only those two players decrypt that one number, so both know what is at play and neither learns the other's
  stake.
- **Paid out blind.** When the match ends, anyone can settle the purse: the winner receives their own stake plus the
  table stake, and the loser gets back whatever they put in above it. Every amount stays encrypted.
- **No free rides.** A stake the player cannot cover moves zero (ERC-7984 semantics), and the purse only counts what it
  actually received, so an empty purse plays for nothing and can win nothing.
- **Proven on Sepolia:** on table 20 the host staked a hidden 5 and the guest a hidden 3. The guest won, and after
  [the payout](https://sepolia.etherscan.io/tx/0x85e63c3a8586a206e461215ef04362fa2a91a002032e48fe3809e102d64d7e25) the
  host held 3 fewer cUSDT and the guest 3 more. No stake or payout amount appears anywhere on the chain.

The game contract is unchanged: the purse only reads its results. Matches against Wren are not staked, since she never
sends a transaction.

## Repository

| Path                        | What it is                                                                     |
| --------------------------- | ------------------------------------------------------------------------------ |
| `contracts/BlindCup.sol`    | The game: seating, encrypted rolls, bids, the blind count, settlement, timeout |
| `contracts/CupPurse.sol`    | Hidden stakes in an ERC-7984 token, paid out from the game's result            |
| `test/`                     | Tests for the game, the purse and Wren, on Zama's mock FHE chain               |
| `bot/`                      | Wren: `brain.ts` (pure decisions), `service.ts` (reads, decrypts, signs)       |
| `api/wren.ts`               | Wren's hosted endpoint: returns a signed move for the player to relay          |
| `web/`                      | The game in the browser: Vite, Phaser, Zama's relayer SDK                      |
| `tasks/BlindCup.ts`         | Live-network tasks: play a round, play a match against Wren, settle a table    |
| `tasks/CupPurse.ts`         | Deploy the purse; play and pay out a staked match on Sepolia                   |
| `scripts/smoke-wren-api.ts` | Calls Wren's endpoint against Sepolia and relays her answers                   |
| `scripts/export-match.ts`   | Saves a finished table's events for the replay (public nodes drop old logs)    |

## Run it

```bash
npm install
npx hardhat test                                   # 26 tests on the mock FHE chain
npx hardhat --network sepolia blindcup:wren        # a full match against Wren on Sepolia
cd web && npm install && npm run dev               # the game at http://localhost:5173
```

Live tasks read `MNEMONIC` from `npx hardhat vars`. The local web server serves Wren from `api/wren.ts` and needs
`WREN_PRIVATE_KEY` in the environment or in `npx hardhat vars`.

Every transaction pays a 0.01 gwei priority tip. Sepolia's base fee is near zero, so a whole match costs about 0.0002
test ETH.

## Limits, stated plainly

- Testnet only (Sepolia).
- Dice are 16 random bits reduced mod 6, so faces 1 to 4 carry one extra outcome in 65,536.
- Against Wren, the player relays her signed moves. A player could hold back her move and later claim a forfeit; those
  wins are flagged `byForfeit` so a leaderboard can leave them out.
- Public RPC nodes lag; the app reads state at the block of its own last transaction.

## License

BSD-3-Clause-Clear. Built on Zama's [fhevm-hardhat-template](https://github.com/zama-ai/fhevm-hardhat-template).
