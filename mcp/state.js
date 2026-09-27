// Jev に渡す state の組み立て。jev_review（server.js）と較正（calibrate-core.js）で共有する。
// 較正を別の形の state で回すと、本番とは別の入力で閾値を決めることになるため、ここ一箇所に置く。

export const MAX_CONTENT = Number(process.env.ZUKAI_MAX_CONTENT || 60000);

const STATE_HEADINGS = {
  diagram: {
    task: "# この図解が説明すべき仕組み（依頼内容）",
    source: "# 元資料（図解の主張はここで裏付けられている必要がある）",
    fallback: "(提供なし。資料に無い断定が無いかは、依頼内容のみを基準に判断すること)",
    body: "図解アーティファクト",
  },
  article: {
    task: "# この文章が答えるべき問い（依頼内容）",
    source: "# 元資料（本文の主張はここで裏付けられている必要がある）",
    fallback: "(提供なし。資料に無い断定が無いかは、依頼内容のみを基準に判断すること)",
    body: "記事原稿",
  },
};

export function buildState({ task, sourceMaterial, artifact, note, scope }) {
  const h = STATE_HEADINGS[scope] || STATE_HEADINGS.diagram;
  const truncated = artifact.content.length > MAX_CONTENT;
  const body = truncated ? artifact.content.slice(0, MAX_CONTENT) : artifact.content;
  return [
    h.task,
    task,
    "",
    h.source,
    sourceMaterial?.trim() || h.fallback,
    "",
    note ? `# 今回の変更点\n${note}\n` : "",
    `# ${h.body} (${artifact.path}, ${artifact.bytes} bytes${truncated ? ", 先頭のみ" : ""})`,
    body,
  ]
    .filter((s) => s !== "")
    .join("\n");
}
