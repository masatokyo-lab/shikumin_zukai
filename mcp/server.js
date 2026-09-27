#!/usr/bin/env node
// zukai-jev — 図解・記事を Jev で検査する MCP サーバ。
// 仕様は docs/HANDOFF-jev-gate.md（層分割は付記 G）。
//
// 検査は3つの層に分けて行う（layers.js）。人間と Jev が「同じものを見て」「同じ群を問う」ように揃える:
//   ① 本文    本文＋キャプション（図は隠す）      article 18問（s7 は人間確認）
//   ② 図単体  SVG 1枚だけ                        g2 ＋ g5
//   ③ 整合    本文全体＋SVG 1枚                  g3
//   ④ 公開判断 — 人間が行う。Jev は使わない（禁止事項 #4）。記録はするが較正には使わない
//
// env:
//   AI_GATEWAY_API_KEY   Vercel AI Gateway のキー。.env に置く（HANDOFF 6章）。
//                        無い場合は stub モードで動く（判定は偽物と明示される）
//   JEV_MODEL            モデルの上書き（既定 typesafe-ai/jev）
//   JEV_TIMEOUT_MS       呼び出しタイムアウト（既定 20000）
//   ZUKAI_REPO_ROOT      リポジトリルート（既定: cwd）

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

import { callJev, describeClient, MODE } from "./jev.js";
import {
  loadAllRubrics,
  loadLayer,
  loadAllLayers,
  buildQuestions,
  interpret,
  fixList,
  groupStructure,
  DEFAULT_SCOPE,
} from "./rubric.js";
import { LAYERS, LAYER_IDS, PUBLICATION, LEGACY_SCOPE, layerDef, layerName } from "./layers.js";
import { evaluateEscalation, previousReview, previousFailedGroupsOf } from "./escalation.js";
import { prepareInputs, extractFigures, detectKind, sha256 } from "./content.js";
import { buildLayerState } from "./state.js";
import * as store from "./store.js";
import * as labels from "./labels.js";

const REPO_ROOT = resolve(process.env.ZUKAI_REPO_ROOT || process.cwd());

const CALIBRATION_WARNING =
  "ルーブリックの閾値は較正前の暫定値（HANDOFF 3.3「0.70 と 0.50 に根拠はない」）。" +
  "samples.json と較正が済むまで、この判定を品質の根拠にしないこと（HANDOFF 禁止事項 #6）。";
const STUB_WARNING = "stub モードの結果。スコアは決定論的なダミーで、品質判断には使えない。";

function readInput(path, inlineContent, inlineName) {
  if (inlineContent) {
    return { path: path || inlineName, content: inlineContent, bytes: Buffer.byteLength(inlineContent, "utf8") };
  }
  if (!path) return null;
  const abs = isAbsolute(path) ? path : resolve(REPO_ROOT, path);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith("..")) throw new Error(`リポジトリ外のパスは読めません: ${path}`);
  if (!existsSync(abs)) throw new Error(`ファイルが見つかりません: ${rel}`);
  return { path: rel, content: readFileSync(abs, "utf8"), bytes: statSync(abs).size };
}

const newRunId = () =>
  `run_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;

// 同じ対象の直近の記録から run を引き継ぐ。合格した対象は、次に直したとき新しい run から数える。
// 不合格のまま（止めどきが出た後を含む）なら同じ run を続ける — 呼び直しで反復回数をリセットさせない。
function resolveRun(subject, kind, explicitRunId) {
  if (explicitRunId) return explicitRunId;
  const last = store.lastForSubject(REPO_ROOT, subject, kind);
  if (last && last.result !== "pass") return last.run_id;
  return newRunId();
}

// 反復を数える単位。層と対象（本文・図）の組。
function subjectOf(layer, inputs) {
  const f = inputs.figure;
  const fig = f ? (f.source === "file" && !f.path.startsWith("(") ? f.path : `${f.path}#${f.label}`) : null;
  if (layer === "text") return `text:${inputs.text.path}`;
  if (layer === "figure") return `figure:${fig}`;
  return `alignment:${inputs.text.path}|${fig}`;
}

function displayOf(layer, inputs) {
  const f = inputs.figure;
  const fig = f ? (f.source === "inline" ? `${f.path}#${f.label}` : f.path) : null;
  if (layer === "text") return inputs.text.path;
  if (layer === "figure") return fig;
  return `${inputs.text.path} × ${f.label}`;
}

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
// HANDOFF 禁止事項 #5: 判定不能を PASS に倒さない。必ず isError で返す。
const fail = (e) => ({
  isError: true,
  content: [{ type: "text", text: `zukai-jev error: ${e?.message || String(e)}` }],
});

// 旧 API の scope を層に読み替える。diagram（22問を本文＋全図に一括）は廃止。
function resolveLayer(layer, scope) {
  if (layer && scope) throw new Error("layer と scope を同時に渡さない。scope は廃止予定で、layer だけを使う。");
  if (layer) return { layer: layerDef(layer).id, warnings: [] };
  if (scope === "article") {
    return {
      layer: LEGACY_SCOPE.article,
      warnings: ["scope=article は廃止予定。①本文と同じ検査なので layer=text として実行した。今後は layer を渡すこと。"],
    };
  }
  if (scope === "diagram") {
    throw new Error(
      "scope=diagram（22問を本文＋全図に一括で当てる検査）は廃止した（付記 G）。" +
        "本文は layer=text、図は layer=figure（図単体）と layer=alignment（本文との整合）に分けて検査する。" +
        "まとめて回すなら jev_review_all。"
    );
  }
  throw new Error(`layer を指定すること: ${LAYER_IDS.map((id) => `${id}（${layerName(LAYERS[id])}）`).join(" / ")}`);
}

// ── 1層ぶんの検査。jev_review と jev_review_all の共通部分 ─────────────────
async function reviewLayer({ task, layer, main, figureFile, figure, source_material, note, run_id, extraWarnings = [] }) {
  const rubric = loadLayer(REPO_ROOT, layer);
  const def = layerDef(layer);
  const inputs = prepareInputs({ layer, main, figureFile, figure });
  const built = buildLayerState({ layer, task, sourceMaterial: source_material, inputs });
  const subject = subjectOf(layer, inputs);
  const display = displayOf(layer, inputs);
  const runId = resolveRun(subject, "review", run_id);
  const iteration = store.nextIteration(REPO_ROOT, runId, subject, "review");
  store.setState(REPO_ROOT, {
    status: "running",
    stage: `jev_review ${layerName(def)}`,
    run_id: runId,
    artifact: display,
    layer,
    subject,
    iteration,
  });
  try {
    const res = await callJev(built.state, buildQuestions(rubric));
    const result = interpret(res.answers, rubric);
    const fixes = fixList(result, rubric);
    // エスカレーションはサーバーが計算する。呼び出し側に履歴の突き合わせを任せると、
    // 忘れた瞬間に静かに発火しなくなる（HANDOFF 2.3）。比較は同じ層・同じ対象の前周とだけ。
    const prev = previousReview(store.readAll(REPO_ROOT), runId, iteration, subject);
    const escalation = evaluateEscalation({
      iteration,
      verdict: result.verdict,
      failedGroups: result.failed_groups,
      previousFailedGroups: previousFailedGroupsOf(prev),
      maxRetries: rubric.escalation.max_retries,
    });
    const figureInfo = inputs.figure
      ? {
          label: inputs.figure.label,
          path: inputs.figure.path,
          source: inputs.figure.source,
          index: inputs.figure.index ?? null,
          caption: inputs.figure.caption ?? null,
        }
      : null;
    const input = {
      // ラベル（人間の判定）はこの入力にだけ効く。版が変われば別の標本。
      state_sha256: sha256(built.state),
      text_sha256: inputs.text?.source_sha256 ?? null,
      figure_sha256: inputs.figure?.source_sha256 ?? null,
      includes: built.includes,
      normalization: inputs.normalization,
      truncated: built.truncated,
    };
    const warnings = [
      ...extraWarnings,
      res.mode === "stub" ? STUB_WARNING : null,
      result.calibrated ? null : CALIBRATION_WARNING,
      result.missing_answers.length
        ? `回答が欠けている質問がある: ${result.missing_answers.join(", ")}。判定不能として unknown を返した。人間に戻すこと。`
        : null,
      ...escalation.reasons.map((r) => `エスカレーション（${r.id}）: ${r.reason}`),
      ...built.truncated.map((w) => `${w === "text" ? "本文" : "図"}が長すぎるので先頭だけを検査した。後ろの欠陥は見ていない。`),
      ...inputWarnings(layer, inputs, { task, source_material }),
      // プロバイダの警告を伏せない。設定が無視された等が黙って通ると判定の意味が変わる。
      ...res.provider_warnings.map((w) => `Jev プロバイダの警告: ${typeof w === "string" ? w : JSON.stringify(w)}`),
    ].filter(Boolean);

    const record = store.append(REPO_ROOT, {
      kind: "review",
      run_id: runId,
      iteration,
      layer,
      layer_label: layerName(def),
      subject,
      artifact: display,
      figure: figureInfo,
      task,
      note: note || null,
      scope: rubric.scope,
      rubric_version: rubric.version,
      rubric_source: rubric.source,
      mode: res.mode,
      model: res.model,
      latency_ms: res.latency_ms,
      usage: res.usage,
      provider_warnings: res.provider_warnings,
      rounding: res.rounding,
      input,
      polarity: result.polarity,
      result: result.result,
      fail_reason: result.fail_reason,
      verdict: result.verdict,
      clean_ratio: result.clean_ratio,
      items: result.items,
      groups: result.groups,
      defects: result.defects,
      failed_groups: result.failed_groups,
      missing_answers: result.missing_answers,
      unreachable_groups: result.unreachable_groups,
      fragile_groups: result.fragile_groups,
      escalate: escalation.escalate,
      previous_failed_groups: escalation.previous_failed_groups,
      human_review: result.human_review,
      calibrated: result.calibrated,
    });
    store.setState(REPO_ROOT, {
      status: "idle",
      stage: null,
      run_id: runId,
      artifact: display,
      layer,
      subject,
      iteration,
      last_verdict: result.verdict,
      last_result: result.result,
      last_clean_ratio: result.clean_ratio,
      last_failed_groups: result.failed_groups,
      last_escalate: escalation.escalate,
      last_seq: record.seq,
    });
    // jev_label で標本を組むために、同じ state を組み直せる入力を手元に残す
    // （本文を含むので .jev/ 配下・commit しない）。
    labels.saveReviewSnapshot(REPO_ROOT, record.seq, {
      seq: record.seq,
      layer,
      task,
      source_material: source_material || null,
      main: main ? { path: main.path, content: main.content } : null,
      figure_file: figureFile ? { path: figureFile.path, content: figureFile.content } : null,
      figure: figure ?? null,
      state_sha256: input.state_sha256,
      rubric_version: rubric.version,
      client_mode: res.mode,
      result: result.result,
      verdict: result.verdict,
      failed_groups: result.failed_groups,
    });
    const next_action =
      result.result === "pass"
        ? "continue_other_layers"
        : result.fail_reason === "unknown" || escalation.escalate.length
          ? "stop_and_escalate"
          : "fix_and_rereview";
    return {
      result: result.result,
      fail_reason: result.fail_reason,
      next_action,
      layer,
      layer_label: layerName(def),
      subject,
      figure: figureInfo,
      inline_figures: inputs.inline_figures,
      seq: record.seq,
      run_id: runId,
      iteration,
      mode: res.mode,
      rubric: { file: rubric.source, version: rubric.version, question_count: rubric.questions.length },
      polarity: result.polarity,
      verdict: result.verdict,
      clean_ratio: result.clean_ratio,
      latency_ms: res.latency_ms,
      groups: result.groups,
      items: result.items,
      failed_groups: result.failed_groups,
      missing_answers: result.missing_answers,
      unreachable_groups: result.unreachable_groups,
      fragile_groups: result.fragile_groups,
      escalate: escalation.escalate,
      escalation_reasons: escalation.reasons,
      previous_failed_groups: escalation.previous_failed_groups,
      human_review: result.human_review,
      fixes,
      input,
      usage: res.usage,
      rounding: res.rounding,
      warnings,
    };
  } catch (e) {
    store.setState(REPO_ROOT, { status: "error", stage: null, last_error: String(e?.message || e) });
    throw e;
  }
}

// 入力について呼び出し側が知っておくべきこと。黙って捨てたものを見えるようにする。
function inputWarnings(layer, inputs, { task, source_material }) {
  const out = [];
  for (const n of inputs.normalization) {
    if (n.kind === "inspector_meta") out.push(`【検査用メタ】の段落を ${n.count} か所外した（読者には見えないため）。`);
    if (n.kind === "image_file_note") out.push(`「（画像ファイル：…）」の注記を ${n.count} か所外した（読者には見えないため）。`);
    if (n.kind.startsWith("svg_"))
      out.push(`SVG から読者に見えない文字を外した: ${n.kind.replace("svg_", "")} ×${n.count}（描画に無い情報で判定しないため）。`);
  }
  if (inputs.figure && !/<text\b/i.test(inputs.figure.content)) {
    out.push(
      "SVG に文字要素（<text>）が無い。文字がパスに変換されていると Jev は図の文字を読めない" +
        "（matplotlib なら svg.fonttype='none'）。この判定は図の文字を見ていない可能性が高い。"
    );
  }
  if (layer !== "text" && source_material) {
    out.push(`${layerName(LAYERS[layer])}では元資料を state に入れない（${layer === "figure" ? "図だけで成り立つかを見るため" : "本文と図の関係だけを見るため"}）。記録には残した。`);
  }
  if (layer === "alignment" && inputs.figure?.source === "file" && !inputs.figure.label_given) {
    out.push("図の呼び名（figure: \"図3\" など）が無いので、本文のどの図と突き合わせるかを Jev が推測している。呼び名を渡すこと。");
  }
  if (layer === "text" && !task?.trim()) out.push("依頼内容（task）が空。g4 / g6 は問いとの対応で判定するので効きにくい。");
  return out;
}

const server = new McpServer({ name: "zukai-jev", version: "0.3.0" });

// ── ping ────────────────────────────────────────────────────────────────────
server.registerTool(
  "jev_ping",
  {
    title: "Jev 接続確認",
    description:
      "Jev への接続モード（live / stub）、モデル、極性、検査の層（①本文 / ②図単体 / ③整合）ごとの" +
      "ルーブリック構成（出どころのファイル・群・質問数・閾値）と、④公開判断は人間が行うことを返す。" +
      "stub の場合その評価は偽物なので、必ず最初に確認すること。",
    inputSchema: {},
  },
  async () => {
    let rubrics, layers;
    try {
      // 毎回すべて読む。片方しか見ないと、壊れたルーブリックがあっても「基準は健全」に見える。
      rubrics = loadAllRubrics(REPO_ROOT);
      layers = loadAllLayers(REPO_ROOT);
    } catch (e) {
      return fail(e);
    }
    const warnings = [MODE === "stub" ? `APIキー（AI_GATEWAY_API_KEY）が無いため stub モード。${STUB_WARNING}` : null];
    for (const r of rubrics) if (!r.thresholds.calibrated) warnings.push(`${r.source}: ${CALIBRATION_WARNING}`);
    const described = layers.map((rubric) => {
      const def = layerDef(rubric.layer);
      const groups = groupStructure(rubric);
      const unreachable = groups.filter((g) => !g.reachable).map((g) => g.key);
      const fragile = groups.filter((g) => g.fragile).map((g) => g.key);
      if (unreachable.length)
        warnings.push(`${layerName(def)}: 構造上 FAIL しえない群がある: ${unreachable.join(", ")}。`);
      if (fragile.length)
        warnings.push(`${layerName(def)}: FAIL に全問一致が必要な群がある: ${fragile.join(", ")}。実質ほぼ到達しない。`);
      return {
        layer: def.id,
        label: layerName(def),
        human_sees: def.human_sees,
        jev_input: def.jev_input,
        rubric: rubric.source,
        version: rubric.version,
        question_count: rubric.questions.length,
        s7_human_review: Boolean(rubric.scored),
        thresholds: rubric.thresholds,
        groups,
      };
    });
    // 正本にあって、どの層でも問わない群。diagram の g1 / g4 は①（article）で問う。
    const used = new Set(layers.flatMap((l) => l.groups.map((g) => `${l.scope}:${g.key}`)));
    const unused = rubrics.flatMap((r) => r.groups.filter((g) => !used.has(`${r.scope}:${g.key}`)).map((g) => `${r.source}:${g.key}`));
    return ok({
      ...describeClient(),
      result_note:
        "jev_review の result は pass / fail の2値（層ごと）。jev_review_all は①②③をまとめて回し、" +
        "すべて合格なら next_action: hand_to_human で④（公開判断）を人間に渡す。" +
        "判定不能は fail（fail_reason: unknown）で、修正せず人間に返す。",
      repo_root: REPO_ROOT,
      layers: described,
      publication: PUBLICATION,
      unused_groups: unused,
      unused_note: "diagram の g1 / g4 は①本文（article）で同じ問いを問うので、図の層では使わない。",
      rubrics: rubrics.map((r) => ({ source: r.source, version: r.version, scope: r.scope, question_count: r.questions.length })),
      polarity_note: "probability は「欠陥が存在する確率」。高いほど悪い。閾値以上で欠陥ありと判定する。",
      warnings: warnings.filter(Boolean),
    });
  }
);

// ── review: 1層ぶん ─────────────────────────────────────────────────────────
const figureSelector = z
  .union([z.string(), z.number()])
  .optional()
  .describe("図の指定。インライン SVG なら番号（1 起点）・「図3」・要素の id。別ファイルの図なら本文での呼び名（「図3」）。");

server.registerTool(
  "jev_review",
  {
    title: "1つの層を検査する",
    description:
      "①本文 / ②図単体 / ③整合 のどれか1層を検査し、合格/不合格と修正項目を返す。記事全体はふつう jev_review_all で回す。" +
      "layer=text: 本文（図は［図N：キャプション］に置き換える）を article 18問で。依頼内容と元資料も渡す。" +
      "layer=figure: SVG 1枚だけを g2（タイトル・軸・単位）＋ g5（事実と推測）で。本文・キャプション・元資料は渡さない。" +
      "layer=alignment: 本文全体＋SVG 1枚を g3（本文と図の整合）で。" +
      "critical 項目は単独で群FAIL、それ以外は群内2件以上で群FAIL。群FAIL が無ければ合格。" +
      "s7_originality（一次経験の裏打ち）は①でだけ問い、判定に算入せず人間確認に回す。" +
      "next_action: fix_and_rereview は blocking の項目を直して再検査、stop_and_escalate は止めて人間に返す、" +
      "continue_other_layers はこの層は合格（残りの層へ。④公開判断は全層合格の後に人間が行う）。" +
      "画像（PNG / JPEG）は評価できない。結果は .jev/runs.jsonl に記録される。",
    inputSchema: {
      task: z.string().describe("この記事／図解が答えるべき問い・説明すべき仕組み。依頼内容をそのまま。"),
      layer: z.enum(["text", "figure", "alignment"]).optional().describe("検査する層。text=①本文 / figure=②図単体 / alignment=③整合"),
      scope: z
        .enum(["diagram", "article"])
        .optional()
        .describe("廃止予定。article は layer=text として扱う。diagram（一括）は廃止したのでエラーになる。"),
      artifact_path: z.string().optional().describe("本文（.md / .txt / .html）のリポジトリ相対パス。layer=figure では SVG ファイルでもよい。"),
      content: z.string().optional().describe("パスの代わりに本文を直接渡す場合。"),
      figure_path: z.string().optional().describe("本文と別ファイルの図（.svg）。figure / alignment で使う。"),
      figure_content: z.string().optional().describe("図の SVG ソースを直接渡す場合。"),
      figure: figureSelector,
      source_material: z.string().optional().describe("元資料。①の裏付け判定（g5）に使う。省くと効かない。②③では state に入れない。"),
      note: z.string().optional().describe("前回からの変更点。記録に残る（Jev には渡さない）。"),
      run_id: z.string().optional().describe("反復をまとめる ID。省略時は層×対象ごとに自動。"),
    },
  },
  async ({ task, layer, scope, artifact_path, content, figure_path, figure_content, figure, source_material, note, run_id }) => {
    try {
      const resolved = resolveLayer(layer, scope);
      const main = readInput(artifact_path, content, "(inline)");
      const figureFile = readInput(figure_path, figure_content, "(inline-figure)");
      return ok(
        await reviewLayer({
          task,
          layer: resolved.layer,
          main,
          figureFile,
          figure,
          source_material,
          note,
          run_id,
          extraWarnings: resolved.warnings,
        })
      );
    } catch (e) {
      return fail(e);
    }
  }
);

// ── review_all: 1記事の①②③をまとめて ───────────────────────────────────────
function qualify(child) {
  const where = `${child.layer}${child.figure ? `@${child.figure.label}` : ""}`;
  if (child.error) return [`${where}:error`];
  if (child.fail_reason === "unknown") return [`${where}:unknown`];
  return child.failed_groups.map((g) => `${where}:${g}`);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

server.registerTool(
  "jev_review_all",
  {
    title: "記事を①②③まとめて検査する",
    description:
      "1本の記事（または図解アーティファクト）を、①本文 → 図ごとに②図単体と③整合、の順に全部検査して合否をまとめる。" +
      "図は figures（本文と別ファイルの SVG）で渡すか、省略すれば本文中のインライン SVG を使う。" +
      "各層は jev_review と同じ検査で、別々に記録される（較正のラベルは層ごとに付ける）。" +
      "next_action: fix_and_rereview は不合格の層を直して再検査、stop_and_escalate は止めて人間に返す" +
      "（どれかの層の判定不能・止めどき、または記事全体の反復の上限・停滞・振動）、" +
      "hand_to_human は①②③すべて合格なので④公開判断をユーザーに渡す（Jev は公開可否を判定しない）。",
    inputSchema: {
      task: z.string().describe("この記事が答えるべき問い。依頼内容をそのまま。"),
      artifact_path: z.string().optional().describe("本文（.md / .txt / .html）のリポジトリ相対パス。"),
      content: z.string().optional().describe("パスの代わりに本文を直接渡す場合。"),
      figures: z
        .array(
          z.object({
            path: z.string().optional().describe("図（.svg）のリポジトリ相対パス"),
            content: z.string().optional().describe("SVG ソースを直接渡す場合"),
            label: z.string().optional().describe("本文での呼び名（例: 図3）。③で本文の参照と結び付けるのに使う"),
          })
        )
        .optional()
        .describe("本文と別ファイルの図。省略時は本文中のインライン SVG をすべて使う。"),
      source_material: z.string().optional().describe("元資料。①の g5 に使う。"),
      note: z.string().optional().describe("前回からの変更点。記録に残る（Jev には渡さない）。"),
      run_id: z.string().optional().describe("反復をまとめる ID。省略時は記事ごとに自動。"),
    },
  },
  async ({ task, artifact_path, content, figures, source_material, note, run_id }) => {
    try {
      const main = readInput(artifact_path, content, "(inline)");
      if (!main) throw new Error("本文（artifact_path か content）が要る。");
      const kind = detectKind(main.path, main.content);
      if (kind === "svg") throw new Error("artifact_path は本文。図は figures で渡す。");

      const figureJobs = figures?.length
        ? figures.map((f, i) => {
            const file = readInput(f.path, f.content, `(inline-figure-${i + 1})`);
            if (!file) throw new Error(`figures[${i}] に path か content が要る。`);
            return { figureFile: file, figure: f.label ?? null };
          })
        : extractFigures(main.content, kind).map((f) => ({ figureFile: null, figure: f.index }));

      const jobs = [
        { layer: "text", figureFile: null, figure: null },
        ...figureJobs.flatMap((j) => [
          { layer: "figure", ...j },
          { layer: "alignment", ...j },
        ]),
      ];
      const children = await mapLimit(jobs, 3, async (job) => {
        try {
          return await reviewLayer({
            task,
            layer: job.layer,
            // ②で本文ファイルを渡すのはインライン図のときだけ（別ファイルの図は図だけを読む）。
            main: job.layer === "figure" && job.figureFile ? null : main,
            figureFile: job.figureFile,
            figure: job.figure,
            source_material: job.layer === "text" ? source_material : undefined,
            note,
            run_id,
          });
        } catch (e) {
          return { layer: job.layer, figure: job.figure != null ? { label: String(job.figure) } : null, error: e?.message || String(e) };
        }
      });

      // 記事全体の反復。FAIL の集合を「層@図:群」で数え、HANDOFF 2.3 の止めどきを記事単位でも判定する。
      // 層ごとの止めどきだけだと、①を直すと③が落ち、③を直すと①が落ちる往復が止まらない。
      const failed = children.flatMap(qualify).sort();
      const result = children.every((c) => !c.error && c.result === "pass") ? "pass" : "fail";
      const subject = `round:${main.path}`;
      const roundRun = resolveRun(subject, "round", run_id);
      const iteration = store.nextIteration(REPO_ROOT, roundRun, subject, "round");
      const prev = previousReview(store.readAll(REPO_ROOT), roundRun, iteration, subject, "round");
      const anyUnknown = children.some((c) => c.error || c.fail_reason === "unknown");
      const escalation = evaluateEscalation({
        iteration,
        verdict: result === "pass" ? "ship" : anyUnknown ? "unknown" : "block",
        failedGroups: failed,
        previousFailedGroups: previousFailedGroupsOf(prev),
        maxRetries: layerDefMaxRetries(),
      });
      const childEscalations = children.filter((c) => c.escalate?.length).map((c) => `${c.layer_label}${c.figure ? ` ${c.figure.label}` : ""}: ${c.escalate.join(", ")}`);
      const next_action =
        result === "pass"
          ? "hand_to_human"
          : anyUnknown || escalation.escalate.length || childEscalations.length
            ? "stop_and_escalate"
            : "fix_and_rereview";
      const mode = children.find((c) => c.mode)?.mode ?? MODE;
      const record = store.append(REPO_ROOT, {
        kind: "round",
        run_id: roundRun,
        iteration,
        subject,
        artifact: main.path,
        task,
        note: note || null,
        mode,
        result,
        fail_reason: result === "pass" ? null : anyUnknown ? "unknown" : "layer_fail",
        failed_groups: failed,
        children: children.map((c) => ({
          seq: c.seq ?? null,
          layer: c.layer,
          figure: c.figure?.label ?? null,
          result: c.error ? "fail" : c.result,
          error: c.error ?? null,
        })),
        escalate: escalation.escalate,
        previous_failed_groups: escalation.previous_failed_groups,
      });
      const text = children[0];
      return ok({
        result,
        next_action,
        round: {
          seq: record.seq,
          run_id: roundRun,
          iteration,
          escalate: escalation.escalate,
          escalation_reasons: escalation.reasons,
          previous_failed_groups: escalation.previous_failed_groups,
        },
        failed,
        layers: children.map((c) =>
          c.error
            ? { layer: c.layer, figure: c.figure?.label ?? null, result: "fail", error: c.error }
            : {
                layer: c.layer,
                layer_label: c.layer_label,
                figure: c.figure?.label ?? null,
                seq: c.seq,
                run_id: c.run_id,
                iteration: c.iteration,
                result: c.result,
                fail_reason: c.fail_reason,
                verdict: c.verdict,
                failed_groups: c.failed_groups,
                escalate: c.escalate,
                blocking_fixes: c.fixes.filter((f) => f.blocking).map(({ key, label, probability, means }) => ({ key, label, probability, means })),
                other_fixes: c.fixes.filter((f) => !f.blocking).map(({ key, label, probability, means }) => ({ key, label, probability, means })),
              }
        ),
        human_review: text?.human_review ?? null,
        figures: figureJobs.length
          ? children.filter((c) => c.layer === "figure").map((c) => c.figure?.label ?? null)
          : [],
        mode,
        warnings: [
          figureJobs.length ? null : "図が見つからない（インライン SVG も figures も無い）。②③は回していない。図入りの記事なら figures で SVG を渡すこと。",
          ...escalation.reasons.map((r) => `記事全体のエスカレーション（${r.id}）: ${r.reason}`),
          ...children.filter((c) => c.error).map((c) => `${c.layer}${c.figure ? ` ${c.figure.label}` : ""} の検査に失敗: ${c.error}`),
          mode === "stub" ? STUB_WARNING : null,
          CALIBRATION_WARNING,
          ...new Set(children.flatMap((c) => (c.warnings || []).filter((w) => w !== STUB_WARNING && w !== CALIBRATION_WARNING).map((w) => `${c.layer_label ?? c.layer}${c.figure ? ` ${c.figure.label}` : ""}: ${w}`))),
        ].filter(Boolean),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

// 記事全体の反復上限。各ルーブリックの max_retries と同じ（HANDOFF 2.3 は3回）。
function layerDefMaxRetries() {
  return Math.min(...LAYER_IDS.map((id) => loadLayer(REPO_ROOT, id).escalation.max_retries));
}

// ── decide: 任意の型付き質問をそのまま投げる ───────────────────────────────
server.registerTool(
  "jev_decide",
  {
    title: "任意の型付き判断",
    description:
      "Jev の素の呼び出し。state と型付き質問マップを渡して一往復で全回答を得る。" +
      "各質問は { type: 'boolean'|'score', instructions, criteria? }。" +
      "boolean は criteria 不要（付けるなら {true,false} の両方）で、" +
      "返り値は { type: 'boolean', probability } のみ（value フィールドは存在しない）。" +
      "score は criteria に低→高の順序付き水準説明の配列を渡し、返り値は 0 起点の小数位置。" +
      "【使ってはいけない用途】公開可否・機密判定・コンプライアンス判定には使わないこと" +
      "（HANDOFF 禁止事項 #4）。誤判定コストが非対称であり、かつ評価対象を外部APIに送りながら" +
      "「外部に出してよいか」を外部に訊くのは論理矛盾。" +
      "jev_gate を削除したのは同じ理由であり、このツールから同等の質問を再構成しないこと。",
    inputSchema: {
      state: z.string().describe("判断対象の文脈。テキストのみ。画像は評価できない。"),
      questions: z.record(z.string(), z.any()).describe("質問名 -> 質問オブジェクトのマップ。"),
    },
  },
  async ({ state, questions }) => {
    try {
      const res = await callJev(state, questions);
      return ok(res);
    } catch (e) {
      return fail(e);
    }
  }
);

// ── feed / status ─────────────────────────────────────────────────────────
server.registerTool(
  "jev_feed",
  {
    title: "ダッシュボード同期用フィード",
    description:
      "since_seq より後の記録と現在の稼働状態を返す。これをそのままダッシュボード Artifact の DB に書き込むと、スマホから Jev の稼働が見える。" +
      "kind=review は1層ぶんの検査、kind=round は jev_review_all の記事全体のまとめ。",
    inputSchema: {
      since_seq: z.number().optional().describe("最後に同期した seq。省略時は 0（全件）。"),
      limit: z.number().optional().describe("最大件数。既定 50。"),
    },
  },
  async ({ since_seq, limit }) => {
    try {
      const { records, remaining } = store.feed(REPO_ROOT, since_seq ?? 0, limit ?? 50);
      return ok({
        client: describeClient(),
        state: store.getState(REPO_ROOT),
        records,
        remaining,
        next_since_seq: records.length ? records[records.length - 1].seq : since_seq ?? 0,
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "jev_status",
  {
    title: "稼働状況",
    description: "現在の稼働状態と直近のラン要約を返す。",
    inputSchema: {},
  },
  async () => {
    try {
      return ok({ client: describeClient(), ...store.summarize(REPO_ROOT) });
    } catch (e) {
      return fail(e);
    }
  }
);

// ── label: 層ごとの人間の判定（較正の材料） ─────────────────────────────────
server.registerTool(
  "jev_label",
  {
    title: "層ごとの人間の判定を記録する",
    description:
      "①本文 / ②図単体 / ③整合 のどれか1層の検査結果（seq）について、ユーザーが**その層と同じものを見て**出した判定を記録する。" +
      "①なら図を隠した本文とキャプションだけ、②なら図1枚だけ、③なら本文と図1枚を見た判定であること。" +
      "見るものがずれた判定（例: 図込みで読んだ感想を①に付ける）は較正を狂わせるので記録しない。" +
      "ユーザーが報告した値だけを渡すこと（推測で埋めない）。human_verdict: pass = この層に欠陥なし / fail = 欠陥あり。" +
      "④の公開判断（出すか出さないか）はここではなく jev_ship で記録する（較正には使わない）。" +
      "台帳 labels/ledger.jsonl には本文を書かない（リポジトリが public のため）。" +
      "返り値の sample は本文を含むので Drive「99. Jev連携/labels」に保存し、台帳の変更は commit / push すること。",
    inputSchema: {
      seq: z.number().int().describe("jev_review / jev_review_all が返した、その層の検査の seq"),
      human_verdict: z.enum(["pass", "fail"]).describe("pass = この層に欠陥なし / fail = 欠陥あり"),
      group_labels: z
        .record(z.string(), z.enum(["pass", "fail"]))
        .optional()
        .describe("任意。群ごとに判定できたときだけ（例: { g3_text_figure_alignment: 'fail' }）。その層で問う群だけ"),
      boundary: z.boolean().optional().describe("任意。判定に迷った境界事例なら true（較正で重く見る）"),
      note: z.string().optional().describe("理由（任意）。台帳に残るので本文の引用は書かないこと"),
    },
  },
  async ({ seq, human_verdict, group_labels, boundary, note }) => {
    try {
      const review = store.readAll(REPO_ROOT).find((r) => r.seq === seq && r.kind === "review");
      if (!review) throw new Error(`seq ${seq} の層の検査が .jev/runs.jsonl にありません（round の seq ではなく各層の seq を渡す）。`);
      const warnings = [];
      let layer = review.layer;
      if (!layer) {
        // 層分割より前の記録。article は①と同じものを見ているので読み替える。diagram は見るものが揃わない。
        if ((review.scope ?? DEFAULT_SCOPE) === "article") {
          layer = "text";
          warnings.push("層分割より前の scope=article の検査。①本文として記録した。");
        } else {
          throw new Error(
            "層分割より前の diagram（本文＋全図を22問で一括）の検査にはラベルを付けない。人間が見るものと問う群が揃わないため。" +
              "jev_review_all で①②③に分けて検査し直し、その層の seq に付けること。"
          );
        }
      }
      const rubric = loadLayer(REPO_ROOT, layer);
      if (group_labels) {
        const unknown = Object.keys(group_labels).filter((g) => !rubric.groups.some((x) => x.key === g));
        if (unknown.length)
          throw new Error(`${layerName(layerDef(layer))}で問わない群: ${unknown.join(", ")}（問う群: ${rubric.groups.map((g) => g.key).join(", ")}）`);
      }
      const jevResult = review.result ?? (["ship", "revise"].includes(review.verdict) ? "pass" : "fail");
      const entry = labels.appendLabel(REPO_ROOT, {
        kind: "layer_label",
        layer,
        review_seq: seq,
        run_id: review.run_id,
        subject: review.subject ?? null,
        figure: review.figure?.label ?? null,
        rubric_version: review.rubric_version,
        client_mode: review.mode,
        jev_result: jevResult,
        jev_verdict: review.verdict,
        jev_failed_groups: review.failed_groups,
        human_verdict,
        agree: jevResult === human_verdict,
        group_labels: group_labels ?? null,
        boundary: boundary ?? false,
        // 版の特定。本文や図を直すと、このラベルは効かなくなる。
        state_sha256: review.input?.state_sha256 ?? null,
        text_sha256: review.input?.text_sha256 ?? null,
        figure_sha256: review.input?.figure_sha256 ?? null,
        note: note ?? null,
      });
      const snap = labels.readReviewSnapshot(REPO_ROOT, seq);
      const sample = snap ? labels.sampleFromSnapshot(snap, entry) : null;
      return ok({
        recorded: entry,
        sample,
        save_sample_to: `Drive「99. Jev連携/labels」に ${entry.id}.json として保存（本文を含むのでリポジトリに commit しない）`,
        commit: "labels/ledger.jsonl を commit / push すること（クラウドのコンテナは消える）",
        warnings: [
          ...warnings,
          review.mode !== "live" ? "stub の判定に付けた記録。Jev の判定がダミーなので、一致・不一致は較正に使えない（人間の判定そのものは標本として使える）。" : null,
          jevResult === "pass" && human_verdict === "fail"
            ? "Jev が合格にした層を人間は不合格にした（見逃し候補）。理由を note に残すと較正で原因を追える。"
            : null,
          snap ? null : "検査時の入力が .jev/reviews に無い（コンテナが入れ替わった可能性）。本文つきの標本は組めなかった。",
        ].filter(Boolean),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

// ── ship: ④公開判断の記録（較正には使わない） ───────────────────────────────
server.registerTool(
  "jev_ship",
  {
    title: "公開判断（④）を記録する",
    description:
      "ユーザー本人が出した④公開判断（出す / 出さない）を記録する。公開判断は人間が行い責任を持つもので、Jev は判定しない（禁止事項 #4）。" +
      "較正には使わない（①②③のどれとも見るものと問うものが違うため）。" +
      "出さない理由が①②③の問い（本文・図単体・本文と図の整合）に当たるなら、その層の検査に jev_label も付けるようユーザーに確認すること" +
      "（どの層も拾えなかった欠陥＝ルーブリックの穴の候補）。ユーザーが報告した値だけを渡すこと。",
    inputSchema: {
      artifact: z.string().describe("記事のパスまたは名前（例: ネットワークビジネス v2）"),
      decision: z.enum(["ship", "hold"]).describe("ship = 公開する / hold = 公開しない"),
      round_seq: z.number().int().optional().describe("直近の jev_review_all の round.seq（あれば）"),
      reason: z.string().optional().describe("理由（任意）。台帳に残るので本文の引用は書かないこと"),
      missed_by_layers: z
        .boolean()
        .optional()
        .describe("任意。出さない理由が①②③の問いに当たるのに、どの層も落とさなかったなら true"),
    },
  },
  async ({ artifact, decision, round_seq, reason, missed_by_layers }) => {
    try {
      const round = round_seq != null ? store.readAll(REPO_ROOT).find((r) => r.seq === round_seq && r.kind === "round") : null;
      if (round_seq != null && !round) throw new Error(`seq ${round_seq} の round（jev_review_all の記録）がありません。`);
      const entry = labels.appendLabel(
        REPO_ROOT,
        {
          kind: "publication",
          calibration: false,
          artifact,
          decision,
          round_seq: round_seq ?? null,
          jev_round_result: round?.result ?? null,
          jev_failed: round?.failed_groups ?? null,
          missed_by_layers: missed_by_layers ?? null,
          reason: reason ?? null,
        },
        { prefix: "pub", labelSource: "human_publication" }
      );
      return ok({
        recorded: entry,
        commit: "labels/ledger.jsonl を commit / push すること",
        warnings: [
          round && round.result === "pass" && decision === "hold"
            ? "①②③は合格だったが公開しない判断。理由がルーブリックの問いに当たるなら、該当する層に jev_label を付けるか確認すること。"
            : null,
          round && round.result === "fail" && decision === "ship"
            ? "①②③のどこかが不合格のまま公開する判断。群の判定を覆すものではなく人間の公開判断として記録した（禁止事項 #1 は Jev の判定の上書きを禁じる）。"
            : null,
        ].filter(Boolean),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `zukai-jev MCP 起動 · mode=${MODE} · root=${REPO_ROOT} · ${MODE === "stub" ? "APIキー未設定（stub）" : "live"}`
);
