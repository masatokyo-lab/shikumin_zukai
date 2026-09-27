// 人間の判定の記録。2種類を分けて残す（付記 G）:
//
//   kind: "layer_label"   ①本文 / ②図単体 / ③整合 のどれか1層について、**その層と同じものを見て**付けた判定。
//                         Jev と同じ入力・同じ群なので、閾値の較正に使える
//   kind: "publication"   ④公開判断（出す / 出さない）。人間が行い責任を持つ。**較正には使わない**
//                         （①②③のどれとも見るものと問うものが違う）。どの層も拾えなかった欠陥の手がかりにはなる
//
// 層分割より前の台帳（label_source: "curated"、scope: article / diagram）はそのまま残す。
// 読み替えは HANDOFF 付記 G: article → ①、g3 を理由に落とした diagram → ③（本文と図を分けて入れ直す）。
//
// 保存先を2つに分けている。**このリポジトリは public** なので、評価対象の本文を commit しない。
//   .jev/reviews/<seq>.json   検査時の入力（本文を含む）。gitignore。jev_label が標本を組むのに使う
//   labels/ledger.jsonl       判定の台帳。**本文を含まない**。commit する（クラウドのコンテナは消えるため）
// 本文つきの標本は jev_label が返すので、呼び出し側が Drive「99. Jev連携/labels」に保存する。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const snapPath = (repoRoot, seq) => join(repoRoot, ".jev", "reviews", `${seq}.json`);
const ledgerPath = (repoRoot) => join(repoRoot, "labels", "ledger.jsonl");

function ensureDir(path) {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export function saveReviewSnapshot(repoRoot, seq, snapshot) {
  const path = snapPath(repoRoot, seq);
  ensureDir(path);
  writeFileSync(path, JSON.stringify(snapshot), "utf8");
}

export function readReviewSnapshot(repoRoot, seq) {
  const path = snapPath(repoRoot, seq);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function readLedger(repoRoot) {
  const path = ledgerPath(repoRoot);
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

function nextId(ledger, now, prefix) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const n = ledger.filter((e) => e.id?.startsWith(`${prefix}-${day}-`)).length + 1;
  return `${prefix}-${day}-${String(n).padStart(3, "0")}`;
}

export function appendLabel(repoRoot, fields, { now = new Date(), prefix = "live", labelSource = "live" } = {}) {
  const entry = {
    id: fields.id ?? nextId(readLedger(repoRoot), now, prefix),
    ts: now.toISOString(),
    label_source: labelSource,
    ...fields,
  };
  const path = ledgerPath(repoRoot);
  ensureDir(path);
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/**
 * 較正用の標本（samples.json の1件）。検査時と**同じ state を組み直せる**入力を持つ。
 * calibrate-core が content.js / state.js で組み直し、state_sha256 が一致することを確かめる。
 */
export function sampleFromSnapshot(snap, entry) {
  // 層分割より前の検査（scope=article）は本文を content に持っていた。
  const text = snap.main ?? (snap.content != null ? { path: snap.artifact ?? "(legacy)", content: snap.content } : null);
  return {
    id: entry.id,
    layer: entry.layer,
    task: snap.task,
    source_material: snap.source_material,
    text,
    figure_file: snap.figure_file,
    figure: snap.figure,
    human_verdict: entry.human_verdict,
    group_labels: entry.group_labels,
    boundary: entry.boundary ?? false,
    label_source: "live",
    rubric_version: entry.rubric_version,
    state_sha256: snap.state_sha256,
    jev_result: entry.jev_result,
    jev_failed_groups: entry.jev_failed_groups,
  };
}
