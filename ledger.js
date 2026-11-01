// 台帳の解析と記録の作成。shogitree/tettan/core/wallet_ledger.py と同じ規則。
const FINISHING = ["order_done", "order_cancel", "ride"];

export function parse(text) {
  const entries = [];
  const seen = new Set();
  let bad = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const e = JSON.parse(raw);
      if (typeof e.id !== "string" || !Number.isInteger(e.amount)) throw new Error();
      if (!seen.has(e.id)) {
        seen.add(e.id);
        entries.push(e);
      }
    } catch {
      bad += 1;
    }
  }
  return { entries, bad };
}

export const balance = (entries) => entries.reduce((n, e) => n + e.amount, 0);

export function openOrders(entries) {
  const closed = new Set(entries.filter((e) => FINISHING.includes(e.type)).map((e) => e.ref));
  return entries.filter((e) => e.type === "order" && !closed.has(e.id));
}

export const dumps = (e) => JSON.stringify(e);

// 末尾に改行が無い台帳にも、行をつなげずに足す
export function appendText(text, entries) {
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  return base + entries.map((e) => `${dumps(e)}\n`).join("");
}

// 未送信の同じ id は最初の1件に畳む
export function dedupe(entries) {
  const seen = new Set();
  return entries.filter((e) => !seen.has(e.id) && seen.add(e.id));
}

// 送った id だけを外す。送信中に足された記録は残る
export function dropSent(outbox, sentIds) {
  const ids = new Set(sentIds);
  return outbox.filter((e) => !ids.has(e.id));
}

// 鉄鍛の履歴は先頭10文字を日付に使うので、ローカル時刻で書く
export function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n) => String(Math.abs(Math.trunc(n))).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

export function newEntry(type, amount, fields = {}) {
  const prefix = { order_done: "done", order_cancel: "cancel" }[type] ?? type;
  return { id: `${prefix}:${crypto.randomUUID()}`, at: localIso(),
           by: "phone", type, amount, ...fields };
}

export function rideEntries({ fare, order, started, ended, pausedSec }) {
  const paid = order ? -order.amount : 0;
  const ride = newEntry("ride", paid - fare, // -(0) は -0 になるので引き算の向きで書く

                        { fare, started, ended, paused_sec: pausedSec,
                          ...(order ? { ref: order.id } : {}) });
  return order ? [ride, newEntry("order_done", 0, { ref: order.id })] : [ride];
}

// 打ち消せる行か。注文まわりと打ち消し自体、既に打ち消された行は不可
const NOT_VOIDABLE = ["order", "order_cancel", "order_done", "void"];
export function canVoid(entry, entries) {
  if (NOT_VOIDABLE.includes(entry.type)) return false;
  return !entries.some((e) => e.type === "void" && e.ref === entry.id);
}

// 臨時調整の入力検証。dir は "minus"(引く)か "plus"(増やす)。不正なら null、正しければ符号付きの金額。
export function adjustAmount(raw, reason, dir) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || !String(reason ?? "").trim()) return null;
  return dir === "plus" ? n : -n;
}
