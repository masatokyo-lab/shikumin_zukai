// 較正（HANDOFF 7章）。2段に分けてある:
//   1. evaluateSamples  — サンプルを Jev に通して生の回答を得る。**live が要る**（Vercel の /api/calibrate で回す）
//   2. buildReport      — 生の回答から閾値をスイープして報告を作る。**Jev を呼ばない**。どこでも再現できる
// 分けてあるので、回答を1回取れば閾値の検討は何度でもやり直せる（課金は1回分）。
//
// Drive の calibrate.js は使わない。ゲート本体（rubric.js の interpret）と判定が3点食い違うため:
//   - 回答が欠けた質問を「欠陥なし」として飛ばす（本体は unknown にして止める。禁止事項 #5）
//   - s7 の score を verdict に算入する（本体は人間確認の別枠で、verdict に入れない）
//   - s7 の score（0 起点）を 1 起点の閾値 4 とそのまま比べる（A 節。ほぼ全件が落ちる）
// 違う関数で閾値を決めても本番の閾値にはならないので、ここでは interpret をそのまま呼ぶ。

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { loadRubric, buildQuestions, interpret, SCOPES } from "./rubric.js";
import { callJev, MODE } from "./jev.js";
import { buildState, MAX_CONTENT } from "./state.js";

export const SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9];
const VERDICTS = ["pass", "fail"];

// サンプルの形:
//   { id, scope: "diagram"|"article", task, content | content_file, source_material?,
//     human_verdict: "pass"|"fail", boundary?: bool, target_group?: "g3_..."|null, provenance? }
// content_file はリポジトリ直下からの相対パス。長い SVG や原稿を JSON に埋めずに済む。
export function loadSamples(repoRoot, file = "samples.json") {
  const path = join(repoRoot, file);
  if (!existsSync(path)) throw new Error(`${file} がありません。HANDOFF 7章の形式で作ること。`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.samples;
  if (!Array.isArray(list)) throw new Error(`${file} は配列か { samples: [...] } であること。`);
  return list.map((s) => {
    if (s.content_file && s.content == null) {
      const p = resolve(repoRoot, s.content_file);
      const rel = relative(repoRoot, p);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${s.id}: content_file がリポジトリ外です`);
      return { ...s, content: readFileSync(p, "utf8") };
    }
    return s;
  });
}

export function validateSamples(samples, repoRoot) {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  for (const s of samples) {
    const tag = s?.id ?? "(id なし)";
    if (!s?.id) errors.push(`${tag}: id が無い`);
    else if (seen.has(s.id)) errors.push(`${tag}: id が重複`);
    seen.add(s?.id);
    if (!SCOPES.includes(s?.scope)) errors.push(`${tag}: scope は ${SCOPES.join(" / ")}`);
    if (!VERDICTS.includes(s?.human_verdict)) errors.push(`${tag}: human_verdict は pass / fail`);
    if (typeof s?.task !== "string" || !s.task.trim()) errors.push(`${tag}: task（依頼内容）が無い`);
    if (typeof s?.content !== "string" || !s.content.trim()) errors.push(`${tag}: content が空`);
    // 較正では黙って切り詰めない。切った後ろに欠陥があれば、ラベルと入力が食い違う。
    else if (s.content.length > MAX_CONTENT)
      errors.push(`${tag}: content が ${s.content.length} 文字で上限 ${MAX_CONTENT} を超える（本番では先頭のみ評価される）`);
    if (SCOPES.includes(s?.scope) && s.target_group != null) {
      const rubric = loadRubric(repoRoot, s.scope);
      if (!rubric.groups.some((g) => g.key === s.target_group))
        errors.push(`${tag}: target_group ${s.target_group} は ${s.scope} のルーブリックに無い`);
    }
    if (s?.human_verdict === "pass" && s?.target_group) warnings.push(`${tag}: pass なのに target_group がある（無視される）`);
  }

  for (const scope of SCOPES) {
    const mine = samples.filter((s) => s?.scope === scope);
    if (!mine.length) continue;
    const pass = mine.filter((s) => s.human_verdict === "pass").length;
    const fail = mine.length - pass;
    if (!pass) warnings.push(`${scope}: pass が0件。too_strict（過剰に落とす）が一度も測れない`);
    if (!fail) warnings.push(`${scope}: fail が0件。too_lenient（見逃し）が一度も測れない`);
    if (!mine.some((s) => s.boundary)) warnings.push(`${scope}: boundary が0件。明白な事例だけでは較正にならない（7.3）`);
    if (mine.length < 10)
      warnings.push(`${scope}: n=${mine.length}。1件の食い違いで一致率が ${Math.round(100 / mine.length)}ポイント動く。閾値は暫定扱い`);
    const rubric = loadRubric(repoRoot, scope);
    const targeted = new Set(mine.map((s) => s.target_group).filter(Boolean));
    const untargeted = rubric.groups.map((g) => g.key).filter((k) => !targeted.has(k));
    if (untargeted.length) warnings.push(`${scope}: 失敗例の無い群 ${untargeted.join(", ")}（caught_intended が測れない）`);
  }
  return { errors, warnings };
}

export function stateFor(sample) {
  return buildState({
    task: sample.task,
    sourceMaterial: sample.source_material,
    artifact: { content: sample.content, path: sample.id, bytes: Buffer.byteLength(sample.content, "utf8") },
    note: null,
    scope: sample.scope,
  });
}

// 例外で全体を止めない。1件の失敗で他の回答まで捨てると、課金だけして何も残らない。
export async function evaluateSamples(samples, { repoRoot, concurrency = 4 } = {}) {
  const out = new Array(samples.length);
  let next = 0;
  async function worker() {
    while (next < samples.length) {
      const i = next++;
      const s = samples[i];
      const rubric = loadRubric(repoRoot, s.scope);
      try {
        const r = await callJev(stateFor(s), buildQuestions(rubric));
        out[i] = {
          id: s.id,
          scope: s.scope,
          rubric_version: rubric.version,
          mode: r.mode,
          answers: r.answers,
          latency_ms: r.latency_ms,
          provider_warnings: r.provider_warnings,
        };
      } catch (e) {
        out[i] = { id: s.id, scope: s.scope, rubric_version: rubric.version, mode: MODE, error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, samples.length) }, worker));
  return out;
}

// 貼り戻し用。probability は3桁で十分（閾値は0.1刻み）。stub の回答は判定に使えないので mode を残す。
export function compactEvaluations(evaluations) {
  return evaluations.map((e) => ({
    id: e.id,
    scope: e.scope,
    v: e.rubric_version,
    mode: e.mode,
    ...(e.error
      ? { error: e.error }
      : {
          a: Object.fromEntries(
            Object.entries(e.answers || {}).map(([k, x]) => [
              k,
              x?.type === "score" ? { s: x.score } : typeof x?.probability === "number" ? Number(x.probability.toFixed(3)) : null,
            ])
          ),
        }),
  }));
}

export function expandEvaluations(compact) {
  return compact.map((e) => ({
    id: e.id,
    scope: e.scope,
    rubric_version: e.v,
    mode: e.mode,
    ...(e.error
      ? { error: e.error }
      : {
          answers: Object.fromEntries(
            Object.entries(e.a || {}).map(([k, x]) => [
              k,
              x && typeof x === "object" ? { type: "score", score: x.s } : x === null ? null : { type: "boolean", probability: x },
            ])
          ),
        }),
  }));
}

function atThreshold(rubric, threshold) {
  return { ...rubric, thresholds: { ...rubric.thresholds, probability_threshold: threshold } };
}

// 人間ラベルは pass / fail の2値。ゲートは ship / revise / block / unknown を返す。
// 対応: block（群FAIL あり）→ fail、ship / revise（群FAIL なし）→ pass、unknown → unknown（一致に数えない）。
// revise を pass に寄せるのは、群判定こそがゲートだから（3.3）。単発の欠陥は修正指示であって不合格ではない。
export function judgeAt(answers, rubric, threshold) {
  const r = interpret(answers, atThreshold(rubric, threshold));
  const jev = r.verdict === "unknown" ? "unknown" : r.failed_groups.length ? "fail" : "pass";
  return { jev, verdict: r.verdict, failed_groups: r.failed_groups, defects: r.defects, missing_answers: r.missing_answers };
}

function rate(num, den) {
  return den ? Number((num / den).toFixed(3)) : null;
}

function reportForScope(scope, samples, evaluations, repoRoot) {
  const rubric = loadRubric(repoRoot, scope);
  const current = rubric.thresholds.probability_threshold;
  const byId = new Map(samples.map((s) => [s.id, s]));
  const evals = evaluations.filter((e) => e.scope === scope && byId.has(e.id));
  const usable = evals.filter((e) => !e.error && e.mode === "live");
  const warnings = [];
  const errored = evals.filter((e) => e.error).map((e) => `${e.id}: ${e.error}`);
  if (errored.length) warnings.push(`呼び出しに失敗したサンプル ${errored.length}件（集計から除外）`);
  const stub = evals.filter((e) => !e.error && e.mode !== "live").length;
  if (stub) warnings.push(`stub の回答 ${stub}件を除外した（ダミーなので較正に使えない）`);
  const stale = usable.filter((e) => e.rubric_version !== rubric.version).length;
  if (stale) warnings.push(`ルーブリック ${rubric.version} とは別の版で取った回答が ${stale}件ある。取り直すこと`);

  const n = usable.length;
  const sweep = SWEEP.map((th) => {
    let agree = 0, lenient = 0, strict = 0, unknown = 0;
    for (const e of usable) {
      const human = byId.get(e.id).human_verdict;
      const { jev } = judgeAt(e.answers, rubric, th);
      if (jev === "unknown") unknown++;
      else if (jev === human) agree++;
      else if (jev === "pass") lenient++;
      else strict++;
    }
    return { threshold: th, agreement: rate(agree, n), too_lenient: lenient, too_strict: strict, unknown };
  });

  // 一致率が同じなら、見逃し（too_lenient）が少ない方、次に現行値に近い方を取る。
  // 見逃しを優先して避けるのは、ゲートを通った成果物は人間の目を通らずに進みうるため。
  const ranked = [...sweep].sort(
    (a, b) =>
      (b.agreement ?? -1) - (a.agreement ?? -1) ||
      a.too_lenient - b.too_lenient ||
      Math.abs(a.threshold - current) - Math.abs(b.threshold - current)
  );
  const best = n ? ranked[0] : null;
  const ties = best ? sweep.filter((s) => s.agreement === best.agreement).map((s) => s.threshold) : [];

  if (best && (best.threshold === SWEEP[0] || best.threshold === SWEEP[SWEEP.length - 1]))
    warnings.push(`採用閾値が端（${best.threshold}）に振り切れた。問題は閾値ではなく instructions の可能性が高い（7.3）`);
  if (best && best.agreement < 0.7)
    warnings.push(`最良でも一致率 ${Math.round(best.agreement * 100)}%。0.7 未満なので、生成側ではなく該当群の instructions を直す（7.1）`);
  if (ties.length > 1) warnings.push(`一致率が同点の閾値が ${ties.join(" / ")}。サンプルが少なく閾値を絞り込めていない`);

  const chosen = best?.threshold ?? null;
  const rows = usable.map((e) => {
    const s = byId.get(e.id);
    const j = judgeAt(e.answers, rubric, chosen);
    return {
      id: e.id,
      boundary: Boolean(s.boundary),
      target_group: s.human_verdict === "fail" ? s.target_group ?? null : null,
      human: s.human_verdict,
      jev: j.jev,
      verdict: j.verdict,
      agree: j.jev === s.human_verdict,
      failed_groups: j.failed_groups,
      // 合否が当たっていても、意図した群で落ちていなければ理由が違う。
      caught_intended:
        s.human_verdict === "fail" && s.target_group ? j.failed_groups.includes(s.target_group) : null,
      defects: j.defects,
      missing_answers: j.missing_answers,
    };
  });

  const per_group = {};
  for (const g of rubric.groups) {
    const rel = rows.filter((r) => r.target_group === g.key);
    per_group[g.key] = {
      label: g.label,
      samples: rel.length,
      agreement: rate(rel.filter((r) => r.agree).length, rel.length),
      caught_intended: rate(rel.filter((r) => r.caught_intended).length, rel.length),
    };
  }

  const disagreement_by_question = {};
  for (const r of rows.filter((x) => !x.agree))
    for (const id of r.defects) disagreement_by_question[id] = (disagreement_by_question[id] ?? 0) + 1;

  const boundary = rows.filter((r) => r.boundary);
  return {
    scope,
    rubric_version: rubric.version,
    n,
    current_threshold: current,
    critical_probability_threshold: rubric.thresholds.critical_probability_threshold,
    group_fail_at: rubric.thresholds.group_fail_at,
    threshold_sweep: sweep,
    chosen_threshold: chosen,
    agreement_rate: best?.agreement ?? null,
    boundary_agreement: rate(boundary.filter((r) => r.agree).length, boundary.length),
    too_lenient: rows.filter((r) => r.jev === "pass" && r.human === "fail").map((r) => r.id),
    too_strict: rows.filter((r) => r.jev === "fail" && r.human === "pass").map((r) => r.id),
    unknown: rows.filter((r) => r.jev === "unknown").map((r) => r.id),
    per_group,
    disagreement_by_question,
    not_calibrated: [
      "critical_probability_threshold（0.5 固定。スイープ対象外）",
      "group_fail_at（2 固定）",
      "s7_originality（人間確認の別枠。verdict に算入しないため較正対象外）",
    ],
    warnings,
    errored,
    rows,
  };
}

export function buildReport(samples, evaluations, { repoRoot }) {
  const scopes = SCOPES.filter((sc) => samples.some((s) => s.scope === sc));
  return {
    generated_at: new Date().toISOString(),
    sweep_values: SWEEP,
    verdict_mapping: "block → fail / ship・revise → pass / unknown は一致に数えない",
    scopes: Object.fromEntries(scopes.map((sc) => [sc, reportForScope(sc, samples, evaluations, repoRoot)])),
  };
}

export function summaryLines(report) {
  const out = [];
  for (const r of Object.values(report.scopes)) {
    out.push(`[${r.scope}] rubric ${r.rubric_version} / n=${r.n}（現行 ${r.current_threshold}）`);
    for (const s of r.threshold_sweep)
      out.push(
        `  ${s.threshold}  一致率 ${s.agreement === null ? "—" : (s.agreement * 100).toFixed(1) + "%"}  甘い ${s.too_lenient}  厳しい ${s.too_strict}  不明 ${s.unknown}${s.threshold === r.chosen_threshold ? "  ← 採用" : ""}`
      );
    out.push(`  境界事例の一致率 : ${r.boundary_agreement === null ? "n/a" : (r.boundary_agreement * 100).toFixed(0) + "%"}`);
    out.push(`  見逃し(too_lenient): ${r.too_lenient.join(", ") || "なし"}`);
    out.push(`  過剰(too_strict)   : ${r.too_strict.join(", ") || "なし"}`);
    for (const [g, v] of Object.entries(r.per_group))
      if (v.samples) out.push(`  ${g}  一致 ${Math.round(v.agreement * 100)}%  意図した群で検出 ${Math.round(v.caught_intended * 100)}%  (n=${v.samples})`);
    out.push(`  誤検出の発生源 : ${JSON.stringify(r.disagreement_by_question)}`);
    for (const w of r.warnings) out.push(`  ! ${w}`);
    out.push("");
  }
  return out;
}
