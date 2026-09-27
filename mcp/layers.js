// 検査の層。2026-09-27 に合意した「判定を分ける」設計（docs/HANDOFF-jev-gate.md 付記 F）。
//
//   判定        人間が見るもの                 Jev に渡す入力       問う群
//   ① 本文      本文＋キャプション（図は隠す）   同じもの             article 18問（s7 は人間確認）
//   ② 図単体    図1枚だけ                       SVG のみ             g2（6問）＋g5（2問）
//   ③ 整合      本文全体＋図1枚                  本文＋SVG 1枚        g3（5問）
//   ④ 公開判断  図入りの完成品                   使わない             —（人間が行い、責任を持つ）
//
// 較正で人間と Jev の間で揃えるものは2つ: 「見るもの」と「問う群」。
// どちらかがずれたラベルは較正データにならない。だから層ごとに入力と群を固定する。
//
// 群の質問文は Drive 正本のルーブリック JSON をそのまま使い、ここでは**選ぶだけ**。
// 質問を足したり書き換えたりしない（足すと Drive と食い違う）。

export const LAYERS = {
  text: {
    id: "text",
    number: "①",
    label: "本文",
    rubric: "article",
    // null = そのルーブリックの全群
    groups: null,
    // s7_originality（一次経験の裏打ち）は本文でだけ問う。図単体や組に一次経験を問う意味は無い。
    scored: true,
    human_sees: "本文＋キャプション（図は隠す）",
    jev_input: "同じもの（図は［図N：キャプション］に置き換える）",
  },
  figure: {
    id: "figure",
    number: "②",
    label: "図単体",
    rubric: "diagram",
    // g5 を入れるのは、本文の「筆者試算」などの注記が図には付いてこないため。
    // 図だけが流通したときに、数値の出典・試算の注記が図の中にあるかを見る。
    groups: ["g2_figure_labeling", "g5_epistemic"],
    scored: false,
    human_sees: "図1枚だけ",
    jev_input: "SVG のみ（本文もキャプションも渡さない）",
  },
  alignment: {
    id: "alignment",
    number: "③",
    label: "整合",
    rubric: "diagram",
    groups: ["g3_text_figure_alignment"],
    scored: false,
    human_sees: "本文全体＋図1枚",
    jev_input: "本文（図は［図N：キャプション］）＋検査対象の SVG 1枚",
  },
};

export const LAYER_IDS = Object.keys(LAYERS);

// ④ は層ではない。Jev を使わないことを契約として返すためだけに持つ。
// HANDOFF 禁止事項 #4: 公開可否の判定に Jev を使わない。
export const PUBLICATION = {
  number: "④",
  label: "公開判断",
  by: "human",
  jev: false,
  human_sees: "図入りの完成品",
  calibration: false,
  note:
    "公開判断は人間が行い、責任を持つ。Jev は使わず、較正データにもしない（HANDOFF 禁止事項 #4）。" +
    "記事ごとの重点（法規の記述、解釈の断定など）はここで人間が見る。",
};

// 旧 API の scope。article は ① と同じ入力・同じ群なので読み替える。
// diagram（22問を本文＋全図に一括で当てる）は廃止: 本文の群と図の群を同じラベルで較正できず、
// 図入り記事に g6 がかからず、どの図が悪いかも特定できないため。
export const LEGACY_SCOPE = {
  article: "text",
  diagram: null,
};

export function layerDef(id) {
  const def = LAYERS[id];
  if (!def) {
    throw new Error(`未知の layer: ${JSON.stringify(id)}。${LAYER_IDS.join(" / ")} のいずれか。`);
  }
  return def;
}

export const layerName = (def) => `${def.number} ${def.label}`;
