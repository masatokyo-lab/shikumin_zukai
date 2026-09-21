// probe の中身。CLI（mcp/probe.js）と Vercel の関数（api/probe.js）の両方から呼ぶ。
// 出力は console に書かず行の配列で返す。関数側でレスポンスに載せるため。
//
// 型の契約（@ai-sdk/provider EvaluationModelV4）は読んで確認済み:
//   boolean -> { type:'boolean', probability }  probability は P(true) in [0,1]
//   score   -> { type:'score', score }          score は 0 起点の小数位置 [0, 水準数-1]
// probe が確かめるのは **実際にその形で返ってくるか** と、認証が通るかである。

import { callJev, describeClient, MODE, readProbability, readScore, readScoreLevel } from "./jev.js";

const LEVELS = ["水準1: 全く当てはまらない", "水準2", "水準3", "水準4", "水準5: 完全に当てはまる"];

const STATE = [
  "# 評価対象",
  "この文章は probe 用のダミーです。出典のない断定として「処理速度が3倍になりました」と書いてあります。",
  "具体的な計測条件・比較対象・測定環境はどこにも書かれていません。",
].join("\n");

const QUESTIONS = {
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

export async function runProbe() {
  const lines = [];
  const checks = [];
  const fails = [];
  const log = (s = "") => lines.push(s);
  const check = (name, cond, detail) => {
    checks.push({ name, ok: Boolean(cond), detail: detail ?? null });
    log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) fails.push(name);
  };

  const client = describeClient();
  log("client: " + JSON.stringify(client, null, 2));

  if (MODE !== "live") {
    log("");
    log(
      "AI_GATEWAY_API_KEY が無いため stub モードです。probe は実キーでの疎通確認が目的なので意味がありません。"
    );
    return {
      ok: false,
      reason: "not_live",
      client,
      lines,
      checks,
      fails: ["mode:live"],
      hint: "AI_GATEWAY_API_KEY を環境変数に設定してください（ローカルなら .env、Vercel なら Project Settings → Environment Variables）。",
    };
  }

  let res;
  try {
    res = await callJev(STATE, QUESTIONS);
  } catch (e) {
    log("");
    log(`呼び出しに失敗しました: ${e.message}`);
    return {
      ok: false,
      reason: "call_failed",
      error: e.message,
      client,
      lines,
      checks,
      fails: ["call"],
      hint:
        "確認すること: (1) AI_GATEWAY_API_KEY の値 (2) Vercel AI Gateway のカード登録（無料枠でも必須） (3) モデル ID（JEV_MODEL で上書き可、既定 typesafe-ai/jev） (4) この実行環境から ai-gateway.vercel.sh へ出られるか",
    };
  }

  log("");
  log("raw answers: " + JSON.stringify(res.answers, null, 2));
  log("usage: " + JSON.stringify(res.usage));
  log("rounding: " + JSON.stringify(res.rounding));
  if (res.provider_warnings.length) log("provider warnings: " + JSON.stringify(res.provider_warnings));

  log("");
  log("返り値の形");
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
  if (read) log(`       score raw=${read.raw} → 水準 ${read.level}`);

  log("");
  log("極性の向き（参考。1サンプルなので判定ではない）");
  const pUngrounded = readProbability(ug);
  const pSvg = readProbability(sv);
  log(`  出典なき数値あり: probability=${pUngrounded}（高いほど「欠陥あり」）`);
  log(`  SVGを含む:        probability=${pSvg}（低いはず）`);
  const polarityInverted =
    pUngrounded !== null && pSvg !== null && pUngrounded <= pSvg;
  if (polarityInverted) {
    log("  ※ 期待と逆の並びです。ルーブリックの instructions か、モデルの極性解釈を確認してください。");
  }

  log("");
  log(
    fails.length
      ? `${fails.length} failed: ${fails.join(", ")}\n形が違う場合、jev.js の読み取り関数を実測に合わせること。`
      : "all ok — 返り値の形は契約どおり。較正（samples.json → calibrate）へ進めます。"
  );

  return {
    ok: fails.length === 0,
    reason: fails.length ? "shape_mismatch" : "ok",
    client,
    lines,
    checks,
    fails,
    answers: res.answers,
    usage: res.usage,
    rounding: res.rounding,
    provider_warnings: res.provider_warnings,
    latency_ms: res.latency_ms,
    polarity: { ungrounded_number: pUngrounded, contains_svg: pSvg, inverted: polarityInverted },
  };
}
