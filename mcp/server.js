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
import {
  loadRubric,
  loadAllRubrics,
  buildQuestions,
  interpret,
  fixList,
  groupStructure,
  SCOPES,
  DEFAULT_SCOPE,
} from "./rubric.js";
import { evaluateEscalation, previousReview, previousFailedGroupsOf } from "./escalation.js";
import * as store from "./store.js";
import { buildState } from "./state.js";
import { loadConfig, writeMode } from "./config.js";
import { buildAdvisoryReport } from "./report.js";
import * as labels from "./labels.js";

const REPO_ROOT = resolve(process.env.ZUKAI_REPO_ROOT || process.cwd());

const CALIBRATION_WARNING =
  "ルーブリックの閾値は較正前の暫定値（HANDOFF 3.3「0.70 と 0.50 に根拠はない」）。" +
  "samples.json と較正が済むまで、この判定を品質の根拠にしないこと（HANDOFF 禁止事項 #6）。";
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
      "Jev への接続モード（live / stub）、モデル、極性、そして diagram / article 両方のルーブリック" +
      "（版・質問数・閾値・群構成）を返す。stub の場合その評価は偽物なので、必ず最初に確認すること。",
    inputSchema: {},
  },
  async () => {
    let rubrics;
    try {
      // 両方の scope を毎回読む。片方しか見ないと、記事用ルーブリックが壊れていても
      // 図解の ping が通って「基準は健全」に見えてしまう。
      rubrics = loadAllRubrics(REPO_ROOT);
    } catch (e) {
      return fail(e);
    }
    const warnings = [
      MODE === "stub" ? `APIキー（AI_GATEWAY_API_KEY）が無いため stub モード。${STUB_WARNING}` : null,
    ];
    const described = rubrics.map((rubric) => {
      const groups = groupStructure(rubric);
      const unreachable = groups.filter((g) => !g.reachable).map((g) => g.key);
      const fragile = groups.filter((g) => g.fragile).map((g) => g.key);
      if (!rubric.thresholds.calibrated) warnings.push(`${rubric.scope}: ${CALIBRATION_WARNING}`);
      if (unreachable.length)
        warnings.push(
          `${rubric.scope}: 構造上 FAIL しえない群がある: ${unreachable.join(", ")}。critical が無く、質問数が group_fail_at に届かない。ルーブリック再設計で解消すること。`
        );
      if (fragile.length)
        warnings.push(
          `${rubric.scope}: FAIL に全問一致が必要な群がある: ${fragile.join(", ")}。critical が無く slack が 0 なので、1件の欠陥では落ちない。実質的にはほぼ到達しない。`
        );
      return {
        scope: rubric.scope,
        note: rubric.scope_note,
        version: rubric.version,
        source: rubric.source,
        source_origin: rubric.source_origin,
        polarity: rubric.polarity,
        question_count: rubric.questions.length,
        thresholds: rubric.thresholds,
        groups,
        scored: {
          key: rubric.scored.key,
          threshold: rubric.scored.threshold,
          human_review_required: rubric.scored.human_review_required,
        },
        escalation: rubric.escalation,
      };
    });
    const config = loadConfig(REPO_ROOT);
    if (config.warning) warnings.push(config.warning);
    const transition = labels.transitionStatus(REPO_ROOT, config);
    warnings.push(...transition.prompts);
    return ok({
      ...describeClient(),
      review_mode: config.mode,
      review_mode_source: config.source,
      review_mode_note:
        config.mode === "advisory"
          ? "助言モード（v0）。jev_review は判定を返すが止めない。修正ループを回さず、報告を人間に見せて止まること。"
          : "ゲートモード。群FAIL なら修正ループ（最大3回）、escalate が返ったら人間に返す。",
      transition,
      repo_root: REPO_ROOT,
      scopes: SCOPES,
      default_scope: DEFAULT_SCOPE,
      polarity_note:
        "probability は「欠陥が存在する確率」。高いほど悪い。閾値以上で欠陥ありと判定する。",
      rubrics: described,
      warnings: warnings.filter(Boolean),
    });
  }
);

// ── review: ルーブリック全項目の評価 ───────────────────────────────────────
server.registerTool(
  "jev_review",
  {
    title: "図解をレビューする",
    description:
      "図解または記事を欠陥ルーブリック全項目で検査し、群単位の判定と修正項目リストを返す。" +
      "scope=diagram（既定）は図解用の22問（g1 トレーサビリティ / g2 図のタイトル・軸・単位 / " +
      "g3 本文と図の整合 / g4 粒度バランス / g5 事実と推測の区別）、" +
      "scope=article は図を伴わない文章用の18問（g1 / g4 / g5 / g6 記事としての構成）。" +
      "critical 項目は単独で群FAIL、それ以外は群内2件以上で群FAIL。" +
      "s7_originality（一次経験の裏打ち）は判定に算入せず、人間確認の対象として別枠で返る。" +
      "review_mode（zukai.config.json）が advisory のとき（v0）は止めない：" +
      "report.text をそのままユーザーに見せ、修正ループを回さずに止まり、判定を jev_label で記録すること。" +
      "gate のときは、反復の停滞・振動をサーバー側で判定し escalate に入れて返すので、" +
      "空でなければ回すのをやめて人間に返すこと。" +
      "結果は .jev/runs.jsonl に記録される。",
    inputSchema: {
      task: z.string().describe("この図解／記事が説明すべき仕組み・答えるべき問い。依頼内容をそのまま。"),
      scope: z
        .enum(["diagram", "article"])
        .optional()
        .describe(
          "対象の種類。図を含むアーティファクトは diagram（既定）、図を伴わない文章は article。" +
            "取り違えると、図の無い文章に軸・単位の質問を当てて空振りする（HANDOFF 3.1）。"
        ),
      artifact_path: z.string().optional().describe("リポジトリ相対のアーティファクトパス。"),
      content: z.string().optional().describe("パスの代わりに中身を直接渡す場合。"),
      source_material: z
        .string()
        .optional()
        .describe("元になった資料。裏付け判定（g5 群）に使う。省くと効かない。"),
      note: z.string().optional().describe("前回からの変更点。反復の記録に残る。"),
      run_id: z.string().optional().describe("反復をまとめる ID。省略時は自動。"),
    },
  },
  async ({ task, artifact_path, content, source_material, note, run_id, scope }) => {
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
      const config = loadConfig(REPO_ROOT);
      const advisory = config.mode === "advisory";
      const rubric = loadRubric(REPO_ROOT, scope || DEFAULT_SCOPE);
      const state = buildState({
        task,
        sourceMaterial: source_material,
        artifact,
        note,
        scope: rubric.scope,
      });
      const res = await callJev(state, buildQuestions(rubric));
      const result = interpret(res.answers, rubric);
      const fixes = fixList(result, rubric);
      // エスカレーションはサーバーが計算する。呼び出し側に履歴の突き合わせを任せると、
      // 忘れた瞬間に静かに発火しなくなる（HANDOFF 2.3）。
      const prev = previousReview(store.readAll(REPO_ROOT), runId, iteration);
      // scope が変われば群の集合そのものが変わる（article には g6 があり g2/g3 が無い）。
      // 別のルーブリックの FAIL群 と突き合わせると oscillation が誤発火するので比較しない。
      const comparablePrev = prev && (prev.scope ?? DEFAULT_SCOPE) === rubric.scope ? prev : null;
      // 助言モードはループを回さないので、停滞・振動は起こりえない。判定しない（v0 方針 1章）。
      const escalation = advisory
        ? { escalate: [], reasons: [], previous_failed_groups: previousFailedGroupsOf(comparablePrev) }
        : evaluateEscalation({
        iteration,
        verdict: result.verdict,
        failedGroups: result.failed_groups,
        previousFailedGroups: previousFailedGroupsOf(comparablePrev),
        // 上限もルーブリック側の値に従う（HANDOFF 2.3 は3回）。
        maxRetries: rubric.escalation.max_retries,
          });
      const record = store.append(REPO_ROOT, {
        kind: "review",
        run_id: runId,
        iteration,
        artifact: artifact.path,
        task,
        note: note || null,
        scope: rubric.scope,
        rubric_version: rubric.version,
        rubric_source: rubric.source,
        review_mode: config.mode,
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
      // 判定を jev_label で付けるときに標本を組めるよう、入力を手元に残す（本文を含むので .jev/ 配下・commit しない）。
      labels.saveReviewSnapshot(REPO_ROOT, record.seq, {
        seq: record.seq,
        scope: rubric.scope,
        artifact: artifact.path,
        task,
        content: artifact.content,
        source_material: source_material || null,
        rubric_version: rubric.version,
        client_mode: res.mode,
        verdict: result.verdict,
        failed_groups: result.failed_groups,
      });
      const report = advisory
        ? buildAdvisoryReport({ result, fixes, rubric, clientMode: res.mode, seq: record.seq })
        : null;
      return ok({
        review_mode: config.mode,
        // 呼び出し側が次にやること。advisory では直さない・回さない。
        next_action: advisory ? "present_report_and_stop" : escalation.escalate.length ? "stop_and_escalate" : "fix_and_rereview",
        report,
        label_request: {
          tool: "jev_label",
          seq: record.seq,
          ask: [
            "human_verdict: 合格(pass) / 不合格(fail)",
            "jev_caught_missed: この報告を見て初めて気づいた欠陥があったか",
            "human_caught_missed: Jev が指摘せず、自分で見つけた欠陥があったか",
          ],
        },
        seq: record.seq,
        run_id: runId,
        iteration,
        mode: res.mode,
        scope: rubric.scope,
        rubric_version: rubric.version,
        question_count: rubric.questions.length,
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
          config.warning,
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
      const config = loadConfig(REPO_ROOT);
      return ok({
        client: describeClient(),
        review_mode: config.mode,
        transition: labels.transitionStatus(REPO_ROOT, config),
        ...store.summarize(REPO_ROOT),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

// ── label: 人間の判定を記録する（v0 方針 2.2。サンプル不足の本命の解決策）──────────
server.registerTool(
  "jev_label",
  {
    title: "人間の判定を記録する",
    description:
      "jev_review の報告を見たユーザーの判定を記録する。ユーザー本人が答えた値だけを渡すこと（推測で埋めない）。" +
      "human_verdict は必須。jev_caught_missed / human_caught_missed は移行条件（Jev が目視を上回ったか）の判定に使う。" +
      "台帳 labels/ledger.jsonl には本文を書かない（リポジトリが public のため）。" +
      "返り値の sample は本文を含むので、Drive「99. Jev連携/labels」に保存し、台帳の変更は commit / push すること。",
    inputSchema: {
      seq: z.number().int().describe("jev_review が返した seq（label_request.seq）"),
      human_verdict: z.enum(["pass", "fail"]).describe("ユーザーの最終判定"),
      jev_caught_missed: z.boolean().optional().describe("報告を見て初めて気づいた欠陥があったか"),
      human_caught_missed: z.boolean().optional().describe("Jev が指摘せず、ユーザーが見つけた欠陥があったか"),
      group_labels: z
        .record(z.string(), z.enum(["pass", "fail"]))
        .optional()
        .describe("任意。群ごとに判定できたときだけ（例: { g5_epistemic: 'fail' }）"),
      note: z.string().optional().describe("理由など（任意・台帳に残る。本文の引用は書かないこと）"),
    },
  },
  async ({ seq, human_verdict, jev_caught_missed, human_caught_missed, group_labels, note }) => {
    try {
      const review = store.readAll(REPO_ROOT).find((r) => r.seq === seq && r.kind === "review");
      if (!review) throw new Error(`seq ${seq} のレビューが .jev/runs.jsonl にありません。`);
      const snap = labels.readReviewSnapshot(REPO_ROOT, seq);
      if (group_labels) {
        const rubric = loadRubric(REPO_ROOT, review.scope || DEFAULT_SCOPE);
        const unknown = Object.keys(group_labels).filter((g) => !rubric.groups.some((x) => x.key === g));
        if (unknown.length) throw new Error(`${review.scope} のルーブリックに無い群: ${unknown.join(", ")}`);
      }
      const entry = labels.appendLabel(REPO_ROOT, {
        review_seq: seq,
        run_id: review.run_id,
        scope: review.scope || DEFAULT_SCOPE,
        rubric_version: review.rubric_version,
        client_mode: review.mode,
        review_mode: review.review_mode ?? null,
        jev_verdict: review.verdict,
        jev_failed_groups: review.failed_groups,
        human_verdict,
        jev_caught_missed: jev_caught_missed ?? null,
        human_caught_missed: human_caught_missed ?? null,
        group_labels: group_labels ?? null,
        note: note ?? null,
      });
      const config = loadConfig(REPO_ROOT);
      const transition = labels.transitionStatus(REPO_ROOT, config);
      // 方針 2.2 の形。text と scope/task/content の両方を持たせ、samples.json にそのまま足せるようにする。
      const sample = snap
        ? {
            id: entry.id,
            kind: entry.scope,
            scope: entry.scope,
            task: snap.task,
            text: snap.content,
            content: snap.content,
            source_material: snap.source_material,
            human_verdict,
            group_labels: group_labels ?? null,
            label_source: "live",
            rubric_version: entry.rubric_version,
            jev_verdict: entry.jev_verdict,
            jev_failed_groups: entry.jev_failed_groups,
          }
        : null;
      return ok({
        recorded: entry,
        outcome: entry.outcome,
        sample,
        save_sample_to: "Drive「99. Jev連携/labels」に `${id}.json` として保存（本文を含むのでリポジトリに commit しない）",
        commit: "labels/ledger.jsonl を commit / push すること（クラウドのコンテナは消える）",
        transition,
        warnings: [
          entry.outcome === "excluded_stub" ? "stub の判定に付けたラベル。移行条件にも較正にも数えない。" : null,
          entry.outcome === "unrated" ? "jev_caught_missed / human_caught_missed が無いので、移行条件の判定には数えない。" : null,
          snap ? null : "レビュー時の入力が .jev/reviews に無い（コンテナが入れ替わった可能性）。本文つきの標本は組めなかった。",
          ...transition.prompts,
        ].filter(Boolean),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

// ── record_decision: 移行判断を記録する（v0 方針 4章「判断しないまま続けない」）─────────
server.registerTool(
  "jev_record_decision",
  {
    title: "移行判断を記録する",
    description:
      "移行条件（streak）または件数の節目（checkpoint）に達したとき、ユーザー本人の判断を記録する。" +
      "ユーザーが明示的に判断したときだけ呼ぶこと。switch_to_gate を記録すると zukai.config.json の mode を gate に書き換える。" +
      "stay_advisory も必ず理由つきで記録する（判断しないまま助言モードが続くのを防ぐ）。",
    inputSchema: {
      scope: z.enum(["diagram", "article"]),
      trigger: z.enum(["streak", "checkpoint"]),
      decision: z.enum(["stay_advisory", "switch_to_gate"]),
      reason: z.string().min(1).describe("判断の理由（本人の言葉で）"),
      calibration_report: z.string().optional().describe("checkpoint の場合、見た較正報告（ファイル名や一致率）"),
    },
  },
  async ({ scope, trigger, decision, reason, calibration_report }) => {
    try {
      const config = loadConfig(REPO_ROOT);
      const before = labels.transitionStatus(REPO_ROOT, config).scopes[scope];
      const entry = labels.appendDecision(REPO_ROOT, {
        scope,
        trigger,
        decision,
        reason,
        calibration_report: calibration_report ?? null,
        mode_before: config.mode,
        streak_at_decision: before.streak,
        labels_at_decision: before.checkpoint.labels,
      });
      if (decision === "switch_to_gate") writeMode(REPO_ROOT, "gate", entry.ts.slice(0, 10));
      return ok({
        recorded: entry,
        review_mode: loadConfig(REPO_ROOT).mode,
        commit: "labels/decisions.jsonl（と zukai.config.json）を commit / push すること",
        warnings: [
          decision === "switch_to_gate" && trigger === "streak" && !calibration_report
            ? "較正を見ないままゲートに移った。閾値は較正前の暫定値のままなので、ゲートの誤FAIL・見逃しの率は分かっていない。"
            : null,
          decision === "switch_to_gate" ? "mode はリポジトリ全体に効く（scope 別ではない）。もう一方の scope もゲートで回ることになる。" : null,
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
  `zukai-jev MCP 起動 · mode=${MODE} · root=${REPO_ROOT} · ${
    MODE === "stub" ? "APIキー未設定（stub）" : "live"
  }`
);
