// Jev (TypeSafe AI の判断特化モデル) クライアント。
//
// 仕様は docs/HANDOFF-jev-gate.md 5.1 に従う（Vercel AI Gateway 経由）:
//   import { experimental_evaluate as evaluate } from 'ai';
//   await evaluate({ model: 'typesafe-ai/jev', state, questions })
//
//   questions: { <name>: { type: 'boolean'|'score', instructions, criteria? } }
//   answers:   boolean -> { type: 'boolean', probability }   ← value フィールドは存在しない
//              probability は P(true)。極性は defect なので「欠陥が存在する確率」。
//              score   -> { type: 'score', score }  score は 0 起点の小数位置 [0, 水準数-1]
//
// @ai-sdk/provider の EvaluationModelV4 契約で確認したこと（HANDOFF 5.2 の宿題の一部が片付く）:
//   - boolean の probability は "Model-estimated P(true), in [0,1]"。confidence ではない
//   - score は "Fractional position in [0, number of levels - 1]"。**0 起点の連続値**
//   - result には warnings[] と rounding{probabilityDecimals,scoreDecimals} が付く
//   - evaluate は maxRetries 既定 2 で自前に再試行する。HANDOFF 2.3 の retry_limit=3 とは
//     別の層（通信の再試行 vs 内容の作り直し）なので混同しないこと
// ただし **実キーでの疎通は未実施**（HANDOFF 8章 #1）。認証・課金・実際の返り値は未確認。

import { existsSync } from "node:fs";
import { resolve } from "node:path";

// 自己診断は必ず stub で走らせる。鍵が置いてあるだけで live に切り替わると、
// npm run check がネットワークと課金に依存し、実行のたびに外部へ state を送ることになる。
// ZUKAI_FORCE_STUB=1 のときは .env を読みに行かない（鍵をプロセスに入れない）。
const FORCE_STUB = process.env.ZUKAI_FORCE_STUB === "1";

// HANDOFF 6章 既知のつまずき #1: 鍵のファイル名は必ず .env。
// dotenv は既定で .env しか読まないが、Node 20.12+ の組み込みで同じことができるので依存を足さない。
if (!FORCE_STUB) {
  try {
    const envPath = resolve(process.env.ZUKAI_REPO_ROOT || process.cwd(), ".env");
    if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
      process.loadEnvFile(envPath);
    }
  } catch {
    // .env が壊れていても stub では動く。live なら鍵が無い扱いになり MODE で露見する。
  }
}

const MODEL = process.env.JEV_MODEL || "typesafe-ai/jev";
// HANDOFF 5.1: 認証は Vercel AI Gateway。旧実装の TYPESAFE_API_KEY は受けない
// （エンドポイントが別物なので、通ってしまうより落ちた方が安全）。
const API_KEY = FORCE_STUB ? "" : process.env.AI_GATEWAY_API_KEY || "";
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 20000);
const CONTEXT_TOKENS = 32000; // HANDOFF 5.1

// stub モードは鍵無しでもループを回せるようにするためだけのもの。
// 生成されるレコードは全て mode:"stub" が付くので、どの表示もこれを判定として通せない。
export const MODE = API_KEY ? "live" : "stub";

export function describeClient() {
  return {
    mode: MODE,
    model: MODEL,
    transport: "vercel-ai-gateway",
    key_env: "AI_GATEWAY_API_KEY",
    key_present: Boolean(API_KEY),
    forced_stub: FORCE_STUB,
    context_tokens: CONTEXT_TOKENS,
    agreement_note:
      "Jev の一致度は約68%（自社4ワークフロー評価で67.8%）。正解ラベルは他モデルの平均であり「正しさ」ではなく「一致度」。",
  };
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function stubAnswer(state, name, question) {
  const r = hash32(`${name}::${question.instructions}::${state.length}::${state.slice(0, 512)}`);
  if (question.type === "score") {
    const levels = Array.isArray(question.criteria) ? question.criteria.length : 5;
    // 契約どおり 0 起点の小数位置 [0, levels-1] を返す。
    return { type: "score", score: Number((r * (levels - 1)).toFixed(2)) };
  }
  return { type: "boolean", probability: Number((0.1 + r * 0.85).toFixed(3)) };
}

function callStub(state, questions) {
  const answers = {};
  for (const [name, q] of Object.entries(questions)) answers[name] = stubAnswer(state, name, q);
  return { model: `${MODEL}#stub`, answers, usage: { stub: true }, warnings: [], rounding: null };
}

async function callLive(state, questions) {
  // ai は live のときだけ読む。これで npm install 前でも stub と自己診断が動く。
  let evaluate;
  try {
    ({ experimental_evaluate: evaluate } = await import("ai"));
  } catch (e) {
    throw new Error(
      `ai パッケージを読み込めません（AI SDK 7 以降が必要）: ${e.message}。npm install を実行してください。`
    );
  }
  if (typeof evaluate !== "function") {
    throw new Error(
      "ai パッケージに experimental_evaluate がありません。AI SDK 7 以降か確認してください。"
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await evaluate({ model: MODEL, state, questions, abortSignal: controller.signal });
  } catch (e) {
    throw new Error(
      e?.name === "AbortError"
        ? `Jev の呼び出しが ${TIMEOUT_MS}ms でタイムアウトしました。`
        : `Jev の呼び出しに失敗しました: ${e?.message || String(e)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

// 例外は握らずに投げる。呼び出し側が isError で返す。
// HANDOFF 禁止事項 #5: 判定不能を PASS に倒さない。
export async function callJev(state, questions) {
  const started = Date.now();
  const data = MODE === "live" ? await callLive(state, questions) : callStub(state, questions);
  return {
    mode: MODE,
    model: data.model || data.response?.modelId || MODEL,
    answers: data.answers || {},
    usage: data.usage || null,
    // プロバイダの警告を捨てない。捨てると劣化した評価が正常な判定に見える。
    provider_warnings: Array.isArray(data.warnings) ? data.warnings : [],
    rounding: data.rounding ?? null,
    latency_ms: Date.now() - started,
  };
}

// boolean の欠陥確率。仕様で 0..1 が確定しているので正規化はしない。
// 範囲外・非数値は null（= 未回答扱い）にして、静かに 0 として数えられないようにする。
export function readProbability(answer) {
  const p = answer?.probability;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return p;
}

// HANDOFF 5.2 は「score の返り値の下限が 1 か 0 か未検証」としていたが、
// @ai-sdk/provider の EvaluationModelV4 契約で確定している:
//   score 質問の criteria  = "At least two ordered levels, indexed from zero."
//   score 回答の score     = "Fractional position in [0, number of levels - 1]."
// つまり **0 起点の連続値**。整数ではないので丸めずに保持する。
// 範囲外は読まない（クランプすると規約違反のプロバイダを黙って通してしまう）。
export function readScoreLevel(raw, levelCount) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || levelCount < 2) return null;
  const span = levelCount - 1;
  if (raw < 0 || raw > span) return null;
  return {
    raw, // 0 起点の小数位置
    level: Number((raw + 1).toFixed(2)), // 人間向けの 1 起点表記。小数を残す
    normalized: Number((raw / span).toFixed(3)),
  };
}

// score 回答の生値。フィールド名は契約で score に確定している。
// value / level の別名は受けない — 受けると規約違反のプロバイダを黙って通してしまう。
export function readScore(answer) {
  const v = answer?.score;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
