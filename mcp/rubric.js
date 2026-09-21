// 仕組み図解 の品質ルーブリック。
// 仕様は docs/HANDOFF-jev-gate.md 3章。リポジトリ直下に jev.rubric.json を置くと差し替えられる。
//
// 極性は defect。全ての boolean 質問は「欠陥が存在するか」を問い、probability は
// 欠陥が存在する確率。HANDOFF 3.2: v0.1 は逆の極性（「良いか」）だった。古いコードを
// 流用する場合は必ず反転すること — loadRubric が polarity を検査して誤流用を止める。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readScoreLevel, readProbability, readScore } from "./jev.js";

// s7_originality の水準。低→高の順。
const LEVELS = [
  "水準1: 一般に入手できる情報の再構成のみ。一次経験の痕跡がない",
  "水準2: 経験を語っているが、どの現場・どの制約でも言える内容",
  "水準3: 具体的な事象に触れているが、判断の理由まで踏み込んでいない",
  "水準4: 具体的な事象と、そこで何を選び何を捨てたかが書かれている",
  "水準5: その現場に立った者しか書けない制約・失敗・回避策が書かれている",
];

// 群。HANDOFF 3.5 の群構成に既存の項目キーを割り当てたもの。
// 本来の群構成（g1 は 4 問、g2 は 6 問…）とは項目数が合わない。次ラウンドで
// rubric-article.json / rubric-diagram.json に差し替える前提の暫定形。
const GROUPS = [
  { key: "g1_traceability", label: "トレーサビリティ" },
  { key: "g2_figure_labeling", label: "図のラベリング" },
  { key: "g3_text_figure_alignment", label: "本文と図の整合" },
  { key: "g4_granularity_flow", label: "粒度と流れ" },
  { key: "g5_epistemic", label: "認識の妥当性" },
];

export const DEFAULT_RUBRIC = {
  profile: "zukai",
  polarity: "defect",
  levels: LEVELS,
  groups: GROUPS,
  // 全て boolean。criteria は付けない。
  // （HANDOFF 5.1 は「両方揃えるか両方省くか、片方だけはエラー」としているが、
  //  EvaluationModelV4 の型では true / false が各々 optional。付けないので影響しない。）
  questions: [
    {
      key: "standalone",
      label: "自己完結性",
      group: "g1_traceability",
      instructions:
        "口頭の補足説明なしでは、この図だけを見た第三者が仕組みを理解できない箇所があるか。指示語の指す先が図内で辿れない、前提が図外にある等。",
    },
    {
      key: "labels",
      label: "ラベルの一般論語",
      group: "g2_figure_labeling",
      instructions:
        "ラベルに「最適化」「連携強化」「効率化」のような一般論語が使われているか。主体・動作・対象のいずれかが特定できないラベルがあるか。",
    },
    {
      key: "legibility",
      label: "可読性の不足",
      group: "g2_figure_labeling",
      instructions:
        "スマートフォン幅で読めない箇所があるか。ライトモード・ダークモードのいずれかでコントラストが不足しているか。文字が小さすぎる箇所があるか。",
    },
    {
      key: "structure",
      label: "構造の不一致",
      group: "g3_text_figure_alignment",
      critical: true,
      instructions:
        "構造（要素の分け方・階層・包含関係）が説明対象の仕組みを写していない箇所があるか。並列でないものが並列に置かれている、包含関係が逆または欠けている等。",
    },
    {
      key: "causality",
      label: "因果の曖昧さ",
      group: "g3_text_figure_alignment",
      instructions:
        "矢印・順序・分岐に曖昧さがあるか。向きや起点終点が不明な線、何が何を引き起こすのか読み取れない箇所があるか。",
    },
    {
      key: "density",
      label: "情報密度の破綻",
      group: "g4_granularity_flow",
      instructions:
        "情報量が1枚で処理できる範囲を超えているか。または薄すぎて図解にした意味がない状態か。",
    },
    {
      key: "hierarchy",
      label: "視覚階層の不整合",
      group: "g4_granularity_flow",
      instructions:
        "サイズ・色・配置が重要度の順序と一致していないか。最も重要な要素より先に目に入る装飾的要素があるか。",
    },
    {
      key: "grounded",
      label: "裏付けのない断定",
      group: "g5_epistemic",
      critical: true,
      instructions:
        "図解に、入力資料で裏付けられていない断定・具体的数値・製品名が混入しているか。出典の粒度が主張の粒度に対応していない箇所があるか。",
      // HANDOFF 3.4: これが立っても「出典を確認せよ」という指示であり、
      // 「事実が間違っている」という判定ではない。真偽検証は Jev の死角。
      means: "出典を確認せよ（事実の真偽判定ではない。確認作業は人間かウェブ検索が要る）",
    },
  ],
  // 唯一の scored 質問。verdict には算入しない。
  // HANDOFF 禁止事項 #3: s7 の人間確認を外さない。Jev の死角であり、
  // もっともらしく具体的な記述を生成すれば通過できてしまう。
  scored: {
    key: "s7_originality",
    label: "一次経験の裏打ち",
    instructions:
      "この内容は、組み込み・低レイヤの一次経験に裏打ちされているか。一般に入手できる情報の再構成にとどまっていないか。",
    threshold: 4,
    human_review_required: true,
  },
  // HANDOFF 3.3。いずれも較正前の暫定値。0.70 と 0.50 に根拠はない。
  thresholds: {
    probability_threshold: 0.7,
    critical_probability_threshold: 0.5,
    group_fail_at: 2,
    calibrated: false,
  },
};

export function loadRubric(repoRoot) {
  const path = join(repoRoot, "jev.rubric.json");
  if (!existsSync(path)) return DEFAULT_RUBRIC;
  const custom = JSON.parse(readFileSync(path, "utf8"));
  // 極性の誤流用を止める。v0.1 の「良いか」極性のルーブリックを読み込むと
  // 判定が全て裏返り、欠陥のある図解が ship になる。
  if (custom.polarity !== "defect") {
    throw new Error(
      'jev.rubric.json の polarity が "defect" ではありません。' +
        "全ての boolean 質問は「欠陥が存在するか」を問う形でなければなりません（HANDOFF 3.2）。"
    );
  }
  return { ...DEFAULT_RUBRIC, ...custom, source: "jev.rubric.json" };
}

export function buildQuestions(rubric) {
  const questions = {};
  for (const q of rubric.questions) {
    questions[q.key] = { type: "boolean", instructions: q.instructions };
  }
  questions[rubric.scored.key] = {
    type: "score",
    instructions: rubric.scored.instructions,
    criteria: rubric.levels,
  };
  return questions;
}

function thresholdFor(question, thresholds) {
  return question.critical
    ? thresholds.critical_probability_threshold
    : thresholds.probability_threshold;
}

/**
 * 回答を見ずに、群が構造上どこまで FAIL しうるかを出す。
 * interpret と jev_ping の両方がこれを使う（判定が2箇所でずれないように）。
 *
 * `slack` は「critical 抜きで FAIL に到達するまでの余裕」:
 *   slack  < 0  → unreachable: critical が無ければ構造上 FAIL しない
 *   slack === 0 → fragile:     critical が無ければ**全問一致**が必要で、実質ほぼ到達しない
 *
 * 二値の reachable だけだと、1問しかない群は検出できても
 * 「2問で group_fail_at=2」の群が「到達可能」と判定されて漏れる。
 */
export function groupStructure(rubric) {
  const failAt = rubric.thresholds.group_fail_at;
  return rubric.groups.map((g) => {
    const members = rubric.questions.filter((q) => q.group === g.key);
    const critical = members.filter((q) => q.critical).map((q) => q.key);
    const slack = members.length - critical.length - failAt;
    return {
      key: g.key,
      label: g.label,
      size: members.length,
      questions: members.map((q) => q.key),
      critical,
      fail_at: failAt,
      slack,
      reachable: critical.length > 0 || slack >= 0,
      fragile: critical.length === 0 && slack === 0,
    };
  });
}

export function interpret(answers, rubric) {
  const t = rubric.thresholds;

  const items = rubric.questions.map((q) => {
    const probability = readProbability(answers[q.key]);
    const threshold = thresholdFor(q, t);
    return {
      key: q.key,
      label: q.label,
      group: q.group,
      critical: Boolean(q.critical),
      probability,
      threshold,
      // null は「未回答」。欠陥なしと数えない。
      defect: probability === null ? null : probability >= threshold,
    };
  });

  // HANDOFF 4章: 答えが欠けると群の欠陥数が実際より少なく数えられ、静かにゲートが緩む。
  const missing_answers = items.filter((i) => i.defect === null).map((i) => i.key);

  const groups = groupStructure(rubric).map((g) => {
    const members = items.filter((i) => i.group === g.key);
    const defects = members.filter((i) => i.defect === true);
    const criticalDefects = defects.filter((i) => i.critical);
    return {
      ...g,
      defects: defects.map((d) => d.key),
      critical_defects: criticalDefects.map((d) => d.key),
      // critical は単独で FAIL、それ以外は群内 group_fail_at 件以上で FAIL。
      fail: criticalDefects.length > 0 || defects.length >= g.fail_at,
    };
  });

  // 構造上 FAIL しない群（unreachable）と、全問一致が要る群（fragile）を隠さない。
  // 黙って緩んでいる箇所は必ず露出させる。
  const unreachable_groups = groups.filter((g) => !g.reachable).map((g) => g.key);
  const fragile_groups = groups.filter((g) => g.fragile).map((g) => g.key);
  const failedGroups = groups.filter((g) => g.fail);
  const defects = items.filter((i) => i.defect === true);

  // 欠陥が無い質問の割合。品質スコアではない（Jev の一致度は約68%）。
  // 推移を見るためだけの値で、ゲートには使わない。
  const answered = items.filter((i) => i.defect !== null);
  const clean_ratio = answered.length
    ? Number(((answered.length - defects.length) / answered.length).toFixed(3))
    : null;

  // scored は verdict に算入しない。人間確認の対象として別枠で返す。
  // score は 0 起点の小数位置。threshold は水準番号（1 起点）で書かれているので level と比べる。
  const rawScore = readScore(answers[rubric.scored.key]);
  const scoreRead = readScoreLevel(rawScore, rubric.levels.length);
  const scoreLevel = scoreRead?.level ?? null;
  const human_review = {
    required: true,
    key: rubric.scored.key,
    label: rubric.scored.label,
    raw: rawScore, // 0 起点の小数位置
    level: scoreLevel, // 1 起点表記。小数のまま（3.6 は水準4に届いていない）
    level_description:
      scoreLevel === null
        ? null
        : rubric.levels[Math.min(rubric.levels.length - 1, Math.round(scoreLevel) - 1)],
    threshold: rubric.scored.threshold,
    meets_threshold: scoreLevel === null ? null : scoreLevel >= rubric.scored.threshold,
    note:
      "Jev の出力は参考値。一次経験の有無は state のテキストからは検証できない（HANDOFF 3.4）。" +
      "人間が確認するまで ship を名乗らないこと（禁止事項 #3）。",
  };

  let verdict;
  if (missing_answers.length) verdict = "unknown";
  else if (failedGroups.length) verdict = "block";
  else if (defects.length) verdict = "revise";
  else verdict = "ship";

  return {
    verdict,
    polarity: "defect",
    // 「欠陥なしと答えられた質問の割合」。**品質スコアではないのでゲートに使わない。**
    // かつて overall という名前で出していたが、名前が必ず誤用されるので廃止した。
    clean_ratio,
    items,
    groups,
    defects: defects.map((d) => d.key),
    failed_groups: failedGroups.map((g) => g.key),
    missing_answers,
    unreachable_groups,
    fragile_groups,
    human_review,
    calibrated: Boolean(rubric.thresholds.calibrated),
  };
}

export function fixList(interpreted, rubric) {
  const byKey = new Map(rubric.questions.map((q) => [q.key, q]));
  const failed = new Set(interpreted.failed_groups);
  return interpreted.defects.map((key) => {
    const q = byKey.get(key);
    return {
      key,
      label: q?.label ?? key,
      group: q?.group ?? null,
      critical: Boolean(q?.critical),
      // 群が FAIL している項目から先に直す。群 FAIL していない欠陥は revise 止まり。
      blocking: q ? failed.has(q.group) : false,
      probability: interpreted.items.find((i) => i.key === key)?.probability ?? null,
      instructions: q?.instructions ?? "",
      means: q?.means,
    };
  });
}
