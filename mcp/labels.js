// 出荷判定の記録。検査器が合格にした成果物を、本人が出荷したか止めたかを残す。
// 「Jev は合格にしたが本人が止めた」事例（too_lenient）が溜まる唯一の経路で、閾値の較正に使う。
//
// 保存先を2つに分けている。**このリポジトリは public** なので、評価対象の本文を commit しない。
//   .jev/reviews/<seq>.json   レビュー時の入力（本文を含む）。gitignore。jev_label が標本を組むのに使う
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

function nextId(ledger, now) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const n = ledger.filter((e) => e.id?.startsWith(`live-${day}-`)).length + 1;
  return `live-${day}-${String(n).padStart(3, "0")}`;
}

export function appendLabel(repoRoot, fields, now = new Date()) {
  const entry = { id: fields.id ?? nextId(readLedger(repoRoot), now), ts: now.toISOString(), label_source: "live", ...fields };
  const path = ledgerPath(repoRoot);
  ensureDir(path);
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}
