// 入力の分解。本文と図を分け、層（layers.js）ごとに「人間が見るもの」と同じ形に揃える。
//
//   ① 本文    本文。図は［図N：キャプション］に置き換える（図は隠す）
//   ② 図単体  SVG 1枚だけ
//   ③ 整合    本文（図は［図N：…］、検査対象だけ印を付ける）＋ SVG 1枚
//
// 入力は2通り:
//   - 本文ファイル（.md / .txt / .html）と、図ファイル（.svg）が別々
//     例: note 原稿（Google Doc の書き出し）と図フォルダの fig3_tree.svg
//   - 図がインライン SVG として本文に入っている HTML / Markdown
//     例: artifacts/<slug>.html（<figure><svg>…</svg><figcaption>…</figcaption></figure>）
//
// 画像（PNG / JPEG）は評価できない（HANDOFF 3.4）。受け取った時点で止める。

import { createHash } from "node:crypto";
import { basename } from "node:path";

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|avif)$/i;

export function detectKind(path, content) {
  const p = String(path || "");
  if (IMAGE_EXT.test(p) || content.startsWith("�PNG") || content.startsWith("\u0089PNG")) return "image";
  if (/\.svg$/i.test(p)) return "svg";
  if (/\.html?$/i.test(p)) return "html";
  const head = content.trimStart().slice(0, 400).toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  return "text";
}

export function assertNotImage(path, content) {
  if (detectKind(path, content) === "image") {
    throw new Error(
      `${path || "入力"} は画像です。Jev は画像を評価できない（HANDOFF 3.4）。SVG ソースを渡すこと。` +
        "matplotlib なら svg.fonttype='none' で書き出さないと文字がパスになり読めない。"
    );
  }
}

// ── 検査用の注記を外す ──────────────────────────────────────────────────────
// 製造側（チャット）が検査のために書き込む注記は、読者の目には入らない。
// 残すと「人間が見るもの」と Jev の入力がずれる。例えば冒頭の【検査用メタ】は、
// critical の g6_no_conclusion_first（冒頭2〜3文に結論が無いか）を誤って立てうる。
// 外したものは黙らずに normalization として返す。
// 段落単位（空行まで、または入力の末尾まで）。m フラグの $ は行末に当たるので使わない。
const INSPECTOR_META = /^[ \t]*【検査用メタ】[\s\S]*?(?:\n[ \t]*\n|(?![\s\S]))/gm;
const IMAGE_FILE_NOTE = /[（(][ \t]*画像ファイル[ \t]*[：:][^）)\n]*[）)]/g;

export function stripInspectorNotes(text) {
  const removed = [];
  let out = text;
  const meta = out.match(INSPECTOR_META);
  if (meta) {
    removed.push({ kind: "inspector_meta", count: meta.length, chars: meta.join("").length });
    out = out.replace(INSPECTOR_META, "");
  }
  const notes = out.match(IMAGE_FILE_NOTE);
  if (notes) {
    removed.push({ kind: "image_file_note", count: notes.length });
    out = out.replace(IMAGE_FILE_NOTE, "");
  }
  return { text: out, removed };
}

// ── 図の抽出 ────────────────────────────────────────────────────────────────

// <svg> … </svg> を入れ子を数えて探す（SVG の中に <svg> が入ることがある）。
function svgRanges(src) {
  const ranges = [];
  const re = /<svg\b|<\/svg\s*>/gi;
  let depth = 0;
  let start = -1;
  let m;
  while ((m = re.exec(src))) {
    if (m[0][1] !== "/") {
      if (depth === 0) start = m.index;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) ranges.push({ start, end: m.index + m[0].length });
    }
  }
  return ranges;
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

// 図として数えない領域。HTML の <script> / <style> / コメント、Markdown のコードブロック。
// ここにある <svg> は描画される図ではなく、コードや例示の文字列。
function maskedRanges(src, kind) {
  const out = [];
  const add = (re) => {
    let m;
    while ((m = re.exec(src))) out.push({ start: m.index, end: m.index + m[0].length });
  };
  if (kind === "html") {
    add(/<!--[\s\S]*?-->/g);
    add(/<script\b[\s\S]*?<\/script\s*>/gi);
    add(/<style\b[\s\S]*?<\/style\s*>/gi);
    add(/<head\b[\s\S]*?<\/head\s*>/gi);
  } else {
    add(/^```[\s\S]*?^```[^\n]*$/gm);
  }
  return out;
}

const inside = (r, ranges) => ranges.some((x) => r.start >= x.start && r.end <= x.end);

/**
 * 本文中のインライン図を順に返す。<figure> の中にあれば <figcaption> をキャプションにする。
 * キャプションは読者に見えるものだけ（SVG の <title> や aria-label は使わない。①に図の中身が漏れる）。
 */
export function extractFigures(src, kind) {
  if (kind === "svg") return [];
  const masked = maskedRanges(src, kind);
  const figureBlocks = [];
  const fre = /<figure\b[^>]*>[\s\S]*?<\/figure\s*>/gi;
  let m;
  while ((m = fre.exec(src))) {
    const r = { start: m.index, end: m.index + m[0].length };
    if (!inside(r, masked)) figureBlocks.push({ ...r, html: m[0] });
  }

  const figures = [];
  for (const svg of svgRanges(src)) {
    if (inside(svg, masked)) continue;
    const block = figureBlocks.find((f) => svg.start >= f.start && svg.end <= f.end);
    // 1つの <figure> に SVG が複数あっても、置き換えは <figure> 単位で1回だけ。
    if (block && figures.some((f) => f.range.start === block.start)) continue;
    const cap = block?.html.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption\s*>/i);
    const caption = cap ? stripTags(cap[1]) : null;
    const idAttr = (block?.html.match(/<figure\b[^>]*\bid="([^"]+)"/i) ||
      src.slice(svg.start, svg.end).match(/^<svg\b[^>]*\bid="([^"]+)"/i) || [])[1];
    figures.push({
      range: block ? { start: block.start, end: block.end } : { start: svg.start, end: svg.end },
      svg: src.slice(svg.start, svg.end),
      caption,
      element_id: idAttr ?? null,
    });
  }
  const seen = new Map();
  return figures.map((f, i) => {
    // 「図3：…」で始まるキャプションは、その番号を名前にする。本文での呼び名と揃えるため。
    const base = f.caption?.match(/^(図\s*\d+)/)?.[1].replace(/\s+/g, "") ?? `図${i + 1}`;
    // 同じ呼び名が2枚あると（キャプションの誤記など）別の図が同じ対象として数えられる。順番で区別する。
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...f, index: i + 1, label: n === 1 ? base : `${base}#${i + 1}` };
  });
}

function placeholder(fig, { target = false } = {}) {
  const mark = target ? "（検査対象）" : "";
  if (!fig.caption) return `［${fig.label}${mark}］`;
  const rest = fig.caption.startsWith(fig.label)
    ? fig.caption.slice(fig.label.length).replace(/^[\s：:]+/, "")
    : fig.caption;
  return rest ? `［${fig.label}${mark}：${rest}］` : `［${fig.label}${mark}］`;
}

// ── HTML → 本文 ─────────────────────────────────────────────────────────────
function htmlToText(src) {
  return decodeEntities(
    src
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<head\b[\s\S]*?<\/head\s*>/gi, "")
      .replace(/<title\b[\s\S]*?<\/title\s*>/gi, "")
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
      .replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n\n${"#".repeat(Number(n))} `)
      .replace(/<\/h[1-6]\s*>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n・")
      .replace(/<\/(td|th)\s*>/gi, " | ")
      .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|ul|ol|li|tr|table|blockquote|figure|dl|dt|dd)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
  )
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 本文を「人間が①で見る形」にする。インライン図は［図N：キャプション］に置き換え、
 * 検査用の注記を外す。target（図の番号）を渡すと、その図のプレースホルダに（検査対象）を付ける（③用）。
 */
export function toReaderText(src, kind, figures, { target = null } = {}) {
  let out = "";
  let pos = 0;
  for (const f of figures) {
    out += src.slice(pos, f.range.start);
    // HTML は後段でタグを剥がすので、プレースホルダは段落として残す。
    const ph = placeholder(f, { target: target === f.index });
    out += kind === "html" ? `<p>${ph}</p>` : ph;
    pos = f.range.end;
  }
  out += src.slice(pos);
  const text = kind === "html" ? htmlToText(out) : out;
  return stripInspectorNotes(text);
}

/**
 * 図の指定を解決する。数値（1 起点の順番）、「図3」のような呼び名、または要素の id。
 * 図が1枚だけなら指定は省略できる。複数あって指定が無ければ止める（黙って1枚目を選ばない）。
 */
export function selectFigure(figures, selector) {
  if (!figures.length) return null;
  if (selector == null || selector === "") {
    if (figures.length === 1) return figures[0];
    throw new Error(
      `図が ${figures.length} 枚ある。figure で指定すること: ` +
        figures.map((f) => `${f.index}（${f.label}${f.element_id ? ` / #${f.element_id}` : ""}）`).join("、")
    );
  }
  const key = String(selector).replace(/\s+/g, "");
  const hit =
    figures.find((f) => String(f.index) === key) ||
    figures.find((f) => f.label === key || f.label === `図${key}`) ||
    figures.find((f) => f.element_id && f.element_id === key.replace(/^#/, ""));
  if (!hit) {
    throw new Error(`図 ${JSON.stringify(selector)} が見つからない。あるのは: ${figures.map((f) => f.label).join("、")}`);
  }
  return hit;
}

// 読者には見えないのに Jev だけが読む文字。<title> があると「図のタイトルがあるか」（critical の
// g2_no_title）を見かけ上満たし、aria-label や <desc> に図の説明を書くと描画が間違っていても
// 説明を信じて整合と判定しうる。人間が見るもの（描画）に揃えるため外し、外したことは返す。
const SVG_HIDDEN = [
  { kind: "svg_comment", re: /<!--[\s\S]*?-->/g },
  { kind: "svg_metadata", re: /<metadata\b[\s\S]*?<\/metadata\s*>/gi },
  { kind: "svg_title", re: /<title\b[\s\S]*?<\/title\s*>/gi },
  { kind: "svg_desc", re: /<desc\b[\s\S]*?<\/desc\s*>/gi },
  { kind: "svg_aria_text", re: /\saria-(?:label|description|roledescription)\s*=\s*(?:"[^"]*"|'[^']*')/gi },
];

export function sanitizeSvg(svg) {
  const removed = [];
  let out = svg;
  for (const { kind, re } of SVG_HIDDEN) {
    const hits = out.match(re);
    if (hits) {
      removed.push({ kind, count: hits.length });
      out = out.replace(re, "");
    }
  }
  return { svg: out, removed };
}

function svgOnly(content, path) {
  const r = svgRanges(content);
  if (!r.length) throw new Error(`${path || "図"} に <svg>…</svg> が見つからない。SVG ソースを渡すこと。`);
  return content.slice(r[0].start, r[r.length - 1].end);
}

/**
 * 層ごとの入力を組み立てる。server（jev_review）と calibrate（標本）で共有する。
 *
 * @param {object} p
 * @param {"text"|"figure"|"alignment"} p.layer
 * @param {{path:string, content:string}|null} p.main       本文。figure 層では SVG ファイルでもよい
 * @param {{path:string, content:string}|null} p.figureFile  別ファイルの図（.svg）
 * @param {string|number|null} p.figure                      図の指定（番号・呼び名・id）
 */
export function prepareInputs({ layer, main, figureFile = null, figure = null }) {
  if (main) assertNotImage(main.path, main.content);
  if (figureFile) assertNotImage(figureFile.path, figureFile.content);
  const mainKind = main ? detectKind(main.path, main.content) : null;

  if (layer === "text") {
    if (!main) throw new Error("layer=text には本文（artifact_path か content）が要る。");
    if (mainKind === "svg") throw new Error("layer=text に SVG が渡された。図は layer=figure で検査する。");
    if (figureFile) throw new Error("layer=text では図を渡さない（①本文は図を隠して見る）。図は layer=figure / alignment で。");
    const figures = extractFigures(main.content, mainKind);
    const reader = toReaderText(main.content, mainKind, figures);
    return {
      text: describe(main, reader.text, mainKind),
      figure: null,
      inline_figures: figures.map(publicFigure),
      normalization: normalization(reader.removed, figures.length),
    };
  }

  if (layer === "figure") {
    let fig;
    if (figureFile) fig = fileFigure(figureFile, figure);
    else if (!main) throw new Error("layer=figure には図（figure_path か figure_content、または SVG の artifact_path）が要る。");
    else if (mainKind === "svg") fig = fileFigure(main, figure);
    else {
      const figures = extractFigures(main.content, mainKind);
      if (!figures.length) throw new Error(`${main.path} にインライン SVG が無い。図ファイルを figure_path で渡すこと。`);
      fig = inlineFigure(main, selectFigure(figures, figure));
    }
    return { text: null, figure: fig, inline_figures: [], normalization: fig.removed };
  }

  if (layer === "alignment") {
    if (!main) throw new Error("layer=alignment には本文（artifact_path か content）が要る。");
    if (mainKind === "svg") throw new Error("layer=alignment の artifact_path は本文。図は figure_path で渡す。");
    const figures = extractFigures(main.content, mainKind);
    let fig;
    let target = null;
    if (figureFile) {
      fig = fileFigure(figureFile, figure);
    } else {
      if (!figures.length) throw new Error(`${main.path} にインライン SVG が無い。図ファイルを figure_path で渡すこと。`);
      const chosen = selectFigure(figures, figure);
      fig = inlineFigure(main, chosen);
      target = chosen.index;
    }
    const reader = toReaderText(main.content, mainKind, figures, { target });
    return {
      text: describe(main, reader.text, mainKind),
      figure: fig,
      inline_figures: figures.map(publicFigure),
      normalization: [...normalization(reader.removed, figures.length), ...fig.removed],
    };
  }

  throw new Error(`未知の layer: ${JSON.stringify(layer)}`);
}

function describe(src, text, kind) {
  return {
    path: src.path,
    kind,
    content: text,
    bytes: Buffer.byteLength(text, "utf8"),
    source_bytes: Buffer.byteLength(src.content, "utf8"),
    // 版の特定用。ラベル（人間の判定）はこのハッシュの版にだけ効く。
    source_sha256: sha256(src.content),
  };
}

function fileFigure(file, label) {
  const { svg, removed } = sanitizeSvg(svgOnly(file.content, file.path));
  return {
    removed,
    source: "file",
    path: file.path,
    label: label != null && label !== "" ? String(label) : basename(file.path || "図"),
    // 呼び名（「図3」など）を渡されたときだけ、本文中の参照と結び付けられる。
    label_given: label != null && label !== "",
    caption: null,
    content: svg,
    bytes: Buffer.byteLength(svg, "utf8"),
    source_sha256: sha256(file.content),
  };
}

function inlineFigure(main, f) {
  const { svg, removed } = sanitizeSvg(f.svg);
  return {
    removed,
    source: "inline",
    path: main.path,
    label: f.label,
    index: f.index,
    element_id: f.element_id,
    caption: f.caption,
    content: svg,
    bytes: Buffer.byteLength(svg, "utf8"),
    // 版の特定は外す前の SVG で行う（見えない文字だけを直した版も別の版として扱う）。
    source_sha256: sha256(f.svg),
  };
}

const publicFigure = (f) => ({ index: f.index, label: f.label, caption: f.caption, element_id: f.element_id });

function normalization(removed, figureCount) {
  const out = [...removed];
  if (figureCount) out.push({ kind: "inline_figures_to_placeholders", count: figureCount });
  return out;
}
