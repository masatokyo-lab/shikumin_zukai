// 評価履歴の保存先。.jev/runs.jsonl が唯一の真実で、ダッシュボードはその写し。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".jev";

function dir(repoRoot) {
  const d = join(repoRoot, DIR);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

const runsPath = (repoRoot) => join(dir(repoRoot), "runs.jsonl");
const statePath = (repoRoot) => join(dir(repoRoot), "state.json");

export function readAll(repoRoot) {
  const p = runsPath(repoRoot);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function append(repoRoot, record) {
  const existing = readAll(repoRoot);
  const seq = existing.length ? Math.max(...existing.map((r) => r.seq || 0)) + 1 : 1;
  const full = { seq, ts: new Date().toISOString(), ...record };
  appendFileSync(runsPath(repoRoot), JSON.stringify(full) + "\n", "utf8");
  return full;
}

export function feed(repoRoot, sinceSeq = 0, limit = 50) {
  const rows = readAll(repoRoot).filter((r) => (r.seq || 0) > sinceSeq);
  return { records: rows.slice(0, limit), remaining: Math.max(0, rows.length - limit) };
}

export function getState(repoRoot) {
  const p = statePath(repoRoot);
  if (!existsSync(p)) return { status: "idle", run_id: null, iteration: 0, stage: null };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { status: "idle", run_id: null, iteration: 0, stage: null };
  }
}

export function setState(repoRoot, patch) {
  const next = { ...getState(repoRoot), ...patch, updated_at: new Date().toISOString() };
  writeFileSync(statePath(repoRoot), JSON.stringify(next, null, 2), "utf8");
  return next;
}

// 反復は「同じ run の、同じ対象（subject）」で数える。層分割後は1つの記事で
// ①本文・②図単体・③整合を図の数だけ回すので、run だけで数えると他の層の検査まで周回に数えてしまう。
// subject を持たない古い記録は run だけで数える。
export function nextIteration(repoRoot, runId, subject = null, kind = null) {
  const prev = readAll(repoRoot).filter(
    (r) =>
      r.run_id === runId &&
      (subject == null || r.subject === subject) &&
      (kind == null || r.kind === kind)
  );
  return prev.length + 1;
}

// 同じ対象の直近の記録。層や図を行き来しても反復を数えられるよう、
// 「直前に検査したもの」ではなく「同じ対象の最後の記録」を探す。
export function lastForSubject(repoRoot, subject, kind) {
  const rows = readAll(repoRoot);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].subject === subject && rows[i].kind === kind) return rows[i];
  }
  return null;
}

export function summarize(repoRoot) {
  const rows = readAll(repoRoot);
  const state = getState(repoRoot);
  const byRun = new Map();
  for (const r of rows) {
    if (!r.run_id) continue;
    const entry = byRun.get(r.run_id) || {
      run_id: r.run_id,
      artifact: r.artifact,
      layer: r.layer ?? null,
      subject: r.subject ?? null,
      evaluations: 0,
    };
    entry.evaluations += 1;
    entry.last_verdict = r.verdict ?? entry.last_verdict;
    // 品質スコアではなく「欠陥なしと答えられた質問の割合」。ゲートには使わない。
    entry.last_clean_ratio = r.clean_ratio ?? entry.last_clean_ratio;
    entry.last_failed_groups = r.failed_groups ?? entry.last_failed_groups;
    entry.last_escalate = r.escalate ?? entry.last_escalate;
    entry.last_ts = r.ts;
    entry.artifact = r.artifact || entry.artifact;
    byRun.set(r.run_id, entry);
  }
  return { state, total_evaluations: rows.length, runs: [...byRun.values()].slice(-20) };
}
