// 台帳のスマホ画面。状態は localStorage に置く(読み書きは必ず try/catch)。
import { fare, isLate, runningSeconds, pausedSeconds, rideConfig } from "./fare.js";
import { parse, balance, openOrders, newEntry, rideEntries, appendText,
         dedupe, dropSent, localIso, canVoid, adjustAmount } from "./ledger.js";
import { getFile, appendEntries } from "./store.js";

const KEYS = { cfg: "wallet.cfg", meter: "wallet.meter", outbox: "wallet.outbox", cache: "wallet.cache" };

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 保存できなくても画面は動かす */ }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const coin = (text) => esc(text).replaceAll("{coin}", '<img class="coin" src="coin.svg" alt="">');
const amount = (n) => coin(`${n}{coin}`);
const signed = (n) => coin(`${n > 0 ? "+" : ""}${n}{coin}`);

const state = {
  cfg: load(KEYS.cfg, null),
  meter: load(KEYS.meter, null),
  outbox: load(KEYS.outbox, []),
  cache: load(KEYS.cache, { text: "", shop: null }),
  view: "list",
  error: "",
  syncing: false,
  again: false,
  adjustDir: "minus", // 臨時調整の向き(minus=引く / plus=増やす)
  target: null,   // 打ち消す行の id
  endedAt: null,  // 帰庫を押した時刻
};
if (!Array.isArray(state.outbox)) state.outbox = [];
if (!state.cache || typeof state.cache.text !== "string") state.cache = { text: "", shop: null };
if (state.meter) state.view = "meter";

const app = document.getElementById("app");
const saveOutbox = () => save(KEYS.outbox, state.outbox);
const saveCache = () => save(KEYS.cache, state.cache);
const saveMeter = () => save(KEYS.meter, state.meter);

// ── 計算 ──────────────────────────────────────────────

function ledger() {
  return parse(appendText(state.cache.text, dedupe(state.outbox)));
}
const shopItem = (id) => (state.cache.shop?.items ?? []).find((i) => i.id === id);
const orderOf = (id) => openOrders(ledger().entries).find((o) => o.id === id) ?? null;

function describe(e) {
  switch (e.type) {
    case "earn_daily": return `日鍛の達成${e.day ? ` ${e.day}` : ""}`;
    case "earn_lap": return "周回";
    case "order": return `注文: ${e.name ?? e.item ?? ""}`;
    case "order_cancel": return "注文の取消";
    case "ride": return `送迎の運賃${e.fare ? `(運賃 ${e.fare}{coin})` : ""}`;
    case "adjust": return `臨時: ${e.reason ?? ""}`;
    case "void": return `打ち消し: ${e.reason ?? ""}`;
    default: return e.type ?? "";
  }
}

// ── 同期 ──────────────────────────────────────────────

async function sync() {
  if (!state.cfg) return;
  if (state.syncing) { state.again = true; return; }
  state.syncing = true;
  try {
    do {
      state.again = false;
      const pending = dedupe(state.outbox);
      let got;
      if (pending.length) {
        got = await appendEntries(state.cfg, pending);
        // 送っている間に足された記録は残す
        state.outbox = dropSent(state.outbox, pending.map((e) => e.id));
        saveOutbox();
      } else {
        got = await getFile(state.cfg, "ledger.jsonl");
      }
      state.cache.text = got.text;
      saveCache();
      const shop = await getFile(state.cfg, "shop.json");
      try {
        state.cache.shop = JSON.parse(shop.text);
        saveCache();
      } catch {
        throw new Error("商品の設定を読めません");
      }
    } while (state.again);
    state.error = "";
  } catch (e) {
    state.error = e.message || "通信に失敗しました";
  } finally {
    state.syncing = false;
    render();
  }
}

function add(entries) {
  const known = new Set(state.outbox.map((e) => e.id));
  for (const e of entries) if (!known.has(e.id)) state.outbox.push(e);
  saveOutbox();
  render();
  sync();
}

// ── 画面 ──────────────────────────────────────────────

function header() {
  const parts = [];
  if (state.outbox.length) parts.push(`<div class="banner">未送信 ${state.outbox.length}件</div>`);
  if (state.error) parts.push(`<div class="banner">${esc(state.error)}</div>`);
  if (parse(state.cache.text).bad) parts.push('<div class="banner">台帳に読めない行があります</div>');
  return parts.join("");
}

function settingsView() {
  const first = !state.cfg;
  return `<div class="card"><h1>${first ? "はじめに" : "設定"}</h1>
    <label>リポジトリ(例: owner/name)<input id="repo" value="${esc(state.cfg?.repo ?? "")}" autocomplete="off" autocapitalize="off"></label>
    <label>トークン${first ? "" : "(空欄なら今のまま)"}<input id="token" type="password" autocomplete="off" autocapitalize="off"></label>
    <div class="row">${first ? "" : '<button data-act="back">戻る</button>'}
    <button class="primary" data-act="save-cfg">保存</button></div></div>`;
}

function orderCard(o) {
  const item = shopItem(o.item);
  const notes = (item?.notes ?? []).map((n) => `<li>${coin(n)}</li>`).join("");
  const start = item?.kind === "ride"
    ? `<button class="primary" data-act="start-order" data-id="${esc(o.id)}">メーター開始</button>`
    : `<button class="primary" data-act="done" data-id="${esc(o.id)}">完了</button>`;
  return `<div class="card"><strong>${esc(o.name ?? o.item ?? "注文")}</strong>
    <span class="sub"> ${amount(-o.amount)}</span>
    ${notes ? `<ul class="notes">${notes}</ul>` : ""}
    <div class="row">${start}<button class="danger" data-act="cancel" data-id="${esc(o.id)}">取消</button></div></div>`;
}

function listView() {
  const { entries } = ledger();
  const hist = entries.filter((e) => e.amount !== 0).reverse().slice(0, 100).map((e) => {
    const can = canVoid(e, entries);
    return `<li><div class="what">${coin(describe(e))}<div class="sub">${esc((e.at ?? "").slice(5, 16).replace("T", " "))}</div></div>
      <span class="amt ${e.amount > 0 ? "plus" : "minus"}">${signed(e.amount)}</span>
      ${can ? `<button class="small" data-act="void" data-id="${esc(e.id)}">打ち消し</button>` : ""}</li>`;
  }).join("");
  return `<div class="card"><div class="sub" style="text-align:center">残高</div>
      <div class="balance">${amount(balance(entries))}</div></div>
    ${openOrders(entries).map(orderCard).join("")}
    <div class="row"><button data-act="adjust-minus">臨時で引く</button>
      <button data-act="adjust-plus">臨時で増やす</button></div>
    <div class="row"><button data-act="start-free">注文なしでメーター開始</button></div>
    <div class="card" style="margin-top:14px"><h2>履歴</h2>
      <ul class="hist">${hist || '<li class="sub">まだありません</li>'}</ul></div>
    <p style="text-align:center"><button class="small" data-act="settings">設定</button></p>`;
}

function adjustView() {
  return `<div class="card"><h1>${state.adjustDir === "plus" ? "臨時で増やす" : "臨時で引く"}</h1>
    <label>金額<input id="adj-amount" type="number" inputmode="numeric" min="1" step="1"></label>
    <label>理由(必須)<input id="adj-reason" autocomplete="off"></label>
    <p id="form-error" class="sub"></p>
    <div class="row"><button data-act="back">戻る</button><button class="primary" data-act="adjust-ok">記録</button></div></div>`;
}

function voidView() {
  const e = ledger().entries.find((x) => x.id === state.target);
  if (!e) { state.view = "list"; return listView(); }
  return `<div class="card"><h1>打ち消し</h1>
    <p>${coin(describe(e))}: ${signed(e.amount)}</p>
    <label>理由(必須)<input id="void-reason" autocomplete="off"></label>
    <p id="form-error" class="sub"></p>
    <div class="row"><button data-act="back">戻る</button><button class="primary" data-act="void-ok">打ち消す</button></div></div>`;
}

function meterView() {
  const m = state.meter;
  const open = m.pauses.at(-1)?.[1] === null;
  const order = m.orderId ? orderOf(m.orderId) : null;
  return `<div class="card"><h1>メーター${m.orderId ? "" : "(注文なし)"}</h1>
    <div class="meter" id="m-fare"></div>
    <div class="clock" id="m-clock"></div>
    <div style="text-align:center"><span class="tag" id="m-late" hidden>割増</span>
      <span class="tag" id="m-pause" hidden>一時停止中</span></div>
    ${m.orderId && !order ? '<p class="sub">注文が台帳に見つかりません。同期してから帰庫してください</p>' : ""}
    <div class="row"><button data-act="pause">${open ? "再開" : "一時停止"}</button>
      <button class="primary" data-act="finish">帰庫</button></div></div>`;
}

function finishView() {
  const m = state.meter;
  const end = state.endedAt;
  const shop = state.cache.shop;
  const total = fare(m.started, end, m.pauses, rideConfig(shop));
  const order = m.orderId ? orderOf(m.orderId) : null;
  const blocked = m.orderId && !order;
  const net = total - (order ? -order.amount : 0);
  return `<div class="card"><h1>帰庫</h1>
    <div class="meter">${amount(total)}</div>
    ${order ? `<p>注文で払った額 ${amount(-order.amount)} を引いて、${amount(net)} を記録します</p>`
            : blocked ? '<p class="sub">注文が台帳に見つかりません。戻って同期してください</p>'
                      : `<p>全額 ${amount(total)} を記録します</p>`}
    <div class="row"><button data-act="finish-back">戻る</button>
      ${blocked ? "" : '<button class="primary" data-act="finish-ok">確定</button>'}</div></div>`;
}

function render() {
  try {
    draw();
  } catch (e) {
    app.innerHTML = `<div class="card"><h1>表示できません</h1><p class="sub">${esc(e.message || e)}</p>
      <p class="sub">再読み込みしてください。直らなければ設定を開き直してください</p>
      <p><button data-act="reload">再読み込み</button> <button data-act="settings">設定</button></p></div>`;
  }
}

function draw() {
  let body;
  if (!state.cfg || state.view === "settings") body = settingsView();
  else if (state.view === "adjust") body = adjustView();
  else if (state.view === "void") body = voidView();
  else if (state.view === "meter" && state.meter) body = meterView();
  else if (state.view === "finish" && state.meter && state.endedAt) body = finishView();
  else { state.view = "list"; body = listView(); }
  // 同期の終了などで描き直しても、入力中の文字を消さない
  const typed = {};
  for (const el of app.querySelectorAll("input[id]")) typed[el.id] = el.value;
  app.innerHTML = (state.cfg && state.view !== "settings" ? header() : "") + body;
  for (const [id, value] of Object.entries(typed)) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }
  tick();
}

function tick() {
  const m = state.meter;
  const shop = state.cache.shop;
  if (state.view !== "meter" || !m || !document.getElementById("m-fare")) return;
  const now = Date.now();
  const secs = runningSeconds(m.started, now, m.pauses);
  const pad = (n) => String(n).padStart(2, "0");
  document.getElementById("m-clock").textContent =
    `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
  document.getElementById("m-fare").innerHTML =
    amount(fare(m.started, now, m.pauses, rideConfig(shop)));
  document.getElementById("m-late").hidden = !isLate(now, rideConfig(shop).late);
  document.getElementById("m-pause").hidden = m.pauses.at(-1)?.[1] !== null;
}
setInterval(tick, 1000);

// ── 操作 ──────────────────────────────────────────────

function startMeter(orderId) {
  if (!state.cache.shop?.ride) {
    state.error = "運賃の設定を読めていません。つながってからやり直してください";
    render();
    return;
  }
  state.meter = { orderId, started: Date.now(), pauses: [] };
  saveMeter();
  state.view = "meter";
  render();
}

const actions = {
  "save-cfg": () => {
    const repo = document.getElementById("repo").value.trim();
    const token = document.getElementById("token").value.trim() || state.cfg?.token || "";
    if (!repo || !token) return;
    state.cfg = { repo, token };
    save(KEYS.cfg, state.cfg);
    state.error = "";
    state.view = state.meter ? "meter" : "list";
    render();
    sync();
  },
  settings: () => { state.view = "settings"; render(); },
  reload: () => location.reload(),
  back: () => { state.view = "list"; render(); },
  "adjust-minus": () => { state.adjustDir = "minus"; state.view = "adjust"; render(); },
  "adjust-plus": () => { state.adjustDir = "plus"; state.view = "adjust"; render(); },
  void: (el) => { state.target = el.dataset.id; state.view = "void"; render(); },
  "adjust-ok": () => {
    const reason = document.getElementById("adj-reason").value.trim();
    const signedN = adjustAmount(document.getElementById("adj-amount").value, reason, state.adjustDir);
    if (signedN === null) {
      document.getElementById("form-error").textContent = "金額(1以上の整数)と理由を入れてください";
      return;
    }
    state.view = "list";
    add([newEntry("adjust", signedN, { reason })]);
  },
  "void-ok": () => {
    const e = ledger().entries.find((x) => x.id === state.target);
    const reason = document.getElementById("void-reason").value.trim();
    if (!e || !reason) {
      document.getElementById("form-error").textContent = "理由を入れてください";
      return;
    }
    state.view = "list";
    add([newEntry("void", -e.amount, { ref: e.id, reason })]);
  },
  done: (el) => confirm("この注文を完了にしますか?") && add([newEntry("order_done", 0, { ref: el.dataset.id })]),
  cancel: (el) => {
    const o = orderOf(el.dataset.id);
    if (!o || !confirm("この注文を取り消しますか?")) return;
    add([newEntry("order_cancel", -o.amount, { ref: o.id })]);
  },
  "start-order": (el) => startMeter(el.dataset.id),
  "start-free": () => startMeter(null),
  pause: () => {
    const last = state.meter.pauses.at(-1);
    if (last && last[1] === null) last[1] = Date.now();
    else state.meter.pauses.push([Date.now(), null]);
    saveMeter();
    render();
  },
  finish: () => { state.endedAt = Date.now(); state.view = "finish"; render(); },
  "finish-back": () => { state.endedAt = null; state.view = "meter"; render(); },
  "finish-ok": () => {
    const m = state.meter;
    const end = state.endedAt;
    const order = m.orderId ? orderOf(m.orderId) : null;
    if (m.orderId && !order) return;
    const rows = rideEntries({
      fare: fare(m.started, end, m.pauses, rideConfig(state.cache.shop)), order,
      started: localIso(new Date(m.started)), ended: localIso(new Date(end)),
      pausedSec: pausedSeconds(end, m.pauses),
    });
    state.meter = null;
    state.endedAt = null;
    saveMeter();
    state.view = "list";
    add(rows);
  },
};

app.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sync();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
sync();
