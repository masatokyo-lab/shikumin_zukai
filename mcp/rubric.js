// 仕組み図解 の品質ルーブリック。
// リポジトリ直下に jev.rubric.json を置くと丸ごと差し替えられる。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeScore } from "./jev.js";

const LEVELS = [
  "破綻: 事実誤認・意味の通らない箇所がある",
  "要修正: 読んでも仕組みが伝わらない",
  "許容: 伝わるが粗い",
  "良好: このまま使える",
  "秀逸: 手を入れる必要がない",
];

export const DEFAULT_RUBRIC = {
  profile: "zukai",
  levels: LEVELS,
  dimensions: [
    {
      key: "structure",
      label: "構造の正確さ",
      instructions:
        "この図解の構造（要素の分け方・階層・包含関係）は、説明対象の仕組みを正しく写しているか。",
    },
    {
      key: "causality",
      label: "因果と流れ",
      instructions:
        "矢印・順序・分岐が、何が何を引き起こすのかを曖昧さなく示しているか。向きや起点終点が不明な線がないか。",
    },
    {
      key: "density",
      label: "情報密度",
      instructions:
        "1枚で処理できる情報量か。詰め込みすぎて読めない、または薄すぎて図解の意味がない状態になっていないか。",
    },
    {
      key: "hierarchy",
      label: "視覚階層",
      instructions:
        "最も重要な要素が最初に目に入るか。サイズ・色・配置が重要度の順序と一致しているか。",
    },
    {
      key: "labels",
      label: "ラベルの具体性",
      instructions:
        "ラベルが「最適化」「連携強化」のような一般論語ではなく、具体的な主体・動作・対象で書かれているか。",
    },
    {
      key: "standalone",
      label: "自己完結性",
      instructions:
        "口頭の補足説明なしに、この図だけを見た第三者が仕組みを理解できるか。",
    },
    {
      key: "legibility",
      label: "可読性",
      instructions:
        "スマートフォン幅で読めるか。ライトモード・ダークモードの双方でコントラストが確保されているか。文字が小さすぎないか。",
    },
  ],
  gates: [
    {
      key: "grounded",
      label: "裏付け",
      instructions:
        "図解に書かれた主張は、すべて入力資料で裏付けられているか。資料にない断定や数字が混入していないか。",
      min: 0.8,
    },
    {
      key: "shippable",
      label: "公開可否",
      instructions: "この図解は、これ以上直さずに社外に出せる品質か。",
      min: 0.7,
    },
  ],
  decision: {
    key: "next_action",
    instructions: "この図解に対して次に取るべき行動はどれか。",
    criteria: {
      ship: "このまま公開してよい",
      revise: "個別の要素を直せば公開できる",
      restructure: "構成そのものを作り直す必要がある",
      more_input: "元資料が足りず、判断も改善もできない",
    },
  },
  thresholds: {
    dimension_min: 0.7,
    blocking: ["structure", "causality", "labels", "grounded"],
  },
};

export function loadRubric(repoRoot) {
  const path = join(repoRoot, "jev.rubric.json");
  if (!existsSync(path)) return DEFAULT_RUBRIC;
  const custom = JSON.parse(readFileSync(path, "utf8"));
  return { ...DEFAULT_RUBRIC, ...custom, source: "jev.rubric.json" };
}

export function buildQuestions(rubric, { gateOnly = false } = {}) {
  const questions = {};
  if (!gateOnly) {
    for (const d of rubric.dimensions) {
      questions[d.key] = { type: "score", instructions: d.instructions, criteria: rubric.levels };
    }
  }
  for (const g of rubric.gates) {
    questions[g.key] = { type: "noul", instructions: g.instructions };
  }
  questions[rubric.decision.key] = {
    type: "choice",
    instructions: rubric.decision.instructions,
    criteria: rubric.decision.criteria,
  };
  return questions;
}

export function interpret(answers, rubric) {
  const levelCount = rubric.levels.length;
  const min = rubric.thresholds.dimension_min;
  const blocking = new Set(rubric.thresholds.blocking);

  const dimensions = rubric.dimensions.map((d) => {
    const value = normalizeScore(answers[d.key]?.score, levelCount);
    return {
      key: d.key,
      label: d.label,
      value,
      raw: answers[d.key]?.score ?? null,
      pass: value === null ? null : value >= min,
      blocking: blocking.has(d.key),
    };
  });

  const gates = rubric.gates.map((g) => {
    const value = typeof answers[g.key]?.noul === "number" ? answers[g.key].noul : null;
    return {
      key: g.key,
      label: g.label,
      value,
      threshold: g.min,
      pass: value === null ? null : value >= g.min,
      blocking: blocking.has(g.key),
    };
  });

  const all = [...dimensions, ...gates];
  const failures = all.filter((x) => x.pass === false);
  const blockingFailures = failures.filter((x) => x.blocking);
  const unknown = all.filter((x) => x.pass === null);

  const scored = dimensions.filter((d) => typeof d.value === "number");
  const overall = scored.length
    ? Number((scored.reduce((s, d) => s + d.value, 0) / scored.length).toFixed(3))
    : null;

  let verdict;
  if (unknown.length) verdict = "unknown";
  else if (blockingFailures.length) verdict = "block";
  else if (failures.length) verdict = "revise";
  else verdict = "ship";

  return {
    verdict,
    overall,
    dimensions,
    gates,
    failures: failures.map((f) => f.key),
    blocking_failures: blockingFailures.map((f) => f.key),
    jev_next_action: answers[rubric.decision.key]?.choice ?? null,
    jev_next_action_confidence: answers[rubric.decision.key]?.confidence ?? null,
  };
}

export function fixList(interpreted, rubric) {
  const byKey = new Map([...rubric.dimensions, ...rubric.gates].map((x) => [x.key, x]));
  return interpreted.failures.map((key) => ({
    key,
    label: byKey.get(key)?.label ?? key,
    instructions: byKey.get(key)?.instructions ?? "",
    blocking: rubric.thresholds.blocking.includes(key),
  }));
}
