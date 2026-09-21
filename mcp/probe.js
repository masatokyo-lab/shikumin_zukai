#!/usr/bin/env node
// probe — 実キーで Jev に 1 往復し、認証・モデル名・返り値の形を確かめる。
// HANDOFF 6章「順序の原則」: これが通るまで先へ進まない。
//
//   echo 'AI_GATEWAY_API_KEY=...' > .env   # ファイル名は必ず .env
//   npm run probe
//
// 中身は mcp/probe-core.js。Vercel の /api/probe も同じものを呼ぶので、
// 「ローカルで通った probe」と「ブラウザで通った probe」が同じ検査であることが保証される。

import { runProbe } from "./probe-core.js";

const result = await runProbe();
for (const line of result.lines) console.log(line);
if (result.hint) console.error(`\n${result.hint}`);
process.exit(result.ok ? 0 : 1);
