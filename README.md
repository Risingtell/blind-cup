# Blind Cup

**Liar's dice, rebuilt on Zama FHE. Even the referee is blind.**

Two cups, five dice each, rolled encrypted on chain. You see only your own. When someone calls a lie, the contract
counts every die without seeing a single one and publishes one word: the bid held, or it was a lie. The cups are never
opened, not even after the game.

- Contract (Sepolia):
  [`0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB`](https://sepolia.etherscan.io/address/0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB)
- Play: the web app in [`web/`](web) (live link coming with the hosted demo)
- 19 tests (contract, the bot's mind, full matches on the mock chain); 97% statement coverage of the contract

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

## Repository

| Path                        | What it is                                                                     |
| --------------------------- | ------------------------------------------------------------------------------ |
| `contracts/BlindCup.sol`    | The game: seating, encrypted rolls, bids, the blind count, settlement, timeout |
| `test/`                     | Contract tests and Wren's tests, on Zama's mock FHE chain                      |
| `bot/`                      | Wren: `brain.ts` (pure decisions), `service.ts` (reads, decrypts, signs)       |
| `api/wren.ts`               | Wren's hosted endpoint: returns a signed move for the player to relay          |
| `web/`                      | The game in the browser: Vite, Phaser, Zama's relayer SDK                      |
| `tasks/BlindCup.ts`         | Live-network tasks: play a round, play a match against Wren, settle a table    |
| `scripts/smoke-wren-api.ts` | Calls Wren's endpoint against Sepolia and relays her answers                   |

## Run it

```bash
npm install
npx hardhat test                                   # 19 tests on the mock FHE chain
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
