# HANDOFF: Jev 品質ゲート

コンテンツ生成の品質判定を Jev（TypeSafe AI の判断特化モデル）に外部化し、
Claude Code の生成ループに MCP 経由で組み込むプロジェクトの引き継ぎ資料。

> **この文書について**
> Google Drive「99. Jev連携」の `HANDOFF-jev-gate.md`（file id `1B7QJUPlwao0FUstLjmKKpDs92pNPnHFv`）
> をリポジトリに取り込んだもの。**1〜9章は原文のまま**で、このリポジトリの実装が従うべき契約として置いている。
> 本ラウンドで確認・是正したことは末尾の「付記」にまとめてあり、原文には手を入れていない。
> 原文と食い違いが出た場合は Drive 側を正とし、この写しを更新すること。

---

## 1. 目的とスコープ

### 1.1 目的

生成コンテンツの品質基準を暗黙知のまま運用せず、ルーブリックとして外部化し、
毎回同じ基準で検査する。**目的は「一貫性」であり、コスト削減ではない。**

想定される判断量は週20〜50件。この規模では Jev の低コストは意味を持たない。
導入根拠を「安いから」に置かないこと。

### 1.2 対象コンテンツ

- ビジネスモデル図解（X / note、アカウント @shikumin_zukai）
- 組み込みエンジニアとしての技術情報発信

### 1.3 スコープ外（明示的に除外）

| 除外対象 | 理由 |
|---|---|
| **公開可否の判定**（機密・薬機法・就業規則） | 誤判定コストが非対称。偽陰性が取り返しのつかない損害になる。また state は外部API に送信されるため、「外部に出して良いか」を外部に送るのは論理矛盾 |
| **医療機器ドメインの内容** | 本人の判断により対象外。v0.3 で s7 の instructions から削除済み |
| 事実の真偽検証 | Jev は state のテキストしか見ない。後述 3.4 |

---

## 2. 設計上の確定事項

### 2.1 役割分担

| 主体 | 責務 |
|---|---|
| Claude | 生成・推論・修正・最終判断 |
| Jev | ルーブリックに基づく検査結果の返却のみ |
| 人間 | ルーブリックの較正・改訂、s7 の最終確認 |

Jev は「Claude が従う上司」ではなく「Claude が判断材料として利用する外部検査器」。

### 2.2 オーバーライド規定

| 層 | オーバーライド | 根拠 |
|---|---|---|
| 群（boolean 由来） | **不可** | 客観的に確認可能な欠陥。解釈の余地がない |
| scored（s7_originality） | 可。ただし理由を記録し人間に提示 | 独自性の判断は割れて当然 |

**沈黙のオーバーライドは禁止。**使ったら必ず可視化する。
ゲートに縛られる側がゲートの適用可否を自分で決められる構造は、ゲートを任意にする。

### 2.3 リトライとエスカレーション

最大3回。以下のいずれかでエスカレーション（人間に返す）。

| トリガー | 条件 |
|---|---|
| `retry_limit` | 3回到達 |
| `stagnation` | FAIL群の集合が前回と同一 |
| `oscillation` | 前回になかったFAIL群が出現（総数が減っていても発火） |

`oscillation` は項目間のトレードオフ（具体性↑で密度↓など）をモグラ叩きしている状態の検出用。
**比較は群単位（4〜5個）で行う。**項目単位（18〜20個）だと誤検出で毎回集合が変わり常時発火する。
修正指示には項目単位のIDを使う。

### 2.4 Goodhart 対策

ルーブリックに最適化された文章に収束するリスクは実在する。
特に `g6_filler` のような表面的項目はゲームしやすい。
**月1で人間が抜き取り確認し、形骸化した項目を差し替えること。**

---

## 3. ルーブリック仕様

### 3.1 ファイル構成

| ファイル | 対象 | 群 | 質問数 |
|---|---|---|---|
| `rubric-article.json` | 図を伴わない文章 | g1, g4, g5, g6 | 18 + scored 1 |
| `rubric-diagram.json` | 図解コンテンツ | g1, g2, g3, g4, g5 | 20 + scored 1 |

共通版は作らない。g2（軸・単位）と g3（本文と図の整合）は図が無いと空振りする。

### 3.2 極性

**全ての boolean 質問は「欠陥が存在するか」を問う（polarity = defect）。**
`probability` = 欠陥が存在する確率。閾値以上で欠陥ありと判定。

v0.1 は逆の極性（「良いか」）だった。古いコードを流用する場合は必ず反転すること。

### 3.3 閾値と群判定

```
probability_threshold           = 0.70   (通常)
critical_probability_threshold  = 0.50   (critical 指定の質問)
group_fail_at                   = 2      (群内でこの件数以上の欠陥で群FAIL)
critical                        = 単独でFAIL
```

**この設計の理由（重要）**：Jev の一致度は約68%。
20問すべてを独立したハードゲートにすると、各問の誤検出率10%と仮定して
「1つも誤検出しない確率」は約12%。9割方どこかが誤FAILし、毎回3回使い切る。
閾値と群判定で実効ゲート数を約6に下げている。

**0.70 と 0.50 に根拠はない。**較正でスイープして決めること（`calibrate.mjs` が実装済み）。

### 3.4 Jev の死角（設計上の前提）

| 項目 | 可否 |
|---|---|
| 「出典なしで具体的数値・製品名が断定されている」という**形**の検出 | 可能 |
| その事実が**実際に間違っている**かの検証 | **不可能** |
| 記述が**本当に一次経験に基づく**かの検証 | **不可能**（s7 の死角） |
| 画像（PNG/JPEG）の評価 | **不可能**。state はテキストのみ |

- `g5_*` が立っても「出典を確認せよ」という指示であり「間違っている」という判定ではない。
  確認作業は人間かウェブ検索が要る。
- `s7_originality` は `human_review_required: true`。Jev の出力は参考値。
  もっともらしく具体的な記述を生成すれば通過できてしまう。**ここを自動化した時点で仕組みの意義が消える。**
- 図は **SVG ソースをテキストとして state に含める**こと。PNG/JPEG が必要なら SVG から変換する。

### 3.5 群の内訳

| 群 | 内容 | article | diagram |
|---|---|---|---|
| g1_traceability | 主語省略、指示語の曖昧さ、話題転換の不明瞭、読み返しの強制（4問） | ○ | ○ |
| g2_figure_labeling | タイトル、軸の意味、単位、ラベル不一致、誤解を招くスケール、凡例（6問） | — | ○ |
| g3_text_figure_alignment | 問いと図の不一致、図種の誤り、時間軸欠落、粒度差、補強不成立（5問） | — | ○ |
| g4_granularity_flow | 冒頭の抽象度、前提の飛ばし、問いと情報の粒度不整合、論点混在、抽象度の跳躍（5問） | ○ | ○ |
| g5_epistemic | 無標の推測、出典なき具体性、**出典粒度の不一致**、**結論の誇張**（4問 / diagram版は2問） | ○ | ○ |
| g6_article_structure | 結論先出しの欠如、一般論、リスク欠落、実行不能、定型句（5問） | ○ | — |
| scored: s7_originality | 組み込み・低レイヤの一次経験に裏打ちされているか（5段階、threshold 4） | ○ | ○ |

`g5_source_granularity_gap` と `g5_overstated_conclusion` は article 版のみ。
実際の裏取り作業で「Picker論文を出典に挙げながら、個別の数値には出典が対応していない」
という欠陥が既存のどの質問にも引っかからなかったため追加した。

---

## 4. ファイル一覧

| ファイル | 責務 |
|---|---|
| `package.json` | `type: module`。依存は ai@^7 / @modelcontextprotocol/sdk / dotenv / zod |
| `probe.mjs` | **最初に実行する。**認証・モデル名・返り値の形を確認 |
| `jev-gate.mjs` | ライブラリ。質問生成 → Jev 呼び出し → 群分類 |
| `jev-gate-server.mjs` | MCP サーバー。`quality_gate` ツールを1つ公開 |
| `rubric-article.json` | 記事用ルーブリック |
| `rubric-diagram.json` | 図解用ルーブリック |
| `calibrate.mjs` | 較正。閾値スイープと群別診断 |
| `.env` | `AI_GATEWAY_API_KEY=...`（**ファイル名は必ず `.env`**） |
| `samples.json` | 較正用サンプル（未作成。7章参照） |

### 実装上の判断

- API 呼び出しが失敗したら `isError` で返す。**判定不能を PASS に倒さない。**
- `missing_answers` を返す。答えが欠けると群の欠陥数が実際より少なく数えられ、
  **静かにゲートが緩む**ため。これが返ったら人間に戻すこと。

---

## 5. API 仕様

### 5.1 確定事項

```js
import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev',          // Vercel AI Gateway 経由
  state: '評価対象のテキスト',
  questions: {
    some_defect: { type: 'boolean', instructions: '...' },
    originality: { type: 'score', instructions: '...', criteria: ['水準1', ..., '水準5'] },
  },
});

// result.answers
// { some_defect: { type: 'boolean', probability: 0.91 } }
```

| 項目 | 仕様 |
|---|---|
| boolean の返り値 | `{ type: 'boolean', probability }` のみ。**`value` フィールドは存在しない。**probability は P(true) |
| score の指定 | `criteria` に水準説明の**配列**。`scale: {min,max}` ではない |
| boolean の criteria | `{ true: '...', false: '...' }`。**両方揃えるか、両方省くか。片方だけは I/O 前にエラー** |
| 必要バージョン | **AI SDK 7 以降** |
| コンテキスト | 32,000 トークン |
| 価格 | 入力100万トークンあたり 0.042 ドル、出力は無課金 |
| 精度 | 自社4ワークフロー評価で 67.8%。正解ラベルは他モデルの平均であり「正しさ」ではなく「一致度」 |

### 5.2 未検証（要 probe 確認）

| 項目 | 対応 |
|---|---|
| **score の返り値の下限が 1 か 0 か** | `probe.mjs` の出力で確認し、ルーブリックの `threshold: 4` を合わせる |
| `ai@^7` / `@modelcontextprotocol/sdk@^1` の正確な最新版 | `npm install` でエラーが出たらバージョン指定を外す |
| 確信度が較正されているか | 独立した実証なし。閾値は経験的に決めるしかない |

---

## 6. セットアップ手順

```bash
mkdir jev-gate && cd jev-gate
# 7ファイルを配置
npm install
echo 'AI_GATEWAY_API_KEY=...' > .env      # ファイル名は .env（.env.local は読まれない）

npm run probe                             # ← 先にこれ。通るまで次へ進まない
```

probe が通ったら：

```bash
claude mcp add jev-gate -- node "$(pwd)/jev-gate-server.mjs"
# Claude Code を完全終了 → このディレクトリで起動し直す
```

### 既知のつまずき

| 症状 | 原因 |
|---|---|
| 認証エラー | `.env` のファイル名違い。dotenv は既定で `.env` しか読まない |
| クレジットカードエラー | Vercel AI Gateway は無料枠でもカード登録が必須 |
| `mcp list` は Connected なのにツールが無い | 登録時点で起動済みのセッションにはツール定義が反映されない。**完全再起動が必要** |

### 順序の原則

**ルーブリックが先、配線は後。**
較正されていない基準で MCP を回しても、間違った基準で一貫して叩くだけの機械になる。

---

## 7. 較正の進め方

### 7.1 手順

1. `samples.json` を作る（形式は `calibrate.mjs` 冒頭のコメント参照）
2. `node calibrate.mjs` → `calibration-report.json` が出力される
3. 一致率 < 0.7、または `caught_intended` が低い群があれば、
   **生成側ではなくその群の `instructions` を修正する**

### 7.2 calibrate.mjs が出すもの

| 指標 | 用途 |
|---|---|
| `threshold_sweep` | 0.5〜0.9 で判定し直し、一致率最大の閾値を採用 |
| `too_lenient` / `too_strict` | 不一致の**向き**。単一の一致率では直す方向が判別できない |
| `caught_intended` | 意図した群で落ちたか。**合否が当たっていても理由が違うケース**を検出 |
| `disagreement_by_question` | 誤検出の発生源となった質問ID |

### 7.3 サンプル選定の原則

- 合格・不合格をおおむね半々に
- 境界事例（`boundary: true`）を数本混ぜる。中央の明白な事例だけでは較正にならない
- 閾値が 0.5 や 0.9 に振り切れる場合、問題は閾値ではなく `instructions`

### 7.4 サンプル候補（既に人間の判定が付いているもの）

ジレットnote制作の過程で本人が差し戻した出力。判定ラベルが既に存在する。

| 対象 | target_group | verdict | 備考 |
|---|---|---|---|
| 診断フローを2列の表に変換した版 | g3_text_figure_alignment | fail | **最良の境界事例。**表として正しいが問いに合わない |
| 図の中に型の説明文を入れた版 | g3_text_figure_alignment | fail | 図の情報量が過剰 |
| 4類型の2×2マトリクス版 | g3_text_figure_alignment | fail | 論理的不整合で横軸レイアウトに変更 |
| python-docx版ドラフト | g6_article_structure | fail | 「1,000円の商品として不十分」 |
| ジレット裏取り資料 | g5_epistemic | fail | boundary。出典粒度の不一致 |
| HANDOFF.md が挙げた6ギャップ該当箇所 | g6 / g4 | fail | 本文が薄い／型定義が浅い／根拠なし／ペルソナAの具体性不足 |
| flow_light.svg（最終版） | — | pass | 1の修正後。**同内容のPASS/FAILペアになる** |
| ドーナツ図、2パネル棒グラフ | — | pass | |
| gillette_design_v7_jp.pdf | — | pass | |

### 7.5 不足しているサンプル

| 不足 | 影響 |
|---|---|
| **g1（トレーサビリティ）のラベル付き例** | この群だけ較正できない |
| **記事側の PASS 例** | `too_strict` が一度も測れない |
| g2（軸・単位）の失敗例 | 0始まりでない軸などは意図的に作る必要あり |

図だけのサンプルは使えない。**その図が載っていた章の本文とセットで**拾うこと。

---

## 8. 未解決・判断待ち

| # | 項目 | 状態 |
|---|---|---|
| 1 | probe.mjs の実行結果 | **未実行。**score の下限がここで確定する |
| 2 | 閾値 0.70 / 0.50 の妥当性 | 較正待ち |
| 3 | `rubric-article.json` の critical 指定 | 現在 `g6_no_conclusion_first` と g5 の4問のみ。増減は本人判断待ち |
| 4 | g2/g3 用の SVG 境界事例 | 未作成。意図的に軸をずらした図と本文のペアが必要 |
| 5 | ジレットnote原稿の訂正反映 | `gillette-factcheck-corrected.md` 作成済み、原稿未反映 |

---

## 9. 変更してはいけない設計（理由つき）

1. **群のオーバーライドを許可しない** — ゲートが任意になる
2. **エスカレーション判定を項目単位に戻さない** — 誤検出で常時発火する
3. **s7 の人間確認を外さない** — Jev の死角であり、偽の専門性は信用を回復できない
4. **公開可否判定に使わない** — 誤判定コストが非対称、かつ state の外部送信と矛盾
5. **判定不能を PASS に倒さない** — 静かにゲートが緩む
6. **MCP 登録を較正より先にしない** — 較正されていない基準で叩き続けることになる

---
---

# 付記：本リポジトリでの反映状況

ここから下は原文にはない。実装を突き合わせて分かったことと、まだ合っていないことの記録。

## A. 型定義で確定したこと（`ai@7.0.107` / `@ai-sdk/provider` の `EvaluationModelV4`）

5.2 の未検証項目のうち、**実キーを使わずに契約から確定できたもの**。

| 項目 | 原文 | 確定した内容 |
|---|---|---|
| score の起点 | 「下限が 1 か 0 か未検証」（8章 #1） | **0 起点**。`criteria` は "At least two ordered levels, **indexed from zero**"、`score` は "**Fractional position in [0, number of levels - 1]**"。整数ではなく**小数**で返る |
| boolean の probability | `{type:'boolean', probability}`、value なし | 原文どおり。"Model-estimated P(true), in [0,1]. **Not confidence in either outcome**" |
| score のフィールド名 | 記載なし | `score`。別名（`value` / `level`）は契約に無いので受けない |
| boolean の criteria | 「両方揃えるか両方省くか。片方だけはエラー」 | 型では `true` / `false` が**各々 optional**。片方だけでも型は通る。実装では両方省いているので影響しない |
| `choice` 型 | 記載なし（boolean / score のみ） | `choice` 型も存在する（`{type:'choice', choice, probabilities?}`）。今回は使わない |
| result の付随情報 | 記載なし | `warnings[]` と `rounding{probabilityDecimals, scoreDecimals}` が付く。`usage` は `{inputTokens, outputTokens, totalTokens}` |
| 再試行 | 2.3 で retry_limit=3 | `evaluate` 自身が `maxRetries` 既定 2 で**通信の**再試行をする。2.3 の 3 回は**内容の作り直し**であり別の層。混同しないこと |

**s7 の `threshold: 4` の扱い**：score が 0 起点の小数なので、実装では
「人間向けの 1 起点表記に直した `level`（= `score + 1`、小数のまま）」を 4 と比べている。
水準3.6 は閾値4に届いていない、という読み方になる。

**依然として未検証**：認証・課金・実際の返り値・一致度。`npm run probe` が通っていない（8章 #1 は未解決のまま）。
2026-09-21 に実キーで試したが、実行環境の egress ポリシーが `ai-gateway.vercel.sh` /
`api.typesafe.ai` / `console.typesafe.ai` のいずれも遮断しており（CONNECT に 403）、
**Jev に到達できずリクエストは送出されていない**。鍵の有効性も未検証のまま。
同日の別セッション（ルーブリック差し替えの回）で再試行したが結果は同じ。
`CONNECT ai-gateway.vercel.sh:443` に `HTTP/1.1 403 Forbidden`、`api.typesafe.ai` も同様。
そのセッションには鍵自体が渡っていないため、鍵無しでは probe が `stub` を検出して
成功を装わずに終了すること（意図どおり）と、ダミー鍵では Gateway に届かないことだけを確認した。
確認できたのは、SDK が `https://ai-gateway.vercel.sh/v4/ai/evaluation-model` へ送ること
（5.1 の「Vercel AI Gateway 経由」は正しい）と、失敗が PASS に倒れず `isError` で落ちること。

## B. 原文の記述ミスと判断したもの

| 箇所 | 原文 | 実体 |
|---|---|---|
| 3.1 の質問数 | diagram は「20問」 | Drive の `rubric-diagram.json` v0.4.0 は **22問**（g1:4 / g2:6 / g3:5 / g4:5 / g5:2）。3.5 の内訳の合計とも一致する。**3.1 の記載ミスと判断した**。article の18問は 3.1 / 3.5 / JSON すべて一致 |
| 4章 / 6章 / 7.1 のファイル名 | `probe.mjs`、`jev-gate.mjs`、`calibrate.mjs` | Drive 上の実体は `.js`。`package.json` に `type: module` があるので `.js` で ESM として動く。**原文の表記ミスと判断した**（原文は変更していない） |
| 4章 の依存 | `dotenv` | Node 20.12+ の `process.loadEnvFile()` で同じこと（`.env` のみ読む）ができるため、実装では依存を足していない。`.env` というファイル名の制約は原文どおり守っている |

## C. 実装がまだ原文に合っていないところ

| # | 原文 | 現状の実装 |
|---|---|---|
| 1 | ~~3.1: `rubric-article.json` と `rubric-diagram.json` の2本立て、18問 / 22問~~ | **対応済み。** Drive「99. Jev連携」の v0.4.0 をリポジトリ直下に取り込み、`mcp/rubric.js` が読む。`jev_review` の `scope`（`diagram` 既定 / `article`）で切り替える |
| 2 | ~~3.5: g1 は4問、g2 は6問、g3 は5問、g4 は5問、g5 は4問、g6 は5問~~ | **対応済み。** 差し替えで内訳どおりになった（diagram 4/6/5/5/2、article 4/5/4/5）。自己診断が群ごとの問数を毎回突き合わせる |
| 3 | ~~3.3: `group_fail_at = 2`~~ | **対応済み。** 縮退は解消。両ルーブリックとも `unreachable` / `fragile` はゼロで、g1 も2件の欠陥で落ちる。報告経路（`unreachable_groups` / `fragile_groups`）は較正でいじったときの再発検出用に残してある |
| 4 | ~~3.1: `g6_article_structure`（記事構造）~~ | **対応済み。** `rubric-article.json` に5問。`scope: "article"` で有効になる |
| 5 | ~~2.3: `stagnation` / `oscillation` の群単位検出~~ | **対応済み。** `mcp/escalation.js` がサーバー側で群単位に判定し、`jev_review` が `escalate` / `escalation_reasons` で返す |
| 6 | 7章: `samples.json` と `calibrate` | **未着手。閾値 0.70 / 0.50 / 2 は根拠のない初期値のまま。** 6章「順序の原則」に対して配線が先行している状態は解消していない |
| 7 | 5.2 / 8章 #1: probe を通す | **未達。** 実行環境の egress が `ai-gateway.vercel.sh` を遮断しており到達できない（A 節末尾） |

### ルーブリック差し替えで判明したこと

| 箇所 | 原文 | 実体 |
|---|---|---|
| 8章 #3 の critical 指定 | 「`rubric-article.json` の critical は `g6_no_conclusion_first` と g5 の4問のみ」 | Drive の v0.4.0 では g5 のうち critical は3問。`g5_overstated_conclusion` は critical ではない。**原文の記述ミスと判断した**（合計4問という数だけは合っている） |
| 3.1 の質問数 | diagram は「20問」 | B 節に記録済みのとおり 22問。差し替えで実装も22問になった |

### 差し替えで消えた検査

暫定ルーブリックには Drive 正本に対応する質問が無い項目が2つあり、差し替えで**落ちた**。
黙って消さないためにここに残す。

| 消えた項目 | 何を見ていたか | 代替 |
|---|---|---|
| `legibility` | スマホ幅で読めるか、ライト/ダークのコントラストが足りているか | 無し。SKILL.md の生成規則として残し、Jev では検査しない |
| `hierarchy` | サイズ・色・配置が重要度の順序と一致しているか | 無し（`g4_*` が粒度は見るが視覚階層は見ない） |

どちらも HTML アーティファクト固有の関心で、Drive のルーブリックは媒体に依存しない欠陥だけを
扱っている。必要なら **Drive 側に足してから取り込む**こと。リポジトリ側だけで足すと
「Drive を正とする」が崩れ、次に取り込んだ時点で黙って消える。

なお `standalone` / `labels` / `structure` / `causality` / `density` / `grounded` は
正本側のより細かい質問（`g1_*` / `g2_*` / `g3_*` / `g4_*` / `g5_*`）に吸収されている。

## D. 禁止事項に対する現状

| # | 禁止事項 | 実装での担保 |
|---|---|---|
| 1 | 群のオーバーライドを許可しない | 群判定を上書きする経路を設けていない |
| 2 | エスカレーション判定を項目単位に戻さない | `mcp/escalation.js` が群単位で比較し、`escalate` を返す。項目単位の ID は修正指示（`fixes`）にのみ使う |
| 3 | s7 の人間確認を外さない | `s7_originality` は verdict に算入せず、`human_review.required: true` を毎回返す |
| 4 | 公開可否判定に使わない | `shippable` ゲートと `jev_gate` ツールを削除。自己診断に不在確認のテストを置いた。加えて `jev_decide`（任意質問のパススルー）の description に「公開可否・機密・コンプライアンス判定に使わない」と `jev_gate` の再構成禁止を明記した。**description は抑止であって強制ではない**（キーワード検査は誤検知が出るうえ回避も容易） |
| 5 | 判定不能を PASS に倒さない | API 失敗は `isError`。回答欠損・範囲外の値は `missing_answers` に入り `verdict: "unknown"` |
| 6 | MCP 登録を較正より先にしない | **守れていない**（C-6）。ルーブリックは正本に揃ったが、閾値は較正されていない。`jev_ping` と `jev_review` が毎回「較正前の暫定値」と警告する形で可視化するに留めている |

## E. HANDOFF に書かれていない防御（レビュー指摘への対応で追加）

| 防御 | 理由 |
|---|---|
| `unreachable_groups` に加えて `fragile_groups` を報告 | 二値の到達可否では「2問で `group_fail_at: 2`」＝全問一致が必要な群を「到達可能」と誤報する。`slack`（critical 抜きで FAIL に届くまでの余裕）を出して区別する |
| 自己診断の強制 stub（`ZUKAI_FORCE_STUB=1`） | `.env` を置いた瞬間に `npm run check` が live に切り替わり、実行のたびに外部へ state を送って課金される状態だった。鍵をプロセスに入れない |
| `jev_decide` の description に禁止事項 #4 を明記 | `jev_gate` を消しても、任意質問のパススルーから同等の判定を再構成できる。description はモデルが毎回読むので、キーワード検査より確実性が高い場面がある |
| `overall` の廃止 | 実体は「欠陥なしと答えられた質問の割合」で品質スコアではない。コメントで否定しても名前が誤用を招くため、`clean_ratio` に一本化した |
