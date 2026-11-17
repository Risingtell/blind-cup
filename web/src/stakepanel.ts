/** The stake box in the side panel: what it shows depends on the table and on who you are at it. */
import { Phase, type TableState, type Wallet } from "./chain";
import type { View } from "./match";
import { balanceOf, getTestCusdt, hasStake, isSettled, myStake, payOut, show, stakeOn, tableStake } from "./stakes";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Mode = "host" | "guest" | "play" | "payout" | "none";

export class StakePanel {
  private key = "";
  private busy = false;
  private poll: ReturnType<typeof setInterval> | undefined;
  private wallet: Wallet | null = null;

  constructor() {
    $("cusdt-show").onclick = () => void this.showBalance();
    $("cusdt-get").onclick = () =>
      void this.act(async (w) => {
        await getTestCusdt(w, 20n, (s) => this.status(s));
        this.status("You have 20 more test cUSDT.");
        await this.showBalance();
      });
  }

  private el = {
    box: $("stake"),
    note: $("stake-note"),
    form: $("stake-form"),
    amount: $<HTMLInputElement>("stake-amount"),
    stake: $<HTMLButtonElement>("stake-btn"),
    skip: $<HTMLButtonElement>("stake-skip"),
    pay: $<HTMLButtonElement>("purse-pay"),
  };

  private status(s: string) {
    $("stake-status").textContent = s;
  }

  private amount(): bigint | null {
    const n = Number(this.el.amount.value);
    return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? BigInt(n) : null;
  }

  private async act(run: (w: Wallet) => Promise<void>) {
    if (this.busy || !this.wallet) return;
    this.busy = true;
    for (const b of [this.el.stake, this.el.skip, this.el.pay]) b.disabled = true;
    try {
      await run(this.wallet);
    } catch (e) {
      this.status(message(e));
    } finally {
      this.busy = false;
      for (const b of [this.el.stake, this.el.skip, this.el.pay]) b.disabled = false;
    }
  }

  async showBalance() {
    if (!this.wallet) return;
    $("cusdt").textContent = "decrypting...";
    try {
      $("cusdt").textContent = `${show(await balanceOf(this.wallet))} cUSDT`;
    } catch (e) {
      $("cusdt").textContent = "";
      this.status(message(e));
    }
  }

  private layout(mode: Mode, note: string, opts: { form?: boolean; skip?: string; pay?: boolean } = {}) {
    this.el.box.hidden = mode === "none";
    this.el.note.textContent = note;
    this.el.form.hidden = !opts.form;
    this.el.skip.hidden = !opts.skip;
    this.el.skip.textContent = opts.skip ?? "";
    this.el.pay.hidden = !opts.pay;
  }

  hide() {
    this.key = "";
    this.layout("none", "");
  }

  /**
   * Before an invited guest sits: if the host staked, offer to stake too. Resolves when the guest has chosen,
   * so the caller can then take the seat. Resolves at once when there is nothing to choose.
   */
  async beforeSitting(w: Wallet, t: TableState): Promise<void> {
    this.wallet = w;
    if (t.phase !== Phase.Open || same(t.players[0], w.address) || !(await hasStake(t.id, t.players[0]))) return;
    this.key = `guest:${t.id}`;
    if (await hasStake(t.id, w.address)) {
      this.layout("guest", `Your hidden stake on this table: ${show(await myStake(w, t.id))} cUSDT.`);
      return;
    }
    this.layout(
      "guest",
      "Your friend put a hidden stake on this table. Add your own before you sit, or sit without one. " +
        "The table plays for the smaller of the two, and neither of you sees the other's amount.",
      { form: true, skip: "Take your seat without a stake" },
    );
    this.el.stake.textContent = "Stake and take your seat";
    // The choice is made here, so the plain "take your seat" buttons step aside until it is.
    for (const id of ["sit", "play-friend"]) $(id).hidden = true;
    await new Promise<void>((done) => {
      this.el.skip.onclick = () => done();
      this.el.stake.onclick = () =>
        void this.act(async (wallet) => {
          const a = this.amount();
          if (a === null) return this.status("Enter a whole number of cUSDT, 1 or more.");
          await stakeOn(wallet, t.id, a, (s) => this.status(s));
          this.status("Your hidden stake is in. Taking your seat...");
          done();
        });
    });
  }

  /** Called on every paint; refreshes only when the table, its phase or your role changes. */
  update(v: View, w: Wallet | null) {
    this.wallet = w;
    const t = v.table;
    if (!w || !t || v.names || v.opponent !== "friend" || v.mySeat === null) {
      if (!this.key.startsWith("guest:")) this.hide();
      return;
    }
    const mode: Mode = t.phase === Phase.Open && v.mySeat === 0 ? "host" : t.phase === Phase.Done ? "payout" : "play";
    const key = `${mode}:${t.id}:${t.phase}`;
    if (key === this.key) return;
    this.key = key;
    void this.refresh(mode, t, w).catch((e) => this.status(message(e)));
  }

  private async refresh(mode: Mode, t: TableState, w: Wallet) {
    const [host, guest] = t.players;
    clearInterval(this.poll);
    this.status("");
    if (mode === "host") {
      if (await hasStake(t.id, w.address)) {
        this.layout(
          "host",
          `Your hidden stake: ${show(await myStake(w, t.id))} cUSDT. Your friend can add theirs before sitting.`,
        );
        return;
      }
      this.layout(
        "host",
        "Optional: put a hidden stake on this table in Zama's test cUSDT. Your friend never sees the amount; " +
          "the table plays for the smaller of your two stakes. A stake you can't cover counts as zero.",
        { form: true },
      );
      this.el.stake.textContent = "Stake hidden";
      this.el.stake.onclick = () =>
        void this.act(async (wallet) => {
          const a = this.amount();
          if (a === null) return this.status("Enter a whole number of cUSDT, 1 or more.");
          await stakeOn(wallet, t.id, a, (s) => this.status(s));
          this.status("");
          this.key = "";
          this.update({ table: t, mySeat: 0, opponent: "friend" } as View, wallet);
        });
      return;
    }

    const staked = (await hasStake(t.id, host)) || (await hasStake(t.id, guest));
    if (mode === "play") {
      if (!staked) return this.hide();
      const atPlay = await tableStake(w, t.id, guest).catch(() => null);
      this.layout(
        "play",
        atPlay === null
          ? "Only one of you staked, so this table plays for nothing; stakes come back at the end."
          : `This table plays for ${show(atPlay)} cUSDT. Nobody else can see that number.`,
      );
      return;
    }

    // Done
    if (!staked && !(await isSettled(t.id))) return this.hide();
    if (await isSettled(t.id)) {
      this.layout("payout", "Stakes paid out. Press Show my cUSDT to see your balance.");
      return;
    }
    this.layout(
      "payout",
      "The match is over. Pay out the hidden stakes: the winner gets their stake plus the table's.",
      {
        pay: true,
      },
    );
    // Either player may pay out; if the other one does, say so instead of offering a payout that would be refused.
    this.poll = setInterval(() => {
      void isSettled(t.id).then((done) => {
        if (!done || this.busy) return;
        clearInterval(this.poll);
        this.layout("payout", "Stakes paid out. Press Show my cUSDT to see your balance.");
      });
    }, 6000);
    this.el.pay.onclick = () =>
      void this.act(async (wallet) => {
        this.status("Paying out the purse. Confirm in your wallet.");
        await payOut(wallet, t.id);
        clearInterval(this.poll);
        this.status("Paid out.");
        this.layout("payout", "Stakes paid out.");
        await this.showBalance();
      });
  }
}
