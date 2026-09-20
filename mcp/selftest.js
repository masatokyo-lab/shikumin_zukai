#!/usr/bin/env node
// 自己診断。2 部構成:
//   A. MCP ハンドシェイクから jev_review / jev_feed までを実際に往復させる
//   B. interpret() の判定ロジックを作った回答で直接検査する（極性・群判定・欠損・s7）
// APIキーが無くても stub モードで通る。ai パッケージも不要。`npm run check` で実行。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { DEFAULT_RUBRIC, interpret, fixList, loadRubric } from "./rubric.js";

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

// ── B. 判定ロジック ────────────────────────────────────────────────────────
console.log("判定ロジック（interpret）");

const R = DEFAULT_RUBRIC;
const QKEYS = R.questions.map((q) => q.key);

// 全問「欠陥なし」+ s7 満点。上書きで個別のケースを作る。
function answers(overrides = {}, { omit = [] } = {}) {
  const a = {};
  for (const k of QKEYS) {
    if (omit.includes(k)) continue;
    a[k] = { type: "boolean", probability: 0.05 };
  }
  // s7 は 0 起点なので満点は 水準数-1。
  if (!omit.includes(R.scored.key)) a[R.scored.key] = { type: "score", score: R.levels.length - 1 };
  for (const [k, v] of Object.entries(overrides)) {
    a[k] = typeof v === "number" ? { type: "boolean", probability: v } : v;
  }
  return a;
}
const run = (overrides, opts) => interpret(answers(overrides, opts), R);

// 極性: 欠陥質問であること、公開可否がどこにも無いこと
check("極性は defect", R.polarity === "defect");
const allKeys = [...QKEYS, ...R.groups.map((g) => g.key), R.scored.key].join(" ");
check("公開可否（shippable）が存在しない", !/shippable|公開可否/.test(allKeys + JSON.stringify(R)));

const clean = run({});
check("欠陥ゼロなら ship", clean.verdict === "ship", clean.verdict);
check("欠陥ゼロなら clean_ratio = 1", clean.clean_ratio === 1, String(clean.clean_ratio));

// 極性の向き: probability が高い = 欠陥あり
const oneDefect = run({ legibility: 0.9 });
check("probability 0.9 は欠陥と解釈される", oneDefect.defects.includes("legibility"));
check("欠陥1件（群FAILなし）は revise", oneDefect.verdict === "revise", oneDefect.verdict);

// 非 critical の閾値は 0.70
check("非critical 0.69 は欠陥ではない", run({ legibility: 0.69 }).defects.length === 0);
check("非critical 0.70 は欠陥", run({ legibility: 0.7 }).defects.includes("legibility"));

// critical の閾値は 0.50、かつ単独で群FAIL
const crit = run({ structure: 0.5 });
check("critical 0.50 は欠陥", crit.defects.includes("structure"));
check("critical 単独で群FAIL → block", crit.verdict === "block" && crit.failed_groups.includes("g3_text_figure_alignment"), `${crit.verdict} ${crit.failed_groups}`);
check("critical 0.49 は欠陥ではない", run({ structure: 0.49 }).defects.length === 0);

// group_fail_at = 2
const twoInGroup = run({ labels: 0.9, legibility: 0.9 });
check("同一群2件で群FAIL → block", twoInGroup.verdict === "block" && twoInGroup.failed_groups.includes("g2_figure_labeling"), `${twoInGroup.verdict} ${twoInGroup.failed_groups}`);
const twoAcrossGroups = run({ legibility: 0.9, density: 0.9 });
check("別群1件ずつでは群FAILしない → revise", twoAcrossGroups.verdict === "revise" && twoAcrossGroups.failed_groups.length === 0, `${twoAcrossGroups.verdict} ${twoAcrossGroups.failed_groups}`);

// 欠損。無視すると群の欠陥数が実際より少なく数えられ、静かにゲートが緩む。
const missing = run({}, { omit: ["density"] });
check("回答欠損で verdict は unknown", missing.verdict === "unknown", missing.verdict);
check("欠損は ship にならない", missing.verdict !== "ship");
check("missing_answers に欠損キーが入る", missing.missing_answers.includes("density"), String(missing.missing_answers));
const outOfRange = run({ density: { type: "boolean", probability: 1.5 } });
check("範囲外の probability は欠損扱い", outOfRange.missing_answers.includes("density") && outOfRange.verdict === "unknown");
const notANumber = run({ density: { type: "boolean" } });
check("probability 欠落は欠損扱い", notANumber.missing_answers.includes("density"));

// s7 は verdict に算入しない（禁止事項 #3）
const lowS7 = run({ [R.scored.key]: { type: "score", score: 0 } });
check("s7 が低くても verdict は変わらない", lowS7.verdict === "ship", lowS7.verdict);
check("s7 は defects に入らない", !lowS7.defects.includes(R.scored.key));
check("s7 は人間確認必須", lowS7.human_review.required === true);
check("s7 の閾値未達が出る", lowS7.human_review.meets_threshold === false, JSON.stringify(lowS7.human_review));
check("s7 満点は閾値到達", clean.human_review.meets_threshold === true, JSON.stringify(clean.human_review));
const noS7 = run({}, { omit: [R.scored.key] });
check("s7 欠損は level null（verdict は巻き込まない）", noS7.human_review.level === null && noS7.verdict === "ship");

// score は 0 起点の小数位置 [0, 水準数-1]（EvaluationModelV4 契約）。
const s7 = (score) => run({ [R.scored.key]: { type: "score", score } }).human_review;
check("score 0 は水準1", s7(0).level === 1, JSON.stringify(s7(0)));
check("score 4 は水準5（5段階の上限）", s7(4).level === 5, String(s7(4).level));
check("score は小数のまま保持される", s7(2.6).level === 3.6, String(s7(2.6).level));
check("水準3.6 は閾値4に届かない", s7(2.6).meets_threshold === false);
check("水準4.0 は閾値4に届く", s7(3).meets_threshold === true, String(s7(3).level));
check("水準の説明文が付く", typeof s7(4).level_description === "string" && s7(4).level_description.includes("水準5"));
check("範囲外の score（5段階で 5）は読まない", s7(5).level === null, JSON.stringify(s7(5)));
check("負の score は読まない", s7(-1).level === null);
check("score の生値は0起点で残る", s7(2.6).raw === 2.6, String(s7(2.6).raw));

// 構造上 FAIL しえない群を隠さない
check("FAILしえない群が露出する", clean.unreachable_groups.includes("g1_traceability"), String(clean.unreachable_groups));

// 較正されていないことを毎回言う
check("calibrated は false", clean.calibrated === false);

// fixList
const fixes = fixList(twoInGroup, R);
check("fixList が欠陥項目を返す", fixes.length === 2, String(fixes.length));
check("群FAIL中の項目は blocking", fixes.every((f) => f.blocking === true));
check("群FAILしていない欠陥は blocking でない", fixList(oneDefect, R).every((f) => f.blocking === false));
check("grounded に「出典を確認せよ」の注記がある", Boolean(R.questions.find((q) => q.key === "grounded")?.means));

// v0.1 極性のルーブリック誤流用を止める
const badRubricDir = mkdtempSync(resolve(tmpdir(), "zukai-badrubric-"));
writeFileSync(resolve(badRubricDir, "jev.rubric.json"), JSON.stringify({ polarity: "quality" }), "utf8");
let rejected = false;
try {
  loadRubric(badRubricDir);
} catch {
  rejected = true;
}
check("polarity が defect でないルーブリックは拒否される", rejected);

// ── A. MCP 往復 ────────────────────────────────────────────────────────────
const client = new Client({ name: "zukai-selftest", version: "0.2.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, ZUKAI_REPO_ROOT: sandbox },
  })
);

console.log(`\nMCP 往復 (sandbox: ${sandbox})`);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check("tools/list は 5 件", tools.length === 5, tools.join(", "));
for (const t of ["jev_ping", "jev_review", "jev_decide", "jev_feed", "jev_status"]) {
  check(`tool present: ${t}`, tools.includes(t));
}
check("jev_gate は廃止されている", !tools.includes("jev_gate"));

const ping = parse(await client.callTool({ name: "jev_ping", arguments: {} }));
check("ping がモードを返す", ping.mode === "live" || ping.mode === "stub", ping.mode);
check("ping が極性を返す", ping.rubric.polarity === "defect");
check("ping が3閾値を返す", ping.rubric.thresholds.probability_threshold === 0.7 && ping.rubric.thresholds.critical_probability_threshold === 0.5 && ping.rubric.thresholds.group_fail_at === 2);
check("ping が鍵の env 名を返す", ping.key_env === "AI_GATEWAY_API_KEY");
check("ping が5群を返す", ping.rubric.groups.length === 5, String(ping.rubric.groups.length));
check("ping が較正前だと警告する", ping.warnings.some((w) => w.includes("較正")));
check("ping が FAILしえない群を警告する", ping.warnings.some((w) => w.includes("g1_traceability")));

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
check("review が verdict を返す", ["ship", "revise", "block", "unknown"].includes(review.verdict), review.verdict);
check("review が8項目すべてを検査する", review.items.length === 8, String(review.items.length));
check("review が全項目に probability を持つ", review.items.every((i) => typeof i.probability === "number" && i.probability >= 0 && i.probability <= 1));
check("review が5群を返す", review.groups.length === 5);
check("review が iteration 1 を付ける", review.iteration === 1);
check("review の fixes が欠陥数と一致する", review.fixes.length === review.items.filter((i) => i.defect === true).length);
check("review が人間確認枠を返す", review.human_review.required === true);
check("review に公開可否が無い", !JSON.stringify(review).includes("shippable"));
check("review が較正前だと警告する", review.warnings.some((w) => w.includes("較正")));

const review2 = parse(
  await client.callTool({
    name: "jev_review",
    arguments: { task: "同上", artifact_path: "sample.html", note: "2回目" },
  })
);
check("2回目で iteration が増える", review2.iteration === 2, String(review2.iteration));
check("2回目は同じ run を共有する", review2.run_id === review.run_id);

const feed = parse(await client.callTool({ name: "jev_feed", arguments: { since_seq: 0 } }));
check("feed が全件返す", feed.records.length === 2, String(feed.records.length));
check("feed がカーソルを進める", feed.next_since_seq === 2, String(feed.next_since_seq));
check("feed のレコードに群が入る", Array.isArray(feed.records[0].groups));
const tail = parse(await client.callTool({ name: "jev_feed", arguments: { since_seq: 1 } }));
check("feed が since_seq を尊重する", tail.records.length === 1);

const status = parse(await client.callTool({ name: "jev_status", arguments: {} }));
check("status が評価数を数える", status.total_evaluations === 2, String(status.total_evaluations));
check("status がラン後に idle に戻る", status.state.status === "idle", status.state.status);

const decide = parse(
  await client.callTool({
    name: "jev_decide",
    arguments: {
      state: "テスト",
      questions: { some_defect: { type: "boolean", instructions: "欠陥があるか" } },
    },
  })
);
check("decide が boolean を probability で返す", typeof decide.answers.some_defect.probability === "number");

const traversal = await client.callTool({
  name: "jev_review",
  arguments: { task: "x", artifact_path: "../../../etc/passwd" },
});
check("リポジトリ外のパスは拒否される", traversal.isError === true);

await client.close();

console.log(fails.length ? `\n${fails.length} failed: ${fails.join(", ")}` : `\nall ok — ${"mode="}${ping.mode}`);
process.exit(fails.length ? 1 : 0);
