// 品質ルーブリックの読み込みと判定。仕様は docs/HANDOFF-jev-gate.md 3章。
//
// ルーブリックの実体は **リポジトリ直下の rubric-article.json / rubric-diagram.json**。
// これは Google Drive「99. Jev連携」の同名ファイル（v0.4.0）をそのまま取り込んだもので、
// HANDOFF 3.1 の「共通版は作らない」に従い2本立てになっている:
//
//   rubric-article.json  図を伴わない文章    g1 / g4 / g5 / g6   18問 + scored 1
//   rubric-diagram.json  図解コンテンツ      g1 / g2 / g3 / g4 / g5  22問 + scored 1
//
// （HANDOFF 3.1 の本文は diagram を「20問」としているが、3.5 の内訳の合計も Drive の
//   実ファイルも 22問。付記 B に記録したとおり 3.1 の記載ミスと判断している。）
//
// 極性は defect。全ての boolean 質問は「欠陥が存在するか」を問い、probability は
// 欠陥が存在する確率。HANDOFF 3.2: v0.1 は逆の極性（「良いか」）だった。古いコードや
// 古いルーブリックを流用する場合は必ず反転すること — loadRubric が polarity を検査して止める。

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readScoreLevel, readProbability, readScore } from "./jev.js";

// ルーブリックの正本はリポジトリに同梱されている。ZUKAI_REPO_ROOT は評価対象と
// .jev/ の置き場所であってルーブリックの置き場所ではないので、既定はパッケージ側を見る。
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SCOPES = ["diagram", "article"];
export const DEFAULT_SCOPE = "diagram";

const SCOPE_NOTE = {
  diagram: "図解コンテンツ用。g2（軸・単位）と g3（本文と図の整合）を含む。",
  article: "図を伴わない文章用。g2 / g3 は図が無いと空振りするので外し、g6（記事構成）を足す。",
};

// 質問IDの短い表示名。ルーブリックJSON（Drive 正本）には label が無いので、
// 表示とダッシュボードのためにここで持つ。**判定には一切使わない。**
// 未知のIDはキーをそのまま出す（黙って空欄にしない）。
const QUESTION_LABELS = {
  g1_omitted_subject: "主語の省略",
  g1_vague_deixis: "指示語の曖昧さ",
  g1_unexplained_topic_shift: "話題転換の不明瞭",
  g1_requires_backtracking: "読み返しの強制",
  g2_no_title: "タイトルの欠落",
  g2_axis_meaning_unclear: "軸の意味の不明示",
  g2_missing_unit: "単位の欠落",
  g2_label_data_mismatch: "ラベルとデータの不一致",
  g2_misleading_scale: "誤解を招くスケール",
  g2_missing_legend: "凡例の欠落",
  g3_question_mismatch: "問いと図の不一致",
  g3_wrong_chart_type: "図種の誤り",
  g3_missing_time_axis: "時間軸の欠落",
  g3_granularity_gap: "本文と図の粒度差",
  g3_figure_not_supporting: "補強の不成立",
  g4_opening_too_abstract: "冒頭の抽象度",
  g4_premise_skipped: "前提の飛ばし",
  g4_question_info_mismatch: "問いと情報の粒度不整合",
  g4_mixed_concerns: "論点の混在",
  g4_abrupt_abstraction_jump: "抽象度の跳躍",
  g5_unmarked_speculation: "無標の推測",
  g5_fabricated_specificity: "出典なき具体性",
  g5_source_granularity_gap: "出典粒度の不一致",
  g5_overstated_conclusion: "結論の誇張",
  g6_no_conclusion_first: "結論先出しの欠如",
  g6_generic_advice: "一般論",
  g6_no_downside: "リスクの欠落",
  g6_not_actionable: "実行不能",
  g6_filler: "定型句",
};

// HANDOFF 3.4: g5_* が立っても「出典を確認せよ」という指示であり、
// 「その事実が間違っている」という判定ではない。真偽検証は Jev の死角。
const G5_MEANS =
  "出典を確認せよ（事実の真偽判定ではない。確認作業は人間かウェブ検索が要る）";

function rubricPath(repoRoot, scope) {
  // リポジトリ側に同名ファイルがあればそちらを使う（較正の結果を反映する置き場所）。
  const local = repoRoot ? join(repoRoot, `rubric-${scope}.json`) : null;
  if (local && existsSync(local)) return { path: local, origin: "repo_root" };
  const bundled = join(PKG_ROOT, `rubric-${scope}.json`);
  if (existsSync(bundled)) return { path: bundled, origin: "bundled" };
  return null;
}

/**
 * Drive 正本の形（群がオブジェクト、質問が群の中のオブジェクト）を、
 * 判定側が使う平坦な形に直す。**内容は足さない。** 足すと Drive と食い違う。
 */
function normalize(raw, scope, source) {
  // 極性の誤流用を止める。v0.1 の「良いか」極性を読み込むと判定が全て裏返り、
  // 欠陥のある成果物が ship になる。
  if (raw.polarity !== "defect") {
    throw new Error(
      `${source.file} の polarity が "defect" ではありません（実際: ${JSON.stringify(raw.polarity)}）。` +
        "全ての boolean 質問は「欠陥が存在するか」を問う形でなければなりません（HANDOFF 3.2）。"
    );
  }
  if (raw.scope && raw.scope !== scope) {
    throw new Error(
      `${source.file} の scope が "${raw.scope}" です。"${scope}" として読み込もうとしています。` +
        "取り違えると図の無い文章に g2/g3 を当てることになります。"
    );
  }

  const groups = [];
  const questions = [];
  for (const [groupKey, group] of Object.entries(raw.groups || {})) {
    groups.push({ key: groupKey, label: group.label || groupKey });
    for (const [key, q] of Object.entries(group.questions || {})) {
      if (q.type !== "boolean") {
        throw new Error(`${source.file} の ${key} は type が "${q.type}" です。群の質問は boolean のみ。`);
      }
      if (typeof q.instructions !== "string" || !q.instructions.trim()) {
        throw new Error(`${source.file} の ${key} に instructions がありません。`);
      }
      questions.push({
        key,
        label: QUESTION_LABELS[key] || key,
        group: groupKey,
        critical: Boolean(q.critical),
        instructions: q.instructions,
        ...(groupKey === "g5_epistemic" ? { means: G5_MEANS } : {}),
      });
    }
  }
  if (!groups.length || !questions.length) {
    throw new Error(`${source.file} に群または質問がありません。`);
  }

  // scored は1つだけ（HANDOFF 3.5: scored は s7_originality のみ）。
  const scoredEntries = Object.entries(raw.scored || {});
  if (scoredEntries.length !== 1) {
    throw new Error(`${source.file} の scored は1件でなければなりません（実際: ${scoredEntries.length}件）。`);
  }
  const [scoredKey, scored] = scoredEntries[0];
  if (!Array.isArray(scored.criteria) || scored.criteria.length < 2) {
    throw new Error(
      `${source.file} の ${scoredKey} に criteria（低→高の順序付き水準説明の配列）がありません。` +
        "score 質問は scale ではなく criteria で水準を渡す（HANDOFF 5.1）。"
    );
  }

  const scoring = raw.scoring || {};
  for (const k of ["probability_threshold", "critical_probability_threshold", "group_fail_at"]) {
    if (typeof scoring[k] !== "number") {
      throw new Error(`${source.file} の scoring.${k} が数値ではありません。`);
    }
  }

  return {
    scope,
    scope_note: SCOPE_NOTE[scope],
    version: raw.rubric_version || null,
    updated: raw.updated || null,
    source: source.file,
    source_origin: source.origin,
    polarity: "defect",
    levels: scored.criteria,
    groups,
    questions,
    scored: {
      key: scoredKey,
      label: "一次経験の裏打ち",
      instructions: scored.instructions,
      criteria: scored.criteria,
      // HANDOFF 禁止事項 #3: s7 の人間確認を外さない。JSON が false でも外させない。
      human_review_required: true,
      threshold: scored.threshold,
      blind_spot: scored.blind_spot || null,
    },
    thresholds: {
      probability_threshold: scoring.probability_threshold,
      critical_probability_threshold: scoring.critical_probability_threshold,
      group_fail_at: scoring.group_fail_at,
      rationale: scoring.rationale || null,
      // HANDOFF 3.3「0.70 と 0.50 に根拠はない。較正でスイープして決めること」。
      // 較正済みを名乗れるのは samples.json と calibrate を通した後だけ。
      calibrated: raw.calibrated === true,
    },
    escalation: {
      max_retries: raw.escalation?.max_retries ?? 3,
      compare_at: raw.escalation?.compare_at ?? "group",
    },
  };
}

const cache = new Map();

/**
 * @param {string} repoRoot 評価対象リポジトリのルート（ルーブリックの上書き置き場）
 * @param {"diagram"|"article"} scope 対象コンテンツの種類
 */
export function loadRubric(repoRoot, scope = DEFAULT_SCOPE) {
  if (!SCOPES.includes(scope)) {
    throw new Error(`未知の scope: ${JSON.stringify(scope)}。${SCOPES.join(" / ")} のいずれか。`);
  }
  const found = rubricPath(repoRoot, scope);
  if (!found) {
    // 無いときに弱い内蔵ルーブリックへ落ちない。基準が黙って入れ替わるくらいなら止める。
    throw new Error(
      `rubric-${scope}.json が見つかりません（探した場所: ${repoRoot} と ${PKG_ROOT}）。` +
        "Drive「99. Jev連携」の同名ファイルを配置すること。"
    );
  }
  const file = `rubric-${scope}.json`;
  const key = `${found.path}::${scope}`;
  const stamp = readFileSync(found.path, "utf8");
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.rubric;

  let raw;
  try {
    raw = JSON.parse(stamp);
  } catch (e) {
    throw new Error(`${file} が JSON として読めません: ${e.message}`);
  }
  const rubric = normalize(raw, scope, { file, origin: found.origin, path: found.path });
  cache.set(key, { stamp, rubric });
  return rubric;
}

/** 全 scope を読む。jev_ping が両方の構造を報告するのに使う。 */
export function loadAllRubrics(repoRoot) {
  return SCOPES.map((scope) => loadRubric(repoRoot, scope));
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

  // 検査器の出力は合格/不合格の2値（2026-09-25 本人決定）。
  // 群FAIL が無ければ合格。単発の欠陥（revise）も合格にする: 一致度約68%で欠陥1件を不合格にすると
  // 誤検出で毎回落ちてループを使い切る（HANDOFF 3.3）。critical は単独で群FAIL になるので止まる。
  // 判定不能（unknown）は合格にしない（禁止事項 #5）。直す対象が無いので修正ではなく人間に返す。
  const result = verdict === "ship" || verdict === "revise" ? "pass" : "fail";
  const fail_reason = verdict === "unknown" ? "unknown" : verdict === "block" ? "group_fail" : null;

  return {
    result,
    fail_reason,
    verdict,
    scope: rubric.scope,
    rubric_version: rubric.version,
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
