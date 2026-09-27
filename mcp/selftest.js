#!/usr/bin/env node
// 自己診断:
//   A. ルーブリック 2 本（diagram / article）が HANDOFF 3.5 の構成どおりに読めるか
//   B. interpret() の判定ロジックを作った回答で直接検査する（極性・群判定・欠損・s7）
//   L. 層（①本文 / ②図単体 / ③整合）が正本から正しく群を選ぶか（付記 G）
//   I. 入力の分解: 図の抽出・プレースホルダ・見えない文字の除去・層ごとの state
//   C. MCP ハンドシェイクから jev_review / jev_review_all / jev_label / jev_ship まで往復させる
//   D. 較正の集計（層ごと。Jev を呼ばない）
// APIキーが無くても stub モードで通る。ai パッケージも不要。`npm run check` で実行。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  loadRubric,
  loadAllRubrics,
  loadLayer,
  loadAllLayers,
  buildQuestions,
  groupStructure,
  interpret,
  fixList,
  SCOPES,
  DEFAULT_SCOPE,
} from "./rubric.js";
import { LAYER_IDS, PUBLICATION } from "./layers.js";
import { stripInspectorNotes, extractFigures, toReaderText, sanitizeSvg, selectFigure, prepareInputs, sha256 } from "./content.js";
import { buildLayerState } from "./state.js";
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
check("単発の欠陥は合格（2026-09-25 本人決定）", oneDefect.result === "pass" && oneDefect.fail_reason === null);
check("欠陥ゼロは合格", clean.result === "pass");

// 非 critical の閾値は 0.70
check("非critical 0.69 は欠陥ではない", run({ g2_missing_legend: 0.69 }).defects.length === 0);
check("非critical 0.70 は欠陥", run({ g2_missing_legend: 0.7 }).defects.includes("g2_missing_legend"));

// critical の閾値は 0.50、かつ単独で群FAIL
const crit = run({ g3_question_mismatch: 0.5 });
check("critical 0.50 は欠陥", crit.defects.includes("g3_question_mismatch"));
check("critical 単独で群FAIL → block", crit.verdict === "block" && crit.failed_groups.includes("g3_text_figure_alignment"), `${crit.verdict} ${crit.failed_groups}`);
check("群FAIL は不合格（fail / group_fail）", crit.result === "fail" && crit.fail_reason === "group_fail");
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
check("判定不能は合格にしない（fail / unknown）", missing.result === "fail" && missing.fail_reason === "unknown");
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
check("合格（revise）の3周目で retry_limit を出さない", !esc({ iteration: 3, verdict: "revise", failedGroups: [], previousFailedGroups: [] }).includes("retry_limit"));
check("判定不能の3周目は retry_limit を出す", esc({ iteration: 3, verdict: "unknown", failedGroups: [], previousFailedGroups: [] }).includes("retry_limit"));
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


// ── L. 層（付記 G）。人間と Jev が同じものを見て、同じ群を問う ─────────────────────
console.log("\n層（①本文 / ②図単体 / ③整合）");
{
  check("層は text / figure / alignment の3つ", JSON.stringify(LAYER_IDS) === '["text","figure","alignment"]', String(LAYER_IDS));
  const L = Object.fromEntries(loadAllLayers(pkgRoot).map((l) => [l.layer, l]));
  const keys = (l) => l.groups.map((g) => g.key).join(",");
  check("①本文は article の全群", L.text.scope === "article" && keys(L.text) === "g1_traceability,g4_granularity_flow,g5_epistemic,g6_article_structure", keys(L.text));
  check("①本文は18問", L.text.questions.length === 18, String(L.text.questions.length));
  check("②図単体は diagram の g2 / g5", L.figure.scope === "diagram" && keys(L.figure) === "g2_figure_labeling,g5_epistemic", keys(L.figure));
  check("②図単体は8問（g2 6問 + g5 2問）", L.figure.questions.length === 8, String(L.figure.questions.length));
  check("③整合は diagram の g3 だけ", L.alignment.scope === "diagram" && keys(L.alignment) === "g3_text_figure_alignment", keys(L.alignment));
  check("③整合は5問", L.alignment.questions.length === 5, String(L.alignment.questions.length));
  check("s7 は①でだけ問う（禁止事項 #3 の人間確認つき）", L.text.scored?.human_review_required === true && L.figure.scored === null && L.alignment.scored === null);
  check("②③の質問には s7 が入らない", !("s7_originality" in buildQuestions(L.figure)) && !("s7_originality" in buildQuestions(L.alignment)));
  check("①の質問には s7 が入る", "s7_originality" in buildQuestions(L.text) && Object.keys(buildQuestions(L.text)).length === 19);
  for (const l of Object.values(L)) {
    const st = groupStructure(l);
    check(`${l.layer_number}${l.layer_label}: FAIL しえない群も全問一致が要る群も無い`, st.every((g) => g.reachable && !g.fragile), JSON.stringify(st.map((g) => [g.key, g.slack])));
    check(`${l.layer_number}${l.layer_label}: 閾値は正本のまま（0.70 / 0.50 / 2）`, l.thresholds.probability_threshold === 0.7 && l.thresholds.critical_probability_threshold === 0.5 && l.thresholds.group_fail_at === 2);
  }
  const used = new Set(Object.values(L).flatMap((l) => l.groups.map((g) => `${l.scope}:${g.key}`)));
  const unusedDiagram = R.groups.map((g) => g.key).filter((k) => !used.has(`diagram:${k}`));
  check("diagram の g1 / g4 はどの層でも使わない（①の article で問う）", JSON.stringify(unusedDiagram) === '["g1_traceability","g4_granularity_flow"]', String(unusedDiagram));
  check("article の群はすべて①で使う", RA.groups.every((g) => used.has(`article:${g.key}`)));

  const zero = (l) => Object.fromEntries(Object.keys(buildQuestions(l)).map((k) => [k, k === "s7_originality" ? { type: "score", score: 4 } : { type: "boolean", probability: 0.05 }]));
  const fig = interpret(zero(L.figure), L.figure);
  check("②の interpret は human_review を null で返す", fig.human_review === null && fig.result === "pass" && fig.layer === "figure");
  const txt = interpret(zero(L.text), L.text);
  check("①の interpret は human_review を返す", txt.human_review?.required === true && txt.layer === "text");
  const al = interpret({ ...zero(L.alignment), g3_question_mismatch: { type: "boolean", probability: 0.6 } }, L.alignment);
  check("③で critical（問いと図の不一致）が立てば不合格", al.result === "fail" && al.failed_groups[0] === "g3_text_figure_alignment");

  // 正本の群構成が変わったら黙って空の層を作らない（何も検査せずに合格を返すようになる）。
  const noG3 = mkdtempSync(resolve(tmpdir(), "zukai-nog3-"));
  const raw = JSON.parse(readFileSync(resolve(pkgRoot, "rubric-diagram.json"), "utf8"));
  delete raw.groups.g3_text_figure_alignment;
  writeFileSync(resolve(noG3, "rubric-diagram.json"), JSON.stringify(raw), "utf8");
  let err = null;
  try {
    loadLayer(noG3, "alignment");
  } catch (e) {
    err = e.message;
  }
  check("正本に層の群が無ければ止める", Boolean(err && err.includes("g3_text_figure_alignment")), err);
  let unknownLayer = null;
  try {
    loadLayer(pkgRoot, "poster");
  } catch (e) {
    unknownLayer = e.message;
  }
  check("未知の層は拒否する", Boolean(unknownLayer));
  check("④公開判断は人間が行い、Jev も較正も使わない", PUBLICATION.by === "human" && PUBLICATION.jev === false && PUBLICATION.calibration === false);
}

// ── I. 入力の分解（content.js / state.js） ─────────────────────────────────────
console.log("\n入力の分解");
{
  const meta = stripInspectorNotes("【検査用メタ】種類：article\n版：v1\n\n# 見出し\n\n本文（画像ファイル：fig1.png / .svg）です。");
  check("【検査用メタ】の段落を丸ごと外す（複数行）", !meta.text.includes("検査用メタ") && !meta.text.includes("版：v1") && meta.text.startsWith("# 見出し"), JSON.stringify(meta.text));
  check("（画像ファイル：…）の注記を外す", !meta.text.includes("画像ファイル") && meta.text.includes("本文です。"));
  check("外したものを報告する", meta.removed.some((r) => r.kind === "inspector_meta") && meta.removed.some((r) => r.kind === "image_file_note"));

  const html = `<!doctype html><html><head><title>見えない題</title><style>svg{}</style></head><body>
<h1>仕組み</h1><p>本文A &amp; B</p>
<figure id="f1"><svg viewBox="0 0 10 10"><title>隠れた題</title><svg><text>入れ子</text></svg><text aria-label="隠れた説明">A→B</text></svg><figcaption>図1：お金の流れ</figcaption></figure>
<p>本文C</p><svg id="bare"><desc>隠れた説明2</desc><text>C</text></svg>
<script>const s = "<svg><text>コード</text></svg>";</script></body></html>`;
  const figs = extractFigures(html, "html");
  check("インライン図を2枚見つける（<script> 内の <svg> は図ではない）", figs.length === 2, String(figs.length));
  check("入れ子の <svg> は1枚として数える", figs[0].svg.includes("入れ子") && figs[0].svg.endsWith("</svg>"));
  check("<figcaption> をキャプションにする", figs[0].caption === "図1：お金の流れ" && figs[1].caption === null);
  check("キャプションの「図1」を呼び名にし、無ければ順番で付ける", figs[0].label === "図1" && figs[1].label === "図2");
  check("要素の id を拾う", figs[0].element_id === "f1" && figs[1].element_id === "bare");
  const dup = extractFigures('<figure><svg><text>a</text></svg><figcaption>図3：一</figcaption></figure><figure><svg><text>b</text></svg><figcaption>図3：二</figcaption></figure>', "html");
  check("同じ呼び名の図が2枚あっても別の対象として区別する", dup[0].label === "図3" && dup[1].label === "図3#2", JSON.stringify(dup.map((f) => f.label)));
  check("Markdown のコードブロック内の <svg> は図ではない", extractFigures("本文\n\n```html\n<svg><text>例</text></svg>\n```\n", "text").length === 0);

  const reader = toReaderText(html, "html", figs, { target: 2 });
  check("①の本文では図を［図N：キャプション］に置き換える", reader.text.includes("［図1：お金の流れ］") && !reader.text.includes("<svg"), reader.text);
  check("③では検査対象の図に印を付ける", reader.text.includes("［図2（検査対象）］"));
  check("HTML のタグと実体参照を本文にする", reader.text.includes("本文A & B") && reader.text.includes("# 仕組み"));
  check("<title> と <head> は読者に見えないので入れない", !reader.text.includes("見えない題"));

  const clean = sanitizeSvg(figs[0].svg);
  check("SVG の <title> / aria-label を外す（見えないのに Jev だけが読む）", !clean.svg.includes("隠れた題") && !clean.svg.includes("隠れた説明") && clean.svg.includes("A→B"));
  check("SVG の <desc> を外す", !sanitizeSvg(figs[1].svg).svg.includes("隠れた説明2"));
  check("外したものを報告する", clean.removed.some((r) => r.kind === "svg_title") && clean.removed.some((r) => r.kind === "svg_aria_text"));

  let multi = null;
  try {
    selectFigure(figs, null);
  } catch (e) {
    multi = e.message;
  }
  check("図が複数あって指定が無ければ止める（黙って1枚目を選ばない）", Boolean(multi && multi.includes("2 枚")), multi);
  check("図を番号・呼び名・id で選べる", selectFigure(figs, 2) === figs[1] && selectFigure(figs, "図1") === figs[0] && selectFigure(figs, "#bare") === figs[1]);

  const article = { path: "a.md", content: "【検査用メタ】種類：article\n\n# 問い\n\n結論です。\n\n【図】図3：件数と総コスト（画像ファイル：fig3.png / .svg）\n" };
  const svgFile = { path: "figs/fig3.svg", content: '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><title>題</title><text>分岐点 200件</text></svg>' };
  const T = buildLayerState({ layer: "text", task: "依頼X", sourceMaterial: "資料Y", inputs: prepareInputs({ layer: "text", main: article }) });
  check("①の state は依頼内容・元資料・本文を持つ", T.includes.join() === "task,source_material,text" && T.state.includes("依頼X") && T.state.includes("資料Y"));
  check("①の state に検査用の注記は入らない", !T.state.includes("検査用メタ") && !T.state.includes("画像ファイル"));
  const F = buildLayerState({ layer: "figure", task: "依頼X", sourceMaterial: "資料Y", inputs: prepareInputs({ layer: "figure", main: null, figureFile: svgFile, figure: "図3" }) });
  check("②の state は SVG だけ（依頼内容・元資料・本文を入れない）", F.includes.join() === "figure" && !F.state.includes("依頼X") && !F.state.includes("資料Y") && F.state.includes("分岐点 200件"));
  check("②の state から SVG の <title> と XML 宣言が外れる", !F.state.includes("<title>") && !F.state.includes("<?xml"));
  const A = buildLayerState({ layer: "alignment", task: "依頼X", sourceMaterial: "資料Y", inputs: prepareInputs({ layer: "alignment", main: article, figureFile: svgFile, figure: "図3" }) });
  check("③の state は本文と SVG 1枚（依頼内容・元資料は入れない）", A.includes.join() === "text,figure" && !A.state.includes("依頼X") && A.state.includes("結論です") && A.state.includes("分岐点 200件"));
  check("③で別ファイルの図は本文での呼び名と結び付ける", A.state.includes("本文中で「図3」と呼ばれている図"));
  const throws = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e.message;
    }
  };
  check("画像（PNG）は受け取らない", Boolean(throws(() => prepareInputs({ layer: "figure", main: null, figureFile: { path: "x.png", content: "�PNG..." } }))));
  check("①に図ファイルを渡すと止める（①は図を隠して見る）", Boolean(throws(() => prepareInputs({ layer: "text", main: article, figureFile: svgFile }))));
  check("①に SVG を渡すと止める", Boolean(throws(() => prepareInputs({ layer: "text", main: svgFile }))));
  check("③に図が無ければ止める", Boolean(throws(() => prepareInputs({ layer: "alignment", main: article }))));
}

// ── C. MCP 往復 ────────────────────────────────────────────────────────────
const FIG_ARTICLE = `【検査用メタ】種類：article／版：v1

# 在庫を持つか、受注生産にするか

先に結論を言います。月200件までは受注生産の方が安く済みます。

【図】図3：月間件数と総コストの関係（画像ファイル：fig3_cost.png / .svg）

図3の右側が在庫を持つ場合で、件数が増えるほど有利になります。`;
writeFileSync(resolve(sandbox, "nb.md"), FIG_ARTICLE, "utf8");
writeFileSync(
  resolve(sandbox, "fig3.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><title>図3</title><text x="10" y="20">月間件数と総コスト</text><text x="10" y="40">分岐点 200件</text></svg>',
  "utf8"
);
writeFileSync(
  resolve(sandbox, "page.html"),
  `<!doctype html><html><head><title>t</title></head><body><h1>受注から出荷まで</h1><p>受注入力から出荷までの流れ。</p>
<figure><svg viewBox="0 0 10 10"><text>受注→引当→出荷</text></svg><figcaption>図1：受注から出荷まで</figcaption></figure>
<p>倉庫側の内訳。</p><figure><svg viewBox="0 0 10 10"><text>ピッキング→検品</text></svg><figcaption>図2：倉庫の作業</figcaption></figure></body></html>`,
  "utf8"
);

const client = new Client({ name: "zukai-selftest", version: "0.3.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    // 鍵が置いてあっても自己診断は stub で走らせる。ネットワークと課金に依存させない。
    env: { ...process.env, ZUKAI_REPO_ROOT: sandbox, ZUKAI_FORCE_STUB: "1" },
  })
);
const call = async (name, args) => client.callTool({ name, arguments: args });

console.log(`\nMCP 往復 (sandbox: ${sandbox})`);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
const TOOLS = ["jev_ping", "jev_review", "jev_review_all", "jev_decide", "jev_feed", "jev_status", "jev_label", "jev_ship"];
check("tools/list は 8 件", tools.length === TOOLS.length, tools.join(", "));
for (const t of TOOLS) check(`tool present: ${t}`, tools.includes(t));
check("jev_gate は廃止されている", !tools.includes("jev_gate"));

const ping = parse(await call("jev_ping", {}));
check("自己診断は必ず stub で走る", ping.mode === "stub" && ping.forced_stub === true, `${ping.mode} forced=${ping.forced_stub}`);
check("ping が鍵の env 名を返す", ping.key_env === "AI_GATEWAY_API_KEY");
check("助言モードは無い（検査器は合否の2値）", !JSON.stringify(ping).includes("advisory"));
const pingLayers = Object.fromEntries(ping.layers.map((l) => [l.layer, l]));
check("ping が3層を返す", ping.layers.length === 3 && pingLayers.text && pingLayers.figure && pingLayers.alignment);
check("ping が層ごとの質問数を返す（18 / 8 / 5）", pingLayers.text.question_count === 18 && pingLayers.figure.question_count === 8 && pingLayers.alignment.question_count === 5, JSON.stringify(ping.layers.map((l) => [l.layer, l.question_count])));
check("ping が層ごとの出どころを返す", pingLayers.text.rubric === "rubric-article.json" && pingLayers.figure.rubric === "rubric-diagram.json" && pingLayers.alignment.rubric === "rubric-diagram.json");
check("ping が人間の見るものと Jev の入力を層ごとに返す", ping.layers.every((l) => l.human_sees && l.jev_input));
check("ping が s7 は①だけと返す", pingLayers.text.s7_human_review === true && !pingLayers.figure.s7_human_review && !pingLayers.alignment.s7_human_review);
check("ping が④公開判断は人間と返す", ping.publication?.by === "human" && ping.publication.jev === false && ping.publication.calibration === false);
check("ping がどの層でも使わない群を隠さない", JSON.stringify(ping.unused_groups) === '["rubric-diagram.json:g1_traceability","rubric-diagram.json:g4_granularity_flow"]', JSON.stringify(ping.unused_groups));
check("ping が2本のルーブリックの版を返す", ping.rubrics.length === 2 && ping.rubrics.every((r) => r.version === "0.4.0"));
check("ping が較正前だと警告する", ping.warnings.some((w) => w.includes("較正")));
check("ping が FAILしえない群・全問一致の要る群を警告しない", !ping.warnings.some((w) => w.includes("FAIL しえない") || w.includes("全問一致")), JSON.stringify(ping.warnings));
check("ping の群に slack が入る", ping.layers.every((l) => l.groups.every((g) => typeof g.slack === "number")));

// ① 本文
const text1 = parse(await call("jev_review", { task: "在庫を持つか受注生産にするかを判断できるようにする", layer: "text", artifact_path: "nb.md", source_material: "筆者試算", note: "初版" }));
check("①の review が result を返す", ["pass", "fail"].includes(text1.result), text1.result);
check("result は群FAIL の有無と一致する", (text1.result === "fail") === (text1.failed_groups.length > 0 || text1.verdict === "unknown"));
const nextOf = (r) => (r.result === "pass" ? "continue_other_layers" : r.fail_reason === "unknown" || r.escalate.length ? "stop_and_escalate" : "fix_and_rereview");
check("1層の合格は④に渡さず残りの層へ（continue_other_layers）", text1.next_action === nextOf(text1), `${text1.result} ${text1.next_action}`);
check("①は18項目", text1.items.length === 18, String(text1.items.length));
check("①は4群（g1 / g4 / g5 / g6）", text1.groups.length === 4 && text1.groups.some((g) => g.key === "g6_article_structure"));
check("①に g2 / g3 は入らない", !text1.groups.some((g) => g.key === "g2_figure_labeling" || g.key === "g3_text_figure_alignment"));
check("①は s7 の人間確認を返す", text1.human_review?.required === true);
check("①の層名と対象を返す", text1.layer === "text" && text1.layer_label === "① 本文" && text1.subject === "text:nb.md");
check("①の入力に依頼内容・元資料・本文が入る", JSON.stringify(text1.input.includes) === '["task","source_material","text"]');
check("①で外した注記を報告する", text1.input.normalization.some((n) => n.kind === "inspector_meta") && text1.warnings.some((w) => w.includes("検査用メタ")));
check("版を特定するハッシュを返す", /^[0-9a-f]{64}$/.test(text1.input.state_sha256) && /^[0-9a-f]{64}$/.test(text1.input.text_sha256) && text1.input.figure_sha256 === null);
check("review が iteration 1 を付ける", text1.iteration === 1);
check("review の fixes が欠陥数と一致する", text1.fixes.length === text1.items.filter((i) => i.defect === true).length);
check("review に公開可否が無い", !JSON.stringify(text1).includes("shippable"));
check("review が較正前だと警告する", text1.warnings.some((w) => w.includes("較正")));

// ② 図単体 × 3周。同じ層・同じ図なので同じ run で周回を数える。
const figArgs = { task: "件数と総コストの関係", layer: "figure", figure_path: "fig3.svg", figure: "図3", source_material: "筆者試算" };
const fig1 = parse(await call("jev_review", figArgs));
check("②は8項目・2群（g2 / g5）", fig1.items.length === 8 && fig1.groups.map((g) => g.key).join() === "g2_figure_labeling,g5_epistemic", `${fig1.items.length} ${fig1.groups.map((g) => g.key)}`);
check("②は s7 を問わない", fig1.human_review === null && !fig1.items.some((i) => i.key === "s7_originality"));
check("②の入力は図だけ", JSON.stringify(fig1.input.includes) === '["figure"]');
check("②は元資料を入れなかったと言う", fig1.warnings.some((w) => w.includes("元資料を state に入れない")));
check("②は SVG の見えない文字を外したと言う", fig1.warnings.some((w) => w.includes("見えない文字")));
check("②の対象は図ファイル", fig1.subject === "figure:fig3.svg" && fig1.figure?.label === "図3");
check("別の層は別の run（①と②で周回を混ぜない）", fig1.run_id !== text1.run_id && fig1.iteration === 1);
const fig2 = parse(await call("jev_review", figArgs));
check("同じ層・同じ図の2回目は同じ run の2周目", fig2.run_id === fig1.run_id && fig2.iteration === 2, `${fig2.iteration}`);
check("2周目に前周の FAIL群 が入る", Array.isArray(fig2.previous_failed_groups));
const fig3 = parse(await call("jev_review", figArgs));
check("3周目は state が2周目と同一なので FAIL群も同一", JSON.stringify(fig3.failed_groups) === JSON.stringify(fig2.failed_groups));
if (fig3.failed_groups.length) {
  check("同じ結果が続くと stagnation", fig3.escalate.includes("stagnation"), JSON.stringify(fig3.escalate));
  check("理由文が付いて返る", fig3.escalation_reasons.some((r) => r.id === "stagnation" && r.reason));
}
if (fig3.result === "fail") {
  check("3周目で不合格なら retry_limit も出る", fig3.escalate.includes("retry_limit"), JSON.stringify(fig3.escalate));
  check("エスカレーションしたら修正ループを止める", fig3.next_action === "stop_and_escalate", fig3.next_action);
} else {
  check("3周目で合格なら retry_limit を出さない", !fig3.escalate.includes("retry_limit"));
}

// ③ 整合
const align1 = parse(await call("jev_review", { task: "在庫を持つか受注生産にするかを判断できるようにする", layer: "alignment", artifact_path: "nb.md", figure_path: "fig3.svg", figure: "図3", source_material: "筆者試算" }));
check("③は5項目・g3 だけ", align1.items.length === 5 && align1.groups.length === 1 && align1.groups[0].key === "g3_text_figure_alignment");
check("③は s7 を問わない", align1.human_review === null);
check("③の入力は本文と図", JSON.stringify(align1.input.includes) === '["text","figure"]' && align1.input.figure_sha256 && align1.input.text_sha256 === text1.input.text_sha256);
check("③の対象は本文×図", align1.subject === "alignment:nb.md|fig3.svg");

// 旧 API と入力の誤り
const isErr = (r, re) => r.isError === true && (!re || re.test(r.content[0].text));
check("scope=diagram（一括）は廃止のエラー", isErr(await call("jev_review", { task: "x", scope: "diagram", artifact_path: "page.html" }), /廃止/));
const legacyArticle = parse(await call("jev_review", { task: "x", scope: "article", artifact_path: "nb.md" }));
check("scope=article は①として動き、廃止予定を告げる", legacyArticle.layer === "text" && legacyArticle.warnings.some((w) => w.includes("廃止予定")));
check("layer が無ければエラー", isErr(await call("jev_review", { task: "x", artifact_path: "nb.md" }), /layer/));
check("layer と scope を同時に渡すとエラー", isErr(await call("jev_review", { task: "x", layer: "text", scope: "article", artifact_path: "nb.md" })));
check("未知の layer は拒否される", isErr(await call("jev_review", { task: "x", layer: "poster", artifact_path: "nb.md" })));
check("図が複数ある HTML で図を指定しないとエラー", isErr(await call("jev_review", { task: "x", layer: "figure", artifact_path: "page.html" }), /2 枚/));
const inlinePick = parse(await call("jev_review", { task: "x", layer: "alignment", artifact_path: "page.html", figure: "図2" }));
check("インライン図を呼び名で選べる", inlinePick.figure?.label === "図2" && inlinePick.subject === "alignment:page.html|page.html#図2");
writeFileSync(resolve(sandbox, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
check("PNG は評価できないと止める", isErr(await call("jev_review", { task: "x", layer: "figure", figure_path: "chart.png" }), /画像/));
check("リポジトリ外のパスは拒否される", isErr(await call("jev_review", { task: "x", layer: "text", artifact_path: "../../../etc/passwd" })));

// まとめて（jev_review_all）
const all1 = parse(await call("jev_review_all", { task: "在庫を持つか受注生産にするかを判断できるようにする", artifact_path: "nb.md", figures: [{ path: "fig3.svg", label: "図3" }], source_material: "筆者試算", note: "v1" }));
check("review_all は①と、図ごとに②③を回す", all1.layers.map((l) => `${l.layer}${l.figure ? "@" + l.figure : ""}`).join() === "text,figure@図3,alignment@図3", all1.layers.map((l) => l.layer).join());
check("review_all の合否は全層の合否", (all1.result === "pass") === all1.layers.every((l) => l.result === "pass"));
check("review_all の FAIL は「層@図:群」で数える", all1.failed.every((f) => /^(text|figure|alignment)(@[^:]+)?:[a-z0-9_]+$/.test(f)), JSON.stringify(all1.failed));
check("review_all は合格なら④を人間に渡し、不合格なら直すか止める", all1.result === "pass" ? all1.next_action === "hand_to_human" : ["fix_and_rereview", "stop_and_escalate"].includes(all1.next_action), `${all1.result} ${all1.next_action}`);
check("review_all は層ごとの止めどきを引き継ぐ（②は3周済み）", all1.layers.find((l) => l.layer === "figure").iteration === 4 || fig3.result === "pass");
check("review_all は①の s7 人間確認を返す", all1.human_review?.required === true);
check("review_all の round を記録する", typeof all1.round.seq === "number" && all1.round.iteration === 1);
const all2 = parse(await call("jev_review_all", { task: "受注から出荷まで", artifact_path: "page.html" }));
check("図を渡さなければ本文中のインライン SVG をすべて使う", JSON.stringify(all2.figures) === '["図1","図2"]' && all2.layers.length === 5, JSON.stringify(all2.figures));
check("同じ記事の2回目は round の2周目", parse(await call("jev_review_all", { task: "受注から出荷まで", artifact_path: "page.html" })).round.iteration === (all2.result === "pass" ? 1 : 2));
const noFig = parse(await call("jev_review_all", { task: "x", artifact_path: "sample-article.md" }));
check("図が無い記事は①だけで、そう警告する", noFig.layers.length === 1 && noFig.warnings.some((w) => w.includes("図が見つからない")));

// 層ごとの人間の判定（較正の材料）
const alignSeq = all1.layers.find((l) => l.layer === "alignment").seq;
const lab = parse(await call("jev_label", { seq: alignSeq, human_verdict: "fail", group_labels: { g3_text_figure_alignment: "fail" }, boundary: true, note: "見出しと図の数値が合わない" }));
check("jev_label が層つきで台帳に記録する", lab.recorded?.kind === "layer_label" && lab.recorded.layer === "alignment" && lab.recorded.figure === "図3" && /^live-\d{8}-001$/.test(lab.recorded.id), JSON.stringify(lab.recorded));
check("ラベルに版のハッシュを残す", /^[0-9a-f]{64}$/.test(lab.recorded.state_sha256) && lab.recorded.figure_sha256 && lab.recorded.text_sha256);
check("stub の判定に付けた記録だと警告する", lab.warnings.some((w) => w.includes("stub")));
check("jev_label が本文つきの標本を返す", lab.sample?.layer === "alignment" && lab.sample.text?.content === FIG_ARTICLE && lab.sample.figure_file?.path === "fig3.svg" && lab.sample.label_source === "live");
{
  // 標本から組み直した state が検査時と一致する＝較正は本番と同じ入力で回る。
  const cal = await import("./calibrate-core.js");
  check("標本から組み直した state が検査時と同じ", sha256(cal.stateFor(lab.sample).state) === lab.recorded.state_sha256);
  const textLab = parse(await call("jev_label", { seq: text1.seq, human_verdict: "pass" }));
  check("①の標本も組み直すと検査時と同じ", sha256(cal.stateFor(textLab.sample).state) === text1.input.state_sha256);
}
const ledgerText = readFileSync(resolve(sandbox, "labels", "ledger.jsonl"), "utf8");
check("台帳に本文を書かない（リポジトリが public）", !ledgerText.includes("件数が増えるほど有利") && !ledgerText.includes("分岐点 200件") && ledgerText.includes(all1.layers[2].run_id));
check("その層で問わない群のラベルは拒否する", isErr(await call("jev_label", { seq: fig1.seq, human_verdict: "fail", group_labels: { g3_text_figure_alignment: "fail" } }), /問わない群/));
check("round の seq にはラベルを付けない", isErr(await call("jev_label", { seq: all1.round.seq, human_verdict: "fail" })));
check("存在しない seq は拒否する", isErr(await call("jev_label", { seq: 9999, human_verdict: "pass" })));
// 層分割より前の記録。article は①と同じものを見ているので付けられる。diagram（一括）は付けない。
const nextSeq = parse(await call("jev_feed", { since_seq: 0, limit: 1000 })).records.length + 1;
appendFileSync(resolve(sandbox, ".jev", "runs.jsonl"), JSON.stringify({ seq: nextSeq, kind: "review", scope: "diagram", run_id: "old", verdict: "block", failed_groups: ["g2_figure_labeling"] }) + "\n");
appendFileSync(resolve(sandbox, ".jev", "runs.jsonl"), JSON.stringify({ seq: nextSeq + 1, kind: "review", scope: "article", run_id: "old2", verdict: "ship", failed_groups: [] }) + "\n");
check("層分割前の diagram 一括の検査にはラベルを付けない", isErr(await call("jev_label", { seq: nextSeq, human_verdict: "fail" }), /揃わない/));
writeFileSync(resolve(sandbox, ".jev", "reviews", `${nextSeq + 1}.json`), JSON.stringify({ seq: nextSeq + 1, scope: "article", artifact: "old.md", task: "t", content: "旧い本文", source_material: null }));
const oldArticle = parse(await call("jev_label", { seq: nextSeq + 1, human_verdict: "pass" }));
check("層分割前の article の検査は①として記録する", oldArticle.recorded?.layer === "text" && oldArticle.warnings.some((w) => w.includes("①本文")));
check("層分割前の検査からも本文つきの標本を組める", oldArticle.sample?.text?.content === "旧い本文" && oldArticle.sample.layer === "text");

// ④公開判断（較正には使わない）
const ship = parse(await call("jev_ship", { artifact: "nb v1", decision: "hold", round_seq: all1.round.seq, reason: "法務確認待ち" }));
check("jev_ship が④を較正対象外として記録する", ship.recorded?.kind === "publication" && ship.recorded.calibration === false && /^pub-\d{8}-001$/.test(ship.recorded.id), JSON.stringify(ship.recorded));
check("jev_ship が round の合否を控える", ship.recorded.jev_round_result === all1.result);
check("存在しない round は拒否する", isErr(await call("jev_ship", { artifact: "x", decision: "ship", round_seq: 9999 })));
const shipTool = (await client.listTools()).tools.find((t) => t.name === "jev_ship");
check("jev_ship が Jev は公開可否を判定しないと明示する", /禁止事項 #4/.test(shipTool.description) && /較正には使わない/.test(shipTool.description));

const feed = parse(await call("jev_feed", { since_seq: 0, limit: 1000 }));
check("feed が層の検査と round を返す", feed.records.some((r) => r.kind === "review" && r.layer) && feed.records.some((r) => r.kind === "round"));
check("feed の層の記録に層名と入力のハッシュが入る", feed.records.filter((r) => r.kind === "review" && r.layer).every((r) => r.layer_label && r.input?.state_sha256));
check("feed のレコードにルーブリックの版が入る", feed.records.filter((r) => r.kind === "review" && r.layer).every((r) => r.rubric_version === "0.4.0"));
check("記録に note は残るが state には入れない", feed.records.find((r) => r.seq === text1.seq)?.note === "初版");
const tail = parse(await call("jev_feed", { since_seq: feed.next_since_seq - 1 }));
check("feed が since_seq を尊重する", tail.records.length === 1);

const status = parse(await call("jev_status", {}));
check("status がラン後に idle に戻る", status.state.status === "idle", status.state.status);
check("status に overall が残っていない", !JSON.stringify(status).includes("overall"));
check("status の run に層が入る", status.runs.some((r) => r.layer === "figure"));

// R6: jev_decide が禁止事項 #4 の抜け道にならないよう description で抑止する
const decideTool = (await client.listTools()).tools.find((t) => t.name === "jev_decide");
check("jev_decide が公開可否に使うなと明示する", /公開可否/.test(decideTool.description) && /禁止事項 #4/.test(decideTool.description), decideTool.description?.slice(0, 120));
check("jev_decide が jev_gate の再構成を禁じる", /再構成しない/.test(decideTool.description));
const decide = parse(await call("jev_decide", { state: "テスト", questions: { some_defect: { type: "boolean", instructions: "欠陥があるか" } } }));
check("decide が boolean を probability で返す", typeof decide.answers.some_defect.probability === "number");

await client.close();

// ── D. 較正（HANDOFF 7章）。Jev を呼ばず、作った回答で集計ロジックを検査する ─────────
console.log("\nD. 較正");
{
  const cal = await import("./calibrate-core.js");
  const rubric = loadLayer(pkgRoot, "figure");
  const nonCrit = rubric.questions.filter((q) => q.group === "g2_figure_labeling" && !q.critical).map((q) => q.key);
  const [g2a, g2b, g2c] = nonCrit;
  check("較正用に②の g2 に非 critical の質問が3問ある", g2a && g2b && g2c);
  // 全問 0.1（critical 閾値 0.5 未満）を土台に、指定の質問だけ上げる。
  const answersWith = (hi = {}, { drop = null } = {}) => {
    const a = {};
    for (const q of rubric.questions) if (q.key !== drop) a[q.key] = { type: "boolean", probability: hi[q.key] ?? 0.1 };
    return a;
  };
  const clean = answersWith();
  check("欠陥なし → pass", cal.judgeAt(clean, rubric, 0.7).jev === "pass");
  const twoG2 = answersWith({ [g2a]: 0.75, [g2b]: 0.75 });
  check("同じ群で2件 0.75 → 閾値 0.7 で fail", cal.judgeAt(twoG2, rubric, 0.7).jev === "fail");
  check("同じ群で2件 0.75 → 閾値 0.8 で pass", cal.judgeAt(twoG2, rubric, 0.8).jev === "pass");
  check("欠陥1件（群FAIL なし＝revise）は pass に対応づく", cal.judgeAt(answersWith({ [g2a]: 0.9 }), rubric, 0.7).jev === "pass");
  check("回答欠落 → unknown（pass に倒さない）", cal.judgeAt(answersWith({}, { drop: g2a }), rubric, 0.7).jev === "unknown");
  // Drive 版 calibrate.js は s7 の score を verdict に入れ、しかも 0 起点のまま 4 と比べていた。
  const TL = loadLayer(pkgRoot, "text");
  const textAnswers = Object.fromEntries(TL.questions.map((q) => [q.key, { type: "boolean", probability: 0.1 }]));
  check("s7 が最低点でも①の verdict は落ちない（s7 は人間確認の別枠）", cal.judgeAt({ ...textAnswers, s7_originality: { type: "score", score: 0 } }, TL, 0.7).jev === "pass");

  const svg = { path: "f.svg", content: "<svg><text>x</text></svg>" };
  const samples = [
    { id: "A", layer: "figure", task: "t", figure_file: svg, human_verdict: "fail", group_labels: { g2_figure_labeling: "fail" }, boundary: true },
    { id: "B", layer: "figure", task: "t", figure_file: svg, human_verdict: "pass" },
    { id: "C", layer: "figure", task: "t", figure_file: svg, human_verdict: "pass" },
  ];
  const evals = [
    { id: "A", layer: "figure", rubric_version: rubric.version, mode: "live", answers: twoG2 },
    { id: "B", layer: "figure", rubric_version: rubric.version, mode: "live", answers: answersWith({ [g2b]: 0.65, [g2c]: 0.65 }) },
    { id: "C", layer: "figure", rubric_version: rubric.version, mode: "stub", answers: twoG2 },
  ];
  const report = cal.buildReport(samples, evals, { repoRoot: pkgRoot });
  const rep = report.layers.figure;
  const at = (th) => rep.threshold_sweep.find((s) => s.threshold === th);
  check("報告は層ごとに分かれる", Object.keys(report.layers).join() === "figure" && rep.layer_label === "② 図単体");
  check("④公開判断は較正に使わないと明記する", /④/.test(report.publication_note));
  check("stub の回答は集計から外す", rep.n === 2 && rep.warnings.some((w) => /stub/.test(w)));
  check("閾値 0.6 以下では B を過剰に落とす", at(0.5).too_strict === 1 && at(0.6).too_strict === 1);
  check("閾値 0.8 以上では A を見逃す", at(0.8).too_lenient === 1 && at(0.9).too_lenient === 1);
  check("一致率最大の 0.7 を採用する", rep.chosen_threshold === 0.7 && rep.agreement_rate === 1, JSON.stringify(rep.threshold_sweep));
  check("人間が挙げた群で落ちたかを見る（group_labels）", rep.rows.find((r) => r.id === "A").caught_intended === true);
  check("境界事例の一致率を出す", rep.boundary_agreement === 1);
  check("②では critical / group_fail_at だけが較正対象外（s7 は問わない）", rep.not_calibrated.length === 2);

  const tie = cal.buildReport(samples.slice(1, 2), evals.slice(1, 2), { repoRoot: pkgRoot }).layers.figure;
  check("同点なら現行値に近い閾値を選び、同点を警告する", tie.chosen_threshold === 0.7 && tie.warnings.some((w) => /同点/.test(w)), JSON.stringify(tie.threshold_sweep));

  const round = cal.expandEvaluations(cal.compactEvaluations(evals));
  check("貼り戻し用 JSON を戻しても層と判定が変わらない", round.every((e, i) => e.layer === "figure" && cal.judgeAt(e.answers, rubric, 0.7).jev === cal.judgeAt(evals[i].answers, rubric, 0.7).jev));

  const bad = cal.validateSamples(
    [
      { id: "x", layer: "poster", task: "t", human_verdict: "fail" },
      { id: "x", layer: "figure", figure_file: svg, human_verdict: "maybe" },
      { id: "y", layer: "figure", figure_file: svg, human_verdict: "fail", target_group: "g6_article_structure" },
      { id: "z", layer: "text", task: "t", text: { path: "z.md", content: "x".repeat(70000) }, human_verdict: "fail" },
      { id: "d", scope: "diagram", task: "t", content: "c", human_verdict: "fail" },
      { id: "n", layer: "alignment", task: "t", text: { path: "n.md", content: "本文" }, human_verdict: "pass" },
    ],
    pkgRoot
  );
  check("未知の layer を弾く", bad.errors.some((e) => /x: layer/.test(e)));
  check("id の重複を弾く", bad.errors.some((e) => /重複/.test(e)));
  check("human_verdict の値を検査する", bad.errors.some((e) => /human_verdict/.test(e)));
  check("その層で問わない群を書くと弾く", bad.errors.some((e) => /g6_article_structure/.test(e)));
  check("長すぎる本文は切り詰めずに弾く", bad.errors.some((e) => /z: text が上限/.test(e)), JSON.stringify(bad.errors));
  check("層分割前の diagram 一括の標本は弾く", bad.errors.some((e) => /d: 層分割より前/.test(e)));
  check("③に図が無い標本は弾く", bad.errors.some((e) => /n: 入力を組めない/.test(e)));
  const legacy = cal.validateSamples([{ id: "a", layer: "text", legacy_scope: "article", task: "t", text: { path: "a", content: "本文" }, human_verdict: "pass" }], pkgRoot);
  check("層分割前の article 標本は①として通る", legacy.errors.length === 0, JSON.stringify(legacy.errors));
  check("pass が0件なら警告する", cal.validateSamples([samples[0]], pkgRoot).warnings.some((w) => /pass が0件/.test(w)));
  check("②③が閾値を共有すると警告する", cal.validateSamples([samples[0], { id: "al", layer: "alignment", text: { path: "a.md", content: "本文" }, figure_file: svg, human_verdict: "pass" }], pkgRoot).warnings.some((w) => /共有/.test(w)));

  const { default: calibrateApi } = await import("../api/calibrate.js");
  const callApi = async (env, path) => {
    const saved = process.env.PROBE_TOKEN;
    if (env === undefined) delete process.env.PROBE_TOKEN;
    else process.env.PROBE_TOKEN = env;
    const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await calibrateApi({ url: path, headers: { host: "t" } }, res);
    if (saved === undefined) delete process.env.PROBE_TOKEN;
    else process.env.PROBE_TOKEN = saved;
    return res;
  };
  check("PROBE_TOKEN 未設定なら /api/calibrate は実行しない", (await callApi(undefined, "/api/calibrate")).statusCode === 403);
  check("token 違いは 401", (await callApi("s", "/api/calibrate?token=x")).statusCode === 401);
  check("stub では較正しない", (await callApi("s", "/api/calibrate?token=s")).statusCode === 503);
}

console.log(fails.length ? `\n${fails.length} failed: ${fails.join(", ")}` : `\nall ok — ${"mode="}${ping.mode}`);
process.exit(fails.length ? 1 : 0);
