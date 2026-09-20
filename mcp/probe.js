#!/usr/bin/env node
// probe — 実キーで Jev に 1 往復し、認証・モデル名・返り値の形を確かめる。
// HANDOFF 6章「順序の原則」: これが通るまで先へ進まない。
//
//   echo 'AI_GATEWAY_API_KEY=...' > .env   # ファイル名は必ず .env
//   npm run probe
//
// 型の契約（@ai-sdk/provider EvaluationModelV4）は読んで確認済み:
//   boolean -> { type:'boolean', probability }  probability は P(true) in [0,1]
//   score   -> { type:'score', score }          score は 0 起点の小数位置 [0, 水準数-1]
// probe が確かめるのは **実際にその形で返ってくるか** と、認証が通るかである。

import { callJev, describeClient, MODE, readProbability, readScore, readScoreLevel } from "./jev.js";

const client = describeClient();
console.log("client:", JSON.stringify(client, null, 2));

if (MODE !== "live") {
  console.error(
    "\nAI_GATEWAY_API_KEY が無いため stub モードです。probe は実キーでの疎通確認が目的なので意味がありません。" +
      "\n.env に AI_GATEWAY_API_KEY を書いてから再実行してください（.env.local は読まれません）。"
  );
  process.exit(1);
}

const LEVELS = ["水準1: 全く当てはまらない", "水準2", "水準3", "水準4", "水準5: 完全に当てはまる"];

const state = [
  "# 評価対象",
  "この文章は probe 用のダミーです。出典のない断定として「処理速度が3倍になりました」と書いてあります。",
  "具体的な計測条件・比較対象・測定環境はどこにも書かれていません。",
].join("\n");

const questions = {
  // 欠陥極性。ダミーには裏付けのない数値があるので probability は高く出るはず。
  ungrounded_number: {
    type: "boolean",
    instructions: "この文章に、出典や測定条件のない具体的な数値が書かれているか。",
  },
  // 対照。明らかに当てはまらないので probability は低く出るはず。
  contains_svg: {
    type: "boolean",
    instructions: "この文章に SVG のソースコードが含まれているか。",
  },
  detail_level: {
    type: "score",
    instructions: "計測条件がどの程度詳しく書かれているか。",
    criteria: LEVELS,
  },
};

const fails = [];
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails.push(name);
};

let res;
try {
  res = await callJev(state, questions);
} catch (e) {
  console.error(`\n呼び出しに失敗しました: ${e.message}`);
  console.error(
    "\n確認すること:" +
      "\n  - .env のファイル名（dotenv 相当の読み込みは .env のみ）" +
      "\n  - Vercel AI Gateway のカード登録（無料枠でも必須）" +
      "\n  - モデル ID（JEV_MODEL で上書きできる。既定 typesafe-ai/jev）"
  );
  process.exit(1);
}

console.log("\nraw answers:", JSON.stringify(res.answers, null, 2));
console.log("usage:", JSON.stringify(res.usage));
console.log("rounding:", JSON.stringify(res.rounding));
if (res.provider_warnings.length) console.log("provider warnings:", JSON.stringify(res.provider_warnings));

console.log("\n返り値の形");
const ug = res.answers.ungrounded_number;
const sv = res.answers.contains_svg;
const dl = res.answers.detail_level;

check("boolean に type:'boolean' が付く", ug?.type === "boolean", JSON.stringify(ug));
check("boolean は probability を返す", readProbability(ug) !== null, JSON.stringify(ug));
check("boolean に value フィールドは無い", ug !== undefined && !("value" in ug), JSON.stringify(ug));
check("score に type:'score' が付く", dl?.type === "score", JSON.stringify(dl));
const rawScore = readScore(dl);
check("score は score フィールドで返る", rawScore !== null, JSON.stringify(dl));
const read = readScoreLevel(rawScore, LEVELS.length);
check(
  `score は 0 起点 [0, ${LEVELS.length - 1}] の範囲に収まる`,
  read !== null,
  `raw=${rawScore}（範囲外なら 1 起点で返っている疑い。jev.js の readScoreLevel を見直すこと）`
);
if (read) console.log(`       score raw=${read.raw} → 水準 ${read.level}`);

console.log("\n極性の向き（参考。1サンプルなので判定ではない）");
const pUngrounded = readProbability(ug);
const pSvg = readProbability(sv);
console.log(`  出典なき数値あり: probability=${pUngrounded}（高いほど「欠陥あり」）`);
console.log(`  SVGを含む:        probability=${pSvg}（低いはず）`);
if (pUngrounded !== null && pSvg !== null && pUngrounded <= pSvg) {
  console.log(
    "  ※ 期待と逆の並びです。ルーブリックの instructions か、モデルの極性解釈を確認してください。"
  );
}

console.log(
  fails.length
    ? `\n${fails.length} failed: ${fails.join(", ")}\n形が違う場合、jev.js の読み取り関数を実測に合わせること。`
    : "\nall ok — 返り値の形は契約どおり。較正（samples.json → calibrate）へ進めます。"
);
process.exit(fails.length ? 1 : 0);
