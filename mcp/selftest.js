#!/usr/bin/env node
// 自己診断。3 部構成:
//   A. ルーブリック 2 本（diagram / article）が HANDOFF 3.5 の構成どおりに読めるか
//   B. interpret() の判定ロジックを作った回答で直接検査する（極性・群判定・欠損・s7）
//   C. MCP ハンドシェイクから jev_review / jev_feed までを実際に往復させる
// APIキーが無くても stub モードで通る。ai パッケージも不要。`npm run check` で実行。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  loadRubric,
  loadAllRubrics,
  groupStructure,
  interpret,
  fixList,
  SCOPES,
  DEFAULT_SCOPE,
} from "./rubric.js";
import { evaluateEscalation, previousReview, previousFailedGroupsOf } from "./escalation.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "server.js");
const pkgRoot = resolve(here, "..");
const sandbox = mkdtempSync(resolve(tmpdir(), "zukai-selftest-"));

const SAMPLE = `<!doctype html><html lang="ja"><head><title>受注から出荷までの仕組み</title></head>
<body><h1>受注から出荷まで</h1>
<p>営業が受注入力 → 在庫引当 → 倉庫がピッキング → 出荷検品 → 配送業者へ引き渡し</p></body></html>`;
writeFileSync(resolve(sandbox, "sample.html"), SAMPLE, "utf8");

const SAMPLE_ARTICLE = `# 受注から出荷までを内製で回すか外注するか

結論: 月200件を超えるまでは内製で回した方が総コストは低い。
根拠は、外注の固定費が件数に依らず発生する一方、内製の追加工数は件数に比例するため。
ただし繁忙期の人員を確保できることが前提で、これが崩れると逆転する。`;
writeFileSync(resolve(sandbox, "sample-article.md"), SAMPLE_ARTICLE, "utf8");

const fails = [];
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    fails.push(name);
  }
};
const parse = (res) => JSON.parse(res.content[0].text);

// ── A. ルーブリック 2 本 ───────────────────────────────────────────────────
console.log("ルーブリック（HANDOFF 3.1 / 3.5）");

check("scope は diagram と article の2つ", JSON.stringify(SCOPES) === '["diagram","article"]', String(SCOPES));
check("既定の scope は diagram", DEFAULT_SCOPE === "diagram");

const R = loadRubric(pkgRoot, "diagram");
const RA = loadRubric(pkgRoot, "article");
const all = loadAllRubrics(pkgRoot);
check("loadAllRubrics が2本返す", all.length === 2, String(all.length));

// HANDOFF 3.1: 共通版は作らない。図が無いと g2 / g3 は空振りする。
check("diagram は 22 問（HANDOFF 3.5 の内訳の合計）", R.questions.length === 22, String(R.questions.length));
check("article は 18 問", RA.questions.length === 18, String(RA.questions.length));
check("diagram の群は g1/g2/g3/g4/g5", JSON.stringify(R.groups.map((g) => g.key)) === '["g1_traceability","g2_figure_labeling","g3_text_figure_alignment","g4_granularity_flow","g5_epistemic"]', String(R.groups.map((g) => g.key)));
check("article の群は g1/g4/g5/g6", JSON.stringify(RA.groups.map((g) => g.key)) === '["g1_traceability","g4_granularity_flow","g5_epistemic","g6_article_structure"]', String(RA.groups.map((g) => g.key)));
check("article に g2（軸・単位）は無い", !RA.groups.some((g) => g.key === "g2_figure_labeling"));
check("article に g3（本文と図の整合）は無い", !RA.groups.some((g) => g.key === "g3_text_figure_alignment"));
check("diagram に g6（記事構成）は無い", !R.groups.some((g) => g.key === "g6_article_structure"));

const sizeOf = (rubric, key) => rubric.questions.filter((q) => q.group === key).length;
check("g1 は4問（両方）", sizeOf(R, "g1_traceability") === 4 && sizeOf(RA, "g1_traceability") === 4);
check("g2 は6問", sizeOf(R, "g2_figure_labeling") === 6, String(sizeOf(R, "g2_figure_labeling")));
check("g3 は5問", sizeOf(R, "g3_text_figure_alignment") === 5, String(sizeOf(R, "g3_text_figure_alignment")));
check("g4 は5問（両方）", sizeOf(R, "g4_granularity_flow") === 5 && sizeOf(RA, "g4_granularity_flow") === 5);
check("g5 は diagram 2問 / article 4問", sizeOf(R, "g5_epistemic") === 2 && sizeOf(RA, "g5_epistemic") === 4, `${sizeOf(R, "g5_epistemic")} / ${sizeOf(RA, "g5_epistemic")}`);
check("g6 は5問（article のみ）", sizeOf(RA, "g6_article_structure") === 5, String(sizeOf(RA, "g6_article_structure")));

// 3.5: g5_source_granularity_gap と g5_overstated_conclusion は article 版のみ
const hasQ = (rubric, key) => rubric.questions.some((q) => q.key === key);
check("出典粒度の不一致は article のみ", hasQ(RA, "g5_source_granularity_gap") && !hasQ(R, "g5_source_granularity_gap"));
check("結論の誇張は article のみ", hasQ(RA, "g5_overstated_conclusion") && !hasQ(R, "g5_overstated_conclusion"));

for (const rubric of all) {
  check(`${rubric.scope}: 極性は defect`, rubric.polarity === "defect");
  check(`${rubric.scope}: scored は s7_originality ひとつ`, rubric.scored.key === "s7_originality");
  check(`${rubric.scope}: s7 は人間確認必須（禁止事項 #3）`, rubric.scored.human_review_required === true);
  check(`${rubric.scope}: s7 の水準は5段階`, rubric.levels.length === 5, String(rubric.levels.length));
  check(`${rubric.scope}: 較正前として扱われる`, rubric.thresholds.calibrated === false);
  check(`${rubric.scope}: 閾値は 0.70 / 0.50 / 2`, rubric.thresholds.probability_threshold === 0.7 && rubric.thresholds.critical_probability_threshold === 0.5 && rubric.thresholds.group_fail_at === 2);
  check(`${rubric.scope}: 全問に表示名が付く`, rubric.questions.every((q) => q.label && q.label !== q.key), String(rubric.questions.filter((q) => q.label === q.key).map((q) => q.key)));
  check(`${rubric.scope}: g5 に「出典を確認せよ」の注記が付く（HANDOFF 3.4）`, rubric.questions.filter((q) => q.group === "g5_epistemic").every((q) => typeof q.means === "string"));
  check(`${rubric.scope}: 公開可否（shippable）が存在しない`, !/shippable|公開可否/.test(JSON.stringify(rubric)));

  // R1 の目的。群が構造上 FAIL しえない／全問一致が要る状態を解消するための差し替えだった。
  const st = groupStructure(rubric);
  check(`${rubric.scope}: FAIL しえない群が無い`, st.every((g) => g.reachable), String(st.filter((g) => !g.reachable).map((g) => g.key)));
  check(`${rubric.scope}: 全問一致が要る群が無い`, st.every((g) => !g.fragile), String(st.filter((g) => g.fragile).map((g) => g.key)));
}

// critical 指定（HANDOFF 8章 #3 の現状）
const criticalOf = (rubric) => rubric.questions.filter((q) => q.critical).map((q) => q.key);
check("diagram の critical は g2 3問 / g3 2問 / g5 2問", JSON.stringify(criticalOf(R)) === '["g2_no_title","g2_axis_meaning_unclear","g2_missing_unit","g3_question_mismatch","g3_missing_time_axis","g5_unmarked_speculation","g5_fabricated_specificity"]', String(criticalOf(R)));
check("article の critical は g5 3問 + g6 の結論先出し", JSON.stringify(criticalOf(RA)) === '["g5_unmarked_speculation","g5_fabricated_specificity","g5_source_granularity_gap","g6_no_conclusion_first"]', String(criticalOf(RA)));

// 壊れたルーブリックは読まない。基準が黙って入れ替わるくらいなら止める。
const badDir = mkdtempSync(resolve(tmpdir(), "zukai-badrubric-"));
const tryLoad = (dir, scope) => {
  try {
    loadRubric(dir, scope);
    return null;
  } catch (e) {
    return e.message;
  }
};
writeFileSync(resolve(badDir, "rubric-diagram.json"), JSON.stringify({ polarity: "quality", groups: {}, scored: {} }), "utf8");
check("polarity が defect でないルーブリックは拒否される", Boolean(tryLoad(badDir, "diagram")));
writeFileSync(resolve(badDir, "rubric-diagram.json"), JSON.stringify({ polarity: "defect", scope: "article", groups: {}, scored: {} }), "utf8");
check("scope が食い違うルーブリックは拒否される", Boolean(tryLoad(badDir, "diagram")));
writeFileSync(resolve(badDir, "rubric-diagram.json"), "{ broken", "utf8");
check("壊れた JSON は拒否される", Boolean(tryLoad(badDir, "diagram")));
check("未知の scope は拒否される", Boolean(tryLoad(pkgRoot, "poster")));

// 構造判定そのものの回帰テスト。実ルーブリックが健全になっても、
// unreachable / fragile を見つける能力は失わせない。
const synthetic = {
  thresholds: { group_fail_at: 2 },
  groups: [{ key: "solo" }, { key: "pair" }, { key: "pair_with_critical" }, { key: "trio" }],
  questions: [
    { key: "a", group: "solo" },
    { key: "b", group: "pair" },
    { key: "c", group: "pair" },
    { key: "d", group: "pair_with_critical", critical: true },
    { key: "e", group: "pair_with_critical" },
    { key: "f", group: "trio" },
    { key: "g", group: "trio" },
    { key: "h", group: "trio" },
  ],
};
const sstruct = Object.fromEntries(groupStructure(synthetic).map((g) => [g.key, g]));
check("1問の群は unreachable（slack < 0）", sstruct.solo.reachable === false && sstruct.solo.slack < 0, JSON.stringify(sstruct.solo));
check("2問で group_fail_at=2 の群は fragile（slack 0）", sstruct.pair.fragile === true && sstruct.pair.slack === 0, JSON.stringify(sstruct.pair));
check("critical を持つ群は fragile にしない", sstruct.pair_with_critical.fragile === false && sstruct.pair_with_critical.reachable === true);
check("余裕のある群は unreachable でも fragile でもない", sstruct.trio.reachable === true && sstruct.trio.fragile === false && sstruct.trio.slack === 1);

// ── B. 判定ロジック ────────────────────────────────────────────────────────
console.log("\n判定ロジック（interpret）");

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

const clean = run({});
check("欠陥ゼロなら ship", clean.verdict === "ship", clean.verdict);
check("欠陥ゼロなら clean_ratio = 1", clean.clean_ratio === 1, String(clean.clean_ratio));
check("interpret が scope を返す", clean.scope === "diagram", clean.scope);

// 極性の向き: probability が高い = 欠陥あり
const oneDefect = run({ g2_missing_legend: 0.9 });
check("probability 0.9 は欠陥と解釈される", oneDefect.defects.includes("g2_missing_legend"));
check("欠陥1件（群FAILなし）は revise", oneDefect.verdict === "revise", oneDefect.verdict);

// 非 critical の閾値は 0.70
check("非critical 0.69 は欠陥ではない", run({ g2_missing_legend: 0.69 }).defects.length === 0);
check("非critical 0.70 は欠陥", run({ g2_missing_legend: 0.7 }).defects.includes("g2_missing_legend"));

// critical の閾値は 0.50、かつ単独で群FAIL
const crit = run({ g3_question_mismatch: 0.5 });
check("critical 0.50 は欠陥", crit.defects.includes("g3_question_mismatch"));
check("critical 単独で群FAIL → block", crit.verdict === "block" && crit.failed_groups.includes("g3_text_figure_alignment"), `${crit.verdict} ${crit.failed_groups}`);
check("critical 0.49 は欠陥ではない", run({ g3_question_mismatch: 0.49 }).defects.length === 0);

// group_fail_at = 2
const twoInGroup = run({ g2_missing_legend: 0.9, g2_label_data_mismatch: 0.9 });
check("同一群2件で群FAIL → block", twoInGroup.verdict === "block" && twoInGroup.failed_groups.includes("g2_figure_labeling"), `${twoInGroup.verdict} ${twoInGroup.failed_groups}`);
const twoAcrossGroups = run({ g2_missing_legend: 0.9, g4_mixed_concerns: 0.9 });
check("別群1件ずつでは群FAILしない → revise", twoAcrossGroups.verdict === "revise" && twoAcrossGroups.failed_groups.length === 0, `${twoAcrossGroups.verdict} ${twoAcrossGroups.failed_groups}`);

// 差し替え前は g1 が構造上 FAIL しなかった。4問になったので落ちる。
const g1Fail = run({ g1_omitted_subject: 0.9, g1_vague_deixis: 0.9 });
check("g1 が2件で群FAILできる（差し替え前は不可能だった）", g1Fail.failed_groups.includes("g1_traceability"), String(g1Fail.failed_groups));
check("g1 は1件では群FAILしない", !run({ g1_omitted_subject: 0.9 }).failed_groups.includes("g1_traceability"));

// 欠損。無視すると群の欠陥数が実際より少なく数えられ、静かにゲートが緩む。
const missing = run({}, { omit: ["g4_mixed_concerns"] });
check("回答欠損で verdict は unknown", missing.verdict === "unknown", missing.verdict);
check("欠損は ship にならない", missing.verdict !== "ship");
check("missing_answers に欠損キーが入る", missing.missing_answers.includes("g4_mixed_concerns"), String(missing.missing_answers));
const outOfRange = run({ g4_mixed_concerns: { type: "boolean", probability: 1.5 } });
check("範囲外の probability は欠損扱い", outOfRange.missing_answers.includes("g4_mixed_concerns") && outOfRange.verdict === "unknown");
const notANumber = run({ g4_mixed_concerns: { type: "boolean" } });
check("probability 欠落は欠損扱い", notANumber.missing_answers.includes("g4_mixed_concerns"));

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
check("水準の説明文が付く", typeof s7(4).level_description === "string" && s7(4).level_description.length > 0);
check("範囲外の score（5段階で 5）は読まない", s7(5).level === null, JSON.stringify(s7(5)));
check("負の score は読まない", s7(-1).level === null);
check("score の生値は0起点で残る", s7(2.6).raw === 2.6, String(s7(2.6).raw));

// R4: overall は廃止。clean_ratio だけを出す。
check("interpret は overall を返さない", !("overall" in clean), JSON.stringify(Object.keys(clean)));
check("clean_ratio は残っている", typeof clean.clean_ratio === "number");

// R3: 露出用の配列は残す（実ルーブリックでは空になる）
check("unreachable_groups は空", clean.unreachable_groups.length === 0, String(clean.unreachable_groups));
check("fragile_groups は空", clean.fragile_groups.length === 0, String(clean.fragile_groups));

// article 側でも同じ判定が効くこと
const articleAnswers = {};
for (const q of RA.questions) articleAnswers[q.key] = { type: "boolean", probability: 0.05 };
articleAnswers[RA.scored.key] = { type: "score", score: 4 };
const articleClean = interpret(articleAnswers, RA);
check("article も欠陥ゼロなら ship", articleClean.verdict === "ship", articleClean.verdict);
check("article の interpret は 18 項目を返す", articleClean.items.length === 18, String(articleClean.items.length));
const articleCrit = interpret({ ...articleAnswers, g6_no_conclusion_first: { type: "boolean", probability: 0.6 } }, RA);
check("article の結論先出し欠如は単独で群FAIL", articleCrit.verdict === "block" && articleCrit.failed_groups.includes("g6_article_structure"), `${articleCrit.verdict} ${articleCrit.failed_groups}`);

// R2: エスカレーション。比較は群単位。
const esc = (p) => evaluateEscalation({ maxRetries: 3, ...p }).escalate;
check("前周が無ければ何も出さない", esc({ iteration: 1, verdict: "block", failedGroups: ["g3"], previousFailedGroups: null }).length === 0);
check("stagnation: 同じ群で2周", esc({ iteration: 2, verdict: "block", failedGroups: ["g3"], previousFailedGroups: ["g3"] }).includes("stagnation"));
check("stagnation: 順序が違っても同一集合", esc({ iteration: 2, verdict: "block", failedGroups: ["g4", "g3"], previousFailedGroups: ["g3", "g4"] }).includes("stagnation"));
check("oscillation: 前回に無い群が出現", esc({ iteration: 2, verdict: "block", failedGroups: ["g4"], previousFailedGroups: ["g3"] }).includes("oscillation"));
check("oscillation: 総数が減っても発火", esc({ iteration: 2, verdict: "block", failedGroups: ["g4"], previousFailedGroups: ["g3", "g5"] }).includes("oscillation"));
check("群が減っただけでは oscillation しない", !esc({ iteration: 2, verdict: "block", failedGroups: ["g3"], previousFailedGroups: ["g3", "g5"] }).includes("oscillation"));
check("retry_limit: 3周目で発火", esc({ iteration: 3, verdict: "block", failedGroups: ["g3"], previousFailedGroups: ["g9"] }).includes("retry_limit"));
check("retry_limit: 2周目では出ない", !esc({ iteration: 2, verdict: "block", failedGroups: ["g3"], previousFailedGroups: ["g9"] }).includes("retry_limit"));
check("ship した周はエスカレーションしない", esc({ iteration: 5, verdict: "ship", failedGroups: [], previousFailedGroups: [] }).length === 0);
check("通った周（FAIL群が空）で stagnation を出さない", !esc({ iteration: 2, verdict: "revise", failedGroups: [], previousFailedGroups: [] }).includes("stagnation"));
check("unknown でも retry_limit は効く", esc({ iteration: 3, verdict: "unknown", failedGroups: [], previousFailedGroups: [] }).includes("retry_limit"));
check("理由文が付く", evaluateEscalation({ iteration: 3, verdict: "block", failedGroups: ["g3"], previousFailedGroups: ["g3"] }).reasons.every((r) => typeof r.reason === "string" && r.reason.length > 0));
check("ルーブリックの max_retries は 3", R.escalation.max_retries === 3 && RA.escalation.max_retries === 3);

// R2: 記録が古くて failed_groups を持たない場合は比較しない（[] と誤読すると oscillation が誤発火する）
check("failed_groups の無い記録は比較対象にしない", previousFailedGroupsOf({ kind: "review" }) === null);
check("failed_groups があれば拾う", JSON.stringify(previousFailedGroupsOf({ failed_groups: ["g3"] })) === '["g3"]');
check("null を渡しても比較対象にしない", previousFailedGroupsOf(null) === null);
const history = [
  { run_id: "a", kind: "review", iteration: 1, failed_groups: ["g3"] },
  { run_id: "a", kind: "review", iteration: 2, failed_groups: ["g4"] },
  { run_id: "b", kind: "review", iteration: 1, failed_groups: ["g9"] },
];
check("previousReview は同じ run の直前を返す", previousReview(history, "a", 3)?.iteration === 2);
check("previousReview は他の run を混ぜない", previousReview(history, "b", 2)?.failed_groups[0] === "g9");
check("previousReview は最初の周で null", previousReview(history, "a", 1) === null);

// 較正されていないことを毎回言う
check("calibrated は false", clean.calibrated === false);

// fixList
const fixes = fixList(twoInGroup, R);
check("fixList が欠陥項目を返す", fixes.length === 2, String(fixes.length));
check("群FAIL中の項目は blocking", fixes.every((f) => f.blocking === true));
check("群FAILしていない欠陥は blocking でない", fixList(oneDefect, R).every((f) => f.blocking === false));
check("fixList に表示名と instructions が入る", fixes.every((f) => f.label && f.instructions));
const g5Fix = fixList(run({ g5_fabricated_specificity: 0.9 }), R);
check("g5 の修正指示に「出典を確認せよ」が付く", g5Fix[0]?.means?.includes("出典を確認せよ"), JSON.stringify(g5Fix[0]));

// ── C. MCP 往復 ────────────────────────────────────────────────────────────
// C はゲートモードの仕様（修正ループとエスカレーション）を検査する。助言モードは E で切り替えて見る。
writeFileSync(resolve(sandbox, "zukai.config.json"), JSON.stringify({ mode: "gate" }), "utf8");
const client = new Client({ name: "zukai-selftest", version: "0.2.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    // 鍵が置いてあっても自己診断は stub で走らせる。ネットワークと課金に依存させない。
    env: { ...process.env, ZUKAI_REPO_ROOT: sandbox, ZUKAI_FORCE_STUB: "1" },
  })
);

console.log(`\nMCP 往復 (sandbox: ${sandbox})`);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check("tools/list は 7 件", tools.length === 7, tools.join(", "));
for (const t of ["jev_ping", "jev_review", "jev_decide", "jev_feed", "jev_status", "jev_label", "jev_record_decision"]) {
  check(`tool present: ${t}`, tools.includes(t));
}
check("jev_gate は廃止されている", !tools.includes("jev_gate"));

const ping = parse(await client.callTool({ name: "jev_ping", arguments: {} }));
check("自己診断は必ず stub で走る", ping.mode === "stub" && ping.forced_stub === true, `${ping.mode} forced=${ping.forced_stub}`);
check("ping が鍵の env 名を返す", ping.key_env === "AI_GATEWAY_API_KEY");
check("ping が review_mode と読み込み元を返す", ping.review_mode === "gate" && ping.review_mode_source === "zukai.config.json", `${ping.review_mode} ${ping.review_mode_source}`);
check("ping が移行条件の状態を返す", ping.transition?.scopes?.diagram?.streak_required === 3);
check("ping が2本のルーブリックを返す", ping.rubrics.length === 2, String(ping.rubrics.length));
const pingByScope = Object.fromEntries(ping.rubrics.map((r) => [r.scope, r]));
check("ping が極性を返す", ping.rubrics.every((r) => r.polarity === "defect"));
check("ping が3閾値を返す", ping.rubrics.every((r) => r.thresholds.probability_threshold === 0.7 && r.thresholds.critical_probability_threshold === 0.5 && r.thresholds.group_fail_at === 2));
check("ping が質問数を返す（22 / 18）", pingByScope.diagram.question_count === 22 && pingByScope.article.question_count === 18, JSON.stringify(ping.rubrics.map((r) => [r.scope, r.question_count])));
check("ping が diagram 5群 / article 4群を返す", pingByScope.diagram.groups.length === 5 && pingByScope.article.groups.length === 4);
check("ping がルーブリックの版を返す", ping.rubrics.every((r) => r.version === "0.4.0"), JSON.stringify(ping.rubrics.map((r) => r.version)));
check("ping が読み込み元を返す", ping.rubrics.every((r) => typeof r.source === "string" && r.source.startsWith("rubric-")));
check("ping が較正前だと警告する", ping.warnings.some((w) => w.includes("較正")));
check("ping が FAILしえない群を警告しない（R1 で解消済み）", !ping.warnings.some((w) => w.includes("FAIL しえない")), JSON.stringify(ping.warnings));
check("ping が全問一致の要る群を警告しない（R1 で解消済み）", !ping.warnings.some((w) => w.includes("全問一致")), JSON.stringify(ping.warnings));
check("ping の群に slack が入る", ping.rubrics.every((r) => r.groups.every((g) => typeof g.slack === "number")));

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
check("review の既定 scope は diagram", review.scope === "diagram", review.scope);
check("review が22項目すべてを検査する", review.items.length === 22, String(review.items.length));
check("review が全項目に probability を持つ", review.items.every((i) => typeof i.probability === "number" && i.probability >= 0 && i.probability <= 1));
check("review が5群を返す", review.groups.length === 5);
check("review が iteration 1 を付ける", review.iteration === 1);
check("review の fixes が欠陥数と一致する", review.fixes.length === review.items.filter((i) => i.defect === true).length);
check("review が人間確認枠を返す", review.human_review.required === true);
check("review に公開可否が無い", !JSON.stringify(review).includes("shippable"));
check("review が較正前だと警告する", review.warnings.some((w) => w.includes("較正")));
check("review が unreachable/fragile を空で返す", review.unreachable_groups.length === 0 && review.fragile_groups.length === 0);

const review2 = parse(
  await client.callTool({
    name: "jev_review",
    arguments: { task: "同上", artifact_path: "sample.html", note: "2回目" },
  })
);
check("2回目で iteration が増える", review2.iteration === 2, String(review2.iteration));
check("2回目は同じ run を共有する", review2.run_id === review.run_id);

// R2: 往復でもエスカレーションが返る。
// stub は state のハッシュで答えを決めるので、note が違えば確率も変わる。
// stagnation を確実に踏むには **2周目と完全に同じ引数**で3周目を回す。
check("1周目は escalate が空", Array.isArray(review.escalate) && review.escalate.length === 0, JSON.stringify(review.escalate));
check("1周目は previous_failed_groups が null", review.previous_failed_groups === null);
check("2周目に前周の FAIL群 が入る", Array.isArray(review2.previous_failed_groups), JSON.stringify(review2.previous_failed_groups));

const review3 = parse(
  await client.callTool({
    name: "jev_review",
    arguments: { task: "同上", artifact_path: "sample.html", note: "2回目" },
  })
);
check("3周目は state が2周目と同一なので FAIL群も同一", JSON.stringify(review3.failed_groups) === JSON.stringify(review2.failed_groups), `${review3.failed_groups} vs ${review2.failed_groups}`);
if (review3.failed_groups.length) {
  check("同じ結果が続くと stagnation", review3.escalate.includes("stagnation"), JSON.stringify(review3.escalate));
  check("stagnation が warnings にも出る", review3.warnings.some((w) => w.includes("stagnation")));
  check("理由文が付いて返る", review3.escalation_reasons.some((r) => r.id === "stagnation" && r.reason));
} else {
  check("落ちていない周では stagnation しない", !review3.escalate.includes("stagnation"));
}
if (review3.verdict !== "ship") {
  check("3周目で retry_limit も出る", review3.escalate.includes("retry_limit"), JSON.stringify(review3.escalate));
}

// scope=article。別のアーティファクトなので別の run になる。
const articleReview = parse(
  await client.callTool({
    name: "jev_review",
    arguments: {
      task: "受注から出荷までを内製で回すか外注するかを判断できるようにする記事",
      artifact_path: "sample-article.md",
      scope: "article",
      source_material: "外注は固定費、内製は件数比例。分岐点は月200件。繁忙期の人員確保が前提。",
      note: "初版",
    },
  })
);
check("article の review が通る", ["ship", "revise", "block", "unknown"].includes(articleReview.verdict), articleReview.verdict);
check("article の review は 18 項目", articleReview.items.length === 18, String(articleReview.items.length));
check("article の review は4群", articleReview.groups.length === 4, String(articleReview.groups.length));
check("article の review に g6 が入る", articleReview.groups.some((g) => g.key === "g6_article_structure"));
check("article の review に g2/g3 は入らない", !articleReview.groups.some((g) => g.key === "g2_figure_labeling" || g.key === "g3_text_figure_alignment"));
check("article は別の run になる", articleReview.run_id !== review.run_id && articleReview.iteration === 1);
check("review が scope を返す", articleReview.scope === "article", articleReview.scope);

const badScope = await client.callTool({
  name: "jev_review",
  arguments: { task: "x", artifact_path: "sample.html", scope: "poster" },
});
check("未知の scope は拒否される", badScope.isError === true);

const feed = parse(await client.callTool({ name: "jev_feed", arguments: { since_seq: 0 } }));
check("feed が全件返す", feed.records.length === 4, String(feed.records.length));
check("feed がカーソルを進める", feed.next_since_seq === 4, String(feed.next_since_seq));
check("feed のレコードに群が入る", Array.isArray(feed.records[0].groups));
check("feed のレコードに scope が入る", feed.records.every((r) => typeof r.scope === "string"), JSON.stringify(feed.records.map((r) => r.scope)));
check("feed のレコードにルーブリックの版が入る", feed.records.every((r) => r.rubric_version === "0.4.0"));
const tail = parse(await client.callTool({ name: "jev_feed", arguments: { since_seq: 3 } }));
check("feed が since_seq を尊重する", tail.records.length === 1);

const status = parse(await client.callTool({ name: "jev_status", arguments: {} }));
check("status が評価数を数える", status.total_evaluations === 4, String(status.total_evaluations));
check("status がラン後に idle に戻る", status.state.status === "idle", status.state.status);
check("status に overall が残っていない", !JSON.stringify(status).includes("overall"));
check("status が clean_ratio を集計する", status.runs.every((r) => "last_clean_ratio" in r), JSON.stringify(status.runs));

// R6: jev_decide が禁止事項 #4 の抜け道にならないよう description で抑止する
const decideTool = (await client.listTools()).tools.find((t) => t.name === "jev_decide");
check("jev_decide が公開可否に使うなと明示する", /公開可否/.test(decideTool.description) && /禁止事項 #4/.test(decideTool.description), decideTool.description?.slice(0, 120));
check("jev_decide が jev_gate の再構成を禁じる", /再構成しない/.test(decideTool.description));

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

// ── E. 助言モード（v0 方針）。設定は呼び出しごとに読むので、書き換えるだけで切り替わる ─────
console.log("\nE. 助言モード");
writeFileSync(resolve(sandbox, "zukai.config.json"), JSON.stringify({ mode: "advisory" }), "utf8");
const advArgs = { task: "同上", artifact_path: "sample.html", note: "2回目" };
const adv1 = parse(await client.callTool({ name: "jev_review", arguments: advArgs }));
const adv2 = parse(await client.callTool({ name: "jev_review", arguments: advArgs }));
check("advisory の review_mode が返る", adv1.review_mode === "advisory");
check("advisory は修正ループを指示しない", adv1.next_action === "present_report_and_stop" && adv2.next_action === "present_report_and_stop");
check("advisory は同じ結果が続いてもエスカレーションしない", adv2.escalate.length === 0 && adv2.escalation_reasons.length === 0, JSON.stringify(adv2.escalate));
check("advisory でも verdict は算出する", ["ship", "revise", "block", "unknown"].includes(adv1.verdict));
check("advisory は報告本文を返す", typeof adv1.report?.text === "string" && adv1.report.text.includes("助言モード"));
check("報告が stub を明示する", adv1.report.text.includes("stub"));
check("報告が s7 の人間確認を毎回出す", adv1.report.text.includes("人間確認（必須）"));
check("報告が判定の記録を求める", adv1.report.text.includes("判定を記録してください") && adv1.label_request.seq === adv1.seq);
const cfgBroken = resolve(sandbox, "zukai.config.json");
writeFileSync(cfgBroken, JSON.stringify({ mode: "gat" }), "utf8");
const typo = await client.callTool({ name: "jev_review", arguments: advArgs });
check("未知の mode は黙って advisory に倒さず止める", typo.isError === true);
writeFileSync(cfgBroken, JSON.stringify({ mode: "advisory" }), "utf8");

const lab = parse(
  await client.callTool({
    name: "jev_label",
    arguments: { seq: adv1.seq, human_verdict: "fail", jev_caught_missed: true, human_caught_missed: false, group_labels: { g5_epistemic: "fail" } },
  })
);
check("jev_label が台帳に記録する", lab.recorded?.review_seq === adv1.seq && /^live-\d{8}-001$/.test(lab.recorded.id), JSON.stringify(lab.recorded));
check("stub の判定に付けたラベルは移行条件に数えない", lab.outcome === "excluded_stub", lab.outcome);
check("jev_label が本文つきの標本を返す", lab.sample?.content === SAMPLE && lab.sample.label_source === "live");
const ledgerText = readFileSync(resolve(sandbox, "labels", "ledger.jsonl"), "utf8");
check("台帳に本文を書かない（リポジトリが public）", !ledgerText.includes("受注入力") && ledgerText.includes(adv1.run_id));
const badGroup = await client.callTool({ name: "jev_label", arguments: { seq: articleReview.seq, human_verdict: "pass", group_labels: { g2_figure_labeling: "pass" } } });
check("別ルーブリックの群ラベルは拒否する", badGroup.isError === true);
const noSeq = await client.callTool({ name: "jev_label", arguments: { seq: 9999, human_verdict: "pass" } });
check("存在しない seq は拒否する", noSeq.isError === true);

const dec = parse(
  await client.callTool({ name: "jev_record_decision", arguments: { scope: "diagram", trigger: "checkpoint", decision: "stay_advisory", reason: "テスト" } })
);
check("移行判断を記録する", dec.recorded?.decision === "stay_advisory" && dec.review_mode === "advisory");
const sw = parse(
  await client.callTool({ name: "jev_record_decision", arguments: { scope: "diagram", trigger: "streak", decision: "switch_to_gate", reason: "テスト" } })
);
check("switch_to_gate で設定が gate に変わる", sw.review_mode === "gate" && JSON.parse(readFileSync(cfgBroken, "utf8")).mode === "gate");
check("較正を見ずにゲートへ移ると警告する", sw.warnings.some((w) => w.includes("較正")));

await client.close();

// 移行条件の数え方を、作った台帳で直接検査する（MCP 経由では stub しか作れないため）
console.log("\nE2. 移行条件（3回連続で Jev が目視を上回る）");
{
  const L = await import("./labels.js");
  const root = mkdtempSync(resolve(tmpdir(), "zukai-labels-"));
  const cfg = { mode: "advisory", transition: { streak_required: 3, streak_ties_reset: true, checkpoint_labels_per_scope: 10, checkpoint_min_minority_share: 0.3 } };
  let t0 = Date.parse("2026-09-25T00:00:00Z");
  const add = (o) => L.appendLabel(root, { scope: "article", client_mode: "live", jev_verdict: "block", human_verdict: "fail", ...o }, new Date((t0 += 1000)));
  check("Jev だけが見つけた → jev_better", add({ jev_caught_missed: true, human_caught_missed: false }).outcome === "jev_better");
  check("目視だけが見つけた → jev_worse", L.classify({ label_source: "live", client_mode: "live", jev_verdict: "block", jev_caught_missed: false, human_caught_missed: true }) === "jev_worse");
  check("両方見つけた → even", L.classify({ label_source: "live", client_mode: "live", jev_verdict: "revise", jev_caught_missed: true, human_caught_missed: true }) === "even");
  check("Jev が判定不能 → jev_worse", L.classify({ label_source: "live", client_mode: "live", jev_verdict: "unknown", jev_caught_missed: true, human_caught_missed: false }) === "jev_worse");
  check("問いに答えていない → unrated（数えない）", L.classify({ label_source: "live", client_mode: "live", jev_verdict: "ship" }) === "unrated");
  add({ jev_caught_missed: true, human_caught_missed: false });
  check("2連続ではまだ満たさない", L.transitionStatus(root, cfg).scopes.article.streak === 2 && !L.transitionStatus(root, cfg).scopes.article.streak_met);
  add({ jev_caught_missed: false, human_caught_missed: false, human_verdict: "pass", jev_verdict: "ship" });
  check("引き分けで連続が切れる（文字どおりの「連続」）", L.transitionStatus(root, cfg).scopes.article.streak === 0);
  const lax = { ...cfg, transition: { ...cfg.transition, streak_ties_reset: false } };
  check("streak_ties_reset=false なら引き分けで切れない", L.transitionStatus(root, lax).scopes.article.streak === 2);
  add({ jev_caught_missed: false, human_caught_missed: false, client_mode: "stub" });
  check("stub の回は連続に数えない", L.transitionStatus(root, lax).scopes.article.streak === 2);
  for (let i = 0; i < 3; i++) add({ jev_caught_missed: true, human_caught_missed: false });
  const met = L.transitionStatus(root, cfg);
  check("3連続で移行条件を満たし、判断を催促する", met.scopes.article.streak_met && met.prompts.some((x) => x.includes("移行条件")));
  check("もう一方の scope には波及しない", met.scopes.diagram.streak === 0);
  L.appendDecision(root, { scope: "article", trigger: "streak", decision: "stay_advisory", reason: "t" }, new Date((t0 += 1000)));
  check("判断を記録したら数え直す", L.transitionStatus(root, cfg).scopes.article.streak === 0);
  for (let i = 0; i < 3; i++) add({ jev_caught_missed: false, human_caught_missed: false, human_verdict: "pass", jev_verdict: "ship" });
  const cp = L.transitionStatus(root, cfg).scopes.article.checkpoint;
  check("件数の節目: stub を除く現行基準ラベルを数える", cp.labels === 9 && !cp.met, JSON.stringify(cp));
  add({ jev_caught_missed: false, human_caught_missed: false, human_verdict: "pass", jev_verdict: "ship" });
  const cp2 = L.transitionStatus(root, cfg);
  check("10件で節目に達し、較正の実行を催促する", cp2.scopes.article.checkpoint.pending_decision && cp2.prompts.some((x) => x.includes("較正")));
  L.appendLabel(root, { id: "D01", label_source: "curated", scope: "diagram", human_verdict: "pass", needs_rejudge: true });
  check("再判定待ちのラベルは節目に数えない", L.transitionStatus(root, cfg).scopes.diagram.checkpoint.labels === 0 && L.transitionStatus(root, cfg).scopes.diagram.needs_rejudge.includes("D01"));
}

// 報告の並び（方針 2.3）。stub の回答では g5 が立つとは限らないので、作った結果で見る。
{
  const { buildAdvisoryReport } = await import("./report.js");
  const rubric = loadRubric(pkgRoot, "article");
  const g5q = rubric.questions.find((q) => q.group === "g5_epistemic");
  const g6q = rubric.questions.find((q) => q.group === "g6_article_structure");
  const answers = {};
  for (const q of rubric.questions) answers[q.key] = { type: "boolean", probability: q === g5q || q === g6q ? 0.9 : 0.1 };
  answers[rubric.scored.key] = { type: "score", score: 2 };
  const r = interpret(answers, rubric);
  const rep = buildAdvisoryReport({ result: r, fixes: fixList(r, rubric), rubric, clientMode: "live", seq: 1 });
  const t = rep.text;
  check("g5 の発火を最上段（他の指摘より前）に出す", t.indexOf("出典を確認せよ") > -1 && t.indexOf("出典を確認せよ") < t.indexOf("### 指摘"));
  check("g5 を「間違っている」と書かない", !/間違って|誤りである|虚偽/.test(t.split("### 指摘")[0].replace("事実が誤りだという判定ではない", "")));
  check("PASS した群は1行に畳む", (t.match(/問題なし:/g) || []).length === 1 && t.includes("コンテキスト品質"));
  check("live では stub 表示を出さない", !t.includes("stub"));
}

// ── D. 較正（HANDOFF 7章）。Jev を呼ばず、作った回答で集計ロジックを検査する ─────────
console.log("\nD. 較正");
{
  const cal = await import("./calibrate-core.js");
  const rubric = loadRubric(pkgRoot, "diagram");
  const nonCrit = (g) => rubric.questions.filter((q) => q.group === g && !q.critical).map((q) => q.key);
  // 全問 0.1（critical 閾値 0.5 未満）を土台に、指定の質問だけ上げる。
  const answersWith = (hi = {}, { drop = null, s7 = 3 } = {}) => {
    const a = {};
    for (const q of rubric.questions) if (q.key !== drop) a[q.key] = { type: "boolean", probability: hi[q.key] ?? 0.1 };
    a[rubric.scored.key] = { type: "score", score: s7 };
    return a;
  };
  const [g2a, g2b] = nonCrit("g2_figure_labeling");
  const [g4a, g4b] = nonCrit("g4_granularity_flow");
  check("較正用に非 critical の質問が g2 / g4 に2問ずつある", g2a && g2b && g4a && g4b);

  const clean = answersWith();
  check("欠陥なし → pass", cal.judgeAt(clean, rubric, 0.7).jev === "pass");
  const twoG2 = answersWith({ [g2a]: 0.75, [g2b]: 0.75 });
  check("同じ群で2件 0.75 → 閾値 0.7 で fail", cal.judgeAt(twoG2, rubric, 0.7).jev === "fail");
  check("同じ群で2件 0.75 → 閾値 0.8 で pass", cal.judgeAt(twoG2, rubric, 0.8).jev === "pass");
  check("欠陥1件（群FAIL なし＝revise）は pass に対応づく", cal.judgeAt(answersWith({ [g2a]: 0.9 }), rubric, 0.7).jev === "pass");
  check("回答欠落 → unknown（pass に倒さない）", cal.judgeAt(answersWith({}, { drop: g2a }), rubric, 0.7).jev === "unknown");
  // Drive 版 calibrate.js は s7 の score を verdict に入れ、しかも 0 起点のまま 4 と比べていた。
  check("s7 が最低点でも verdict は落ちない（s7 は人間確認の別枠）", cal.judgeAt(answersWith({}, { s7: 0 }), rubric, 0.7).jev === "pass");

  const svg = "<svg><text>x</text></svg>";
  const samples = [
    { id: "A", scope: "diagram", task: "t", content: svg, human_verdict: "fail", target_group: "g2_figure_labeling", boundary: true },
    { id: "B", scope: "diagram", task: "t", content: svg, human_verdict: "pass" },
    { id: "C", scope: "diagram", task: "t", content: svg, human_verdict: "pass" },
  ];
  const evals = [
    { id: "A", scope: "diagram", rubric_version: rubric.version, mode: "live", answers: twoG2 },
    { id: "B", scope: "diagram", rubric_version: rubric.version, mode: "live", answers: answersWith({ [g4a]: 0.65, [g4b]: 0.65 }) },
    { id: "C", scope: "diagram", rubric_version: rubric.version, mode: "stub", answers: twoG2 },
  ];
  const rep = cal.buildReport(samples, evals, { repoRoot: pkgRoot }).scopes.diagram;
  const at = (th) => rep.threshold_sweep.find((s) => s.threshold === th);
  check("stub の回答は集計から外す", rep.n === 2 && rep.warnings.some((w) => /stub/.test(w)));
  check("閾値 0.6 以下では B を過剰に落とす", at(0.5).too_strict === 1 && at(0.6).too_strict === 1);
  check("閾値 0.8 以上では A を見逃す", at(0.8).too_lenient === 1 && at(0.9).too_lenient === 1);
  check("一致率最大の 0.7 を採用する", rep.chosen_threshold === 0.7 && rep.agreement_rate === 1, JSON.stringify(rep.threshold_sweep));
  check("意図した群で落ちたかを見る", rep.rows.find((r) => r.id === "A").caught_intended === true);
  check("境界事例の一致率を出す", rep.boundary_agreement === 1);
  check("s7 / critical / group_fail_at が較正対象外だと明記する", rep.not_calibrated.length === 3);

  const tie = cal.buildReport(samples.slice(1, 2), evals.slice(1, 2), { repoRoot: pkgRoot }).scopes.diagram;
  check("同点なら現行値に近い閾値を選び、同点を警告する", tie.chosen_threshold === 0.7 && tie.warnings.some((w) => /同点/.test(w)), JSON.stringify(tie.threshold_sweep));

  const round = cal.expandEvaluations(cal.compactEvaluations(evals));
  check(
    "貼り戻し用 JSON を戻しても判定が変わらない",
    round.every((e, i) => cal.judgeAt(e.answers, rubric, 0.7).jev === cal.judgeAt(evals[i].answers, rubric, 0.7).jev) &&
      round[0].answers[rubric.scored.key].score === 3
  );

  const bad = cal.validateSamples(
    [
      { id: "x", scope: "poster", task: "t", content: "c", human_verdict: "fail" },
      { id: "x", scope: "diagram", task: "t", content: "c", human_verdict: "maybe" },
      { id: "y", scope: "diagram", task: "t", content: "c", human_verdict: "fail", target_group: "g6_article_structure" },
      { id: "z", scope: "diagram", task: "t", content: "x".repeat(70000), human_verdict: "fail" },
    ],
    pkgRoot
  );
  check("未知の scope を弾く", bad.errors.some((e) => /x: scope/.test(e)));
  check("id の重複を弾く", bad.errors.some((e) => /重複/.test(e)));
  check("human_verdict の値を検査する", bad.errors.some((e) => /human_verdict/.test(e)));
  check("別ルーブリックの群を target_group に書くと弾く", bad.errors.some((e) => /g6_article_structure/.test(e)));
  check("長すぎる content は切り詰めずに弾く", bad.errors.some((e) => /z: content が/.test(e)));
  check("pass が0件なら警告する", bad.warnings.some((w) => /pass が0件/.test(w)));

  const { default: calibrateApi } = await import("../api/calibrate.js");
  const call = async (env, path) => {
    const saved = process.env.PROBE_TOKEN;
    if (env === undefined) delete process.env.PROBE_TOKEN;
    else process.env.PROBE_TOKEN = env;
    const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await calibrateApi({ url: path, headers: { host: "t" } }, res);
    if (saved === undefined) delete process.env.PROBE_TOKEN;
    else process.env.PROBE_TOKEN = saved;
    return res;
  };
  check("PROBE_TOKEN 未設定なら /api/calibrate は実行しない", (await call(undefined, "/api/calibrate")).statusCode === 403);
  check("token 違いは 401", (await call("s", "/api/calibrate?token=x")).statusCode === 401);
  check("stub では較正しない", (await call("s", "/api/calibrate?token=s")).statusCode === 503);
}

console.log(fails.length ? `\n${fails.length} failed: ${fails.join(", ")}` : `\nall ok — ${"mode="}${ping.mode}`);
process.exit(fails.length ? 1 : 0);
