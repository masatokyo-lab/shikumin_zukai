// Jev に渡す state の組み立て。jev_review（server.js）と較正（calibrate-core.js）で共有する。
// 較正を別の形の state で回すと、本番とは別の入力で閾値を決めることになるため、ここ一箇所に置く。
//
// 層（layers.js）ごとに、**人間が見るものと同じもの**だけを入れる:
//
//   ① 本文    依頼内容・元資料 ＋ 本文（図は［図N：キャプション］）
//   ② 図単体  SVG だけ。依頼内容も元資料も入れない
//   ③ 整合    本文 ＋ 検査対象の SVG 1枚。依頼内容・元資料は入れない
//
// ②に元資料を入れないのは、図だけが流通したとき（X など）に、数値の出典や「試算」の注記が
// 図の中にあるかを見るため。元資料があると「資料にあるから裏付けあり」と甘くなる。
// ③は本文と図の関係だけを見る層で、問いは本文の中にある。依頼内容を入れると、図を本文ではなく
// 依頼内容と突き合わせかねない。
//
// 反復の変更点（note）は state に入れない。記録には残す。入れると「タイトルを足した」という
// 申告を Jev が読んで判定が変わり、note の無い較正と本番で入力が食い違う。

export const MAX_CONTENT = Number(process.env.ZUKAI_MAX_CONTENT || 60000);

const FALLBACK_SOURCE = "(提供なし。資料に無い断定が無いかは、依頼内容のみを基準に判断すること)";

const SCOPE_NOTE = {
  text:
    "本文だけを検査する。図は別に検査するので、本文中の［図N：…］や【図】の行は、図の位置とキャプションだけを示している。",
  figure:
    "図1枚だけを検査する。本文もキャプションも渡していない。図が単体で流通しても成り立つかを見る。図は SVG ソースで示す。",
  alignment:
    "本文と、検査対象の図1枚との整合だけを検査する。本文中のほかの図は位置とキャプションだけを示している。図は SVG ソースで示す。",
};

function clip(content) {
  const truncated = content.length > MAX_CONTENT;
  return { body: truncated ? content.slice(0, MAX_CONTENT) : content, truncated };
}

/**
 * @param {object} p
 * @param {"text"|"figure"|"alignment"} p.layer
 * @param {string} [p.task]            依頼内容（①のみ state に入る）
 * @param {string} [p.sourceMaterial]  元資料（①のみ state に入る）
 * @param {object} p.inputs            content.js の prepareInputs の返り値
 * @returns {{ state: string, truncated: string[], includes: string[] }}
 */
export function buildLayerState({ layer, task, sourceMaterial, inputs }) {
  const parts = [`# 検査の範囲\n${SCOPE_NOTE[layer]}`];
  const truncated = [];
  const includes = [];

  if (layer === "text") {
    parts.push(`# この文章が答えるべき問い（依頼内容）\n${task}`);
    parts.push(`# 元資料（本文の主張はここで裏付けられている必要がある）\n${sourceMaterial?.trim() || FALLBACK_SOURCE}`);
    includes.push("task", "source_material");
  }

  if (inputs.text) {
    const { body, truncated: cut } = clip(inputs.text.content);
    if (cut) truncated.push("text");
    parts.push(`# 記事原稿 (${inputs.text.path}, ${inputs.text.bytes} bytes${cut ? ", 先頭のみ" : ""})\n${body}`);
    includes.push("text");
  }

  if (inputs.figure) {
    const f = inputs.figure;
    const { body, truncated: cut } = clip(f.content);
    if (cut) truncated.push("figure");
    const heading = layer === "alignment" ? "検査対象の図" : "図";
    const where =
      layer === "alignment" && f.source === "file" && f.label_given
        ? `。本文中で「${f.label}」と呼ばれている図`
        : "";
    parts.push(`# ${heading}: ${f.label} (${f.path}, ${f.bytes} bytes${cut ? ", 先頭のみ" : ""}${where})\n${body}`);
    includes.push("figure");
  }

  return { state: parts.join("\n\n"), truncated, includes };
}
