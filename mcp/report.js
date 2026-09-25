// 助言モードの報告（v0 方針 2.3）。助言モードの失敗は「報告が読まれなくなること」なので、
//   - 発火した項目だけを出す。PASS した群は1行に畳む
//   - g5（事実と推測）の発火を最上段に出し、「出典を確認せよ」という指示として書く
//     「間違っている」とは書かない（HANDOFF 3.4: Jev は形を検出するのであって真偽を検証しない）
//   - s7 の人間確認は毎回必ず出す（禁止事項 #3）
// 呼び出し側（Claude）はこの text をそのまま見せる。言い換えると、g5 の言い回しが崩れる。

const G5 = "g5_epistemic";
const pct = (p) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "—");

export function buildAdvisoryReport({ result, fixes, rubric, clientMode, seq }) {
  const groupLabel = new Map(rubric.groups.map((g) => [g.key, g.label]));
  const g5 = fixes.filter((f) => f.group === G5);
  const others = fixes.filter((f) => f.group !== G5);
  const firedGroups = new Set(fixes.map((f) => f.group));
  const quiet = result.groups.filter((g) => !firedGroups.has(g.key)).map((g) => g.key);

  const lines = [];
  lines.push(`## Jev 検査報告（助言モード・止めない） #${seq}`);
  const head = [`判定 ${result.verdict}`, `${rubric.scope} ${rubric.version}`];
  if (clientMode !== "live") head.push("**stub：ダミー判定。品質判断に使えない**");
  if (!result.calibrated) head.push("閾値は較正前");
  lines.push(head.join(" · "));

  if (result.missing_answers.length) {
    lines.push("", `**判定不能**：回答が欠けた質問 ${result.missing_answers.length}件（${result.missing_answers.join(", ")}）。この報告で合否を決めないこと。`);
  }

  if (g5.length) {
    lines.push("", "### ⚠ 出典を確認せよ（g5 事実と推測）");
    lines.push("Jev は記述の形を見ている。事実が誤りだという判定ではない。該当箇所の出典を自分で確認すること。");
    for (const f of g5) lines.push(`- **${f.label}**（${pct(f.probability)}）— ${f.instructions}`);
  }

  if (others.length) {
    lines.push("", "### 指摘");
    const byGroup = new Map();
    for (const f of others) byGroup.set(f.group, [...(byGroup.get(f.group) || []), f]);
    for (const [g, list] of byGroup) {
      const failed = result.failed_groups.includes(g);
      lines.push(`**${groupLabel.get(g) ?? g}**${failed ? "（群FAIL）" : ""}`);
      for (const f of list) lines.push(`- ${f.label}（${pct(f.probability)}）— ${f.instructions}`);
    }
  }

  if (quiet.length) lines.push("", `問題なし: ${quiet.map((k) => groupLabel.get(k) ?? k).join(" / ")}`);

  const h = result.human_review;
  lines.push(
    "",
    `### 人間確認（必須）: ${h.label}`,
    `Jev の参考値 水準 ${h.level ?? "—"} / 閾値 ${h.threshold}。一次経験の裏打ちは Jev には検証できない。`
  );

  lines.push(
    "",
    "### 判定を記録してください",
    "1. 合格 / 不合格",
    "2. この報告を見て初めて気づいた欠陥はあったか（はい / いいえ）",
    "3. Jev が指摘せず、自分で見つけた欠陥はあったか（はい / いいえ）"
  );

  return {
    text: lines.join("\n"),
    g5_fired: g5.map((f) => f.key),
    fired: fixes.map((f) => f.key),
    quiet_groups: quiet,
  };
}
