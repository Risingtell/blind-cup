import "./style.css";

import { bestFace, countFor, isRaise, TOTAL } from "../../bot/brain";
import { Phase, Wallet } from "./chain";
import { addressUrl, BLINDCUP, FAUCET, txUrl } from "./config";
import { Match, type View } from "./match";
import { startTable } from "./scene";
import { wrenCard } from "./wren";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let wallet: Wallet | null = null;
let match: Match | null = null;
let qty = 1;
let face = 1;

for (const a of [$("faucet"), ...document.querySelectorAll<HTMLAnchorElement>(".faucet-link")])
  (a as HTMLAnchorElement).href = FAUCET;
const contractLink = $<HTMLAnchorElement>("contract-link");
contractLink.href = addressUrl(BLINDCUP);
contractLink.textContent = `${BLINDCUP.slice(0, 6)}…${BLINDCUP.slice(-4)}`;

wrenCard()
  .then((c) => {
    $("wren-blurb").textContent = c.blurb;
    $("wren-habit").textContent = c.habit;
    $("wren-tell").textContent = c.tell;
  })
  .catch(() => {});

const scene = startTable($("stage"));

// ---------------------------------------------------------------- bid builder

const facesEl = $("faces");
const faceButtons = [0, 1, 2, 3, 4, 5].map((f) => {
  const b = document.createElement("button");
  b.textContent = String(f + 1);
  b.setAttribute("aria-label", `${f + 1}s`);
  b.onclick = () => {
    face = f;
    paintControls();
  };
  facesEl.appendChild(b);
  return b;
});
$("qty-down").onclick = () => {
  qty = Math.max(1, qty - 1);
  paintControls();
};
$("qty-up").onclick = () => {
  qty = Math.min(TOTAL, qty + 1);
  paintControls();
};
$("bid").onclick = () => void match?.bid(qty, face);
$("call").onclick = () => void match?.call();

/** When your turn starts, preselect the smallest legal raise on the face you hold most. */
let preparedFor = "";
function prepareBid(v: View) {
  const t = v.table!;
  const key = `${t.id}:${t.moves}`;
  if (key === preparedFor || !v.myDice) return;
  preparedFor = key;
  face = bestFace(v.myDice);
  qty = Math.max(1, countFor(v.myDice, face));
  while (qty <= TOTAL && !isRaise(t.bid, { quantity: qty, face })) qty++;
  if (qty > TOTAL) {
    qty = TOTAL;
    face = 5;
  }
}

function paintControls() {
  const v = match?.view;
  const t = v?.table;
  const legal = Boolean(t && isRaise(t.bid, { quantity: qty, face }));
  $("qty").textContent = String(qty);
  faceButtons.forEach((b, f) => b.classList.toggle("on", f === face));
  $<HTMLButtonElement>("bid").disabled = !legal || Boolean(v?.busy);
  $<HTMLButtonElement>("bid").textContent = `Bid ${qty} × ${face + 1}s`;
  $<HTMLButtonElement>("call").disabled = !t?.bid || Boolean(v?.busy);
}

// ---------------------------------------------------------------- wallet and starting

async function ensureWallet(): Promise<Wallet> {
  if (wallet) return wallet;
  wallet = await Wallet.connect();
  const btn = $("connect");
  btn.textContent = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
  void checkBalance();
  window.ethereum?.on?.("accountsChanged", () => location.reload());
  window.ethereum?.on?.("chainChanged", () => location.reload());
  return wallet;
}

async function checkBalance() {
  if (!wallet) return;
  const bal = await wallet.balance().catch(() => null);
  $("low").hidden = bal === null || bal >= 200_000_000_000_000n; // a match costs about 0.00017 ETH
}

function newMatch(w: Wallet) {
  match?.stop();
  match = new Match(w);
  match.addEventListener("change", () => paint(match!.view));
  return match;
}

async function start(kind: "wren" | "friend") {
  try {
    const w = await ensureWallet();
    const m = newMatch(w);
    $("play").scrollIntoView({ behavior: "smooth" });
    await (kind === "wren" ? m.playWren() : m.openForFriend());
  } catch (e) {
    $("status").textContent = e instanceof Error ? e.message : String(e);
  }
}

$("connect").onclick = () => void ensureWallet().catch((e) => ($("status").textContent = e.message));
$("play-wren").onclick = () => void start("wren");
$("play-friend").onclick = () => void start("friend");

const linked = new URLSearchParams(location.search).get("table");
if (linked && /^\d+$/.test(linked)) {
  // An invited friend, or a player coming back after a refresh, must land on that table, so the big button
  // takes the seat there instead of opening a new table.
  const sit = async () => {
    try {
      const w = await ensureWallet();
      $("play").scrollIntoView({ behavior: "smooth" });
      await newMatch(w).resume(BigInt(linked));
    } catch (e) {
      $("status").textContent = e instanceof Error ? e.message : String(e);
    }
  };
  $("status").textContent = `Your seat is waiting at table ${linked}.`;
  for (const id of ["play-friend", "sit"]) {
    const b = $(id);
    b.textContent = `Take your seat at table ${linked}`;
    b.classList.add("btn-brass");
    b.hidden = false;
    b.onclick = () => void sit();
  }
  $("play-wren").classList.remove("btn-brass");
  $("invited").hidden = false;
  $("invited").textContent = `Your seat is waiting at table ${linked}.`;
  $("connect").onclick = () => void sit();
}

// ---------------------------------------------------------------- painting

function paint(v: View) {
  scene.render(v);
  const t = v.table;
  $("sit").hidden = true;
  // Keep the table in the address bar, so a refresh or a reopened tab comes back to it.
  if (t) {
    const url = new URL(location.href);
    if (url.searchParams.get("table") !== String(t.id)) {
      url.searchParams.set("table", String(t.id));
      history.replaceState(null, "", url);
    }
  }
  $("table-label").textContent = t ? `Table ${t.id} · round ${t.round || 1}` : "No table yet";
  $("status").textContent = v.status;

  const showShare = Boolean(t && t.phase === Phase.Open && v.opponent === "friend");
  $("share").hidden = !showShare;
  if (showShare) $<HTMLInputElement>("share-link").value = `${location.origin}/?table=${t!.id}`;

  const canAct = v.myTurn && !v.busy && t?.phase === Phase.Bidding;
  $("controls").hidden = !canAct;
  if (canAct) prepareBid(v);
  paintControls();

  $("problem").hidden = !v.error && !v.retry;
  $("problem").classList.toggle("problem-error", Boolean(v.error));
  $("error").textContent = v.error ?? "";
  const retry = $<HTMLButtonElement>("retry");
  retry.hidden = !v.retry;
  if (v.retry) {
    retry.textContent = v.retry.label;
    retry.onclick = () => void v.retry!.run();
  }

  $("tx").innerHTML = v.lastTx
    ? `Last transaction: <a href="${txUrl(v.lastTx)}" target="_blank" rel="noopener">${v.lastTx.slice(0, 10)}…</a>`
    : "";
  if (t?.phase === Phase.Done) void checkBalance();
}
