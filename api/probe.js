// GET /api/probe — ブラウザから probe を 1 回走らせる。
//
// 目的は「この実行環境から Jev に届くか」を出先の端末から確かめること。
// 検査の中身は CLI（npm run probe）と同じ mcp/probe-core.js を呼ぶ。片方だけ通る状態を作らない。
//
// 認証: PROBE_TOKEN を設定した場合のみ ?token= を要求する。
// 未設定でも動くが、その URL を知っている全員が Jev を 1 往復ぶん課金できる状態になる。
// 疎通が取れたら PROBE_TOKEN を入れること（レスポンスにも警告を出している）。

import { runProbe } from "../mcp/probe-core.js";

export const config = { maxDuration: 30 };

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page({ result, unprotected }) {
  const badge = result.ok ? "ok" : "fail";
  const headline = result.ok
    ? "疎通した。返り値の形も契約どおり"
    : { not_live: "鍵が無い（stub のまま）", call_failed: "Jev に届かなかった", shape_mismatch: "届いたが返り値の形が違う" }[
        result.reason
      ] || "失敗";
  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jev probe</title>
<style>
  :root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e2e2e2;--ok:#0a7a3d;--ng:#b3261e;--code:#f6f6f6}
  @media (prefers-color-scheme: dark){:root:not([data-theme=light]){--bg:#121212;--fg:#ececec;--muted:#9a9a9a;--line:#2e2e2e;--ok:#4ade80;--ng:#ff6b6b;--code:#1c1c1c}}
  :root[data-theme=dark]{--bg:#121212;--fg:#ececec;--muted:#9a9a9a;--line:#2e2e2e;--ok:#4ade80;--ng:#ff6b6b;--code:#1c1c1c}
  *{box-sizing:border-box}
  body{margin:0;padding:16px;background:var(--bg);color:var(--fg);
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
  main{max-width:720px;margin:0 auto}
  h1{font-size:18px;margin:0 0 4px}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:700;font-size:13px;
         color:#fff;background:var(--ng)}
  .badge.ok{background:var(--ok)}
  .sub{color:var(--muted);font-size:13px;margin:0 0 16px}
  .warn{border-left:3px solid #d08700;padding:8px 12px;margin:12px 0;background:var(--code);font-size:13px}
  ul.checks{list-style:none;padding:0;margin:12px 0}
  ul.checks li{padding:6px 0;border-bottom:1px solid var(--line);font-size:14px}
  ul.checks li b{font-weight:700}
  .y{color:var(--ok)} .n{color:var(--ng)}
  pre{background:var(--code);padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.5;
      white-space:pre-wrap;word-break:break-word}
  a{color:inherit}
</style></head><body><main>
<h1>Jev probe <span class="badge ${badge}">${badge.toUpperCase()}</span></h1>
<p class="sub">${esc(headline)}${result.latency_ms ? ` · ${result.latency_ms}ms` : ""}</p>
${unprotected ? `<div class="warn">PROBE_TOKEN が未設定です。この URL を知っている人は誰でも Jev を呼べます（1回ぶん課金されます）。疎通を確認したら Vercel の環境変数に PROBE_TOKEN を足してください。</div>` : ""}
${result.hint ? `<div class="warn">${esc(result.hint)}</div>` : ""}
${
  result.checks.length
    ? `<ul class="checks">${result.checks
        .map(
          (c) =>
            `<li><b class="${c.ok ? "y" : "n"}">${c.ok ? "ok" : "FAIL"}</b> ${esc(c.name)}</li>`
        )
        .join("")}</ul>`
    : ""
}
<pre>${esc(result.lines.join("\n"))}</pre>
<p class="sub">JSON で見る: <a href="?format=json">?format=json</a></p>
</main></body></html>`;
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const expected = process.env.PROBE_TOKEN || "";
  const wantsJson = url.searchParams.get("format") === "json";

  if (expected && url.searchParams.get("token") !== expected) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, reason: "unauthorized", hint: "?token= を付けてください。" }));
    return;
  }

  let result;
  try {
    result = await runProbe();
  } catch (e) {
    result = { ok: false, reason: "crashed", error: String(e?.message || e), lines: [String(e?.stack || e)], checks: [], fails: ["crash"] };
  }

  // 疎通確認は毎回走らせたい。中間キャッシュに残さない。
  res.setHeader("cache-control", "no-store");
  res.statusCode = result.ok ? 200 : 502;
  if (wantsJson) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(result, null, 2));
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(page({ result, unprotected: !expected }));
}
