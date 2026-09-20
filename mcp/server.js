#!/usr/bin/env node
// zukai-jev — 仕組み図解アーティファクトを Jev (TypeSafe AI System One) で検査する MCP サーバ。
//
// env:
//   TYPESAFE_API_KEY / JEV_API_KEY   Jev のキー。無い場合は stub モードで動く（判定は偽物と明示される）
//   JEV_BASE_URL, JEV_MODEL          エンドポイント / モデルの上書き
//   ZUKAI_REPO_ROOT                  リポジトリルート（既定: cwd）

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

import { callJev, describeClient, MODE } from "./jev.js";
import { loadRubric, buildQuestions, interpret, fixList } from "./rubric.js";
import * as store from "./store.js";

const REPO_ROOT = resolve(process.env.ZUKAI_REPO_ROOT || process.cwd());
const MAX_CONTENT = Number(process.env.ZUKAI_MAX_CONTENT || 60000);

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
const fail = (e) => ({
  isError: true,
  content: [{ type: "text", text: `zukai-jev error: ${e?.message || String(e)}` }],
});

const server = new McpServer({ name: "zukai-jev", version: "0.1.0" });

// ── ping: live なのか stub なのかを最初に確かめる ──────────────────────────
server.registerTool(
  "jev_ping",
  {
    title: "Jev 接続確認",
    description:
      "Jev への接続モード（live / stub）、モデル、エンドポイント、APIキーの有無、現在のルーブリックを返す。stub の場合その評価は偽物なので、必ず最初に確認すること。",
    inputSchema: {},
  },
  async () => {
    const rubric = loadRubric(REPO_ROOT);
    return ok({
      ...describeClient(),
      repo_root: REPO_ROOT,
      rubric: {
        profile: rubric.profile,
        source: rubric.source || "built-in",
        dimensions: rubric.dimensions.map((d) => d.key),
        gates: rubric.gates.map((g) => g.key),
        blocking: rubric.thresholds.blocking,
      },
      warning: MODE === "stub" ? "APIキーが無いため stub モード。スコアは決定論的なダミーで、品質判断には使えない。" : null,
    });
  }
);

// ── review: ルーブリック全項目の評価 ───────────────────────────────────────
server.registerTool(
  "jev_review",
  {
    title: "図解をレビューする",
    description:
      "図解アーティファクトをルーブリック全項目（構造・因果・密度・階層・ラベル・自己完結性・可読性 + 裏付け/公開可否ゲート）で評価し、判定と修正項目リストを返す。結果は .jev/runs.jsonl に記録される。",
    inputSchema: {
      task: z.string().describe("この図解が説明すべき仕組み。依頼内容をそのまま。"),
      artifact_path: z.string().optional().describe("リポジトリ相対のアーティファクトパス。"),
      content: z.string().optional().describe("パスの代わりに中身を直接渡す場合。"),
      source_material: z.string().optional().describe("図解の元になった資料。裏付け判定に使う。"),
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
        verdict: result.verdict,
        overall: result.overall,
        dimensions: result.dimensions,
        gates: result.gates,
        failures: result.failures,
        blocking_failures: result.blocking_failures,
        jev_next_action: result.jev_next_action,
      });
      store.setState(REPO_ROOT, {
        status: "idle",
        stage: null,
        run_id: runId,
        artifact: artifact.path,
        iteration,
        last_verdict: result.verdict,
        last_overall: result.overall,
        last_seq: record.seq,
      });
      return ok({
        seq: record.seq,
        run_id: runId,
        iteration,
        mode: res.mode,
        verdict: result.verdict,
        overall: result.overall,
        latency_ms: res.latency_ms,
        dimensions: result.dimensions,
        gates: result.gates,
        fixes,
        jev_next_action: result.jev_next_action,
        stub_warning: res.mode === "stub" ? "stub モードの結果。品質判断には使えない。" : undefined,
      });
    } catch (e) {
      store.setState(REPO_ROOT, { status: "error", stage: null, last_error: String(e?.message || e) });
      return fail(e);
    }
  }
);

// ── gate: 公開してよいかだけを安く判定 ─────────────────────────────────────
server.registerTool(
  "jev_gate",
  {
    title: "公開ゲート",
    description:
      "ゲート項目（裏付け・公開可否）と次アクションだけを判定する軽量版。反復の途中で「まだ直すか、出すか」を決めるのに使う。",
    inputSchema: {
      task: z.string().describe("この図解が説明すべき仕組み。"),
      artifact_path: z.string().optional(),
      content: z.string().optional(),
      source_material: z.string().optional(),
      run_id: z.string().optional(),
    },
  },
  async ({ task, artifact_path, content, source_material, run_id }) => {
    let artifact;
    try {
      artifact = readArtifact(artifact_path, content);
    } catch (e) {
      return fail(e);
    }
    const runId = resolveRun(artifact.path, run_id);
    store.setState(REPO_ROOT, {
      status: "running",
      stage: "jev_gate",
      run_id: runId,
      artifact: artifact.path,
    });
    try {
      const rubric = loadRubric(REPO_ROOT);
      const res = await callJev(
        buildState({ task, sourceMaterial: source_material, artifact }),
        buildQuestions(rubric, { gateOnly: true })
      );
      const result = interpret(res.answers, { ...rubric, dimensions: [] });
      const record = store.append(REPO_ROOT, {
        kind: "gate",
        run_id: runId,
        iteration: store.nextIteration(REPO_ROOT, runId),
        artifact: artifact.path,
        task,
        mode: res.mode,
        model: res.model,
        latency_ms: res.latency_ms,
        verdict: result.verdict,
        overall: null,
        dimensions: [],
        gates: result.gates,
        failures: result.failures,
        blocking_failures: result.blocking_failures,
        jev_next_action: result.jev_next_action,
      });
      store.setState(REPO_ROOT, {
        status: "idle",
        stage: null,
        last_verdict: result.verdict,
        last_seq: record.seq,
      });
      return ok({
        seq: record.seq,
        run_id: runId,
        mode: res.mode,
        verdict: result.verdict,
        gates: result.gates,
        jev_next_action: result.jev_next_action,
        stub_warning: res.mode === "stub" ? "stub モードの結果。品質判断には使えない。" : undefined,
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
      "Jev の素の呼び出し。state と型付き質問マップを渡して一往復で全回答を得る。各質問は { type: 'choice'|'score'|'noul', instructions, criteria }。choice の criteria は {key:説明} のマップ、score は低→高の順序付き文字列配列、noul は criteria 不要。",
    inputSchema: {
      state: z.string().describe("判断対象の文脈。"),
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
