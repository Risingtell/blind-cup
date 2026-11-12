# Blind Cup: judge quick-start

Three ways in, from 30 seconds with no wallet to a full check of every claim.

Live site: **[blindcup.onepeg.app](https://blindcup.onepeg.app)** · Contract (Sepolia):
[`0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB`](https://sepolia.etherscan.io/address/0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB)

## 1. Watch a real match (30 seconds, no wallet)

Each replay is rebuilt from the contract's own events, and every step links to its transaction.

- [A player against Wren](https://blindcup.onepeg.app/?watch=14#play) (table 14, two rounds)
- [Two players, three rounds](https://blindcup.onepeg.app/?watch=15#play) (table 15, a HELD and two LIARs)
- [Two players on two real wallets](https://blindcup.onepeg.app/?watch=17#play) (table 17)

Notice what you never see: the dice. Nobody saw them during the match either, and the chain still can't show them.

## 2. Play (3 minutes, any Sepolia wallet)

1. Open [blindcup.onepeg.app](https://blindcup.onepeg.app) and press **Play Wren**.
2. Approve opening a table, then approve Wren's seat. That transaction rolls all ten dice, encrypted.
3. Sign once to lift your cup. Your wallet signs a decryption permit; you see your five dice and nothing else.
4. Bid, or call her bid a lie. When someone calls, watch the cups seal, "counting...", then one word.

A whole match costs about 0.0002 test ETH
([free faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)). To play a person instead, press
**Play a friend** and send the link; they press **Take your seat**.

## 3. Check every claim (2 minutes)

| Claim                                               | Where to check                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The dice come from onchain randomness nobody chose  | [`_rollDie`](https://github.com/Risingtell/blind-cup/blob/2a8387c294cd9f8851132f4d6d4d0fd8438b84b0/contracts/BlindCup.sol#L372-L374): `FHE.randEuint16()` reduced mod 6. No function takes a die value as input. The roll for table 14 happened in [this transaction](https://sepolia.etherscan.io/tx/0x556756d7e3d5a23a0deac0741db2e75cd6e58fd75e2dda4cb47a30d849d14332).                          |
| Only you can read your own dice                     | [`_startRound`](https://github.com/Risingtell/blind-cup/blob/2a8387c294cd9f8851132f4d6d4d0fd8438b84b0/contracts/BlindCup.sol#L302-L317): each die is allowed to the contract and to its owner only (`FHE.allow(die, player)`).                                                                                                                                                                      |
| The contract counts the call without seeing any die | [`_challenge`](https://github.com/Risingtell/blind-cup/blob/2a8387c294cd9f8851132f4d6d4d0fd8438b84b0/contracts/BlindCup.sol#L334-L359): `FHE.eq`, `FHE.or` (ones wild), `FHE.add`, `FHE.ge`, all on ciphertexts. Only the one-bit verdict is made public. Table 14's first call: [transaction](https://sepolia.etherscan.io/tx/0xfb701f59a20bd7072039f4c87ac87a802748845ff64600375227bd4cc127bf33). |
| The verdict can't be forged                         | [`resolve`](https://github.com/Risingtell/blind-cup/blob/2a8387c294cd9f8851132f4d6d4d0fd8438b84b0/contracts/BlindCup.sol#L200-L222) checks the Zama KMS signatures (`FHE.checkSignatures`) before scoring. A HELD settled on table 15: [transaction](https://sepolia.etherscan.io/tx/0xbbfe7fd81b5d1e981f5dc2f30bbe6d647fff5d615f78a123576385a4736a352c).                                           |
| The cups are never opened, even after the match     | No function reveals a die. The test "keeps the cups sealed after the verdict" checks that, after the call is settled, a die still cannot be publicly decrypted and the other player still cannot read it.                                                                                                                                                                                           |
| Wren, the house player, never sends a transaction   | [Her address](https://sepolia.etherscan.io/address/0x5f63e3B0D27FFc5B7e0a128833e24A552CA2405F) has sent none. She signs EIP-712 moves; the player's wallet carries them (`joinTableBySig`, `placeBidBySig`, `challengeBySig`).                                                                                                                                                                      |
| The source is the deployed code                     | Verified on [Sourcify](https://repo.sourcify.dev/11155111/0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB) and [Blockscout](https://eth-sepolia.blockscout.com/address/0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB?tab=contract).                                                                                                                                                                         |

Run the tests yourself:

```bash
git clone https://github.com/Risingtell/blind-cup && cd blind-cup
npm install
npx hardhat test       # 19 tests on Zama's mock FHE chain
npm run coverage       # 97% of the contract's statements
```

## The judging criteria, mapped

| Criterion                                                              | Blind Cup                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Confidentiality design**: would the game break if state were public? | Completely. Liar's dice with visible dice is not a game. Here even the referee is blind: the contract counts ciphertexts and publishes one bit. A commit-reveal version breaks three ways (see [README](README.md#why-not-commit-reveal)). |
| **Fairness**: onchain randomness the player can verify                 | Dice are drawn by `FHE.randEuint16` inside the join and settle transactions. No player, server or developer supplies a value, and the verdict is checked against KMS signatures on chain.                                                  |
| **End-to-end on Sepolia**                                              | Every step is a Sepolia transaction: open, seat, roll, bid, call, settle with proof, next round, match. Tables 14, 15 and 17 are complete matches: table 14 was played in Zerion against Wren, table 17 between two wallet apps.           |
| **Gameplay and UX**                                                    | A house player with a habit and a tell, a staged reveal (sealed cups, "counting...", one word), invite links for friends, a replay, plain error messages, and a seat that either player can settle if the other walks away.                |
| **Demo quality**                                                       | Live site, replays that need no wallet, and a 3-minute video.                                                                                                                                                                              |
| **Code quality**                                                       | NatSpec on the whole contract, 19 tests, 97% statement coverage, lint and CI on every push, and the bot's decisions in a pure, separately tested module.                                                                                   |
