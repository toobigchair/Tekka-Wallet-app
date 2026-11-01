// 台帳リポジトリとの通信。UTF-8 と base64 の変換に注意。
// トークンはヘッダにだけ入れる。エラーの文章・ログには入れない。
import { parse, appendText, dedupe } from "./ledger.js";

const API = "https://api.github.com";
const BRANCH = "main";
const RETRIES = 3;
const enc = new TextEncoder();
const dec = new TextDecoder();

// 大きな台帳で引数が多すぎて落ちないよう、32KB ごとに分ける
function toB64(s) {
  const bytes = enc.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
const fromB64 = (s) =>
  dec.decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

const headers = (token) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

async function send(fetchFn, url, init) {
  try {
    return await fetchFn(url, init);
  } catch {
    throw new Error("台帳に接続できません");
  }
}

// 404 は「空の台帳」にしない。トークンが無効でも 404 になるので、
// 呼び出し側は保存済みの台帳を残したままエラーを出す。
export async function getFile(cfg, name, fetchFn = fetch) {
  const res = await send(
    fetchFn, `${API}/repos/${cfg.repo.trim()}/contents/${name}?ref=${BRANCH}`,
    { headers: headers(cfg.token), cache: "no-store" });
  if (res.status === 404) {
    throw new Error("台帳が見つかりません。リポジトリとトークンを確かめてください");
  }
  if (!res.ok) throw new Error(`台帳を読めません(${res.status})`);
  let data;
  try {
    data = await res.json();
    if (data.encoding !== "base64") throw new Error("台帳が1MBを超えたため読めません");
    return { text: fromB64(data.content), sha: data.sha };
  } catch (e) {
    if (data && data.encoding !== "base64") throw e;
    throw new Error("台帳を読めません");
  }
}

// 台帳の末尾に足す。台帳にある id は書かない。書いた後の { text, sha } を返す。
export async function appendEntries(cfg, entries, fetchFn = fetch) {
  const wanted = dedupe(entries);
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const { text, sha } = await getFile(cfg, "ledger.jsonl", fetchFn);
    const have = new Set(parse(text).entries.map((e) => e.id));
    const fresh = wanted.filter((e) => !have.has(e.id));
    if (!fresh.length) return { text, sha };
    const next = appendText(text, fresh);
    const body = { message: `phone: ${fresh.length}件`, branch: BRANCH, content: toB64(next) };
    if (sha) body.sha = sha;
    const res = await send(
      fetchFn, `${API}/repos/${cfg.repo.trim()}/contents/ledger.jsonl`,
      { method: "PUT", headers: headers(cfg.token), body: JSON.stringify(body) });
    if (res.ok) {
      let newSha = null;
      try { newSha = (await res.json()).content.sha; } catch { /* 次の取得で分かる */ }
      return { text: next, sha: newSha };
    }
    if (res.status !== 409 && res.status !== 422) {
      throw new Error(`台帳に書き込めません(${res.status})`);
    }
  }
  throw new Error("台帳が混み合っています。少し待ってやり直してください");
}
