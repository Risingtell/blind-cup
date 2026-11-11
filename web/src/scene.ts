/**
 * The table, drawn. Everything is procedural (no image files): felt, two leather cups, bone dice, brass type.
 * It reads the match view and animates the changes: your dice rolling in, Wren's cup tapping, and the
 * reveal (cups slam down, "counting...", one stamped word).
 */
import Phaser from "phaser";

import type { View } from "./match";

export const W = 960;
export const H = 600;

const C = {
  felt: 0x0f2a20,
  feltEdge: 0x0a1c16,
  rail: 0x2a1a10,
  brass: 0xe0a43a,
  bone: 0xf1e9d6,
  ink: 0x15110d,
  leather: 0x5a2e1b,
  leatherDark: 0x3b1d10,
  red: 0xd8432f,
};
const DISPLAY = "Anton, Impact, sans-serif";
const BODY = "Inter, system-ui, sans-serif";
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");

const PIPS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

/** Draws one die. `face` is 0..5 (shown 1..6); a shown 1 is wild and gets a brass rim. */
export function drawDie(g: Phaser.GameObjects.Graphics, x: number, y: number, size: number, face: number, dim = false) {
  const wild = face === 0;
  g.fillStyle(dim ? 0x8d877a : C.bone, 1);
  g.fillRoundedRect(x - size / 2, y - size / 2, size, size, size * 0.16);
  g.lineStyle(Math.max(2, size * 0.05), wild ? C.brass : C.ink, wild ? 1 : 0.35);
  g.strokeRoundedRect(x - size / 2, y - size / 2, size, size, size * 0.16);
  g.fillStyle(C.ink, 1);
  for (const [px, py] of PIPS[face + 1]) g.fillCircle(x + px * size * 0.26, y + py * size * 0.26, size * 0.085);
}

function drawCup(g: Phaser.GameObjects.Graphics, w: number, h: number) {
  g.clear();
  g.fillStyle(C.leatherDark, 1);
  g.fillPoints([new Phaser.Math.Vector2(-w * 0.5, h * 0.5), new Phaser.Math.Vector2(w * 0.5, h * 0.5), new Phaser.Math.Vector2(w * 0.38, -h * 0.5), new Phaser.Math.Vector2(-w * 0.38, -h * 0.5)], true);
  g.fillStyle(C.leather, 1);
  g.fillPoints([new Phaser.Math.Vector2(-w * 0.44, h * 0.42), new Phaser.Math.Vector2(w * 0.3, h * 0.42), new Phaser.Math.Vector2(w * 0.22, -h * 0.44), new Phaser.Math.Vector2(-w * 0.34, -h * 0.44)], true);
  g.fillStyle(C.brass, 1);
  g.fillRect(-w * 0.5, h * 0.36, w, h * 0.1);
  g.fillRect(-w * 0.38, -h * 0.5, w * 0.76, h * 0.07);
}

export class TableScene extends Phaser.Scene {
  private view?: View;
  private wrenCup!: Phaser.GameObjects.Container;
  private myCup!: Phaser.GameObjects.Container;
  private dice!: Phaser.GameObjects.Graphics;
  private bidLabel!: Phaser.GameObjects.Text;
  private bidQty!: Phaser.GameObjects.Text;
  private bidDie!: Phaser.GameObjects.Graphics;
  private oppName!: Phaser.GameObjects.Text;
  private oppLine!: Phaser.GameObjects.Text;
  private tap!: Phaser.GameObjects.Text;
  private score!: Phaser.GameObjects.Text;
  private veil!: Phaser.GameObjects.Rectangle;
  private counting!: Phaser.GameObjects.Text;
  private word!: Phaser.GameObjects.Text;
  private idle!: Phaser.GameObjects.Text;
  private shownDice = "";
  private shownWren = 0;
  private shownStage = "";
  private countingTween?: Phaser.Tweens.Tween;

  constructor() {
    super("table");
  }

  create() {
    const g = this.add.graphics();
    g.fillStyle(C.rail, 1).fillEllipse(W / 2, H / 2 + 10, W * 0.98, H * 0.96);
    g.fillStyle(C.feltEdge, 1).fillEllipse(W / 2, H / 2 + 10, W * 0.93, H * 0.88);
    g.fillStyle(C.felt, 1).fillEllipse(W / 2, H / 2 + 10, W * 0.9, H * 0.84);
    g.lineStyle(2, C.brass, 0.25).strokeEllipse(W / 2, H / 2 + 10, W * 0.62, H * 0.5);

    this.oppName = this.add.text(W / 2, 46, "", { fontFamily: DISPLAY, fontSize: "30px", color: hex(C.bone) }).setOrigin(0.5);
    this.oppLine = this.add.text(W / 2, 80, "", { fontFamily: BODY, fontSize: "18px", color: hex(C.brass), fontStyle: "italic" }).setOrigin(0.5);

    const wg = this.add.graphics();
    drawCup(wg, 120, 110);
    this.wrenCup = this.add.container(W / 2, 170, [wg]);
    this.tap = this.add.text(W / 2 + 92, 150, "tap tap", { fontFamily: BODY, fontSize: "16px", color: hex(C.bone) }).setOrigin(0, 0.5).setAlpha(0);

    this.bidLabel = this.add.text(W / 2, 262, "", { fontFamily: BODY, fontSize: "13px", color: hex(C.brass) }).setOrigin(0.5);
    this.bidQty = this.add.text(W / 2 - 18, 312, "", { fontFamily: DISPLAY, fontSize: "64px", color: hex(C.bone) }).setOrigin(1, 0.5);
    this.bidDie = this.add.graphics();

    const mg = this.add.graphics();
    drawCup(mg, 120, 110);
    this.myCup = this.add.container(W / 2 - 300, 470, [mg]).setAngle(-28);
    this.dice = this.add.graphics();

    this.score = this.add.text(W / 2, H - 22, "", { fontFamily: BODY, fontSize: "14px", color: hex(C.bone) }).setOrigin(0.5).setAlpha(0.8);
    this.idle = this.add.text(W / 2, H / 2, "", { fontFamily: DISPLAY, fontSize: "44px", color: hex(C.bone), align: "center" }).setOrigin(0.5);

    this.veil = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.72).setAlpha(0);
    this.counting = this.add.text(W / 2, H / 2, "counting...", { fontFamily: DISPLAY, fontSize: "56px", color: hex(C.bone) }).setOrigin(0.5).setAlpha(0);
    this.word = this.add.text(W / 2, H / 2, "", { fontFamily: DISPLAY, fontSize: "170px", color: hex(C.brass) }).setOrigin(0.5).setAlpha(0);

    this.render(this.view ?? { table: null, mySeat: null, opponent: null, myDice: null, status: "", busy: false, myTurn: false });
  }

  render(v: View) {
    this.view = v;
    if (!this.dice) return; // not created yet; create() will render
    const t = v.table;
    const opp = v.opponent === "wren" ? "WREN" : v.opponent === "friend" ? "YOUR FRIEND" : "";
    this.oppName.setText(opp);
    const done = t?.phase === 3;
    const iWon = done && v.mySeat !== null && t!.winner.toLowerCase() === t!.players[v.mySeat].toLowerCase();
    this.idle.setText(!t ? "PULL UP A CHAIR" : done ? (iWon ? "YOU WIN" : `${opp} WINS`) : "").setColor(done && !iWon ? hex(C.red) : hex(C.bone));
    this.idle.setFontSize(done ? 96 : 44);
    this.wrenCup.setVisible(Boolean(t));
    this.myCup.setVisible(Boolean(t));

    // the standing bid
    this.bidDie.clear();
    if (t?.bid && !done) {
      this.bidLabel.setText("STANDING BID");
      this.bidQty.setText(`${t.bid.quantity} ×`);
      drawDie(this.bidDie, W / 2 + 26, 312, 58, t.bid.face);
    } else {
      this.bidLabel.setText(t && t.phase >= 1 && t.phase < 3 ? "NO BID YET" : "");
      this.bidQty.setText("");
    }

    // score
    if (t && v.mySeat !== null) {
      const me = t.wins[v.mySeat];
      const them = t.wins[1 - v.mySeat];
      const pips = (n: number) => "●".repeat(n) + "○".repeat(Math.max(0, 2 - n));
      this.score.setText(`YOU ${pips(me)}     ROUND ${t.round || 1} · BEST OF 3     ${pips(them)} ${opp}`);
    } else this.score.setText("");

    // your dice: roll in when they change
    const key = v.myDice ? v.myDice.join("") + ":" + (t?.round ?? 0) : "";
    if (key !== this.shownDice) {
      this.shownDice = key;
      this.dice.clear();
      if (v.myDice) {
        v.myDice.forEach((d, i) => drawDie(this.dice, W / 2 - 160 + i * 80, 470, 62, d));
        this.dice.setAlpha(0).setY(30);
        this.tweens.add({ targets: this.dice, alpha: 1, y: 0, duration: 450, ease: "Back.Out" });
        this.tweens.add({ targets: this.myCup, angle: { from: 0, to: -28 }, x: { from: W / 2, to: W / 2 - 300 }, duration: 500, ease: "Cubic.Out" });
      }
    }

    // Wren speaks; her hands sometimes tap the cup
    if (v.wren && v.wren.seq !== this.shownWren) {
      this.shownWren = v.wren.seq;
      this.oppLine.setText(`"${v.wren.says}"`).setAlpha(0);
      this.tweens.add({ targets: this.oppLine, alpha: 1, duration: 300 });
      if (v.wren.tell) {
        this.tweens.add({ targets: this.wrenCup, angle: { from: 0, to: 5 }, yoyo: true, repeat: 1, duration: 110, ease: "Sine.InOut" });
        this.tweens.add({ targets: this.tap, alpha: { from: 0.9, to: 0 }, duration: 900, delay: 100 });
      }
    }
    if (!v.wren && v.opponent !== "wren") this.oppLine.setText("");

    this.renderReveal(v);
  }

  private renderReveal(v: View) {
    const stage = v.reveal ? `${v.reveal.stage}:${v.reveal.held}` : "";
    if (stage === this.shownStage) return;
    this.shownStage = stage;
    this.countingTween?.stop();
    if (!v.reveal) {
      this.tweens.add({ targets: [this.veil, this.counting, this.word], alpha: 0, duration: 300 });
      return;
    }
    const r = v.reveal;
    if (r.stage === "sealed") {
      this.tweens.add({ targets: this.veil, alpha: 1, duration: 300 });
      this.tweens.add({ targets: this.myCup, angle: 0, x: W / 2 - 200, y: 470, duration: 260, ease: "Quad.In" });
      this.tweens.add({ targets: this.dice, alpha: 0, duration: 200 });
      this.time.delayedCall(260, () => this.cameras.main.shake(140, 0.006));
    } else if (r.stage === "counting") {
      this.counting.setAlpha(1);
      this.countingTween = this.tweens.add({ targets: this.counting, alpha: { from: 1, to: 0.35 }, yoyo: true, repeat: -1, duration: 520 });
    } else {
      this.counting.setAlpha(0);
      this.word.setText(r.held ? "HELD" : "LIAR").setColor(hex(r.held ? C.brass : C.red));
      this.word.setScale(2.4).setAlpha(0);
      this.tweens.add({ targets: this.word, scale: 1, alpha: 1, duration: 260, ease: "Back.Out" });
      this.time.delayedCall(200, () => this.cameras.main.shake(220, 0.012));
    }
  }
}

export function startTable(parent: HTMLElement): TableScene {
  const scene = new TableScene();
  new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: W,
    height: H,
    transparent: true,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_HORIZONTALLY },
    scene,
  });
  return scene;
}
