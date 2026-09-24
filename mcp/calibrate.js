#!/usr/bin/env node
// 較正（HANDOFF 7章）。
//
//   npm run calibrate                     samples.json を Jev に通し、回答と報告を書き出す（live 必須）
//   npm run calibrate -- --from <file>    取得済みの回答から閾値スイープだけやり直す（Jev を呼ばない）
//
// 書き出し: calibration-evaluations.json（生の回答）/ calibration-report.json（報告）
// --from には /api/calibrate の画面でコピーした JSON をそのまま渡せる。
// 報告を読んでも、ルーブリックの閾値は**自動では書き換えない**。採用は人間が決める。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODE } from "./jev.js";
import {
  loadSamples,
  validateSamples,
  evaluateSamples,
  compactEvaluations,
  expandEvaluations,
  buildReport,
  summaryLines,
} from "./calibrate-core.js";

const repoRoot = process.env.ZUKAI_REPO_ROOT || process.cwd();
const fromIdx = process.argv.indexOf("--from");
const fromFile = fromIdx > -1 ? process.argv[fromIdx + 1] : null;

const samples = loadSamples(repoRoot);
const { errors, warnings } = validateSamples(samples, repoRoot);
for (const w of warnings) console.log(`warn: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}

let evaluations;
if (fromFile) {
  const raw = JSON.parse(readFileSync(fromFile, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.evaluations;
  evaluations = list[0]?.answers ? list : expandEvaluations(list);
} else {
  if (MODE !== "live") {
    console.error("stub モードでは較正できません（回答がダミー）。AI_GATEWAY_API_KEY を設定するか、--from で取得済みの回答を渡すこと。");
    process.exit(1);
  }
  evaluations = await evaluateSamples(samples, { repoRoot });
  writeFileSync(join(repoRoot, "calibration-evaluations.json"), JSON.stringify(compactEvaluations(evaluations), null, 1));
}

const report = buildReport(samples, evaluations, { repoRoot });
writeFileSync(join(repoRoot, "calibration-report.json"), JSON.stringify(report, null, 2));
console.log("\n" + summaryLines(report).join("\n"));
console.log("採用するかは人間が決める。採用したら rubric-*.json の scoring.probability_threshold を更新し、トップレベルに calibrated: true を立てること。");
