// 運用設定（zukai.config.json）。ルーブリックは Drive 正本なので、運用上の切替はこちらに置く。
//
// mode:
//   advisory  v0。Jev は判定するが止めない。修正ループを回さず、報告を人間に見せて止まる
//   gate      将来。群FAIL で止め、最大3回まで修正ループを回す
// モード名に「gate」を advisory の意味で使わないこと。v0 は検査器であってゲートではない。
// これは HANDOFF 禁止事項 #1（群のオーバーライド）ではなく、設定値として見えるモード切替である。

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REVIEW_MODES = ["advisory", "gate"];
const FILE = "zukai.config.json";

const DEFAULT_TRANSITION = {
  streak_required: 3,
  streak_ties_reset: true,
  checkpoint_labels_per_scope: 10,
  checkpoint_min_minority_share: 0.3,
};

export function loadConfig(repoRoot) {
  const path = join(repoRoot, FILE);
  if (!existsSync(path)) {
    return {
      mode: "advisory",
      source: "default",
      transition: { ...DEFAULT_TRANSITION },
      warning: `${FILE} が無いため advisory で動いている。モードは設定値として明示すること。`,
    };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${FILE} が JSON として読めません: ${e.message}`);
  }
  // 未知のモードで黙って advisory に倒さない。綴り違いで gate のつもりが検査だけになるのを防ぐ。
  if (!REVIEW_MODES.includes(raw.mode)) {
    throw new Error(`${FILE} の mode は ${REVIEW_MODES.join(" / ")} のいずれか（実際: ${JSON.stringify(raw.mode)}）。`);
  }
  return {
    mode: raw.mode,
    source: FILE,
    decided_at: raw.mode_decided_at ?? null,
    note: raw.mode_note ?? null,
    transition: { ...DEFAULT_TRANSITION, ...(raw.transition || {}) },
    warning: null,
  };
}

// モード切替は人間の判断を記録したときにだけ行う（jev_record_decision）。
export function writeMode(repoRoot, mode, decidedAt) {
  if (!REVIEW_MODES.includes(mode)) throw new Error(`未知の mode: ${mode}`);
  const path = join(repoRoot, FILE);
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { transition: DEFAULT_TRANSITION };
  raw.mode = mode;
  raw.mode_decided_at = decidedAt;
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
}
