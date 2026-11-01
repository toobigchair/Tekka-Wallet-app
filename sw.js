const NAME = "wallet-v1";
const FILES = ["./", "index.html", "app.js", "store.js", "ledger.js", "fare.js",
               "style.css", "coin.svg", "manifest.webmanifest"];
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(NAME).then((c) => c.addAll(FILES)));
});
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== NAME).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())));
// 自分のオリジンの GET はネットワーク優先。成功したらキャッシュを更新し、失敗したらキャッシュから返す
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(NAME).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit ?? Promise.reject(new Error("offline")))));
});
