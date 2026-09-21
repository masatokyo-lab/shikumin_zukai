#!/usr/bin/env node
// zukai-jev — 仕組み図解アーティファクトを Jev で検査する MCP サーバ。
// 仕様は docs/HANDOFF-jev-gate.md。
//
// env:
//   AI_GATEWAY_API_KEY   Vercel AI Gateway のキー。.env に置く（HANDOFF 6章）。
//                        無い場合は stub モードで動く（判定は偽物と明示される）
//   JEV_MODEL            モデルの上書き（既定 typesafe-ai/jev）
//   JEV_TIMEOUT_MS       呼び出しタイムアウト（既定 20000）
//   ZUKAI_REPO_ROOT      リポジトリルート（既定: cwd）
//
// このサーバは「公開可否」を判定しない。HANDOFF 禁止事項 #4:
// 誤判定コストが非対称であり、かつ state を外部APIに送る構造と矛盾する。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

import { callJev, describeClient, MODE } from "./jev.js";
import { loadRubric, buildQuestions, interpret, fixList, groupStructure } from "./rubric.js";
import { evaluateEscalation, previousReview, previousFailedGroupsOf } from "./escalation.js";
import * as store from "./store.js";

const REPO_ROOT = resolve(process.env.ZUKAI_REPO_ROOT || process.cwd());
const MAX_CONTENT = Number(process.env.ZUKAI_MAX_CONTENT || 60000);

const CALIBRATION_WARNING =
  "閾値 0.70 / 0.50 / group_fail_at=2 は較正前の暫定値。較正が済むまで、この判定を品質の根拠にしないこと（HANDOFF 禁止事項 #6）。";
const STUB_WARNING = "stub モードの結果。スコアは決定論的なダミーで、品質判断には使えない。";

function readArtifact(artifactPath, inlineContent) {
  if (inlineContent) {
    return { path: artifactPath || "(inline)", content: inlineContent, bytes: inlineContent.length };
  }
  if (!artifactPath) throw new Error("artifact_path か content のどちらかが必要です。");
  const abs = isAbsolute(artifactPath) ? artifactPath : resolve(REPO_ROOT, artifactPath);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith("..")) throw new Error(`リポジトリ外のパスは読めません: ${artifactPath}`);
  if (!existsSync(abs)) throw new Error(`ファイルが見つかりません: ${rel}`);
  return { path: rel, content: readFileSync(abs, "utf8"), bytes: statSync(abs).size };
}

// 図は SVG ソースをテキストとして state に含める（HANDOFF 3.4: 画像は評価できない）。
function buildState({ task, sourceMaterial, artifact, note }) {
  const truncated = artifact.content.length > MAX_CONTENT;
  const body = truncated ? artifact.content.slice(0, MAX_CONTENT) : artifact.content;
  return [
    "# この図解が説明すべき仕組み（依頼内容）",
    task,
    "",
    "# 元資料（図解の主張はここで裏付けられている必要がある）",
    sourceMaterial?.trim() || "(提供なし。資料に無い断定が無いかは、依頼内容のみを基準に判断すること)",
    "",
    note ? `# 今回の変更点\n${note}\n` : "",
    `# 図解アーティファクト (${artifact.path}, ${artifact.bytes} bytes${truncated ? ", 先頭のみ" : ""})`,
    body,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function resolveRun(artifactPath, explicitRunId) {
  if (explicitRunId) return explicitRunId;
  const state = store.getState(REPO_ROOT);
  if (state.run_id && state.artifact === artifactPath) return state.run_id;
  return `run_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
// HANDOFF 禁止事項 #5: 判定不能を PASS に倒さない。必ず isError で返す。
const fail = (e) => ({
  isError: true,
  content: [{ type: "text", text: `zukai-jev error: ${e?.message || String(e)}` }],
});

const server = new McpServer({ name: "zukai-jev", version: "0.2.0" });

// ── ping: live なのか stub なのか、どの基準で測るのかを最初に確かめる ──────
server.registerTool(
  "jev_ping",
  {
    title: "Jev 接続確認",
    description:
      "Jev への接続モード（live / stub）、モデル、極性、閾値、群構成を返す。stub の場合その評価は偽物なので、必ず最初に確認すること。",
    inputSchema: {},
  },
  async () => {
    let rubric;
    try {
      rubric = loadRubric(REPO_ROOT);
    } catch (e) {
      return fail(e);
    }
    const groups = groupStructure(rubric);
    const unreachable = groups.filter((g) => !g.reachable).map((g) => g.key);
    const fragile = groups.filter((g) => g.fragile).map((g) => g.key);
    return ok({
      ...describeClient(),
      repo_root: REPO_ROOT,
      rubric: {
        profile: rubric.profile,
        source: rubric.source || "built-in",
        polarity: rubric.polarity,
        polarity_note:
          "probability は「欠陥が存在する確率」。高いほど悪い。閾値以上で欠陥ありと判定する。",
        thresholds: rubric.thresholds,
        groups,
        scored: {
          key: rubric.scored.key,
          threshold: rubric.scored.threshold,
          human_review_required: rubric.scored.human_review_required,
        },
      },
      warnings: [
        MODE === "stub" ? `APIキー（AI_GATEWAY_API_KEY）が無いため stub モード。${STUB_WARNING}` : null,
        rubric.thresholds.calibrated ? null : CALIBRATION_WARNING,
        unreachable.length
          ? `構造上 FAIL しえない群がある: ${unreachable.join(", ")}。critical が無く、質問数が group_fail_at に届かない。ルーブリック再設計で解消すること。`
          : null,
        fragile.length
          ? `FAIL に全問一致が必要な群がある: ${fragile.join(", ")}。critical が無く slack が 0 なので、1件の欠陥では落ちない。実質的にはほぼ到達しない。`
          : null,
      ].filter(Boolean),
    });
  }
);

// ── review: ルーブリック全項目の評価 ───────────────────────────────────────
server.registerTool(
  "jev_review",
  {
    title: "図解をレビューする",
    description:
      "図解アーティファクトを欠陥ルーブリック全項目で検査し、群単位の判定と修正項目リストを返す。" +
      "群は トレーサビリティ / 図のラベリング / 本文と図の整合 / 粒度と流れ / 認識の妥当性 の5つ。" +
      "critical 項目は単独で群FAIL、それ以外は群内2件以上で群FAIL。" +
      "s7_originality（一次経験の裏打ち）は判定に算入せず、人間確認の対象として別枠で返る。" +
      "反復の停滞・振動はサーバー側で判定し escalate に入れて返すので、" +
      "空でなければ回すのをやめて人間に返すこと。" +
      "結果は .jev/runs.jsonl に記録される。",
    inputSchema: {
      task: z.string().describe("この図解が説明すべき仕組み。依頼内容をそのまま。"),
      artifact_path: z.string().optional().describe("リポジトリ相対のアーティファクトパス。"),
      content: z.string().optional().describe("パスの代わりに中身を直接渡す場合。"),
      source_material: z
        .string()
        .optional()
        .describe("図解の元になった資料。裏付け判定（grounded）に使う。省くと効かない。"),
      note: z.string().optional().describe("前回からの変更点。反復の記録に残る。"),
      run_id: z.string().optional().describe("反復をまとめる ID。省略時は自動。"),
    },
  },
  async ({ task, artifact_path, content, source_material, note, run_id }) => {
    let artifact;
    try {
      artifact = readArtifact(artifact_path, content);
    } catch (e) {
      return fail(e);
    }
    const runId = resolveRun(artifact.path, run_id);
    const iteration = store.nextIteration(REPO_ROOT, runId);
    store.setState(REPO_ROOT, {
      status: "running",
      stage: "jev_review",
      run_id: runId,
      artifact: artifact.path,
      iteration,
    });
    try {
      const rubric = loadRubric(REPO_ROOT);
      const state = buildState({ task, sourceMaterial: source_material, artifact, note });
      const res = await callJev(state, buildQuestions(rubric));
      const result = interpret(res.answers, rubric);
      const fixes = fixList(result, rubric);
      // エスカレーションはサーバーが計算する。呼び出し側に履歴の突き合わせを任せると、
      // 忘れた瞬間に静かに発火しなくなる（HANDOFF 2.3）。
      const prev = previousReview(store.readAll(REPO_ROOT), runId, iteration);
      const escalation = evaluateEscalation({
        iteration,
        verdict: result.verdict,
        failedGroups: result.failed_groups,
        previousFailedGroups: previousFailedGroupsOf(prev),
      });
      const record = store.append(REPO_ROOT, {
        kind: "review",
        run_id: runId,
        iteration,
        artifact: artifact.path,
        task,
        note: note || null,
        mode: res.mode,
        model: res.model,
        latency_ms: res.latency_ms,
        usage: res.usage,
        provider_warnings: res.provider_warnings,
        rounding: res.rounding,
        polarity: result.polarity,
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
        artifact: artifact.path,
        iteration,
        last_verdict: result.verdict,
        last_clean_ratio: result.clean_ratio,
        last_failed_groups: result.failed_groups,
        last_escalate: escalation.escalate,
        last_seq: record.seq,
      });
      return ok({
        seq: record.seq,
        run_id: runId,
        iteration,
        mode: res.mode,
        polarity: result.polarity,
        verdict: result.verdict,
        clean_ratio: result.clean_ratio,
        latency_ms: res.latency_ms,
        groups: result.groups,
        items: result.items,
        failed_groups: result.failed_groups,
        // 1件でもあれば verdict は unknown。無視すると群の欠陥数が実際より少なく数えられる。
        missing_answers: result.missing_answers,
        unreachable_groups: result.unreachable_groups,
        fragile_groups: result.fragile_groups,
        // 空でなければ回すのをやめて人間に返す。判断は呼び出し側でなくここで済ませてある。
        escalate: escalation.escalate,
        escalation_reasons: escalation.reasons,
        previous_failed_groups: escalation.previous_failed_groups,
        human_review: result.human_review,
        fixes,
        usage: res.usage,
        rounding: res.rounding,
        warnings: [
          res.mode === "stub" ? STUB_WARNING : null,
          result.calibrated ? null : CALIBRATION_WARNING,
          result.missing_answers.length
            ? `回答が欠けている質問がある: ${result.missing_answers.join(", ")}。判定不能として unknown を返した。人間に戻すこと。`
            : null,
          ...escalation.reasons.map((r) => `エスカレーション（${r.id}）: ${r.reason}`),
          // プロバイダの警告を伏せない。設定が無視された等が黙って通ると判定の意味が変わる。
          ...res.provider_warnings.map(
            (w) => `Jev プロバイダの警告: ${typeof w === "string" ? w : JSON.stringify(w)}`
          ),
        ].filter(Boolean),
      });
    } catch (e) {
      store.setState(REPO_ROOT, { status: "error", stage: null, last_error: String(e?.message || e) });
      return fail(e);
    }
  }
);

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

// ── feed: ダッシュボードへ未同期のレコードを渡す ───────────────────────────
server.registerTool(
  "jev_feed",
  {
    title: "ダッシュボード同期用フィード",
    description:
      "since_seq より後の評価レコードと現在の稼働状態を返す。これをそのままダッシュボード Artifact の DB に書き込むと、スマホから Jev の稼働が見える。",
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

// ── status: いま何が走っているか ───────────────────────────────────────────
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `zukai-jev MCP 起動 · mode=${MODE} · root=${REPO_ROOT} · ${
    MODE === "stub" ? "APIキー未設定（stub）" : "live"
  }`
);
