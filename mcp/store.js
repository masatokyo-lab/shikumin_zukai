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

export function nextIteration(repoRoot, runId) {
  const prev = readAll(repoRoot).filter((r) => r.run_id === runId);
  return prev.length + 1;
}

export function summarize(repoRoot) {
  const rows = readAll(repoRoot);
  const state = getState(repoRoot);
  const byRun = new Map();
  for (const r of rows) {
    if (!r.run_id) continue;
    const entry = byRun.get(r.run_id) || { run_id: r.run_id, artifact: r.artifact, evaluations: 0 };
    entry.evaluations += 1;
    entry.last_verdict = r.verdict ?? entry.last_verdict;
    entry.last_overall = r.overall ?? entry.last_overall;
    entry.last_ts = r.ts;
    entry.artifact = r.artifact || entry.artifact;
    byRun.set(r.run_id, entry);
  }
  return { state, total_evaluations: rows.length, runs: [...byRun.values()].slice(-20) };
}
