#!/usr/bin/env node
// MCP ハンドシェイクから jev_review / jev_feed までを実際に往復させる自己診断。
// APIキーが無くても stub モードで通る。`npm run check` で実行。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "server.js");
const sandbox = mkdtempSync(resolve(tmpdir(), "zukai-selftest-"));

const SAMPLE = `<!doctype html><html lang="ja"><head><title>受注から出荷までの仕組み</title></head>
<body><h1>受注から出荷まで</h1>
<p>営業が受注入力 → 在庫引当 → 倉庫がピッキング → 出荷検品 → 配送業者へ引き渡し</p></body></html>`;
writeFileSync(resolve(sandbox, "sample.html"), SAMPLE, "utf8");

const fails = [];
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    fails.push(name);
  }
};
const parse = (res) => JSON.parse(res.content[0].text);

const client = new Client({ name: "zukai-selftest", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, ZUKAI_REPO_ROOT: sandbox },
  })
);

console.log(`zukai-jev selftest (sandbox: ${sandbox})`);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check("tools/list", tools.length === 6, tools.join(", "));
for (const t of ["jev_ping", "jev_review", "jev_gate", "jev_decide", "jev_feed", "jev_status"]) {
  check(`tool present: ${t}`, tools.includes(t));
}

const ping = parse(await client.callTool({ name: "jev_ping", arguments: {} }));
check("ping reports mode", ping.mode === "live" || ping.mode === "stub", ping.mode);
check("ping lists rubric dimensions", ping.rubric.dimensions.length === 7);

const review = parse(
  await client.callTool({
    name: "jev_review",
    arguments: {
      task: "受注から出荷までの社内オペレーションを1枚で説明する図解",
      artifact_path: "sample.html",
      source_material: "営業が受注を入力し、在庫を引き当てたうえで倉庫がピッキング・検品し、配送業者へ渡す。",
      note: "初版",
    },
  })
);
check("review returns a verdict", ["ship", "revise", "block", "unknown"].includes(review.verdict), review.verdict);
check("review scores every dimension", review.dimensions.length === 7);
check("review normalises scores to 0..1", review.dimensions.every((d) => d.value >= 0 && d.value <= 1));
check("review evaluates gates", review.gates.length === 2);
check("review assigns iteration 1", review.iteration === 1);
check("review lists fixes for failures", Array.isArray(review.fixes) && review.fixes.length === review.dimensions.concat(review.gates).filter((x) => x.pass === false).length);

const review2 = parse(
  await client.callTool({
    name: "jev_review",
    arguments: { task: "同上", artifact_path: "sample.html", note: "2回目" },
  })
);
check("second review increments iteration", review2.iteration === 2, String(review2.iteration));
check("second review shares the run", review2.run_id === review.run_id);

const gate = parse(
  await client.callTool({ name: "jev_gate", arguments: { task: "同上", artifact_path: "sample.html" } })
);
check("gate returns a verdict", typeof gate.verdict === "string", gate.verdict);
check("gate skips dimensions", gate.gates.length === 2);

const feed = parse(await client.callTool({ name: "jev_feed", arguments: { since_seq: 0 } }));
check("feed returns all records", feed.records.length === 3, String(feed.records.length));
check("feed advances the cursor", feed.next_since_seq === 3, String(feed.next_since_seq));
const tail = parse(await client.callTool({ name: "jev_feed", arguments: { since_seq: 2 } }));
check("feed respects since_seq", tail.records.length === 1);

const status = parse(await client.callTool({ name: "jev_status", arguments: {} }));
check("status counts evaluations", status.total_evaluations === 3, String(status.total_evaluations));
check("status goes idle after a run", status.state.status === "idle", status.state.status);

const traversal = await client.callTool({
  name: "jev_review",
  arguments: { task: "x", artifact_path: "../../../etc/passwd" },
});
check("path traversal is refused", traversal.isError === true);

await client.close();

console.log(fails.length ? `\n${fails.length} failed: ${fails.join(", ")}` : `\nall ${"ok"} — mode=${ping.mode}`);
process.exit(fails.length ? 1 : 0);
