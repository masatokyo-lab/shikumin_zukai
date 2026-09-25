// 人間の判定の記録と、ゲートモードへの移行条件（v0 方針 2.2 / 4章）。
//
// 保存先を2つに分けている。**このリポジトリは public** なので、評価対象の本文を commit しない。
//   .jev/reviews/<seq>.json   レビュー時の入力（本文を含む）。gitignore。jev_label が標本を組むのに使う
//   labels/ledger.jsonl       判定の台帳。**本文を含まない**。commit する（クラウドのコンテナは消えるため）
//   labels/decisions.jsonl    移行判断の記録。commit する
// 本文つきの標本は jev_label が返すので、呼び出し側が Drive「99. Jev連携/labels」に保存する。
//
// 移行条件（2026-09-25 本人決定）: 「3回連続で、本人の目視判断を Jev の判断が上回ったら」。
// 「上回った」は、ラベル付け時の2つの問いで判定する:
//   jev_caught_missed   Jev の報告を見て初めて気づいた欠陥があったか
//   human_caught_missed Jev が指摘せず、本人が見つけた欠陥があったか
//   jev_better = 前者のみ yes / jev_worse = 後者のみ yes / even = 両方 yes か両方 no
// 連続の数え方: jev_better で +1、jev_worse で 0。even は streak_ties_reset（既定 true = 文字どおり「連続」）で 0。
// Jev が判定不能（unknown）だった回は jev_worse として数える。stub の回は数えない。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCOPES } from "./rubric.js";

const SNAP_DIR = [".jev", "reviews"];
const LEDGER = ["labels", "ledger.jsonl"];
const DECISIONS = ["labels", "decisions.jsonl"];

const p = (repoRoot, parts) => join(repoRoot, ...parts);
function ensureDir(path) {
  const d = path.slice(0, path.lastIndexOf("/"));
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function appendJsonl(path, obj) {
  ensureDir(path);
  appendFileSync(path, JSON.stringify(obj) + "\n", "utf8");
}

export function saveReviewSnapshot(repoRoot, seq, snapshot) {
  const path = join(p(repoRoot, SNAP_DIR), `${seq}.json`);
  ensureDir(path);
  writeFileSync(path, JSON.stringify(snapshot), "utf8");
}

export function readReviewSnapshot(repoRoot, seq) {
  const path = join(p(repoRoot, SNAP_DIR), `${seq}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export const readLedger = (repoRoot) => readJsonl(p(repoRoot, LEDGER));
export const readDecisions = (repoRoot) => readJsonl(p(repoRoot, DECISIONS));

// 人間ラベルは pass / fail。ゲートの verdict との対応は較正と同じ（calibrate-core.judgeAt）。
export function toPassFail(verdict) {
  if (verdict === "block") return "fail";
  if (verdict === "ship" || verdict === "revise") return "pass";
  return "unknown";
}

export function classify({ client_mode, jev_verdict, jev_caught_missed, human_caught_missed, label_source }) {
  if (label_source !== "live") return "curated";
  if (client_mode !== "live") return "excluded_stub";
  if (toPassFail(jev_verdict) === "unknown") return "jev_worse";
  if (typeof jev_caught_missed !== "boolean" || typeof human_caught_missed !== "boolean") return "unrated";
  if (jev_caught_missed && !human_caught_missed) return "jev_better";
  if (human_caught_missed && !jev_caught_missed) return "jev_worse";
  return "even";
}

function nextId(ledger, now) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const n = ledger.filter((e) => e.id?.startsWith(`live-${day}-`)).length + 1;
  return `live-${day}-${String(n).padStart(3, "0")}`;
}

export function appendLabel(repoRoot, fields, now = new Date()) {
  const ledger = readLedger(repoRoot);
  const entry = {
    id: fields.id ?? nextId(ledger, now),
    ts: now.toISOString(),
    label_source: "live",
    ...fields,
  };
  entry.outcome = classify(entry);
  appendJsonl(p(repoRoot, LEDGER), entry);
  return entry;
}

export function appendDecision(repoRoot, decision, now = new Date()) {
  const entry = { ts: now.toISOString(), ...decision };
  appendJsonl(p(repoRoot, DECISIONS), entry);
  return entry;
}

// 同じレビューに付け直した場合は最後の判定を採る。
function latestPerReview(entries) {
  const seen = new Map();
  const out = [];
  for (const e of entries) {
    if (e.review_seq == null) {
      out.push(e);
      continue;
    }
    if (seen.has(e.review_seq)) out[seen.get(e.review_seq)] = null;
    seen.set(e.review_seq, out.length);
    out.push(e);
  }
  return out.filter(Boolean);
}

export function transitionStatus(repoRoot, config) {
  const t = config.transition;
  const ledger = latestPerReview(readLedger(repoRoot));
  const decisions = readDecisions(repoRoot);
  const scopes = {};
  for (const scope of SCOPES) {
    const mine = ledger.filter((e) => e.scope === scope);

    // 判断を記録したら、そこから数え直す。判断済みの連続で毎回催促しないため。
    const lastStreakDecision = decisions.filter((d) => d.scope === scope && d.trigger === "streak").at(-1);
    let streak = 0;
    const counted = [];
    for (const e of mine) {
      if (lastStreakDecision && e.ts <= lastStreakDecision.ts) continue;
      if (e.outcome === "jev_better") streak += 1;
      else if (e.outcome === "jev_worse") streak = 0;
      else if (e.outcome === "even" && t.streak_ties_reset) streak = 0;
      else continue;
      counted.push(e.outcome);
    }
    const streakMet = streak >= t.streak_required;

    // 件数の節目。現行基準のラベルだけを数える（過去の承認はラベルにならない。索引 A03）。
    const current = mine.filter((e) => !e.needs_rejudge && (e.human_verdict === "pass" || e.human_verdict === "fail") && e.outcome !== "excluded_stub");
    const pass = current.filter((e) => e.human_verdict === "pass").length;
    const fail = current.length - pass;
    const minority = current.length ? Math.min(pass, fail) / current.length : 0;
    const checkpointMet = current.length >= t.checkpoint_labels_per_scope && minority >= t.checkpoint_min_minority_share;
    const checkpointDecided = decisions.some((d) => d.scope === scope && d.trigger === "checkpoint");

    scopes[scope] = {
      streak,
      streak_required: t.streak_required,
      streak_met: streakMet,
      streak_pending_decision: streakMet,
      recent_outcomes: counted.slice(-5),
      checkpoint: {
        labels: current.length,
        pass,
        fail,
        required: t.checkpoint_labels_per_scope,
        minority_share: Number(minority.toFixed(2)),
        met: checkpointMet,
        decided: checkpointDecided,
        pending_decision: checkpointMet && !checkpointDecided,
      },
      needs_rejudge: mine.filter((e) => e.needs_rejudge).map((e) => e.id),
    };
  }
  const prompts = [];
  for (const [scope, s] of Object.entries(scopes)) {
    if (s.streak_pending_decision)
      prompts.push(
        `${scope}: 移行条件を満たした（Jev が目視を${s.streak}回連続で上回った）。ゲートモードに移るか、助言モードを続けるかを本人が判断し、jev_record_decision で記録すること。`
      );
    if (s.checkpoint.pending_decision)
      prompts.push(
        `${scope}: 現行基準のラベルが${s.checkpoint.labels}件たまった。一致率がいくつであれ一度は較正（npm run calibrate）を実行して結果を本人が見て、判断を jev_record_decision で記録すること。`
      );
  }
  return { mode: config.mode, scopes, prompts };
}
