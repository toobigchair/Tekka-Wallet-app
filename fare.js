// 運賃の計算。時刻はミリ秒。pauses は [開始, 終了|null] の配列。
const minutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function isLate(ms, late) {
  const d = new Date(ms);
  const now = d.getHours() * 60 + d.getMinutes();
  const from = minutes(late.from);
  const to = minutes(late.to);
  return from > to ? now >= from || now < to : now >= from && now < to;
}

function activeSpans(start, end, pauses) {
  const spans = [];
  let from = start;
  for (const [p, q] of [...pauses].sort((a, b) => a[0] - b[0])) {
    if (p > from) spans.push([from, Math.min(p, end)]);
    from = q === null ? end : Math.max(from, q);
  }
  if (from < end) spans.push([from, end]);
  return spans;
}

// 走行時間 sec の時点の実際の時刻
function realTimeAt(spans, sec) {
  let left = sec * 1000;
  for (const [a, b] of spans) {
    if (left <= b - a) return a + left;
    left -= b - a;
  }
  return spans.at(-1)[1];
}

// 一時停止を除いた走行秒数(切り捨て)
export function runningSeconds(start, end, pauses) {
  const spans = activeSpans(start, end, pauses);
  return Math.floor(spans.reduce((n, [a, b]) => n + (b - a), 0) / 1000);
}

export function fare(start, end, pauses, cfg) {
  const spans = activeSpans(start, end, pauses);
  const total = runningSeconds(start, end, pauses);
  let amount = isLate(start, cfg.late) ? cfg.late.base : cfg.normal.base;
  let t = cfg.base_sec;
  while (total > t) {
    const band = isLate(realTimeAt(spans, t), cfg.late) ? cfg.late : cfg.normal;
    amount += band.step;
    t += band.step_sec;
  }
  return amount;
}

export function pausedSeconds(end, pauses) {
  return Math.floor(pauses.reduce((n, [p, q]) => n + ((q ?? end) - p), 0) / 1000);
}

// 設計書 3.2 の既定値。shop.json が無いときに使う
export const DEFAULT_RIDE = {
  base_sec: 1800,
  normal: { base: 300, step_sec: 60, step: 10 },
  late: { from: "22:00", to: "05:00", base: 360, step_sec: 50, step: 10 },
};

export const rideConfig = (shop) => shop?.ride ?? DEFAULT_RIDE;
