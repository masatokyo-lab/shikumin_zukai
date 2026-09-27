// GET /api/calibrate?token=... — samples.json を Jev に通して較正報告を出す（HANDOFF 7章）。
//
// 中身は mcp/calibrate-core.js。CLI（npm run calibrate）と同じ判定で集計する。
// 画面の「回答 JSON」を Claude に貼り戻せば、Jev を呼び直さずに閾値の検討をやり直せる
// （npm run calibrate -- --from <file>）。
//
// probe と違い、サンプル件数ぶん Jev を呼ぶ。PROBE_TOKEN が未設定なら実行しない。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSamples,
  validateSamples,
  evaluateSamples,
  compactEvaluations,
  buildReport,
  summaryLines,
} from "../mcp/calibrate-core.js";
import { MODE } from "../mcp/jev.js";

export const config = { maxDuration: 60 };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page({ title, badge, lines, warnings = [], errors = [], compact = null }) {
  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jev 較正</title>
<style>
  :root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e2e2e2;--ok:#0a7a3d;--ng:#b3261e;--code:#f6f6f6;--accent:#1a56db}
  @media (prefers-color-scheme: dark){:root:not([data-theme=light]){--bg:#121212;--fg:#ececec;--muted:#9a9a9a;--line:#2e2e2e;--ok:#4ade80;--ng:#ff6b6b;--code:#1c1c1c;--accent:#7aa2f7}}
  :root[data-theme=dark]{--bg:#121212;--fg:#ececec;--muted:#9a9a9a;--line:#2e2e2e;--ok:#4ade80;--ng:#ff6b6b;--code:#1c1c1c;--accent:#7aa2f7}
  *{box-sizing:border-box}
  body{margin:0;padding:16px;background:var(--bg);color:var(--fg);
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
  main{max-width:720px;margin:0 auto}
  h1{font-size:18px;margin:0 0 12px}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:700;font-size:13px;color:#fff;background:var(--ng)}
  .badge.ok{background:var(--ok)}
  .warn{border-left:3px solid #d08700;padding:8px 12px;margin:8px 0;background:var(--code);font-size:13px}
  .err{border-left:3px solid var(--ng);padding:8px 12px;margin:8px 0;background:var(--code);font-size:13px}
  pre{background:var(--code);padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  textarea{width:100%;height:160px;font:12px/1.4 ui-monospace,Menlo,monospace;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--code);color:var(--fg)}
  button{display:block;width:100%;margin:8px 0 24px;padding:14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:700;font-size:15px}
  h2{font-size:15px;margin:20px 0 6px}
  .sub{color:var(--muted);font-size:13px}
</style></head><body><main>
<h1>Jev 較正 <span class="badge ${badge === "OK" ? "ok" : ""}">${esc(badge)}</span></h1>
<p class="sub">${esc(title)}</p>
${errors.map((e) => `<div class="err">${esc(e)}</div>`).join("")}
${
  compact
    ? `<h2>回答 JSON（Claude に貼り戻す）</h2>
<p class="sub">これがあれば Jev を呼び直さずに閾値を検討し直せます。ボタンでコピーしてチャットに貼ってください。</p>
<textarea id="j" readonly>${esc(JSON.stringify(compact))}</textarea>
<button id="c" type="button">回答 JSON をコピー</button>`
    : ""
}
${lines.length ? `<h2>集計</h2><pre>${esc(lines.join("\n"))}</pre>` : ""}
${warnings.length ? `<h2>サンプルの警告</h2>${warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}` : ""}
<p class="sub">閾値の採用は自動では行いません。採用するかは人間が決めます。</p>
<script>
  const c=document.getElementById("c"), j=document.getElementById("j");
  if(c) c.addEventListener("click", async()=>{
    try{ await navigator.clipboard.writeText(j.value); c.textContent="コピーしました"; }
    catch{ j.focus(); j.select(); c.textContent="選択しました。長押しでコピーしてください"; }
  });
</script>
</main></body></html>`;
}

function send(res, status, { json, html }, wantsJson) {
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  if (wantsJson) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(json, null, 2));
  } else {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const wantsJson = url.searchParams.get("format") === "json";
  const expected = process.env.PROBE_TOKEN || "";

  if (!expected) {
    const msg = "PROBE_TOKEN が未設定のため実行しません（較正はサンプル件数ぶん Jev を呼ぶ）。Vercel の環境変数に設定して再デプロイしてください。";
    return send(res, 403, { json: { ok: false, reason: "token_not_configured", hint: msg }, html: page({ title: msg, badge: "STOP", lines: [] }) }, wantsJson);
  }
  if (url.searchParams.get("token") !== expected) {
    return send(res, 401, { json: { ok: false, reason: "unauthorized" }, html: page({ title: "?token= が違います。", badge: "STOP", lines: [] }) }, wantsJson);
  }
  if (MODE !== "live") {
    const msg = "AI_GATEWAY_API_KEY が無いため stub です。stub の回答はダミーなので較正に使えません。";
    return send(res, 503, { json: { ok: false, reason: "not_live", hint: msg }, html: page({ title: msg, badge: "STOP", lines: [] }) }, wantsJson);
  }

  let samples, check;
  try {
    samples = loadSamples(REPO_ROOT);
    check = validateSamples(samples, REPO_ROOT);
  } catch (e) {
    return send(res, 500, { json: { ok: false, reason: "samples_unreadable", error: e.message }, html: page({ title: e.message, badge: "FAIL", lines: [] }) }, wantsJson);
  }
  // 形式エラーがあるまま Jev を呼ぶと、課金してから捨てることになる。先に止める。
  if (check.errors.length) {
    return send(
      res,
      400,
      {
        json: { ok: false, reason: "invalid_samples", errors: check.errors, warnings: check.warnings },
        html: page({ title: "samples.json に形式エラーがあるため Jev を呼んでいません。", badge: "FAIL", lines: [], errors: check.errors, warnings: check.warnings }),
      },
      wantsJson
    );
  }

  const evaluations = await evaluateSamples(samples, { repoRoot: REPO_ROOT });
  const compact = compactEvaluations(evaluations);
  const report = buildReport(samples, evaluations, { repoRoot: REPO_ROOT });
  const failedCalls = evaluations.filter((e) => e.error).length;
  const ok = failedCalls === 0;
  return send(
    res,
    ok ? 200 : 502,
    {
      json: { ok, warnings: check.warnings, evaluations: compact, report },
      html: page({
        title: `${samples.length}件を評価${failedCalls ? `（うち ${failedCalls}件は呼び出し失敗）` : ""}`,
        badge: ok ? "OK" : "一部失敗",
        lines: summaryLines(report),
        warnings: check.warnings,
        errors: evaluations.filter((e) => e.error).map((e) => `${e.id}: ${e.error}`),
        compact,
      }),
    },
    wantsJson
  );
}
