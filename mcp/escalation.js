// エスカレーション判定。docs/HANDOFF-jev-gate.md 2.3。
//
// これは「指示」ではなく**ゲートの一部**である。SKILL.md に手順として書くだけだと、
// ゲートに縛られる側がゲートの発火条件を判断する構造になり、履歴の突き合わせを
// 忘れれば静かに発火しなくなる（HANDOFF 2.2 で削除したオーバーライド条項と同じ弱さ）。
// だからサーバーが計算して返す。
//
// **比較は群単位で行う。** 項目単位（18〜20個）だと誤検出で毎回集合が変わり、
// oscillation が常時発火する。修正指示の方は項目単位の ID を使う。

export const DEFAULT_MAX_RETRIES = 3;

export const ESCALATION_REASONS = {
  retry_limit: "反復が上限に達した。これ以上回さず人間に返すこと。",
  stagnation:
    "FAIL群の集合が前周と同一（stagnation）。同じ場所を叩き続けている。ルーブリックが合っていないか元資料が足りない。",
  oscillation:
    "前周になかった群がFAILした（oscillation）。項目間のトレードオフをモグラ叩きしている可能性がある。総数が減っていても止めること。",
};

const normalize = (groups) => [...new Set(groups ?? [])].sort();
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * @param {object} p
 * @param {number} p.iteration               今回が何周目か（1 起点）
 * @param {string} p.verdict                 今回の判定
 * @param {string[]} p.failedGroups          今回の FAIL 群
 * @param {string[]|null} p.previousFailedGroups  前周の FAIL 群。前周が無い／比較できない場合は null
 * @param {number} [p.maxRetries]
 */
export function evaluateEscalation({
  iteration,
  verdict,
  failedGroups,
  previousFailedGroups,
  maxRetries = DEFAULT_MAX_RETRIES,
}) {
  const current = normalize(failedGroups);
  const previous = previousFailedGroups == null ? null : normalize(previousFailedGroups);
  const escalate = [];

  // 合格した周ではエスカレーションしない。3周目で合格したのに
  // 「エスカレーション」と報告するのは誤解を招くだけ。合格は ship と revise（rubric.js の result）。
  if (verdict === "block" || verdict === "unknown") {
    if (iteration >= maxRetries) escalate.push("retry_limit");
    // 両方空（＝落ちていない）で stagnation を出さない。
    if (previous && current.length && sameSet(current, previous)) escalate.push("stagnation");
    // 前周が無ければ「前回になかった群」を判定できない。
    if (previous && current.some((g) => !previous.includes(g))) escalate.push("oscillation");
  }

  return {
    escalate,
    reasons: escalate.map((id) => ({ id, reason: ESCALATION_REASONS[id] })),
    previous_failed_groups: previous,
    max_retries: maxRetries,
  };
}

/** 同じ run の直前のレビュー記録。比較できる形でなければ null。 */
export function previousReview(records, runId, iteration) {
  const prior = (records ?? [])
    .filter(
      (r) =>
        r.run_id === runId &&
        r.kind === "review" &&
        typeof r.iteration === "number" &&
        r.iteration < iteration
    )
    .sort((a, b) => a.iteration - b.iteration);
  return prior.length ? prior[prior.length - 1] : null;
}

/**
 * 前周の FAIL 群。R2 以前に書かれた記録には failed_groups が無いので、
 * その場合は null を返して比較しない（[] と誤読すると oscillation が誤発火する）。
 */
export function previousFailedGroupsOf(record) {
  return Array.isArray(record?.failed_groups) ? record.failed_groups : null;
}
