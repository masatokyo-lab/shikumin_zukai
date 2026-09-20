# shikumin_zukai

仕組み図解のアーティファクトを、作るたびに Jev（TypeSafe AI の判断特化モデル）に**欠陥がないか**検査させ、
落ちた群だけを直して回す環境。判定はすべて記録され、スマホから開けるパネルに同期される。

設計の契約は [`docs/HANDOFF-jev-gate.md`](docs/HANDOFF-jev-gate.md)。
コードとこの README が食い違ったら、HANDOFF を正とする。

| 部品 | 実体 | 役割 |
| --- | --- | --- |
| `zukai-jev` MCP | `mcp/server.js` | 図解を Jev に送って 8 項目 / 5 群 + s7 で検査させる |
| Jev クライアント | `mcp/jev.js` | `ai` SDK 7 の `experimental_evaluate`（Vercel AI Gateway 経由） |
| ルーブリック | `mcp/rubric.js` | 欠陥質問と群判定。`jev.rubric.json` を置けば差し替え |
| 疎通確認 | `mcp/probe.js` | **最初に実行する。**認証・モデル名・返り値の形を確認 |
| 記録 | `.jev/runs.jsonl` | 毎周の判定。唯一の真実 |
| パネル | [品質ゲートパネル](https://claude.ai/artifact/QU2JMRrKPk7uC5hkrBTsJf) | スマホから稼働状況と判定を見る（Artifact DB） |
| ループ手順 | `.claude/skills/zukai-loop/SKILL.md` | 生成 → 検査 → 修正 の回し方 |
| 図解の例 | `artifacts/jev-loop.html` | この一周そのものの図解 |

## 極性：この検査は「欠陥があるか」を問う

**すべての boolean 質問は「欠陥が存在するか」を訊く。`probability` は欠陥が存在する確率で、高いほど悪い。**

以前のバージョンは逆（「良いか」）だった。古いルーブリックを流用するときは必ず反転すること。
`jev.rubric.json` に `"polarity": "defect"` が無いと読み込み時に落ちる（HANDOFF 3.2）。

## 使い方

```bash
npm install
npm run check          # 自己診断。APIキーも ai パッケージも無くても通る
```

### 1. Jev のキーを入れる

```bash
echo 'AI_GATEWAY_API_KEY=...' > .env    # ファイル名は必ず .env（.env.local は読まれない）
npm run probe                           # ← 先にこれ。通るまで次へ進まない
```

**キーが無い場合も動くが `stub` モードになる。** スコアは入力のハッシュから作った決定論的なダミーで、
品質判断には一切使えない。`jev_ping` の `mode` と、パネル上の `STUB` バッジで常に見分けられる。

Vercel AI Gateway は無料枠でもカード登録が必須。認証エラーが出たら、まず `.env` のファイル名を疑うこと。

### 2. MCP を読み込む

`.mcp.json` に登録済み。Claude Code をこのディレクトリで起動すれば `jev_*` ツールが生える。
登録時点で起動済みのセッションにはツール定義が反映されないので、**完全再起動が必要**。

| ツール | 用途 |
| --- | --- |
| `jev_ping` | live か stub か、極性・閾値・群構成を確認（最初に呼ぶ） |
| `jev_review` | 8 項目 / 5 群の本検査。`fixes` に直す対象が返る |
| `jev_decide` | 任意の型付き質問を素で投げる |
| `jev_feed` | 未同期のレコードを取り出す（パネル同期用） |
| `jev_status` | 稼働状況と直近ランの要約 |

**「公開してよいか」を判定するツールは無い。** 誤判定コストが非対称で、かつ評価対象を外部APIに
送りながら「外部に出して良いか」を外部に訊くのは論理矛盾だから（HANDOFF 禁止事項 #4）。

### 3. 回す

「〜の仕組みを図解にして」と頼めば `zukai-loop` スキルが起動し、生成 → `jev_review` → 修正 → 再検査を
最大 3 周する。停滞・振動を検出したらその場で人間に返す。

### 4. スマホで見る

Claude が毎周 `jev_feed` の結果をパネルの DB に書き込む。

## ルーブリック

8 つの欠陥質問を 5 群に分けている。**群単位で FAIL を判定する。**

| 群 | 質問 | critical |
| --- | --- | --- |
| g1_traceability | 自己完結性 | — |
| g2_figure_labeling | ラベルの一般論語、可読性の不足 | — |
| g3_text_figure_alignment | 構造の不一致、因果の曖昧さ | 構造の不一致 |
| g4_granularity_flow | 情報密度の破綻、視覚階層の不整合 | — |
| g5_epistemic | 裏付けのない断定 | 裏付けのない断定 |

判定:

| 条件 | verdict |
| --- | --- |
| 回答が1つでも欠けている | `unknown`（人間に戻す） |
| critical 項目が欠陥、または群内2件以上が欠陥 | `block` |
| 欠陥はあるが群FAILなし | `revise` |
| 欠陥ゼロ | `ship` |

閾値は通常 0.70、critical 指定の質問は 0.50。

**なぜ項目別のハードゲートにしないか**：Jev の一致度は約68%。各問の誤検出率を10%と仮定すると、
8問すべてを独立したゲートにした場合「1つも誤検出しない確率」は 0.9^8 ≒ 43%。
半分以上の周回で誤って `block` になる。群判定と閾値で実効ゲート数を下げている（HANDOFF 3.3）。

`s7_originality`（一次経験の裏打ち、5段階 threshold 4）は**判定に算入しない**。
Jev の死角であり、もっともらしい記述を生成すれば通過できてしまうため、人間確認の対象として別枠で返る。
**ここを自動化した時点でこの仕組みの意義が消える**（HANDOFF 禁止事項 #3）。

## 確認済みのこと / 未確認のこと

事実と推測を分けておく。

**確認済み**
- MCP の往復と判定ロジックは `npm run check` の 67 項目で通っている（ハンドシェイク、5ツール、
  極性の向き、群FAILの境界、回答欠損で `unknown` になること、s7 が判定に入らないこと、
  `shippable` が存在しないこと、リポジトリ外パスの拒否）。
- API の**型の契約**は `ai@7.0.107` と `@ai-sdk/provider` の `EvaluationModelV4` を読んで確認した。
  `boolean` は `{type,probability}`（P(true)、`value` フィールドは無い）、
  `score` は **0 起点の小数位置 `[0, 水準数-1]`**。`warnings[]` と `rounding` が結果に付く。
- 記録 → Artifact DB → パネル表示の経路は `artifacts/jev-loop.html` を 1 周させて確認済み（stub モード）。

**未確認（実キーが要る）**
- **Jev への実際の疎通は未実施。** 認証・課金・実際の返り値・一致度はいずれも未確認。
  `npm run probe` を通すこと（HANDOFF 8章 #1）。
- `experimental_evaluate` は名前どおり実験的 API で、`ai` SDK のパッチ更新で契約が変わりうる。
  壊れた場合 `interpret` は回答を欠損として扱い `verdict: "unknown"` を返すので、誤って `ship` にはならない。

**前提が崩れる条件**
- **閾値 0.70 / 0.50 / `group_fail_at=2` は較正前の初期値で、根拠がない。**
  `samples.json` と較正スクリプトが未着手のため、この判定を品質の根拠にしてはいけない。
  `jev_ping` と `jev_review` が毎回そう警告する。
- 群の割り当てが暫定。HANDOFF 3.5 の本来の構成（g1 は4問、g2 は6問…）に対して項目数が足りず、
  `g1_traceability` は1項目で critical でもないため**構造上 FAIL しない**。
  黙って緩まないよう `unreachable_groups` として毎回報告している。次ラウンドで
  `rubric-article.json` / `rubric-diagram.json` の2本立てに差し替える前提。
- 記事（図を伴わない文章）用のルーブリックは無い。現状は図解専用。
