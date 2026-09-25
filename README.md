# shikumin_zukai

仕組み図解のアーティファクトを、作るたびに Jev（TypeSafe AI の判断特化モデル）に**欠陥がないか**検査させ、
落ちた群だけを直して回す環境。判定はすべて記録され、スマホから開けるパネルに同期される。

設計の契約は [`docs/HANDOFF-jev-gate.md`](docs/HANDOFF-jev-gate.md)。
コードとこの README が食い違ったら、HANDOFF を正とする。

| 部品 | 実体 | 役割 |
| --- | --- | --- |
| `zukai-jev` MCP | `mcp/server.js` | 図解／記事を Jev に送って群単位 + s7 で検査させる |
| Jev クライアント | `mcp/jev.js` | `ai` SDK 7 の `experimental_evaluate`（Vercel AI Gateway 経由） |
| ルーブリック | `rubric-diagram.json`（22問）<br>`rubric-article.json`（18問） | 欠陥質問の正本。Drive「99. Jev連携」の写し |
| 判定ロジック | `mcp/rubric.js` | ルーブリックの読み込み・群判定・修正リスト |
| 疎通確認 | `mcp/probe.js` | **最初に実行する。**認証・モデル名・返り値の形を確認 |
| 記録 | `.jev/runs.jsonl` | 毎周の判定。唯一の真実 |
| パネル | [品質ゲートパネル](https://claude.ai/artifact/QU2JMRrKPk7uC5hkrBTsJf) | スマホから稼働状況と判定を見る（Artifact DB） |
| ループ手順 | `.claude/skills/zukai-loop/SKILL.md` | 生成 → 検査 → 修正 の回し方 |
| 図解の例 | `artifacts/jev-loop.html` | この一周そのものの図解 |

## 極性：この検査は「欠陥があるか」を問う

**すべての boolean 質問は「欠陥が存在するか」を訊く。`probability` は欠陥が存在する確率で、高いほど悪い。**

以前のバージョンは逆（「良いか」）だった。古いルーブリックを流用するときは必ず反転すること。
ルーブリックに `"polarity": "defect"` が無いと読み込み時に落ちる（HANDOFF 3.2）。

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

#### 手元から外へ出られないとき — Vercel で probe を回す

ネットワークの egress 制限で `ai-gateway.vercel.sh` に届かない環境（403 on CONNECT）では、
手元で `npm run probe` は通らない。このリポジトリを Vercel にデプロイすると、
Vercel 側から同じ probe を走らせてブラウザで結果を見られる。**検査の中身は CLI と同一**
（どちらも `mcp/probe-core.js` を呼ぶ）。

1. GitHub からこのリポジトリを Vercel に Import する（Framework Preset は **Other**）。
2. Project Settings → Environment Variables に `AI_GATEWAY_API_KEY` を入れる。
   任意で `PROBE_TOKEN` も入れる（後述）。
3. **再デプロイする。** 環境変数はデプロイ時に焼き込まれるので、足しただけでは反映されない。
4. `https://<project>.vercel.app/` を開き、「probe を実行」を押す。
   JSON で欲しければ `/api/probe?format=json`。

`PROBE_TOKEN` を設定しない限り、**その URL を知っている全員が Jev を1往復ぶん課金できる**。
疎通が取れたら必ず設定すること（未設定のときはページ上にも警告を出している）。
アクセスは `/api/probe?token=...` になる。

| 変数 | 必須 | 用途 |
|---|---|---|
| `AI_GATEWAY_API_KEY` | ○ | 無いと `stub` のままで probe は 502 を返す |
| `PROBE_TOKEN` | 推奨 | `/api/probe` の実行に `?token=` を要求する |
| `JEV_MODEL` | — | 既定 `typesafe-ai/jev` |

### 2. MCP を読み込む

`.mcp.json` に登録済み。Claude Code をこのディレクトリで起動すれば `jev_*` ツールが生える。
登録時点で起動済みのセッションにはツール定義が反映されないので、**完全再起動が必要**。

| ツール | 用途 |
| --- | --- |
| `jev_ping` | live か stub か、極性・閾値・**2本のルーブリックの群構成**を確認（最初に呼ぶ） |
| `jev_review` | 本検査。`scope`（`diagram` 既定 / `article`）でルーブリックを選ぶ。`fixes` に直す対象、`escalate` に止めどきが返る |
| `jev_decide` | 任意の型付き質問を素で投げる |
| `jev_feed` | 未同期のレコードを取り出す（パネル同期用） |
| `jev_status` | 稼働状況と直近ランの要約 |
| `jev_label` | 合格後にユーザーが出した**出荷判定**を記録（台帳 `labels/ledger.jsonl` は本文なし） |

**「公開してよいか」を判定するツールは無い。** 誤判定コストが非対称で、かつ評価対象を外部APIに
送りながら「外部に出して良いか」を外部に訊くのは論理矛盾だから（HANDOFF 禁止事項 #4）。

### 3. 回す

「〜の仕組みを図解にして」と頼めば `zukai-loop` スキルが起動する。

```
生成 → jev_review ─ 不合格 → 修正 → 再検査（最大3周。escalate が返ったら止める）
                  └ 合格   → ユーザーが出荷判定 → jev_label で記録
```

**検査器の出力は `result: pass / fail` の2値。** 出荷してよいかは判定しない（ユーザーが決める）。
次にやることは `next_action`（`fix_and_rereview` / `stop_and_escalate` / `hand_to_human`）で返る。

**止めどきはサーバーが判定する。** `jev_review` は同じ `run_id` の履歴と突き合わせて
`escalate` を返し、空でなければループを止めて人間に返す。

| トリガー | 条件 |
| --- | --- |
| `retry_limit` | 反復が 3 周に達した |
| `stagnation` | FAIL群の集合が前周と同一 |
| `oscillation` | 前周になかった群がFAIL（総数が減っていても発火） |

比較は**群単位**。項目単位だと誤検出で毎回集合が変わり `oscillation` が常時発火する
（修正指示の方は項目単位の ID を使う）。呼び出し側に履歴の突き合わせを任せると、
忘れた瞬間に静かに発火しなくなるのでサーバーが計算している。

### 4. スマホで見る

Claude が毎周 `jev_feed` の結果をパネルの DB に書き込む。

## ルーブリック

**共通版は作らない。**図が無いと g2（軸・単位）と g3（本文と図の整合）は空振りするため、
対象ごとに2本立てにしている（HANDOFF 3.1）。実体は Google Drive「99. Jev連携」の
同名ファイル v0.4.0 をそのまま取り込んだもので、**Drive 側を正とする**。

| ファイル | 対象 | 群 | 質問数 |
| --- | --- | --- | --- |
| `rubric-diagram.json` | 図解コンテンツ（`scope: "diagram"`、既定） | g1 / g2 / g3 / g4 / g5 | 22 + scored 1 |
| `rubric-article.json` | 図を伴わない文章（`scope: "article"`） | g1 / g4 / g5 / g6 | 18 + scored 1 |

| 群 | 内容 | diagram | article | critical |
| --- | --- | --- | --- | --- |
| g1_traceability | 主語省略、指示語の曖昧さ、話題転換の不明瞭、読み返しの強制 | 4 | 4 | — |
| g2_figure_labeling | タイトル、軸の意味、単位、ラベル不一致、誤解を招くスケール、凡例 | 6 | — | タイトル、軸の意味、単位 |
| g3_text_figure_alignment | 問いと図の不一致、図種の誤り、時間軸欠落、粒度差、補強不成立 | 5 | — | 問いと図の不一致、時間軸欠落 |
| g4_granularity_flow | 冒頭の抽象度、前提の飛ばし、問いと情報の粒度不整合、論点混在、抽象度の跳躍 | 5 | 5 | — |
| g5_epistemic | 無標の推測、出典なき具体性（+ article のみ 出典粒度の不一致、結論の誇張） | 2 | 4 | 結論の誇張以外すべて |
| g6_article_structure | 結論先出しの欠如、一般論、リスク欠落、実行不能、定型句 | — | 5 | 結論先出しの欠如 |

`scope` を取り違えると、図の無い文章に軸・単位の質問を当てて空振りする。
`jev_review` の `scope` は明示するのが安全（既定は `diagram`）。

判定:

| 条件 | verdict（内訳） | result |
| --- | --- | --- |
| 回答が1つでも欠けている | `unknown` | **fail**（直さず人間に戻す） |
| critical 項目が欠陥、または群内2件以上が欠陥 | `block` | **fail** |
| 欠陥はあるが群FAILなし | `revise` | **pass**（単発の欠陥は参考として `fixes` に残る） |
| 欠陥ゼロ | `ship` | **pass** |

閾値は通常 0.70、critical 指定の質問は 0.50。

**群が構造上どこまで落ちうるかも毎回報告する。**

| 報告 | 意味 |
| --- | --- |
| `unreachable_groups` | critical が無く質問数が `group_fail_at` に届かない。**構造上 FAIL しない** |
| `fragile_groups` | critical が無く slack が 0。**全問一致が必要**で実質ほぼ落ちない |

差し替え前は暫定ルーブリックが8問しかなく、`g1` が unreachable、`g2` と `g4` が fragile で、
`block` を出せるのは実質2問だけという**縮退状態**だった。2本立てに差し替えた現在、
**両ルーブリックとも unreachable / fragile はゼロ**（`npm run check` が毎回検査する）。
報告そのものは残してある — 較正でルーブリックをいじったときに再発しうるため。

**なぜ項目別のハードゲートにしないか**：Jev の一致度は約68%。各問の誤検出率を10%と仮定すると、
22問すべてを独立したゲートにした場合「1つも誤検出しない確率」は 0.9^22 ≒ 10%。
ほぼ毎周どこかが誤って `block` になる。群判定と閾値で実効ゲート数を約6に下げている（HANDOFF 3.3）。

`s7_originality`（一次経験の裏打ち、5段階 threshold 4）は**判定に算入しない**。
Jev の死角であり、もっともらしい記述を生成すれば通過できてしまうため、人間確認の対象として別枠で返る。
**ここを自動化した時点でこの仕組みの意義が消える**（HANDOFF 禁止事項 #3）。

## 確認済みのこと / 未確認のこと

事実と推測を分けておく。

**確認済み**
- MCP の往復と判定ロジックは `npm run check` の 179 項目で通っている（ハンドシェイク、5ツール、
  2本のルーブリックの群構成と質問数、極性の向き、群FAILの境界、回答欠損で `unknown` になること、
  s7 が判定に入らないこと、`shippable` が存在しないこと、エスカレーション3種の発火と非発火、
  `unreachable` / `fragile` の判別、壊れた／極性の違う／scope の食い違うルーブリックの拒否、
  `scope=article` の往復、リポジトリ外パスの拒否）。
- 自己診断は `ZUKAI_FORCE_STUB=1` で走るので、鍵が置いてあってもネットワークと課金に依存しない。
- API の**型の契約**は `ai@7.0.107` と `@ai-sdk/provider` の `EvaluationModelV4` を読んで確認した。
  `boolean` は `{type,probability}`（P(true)、`value` フィールドは無い）、
  `score` は **0 起点の小数位置 `[0, 水準数-1]`**。`warnings[]` と `rounding` が結果に付く。
- 記録 → Artifact DB → パネル表示の経路は `artifacts/jev-loop.html` を 1 周させて確認済み（stub モード）。

**未確認（実キーが要る）**
- **Jev への実際の疎通は未実施。** 認証・課金・実際の返り値・一致度はいずれも未確認。
  `npm run probe` を通すこと（HANDOFF 8章 #1）。
- 実行環境によっては `ai-gateway.vercel.sh` への egress が塞がれている。2026-09-21 時点の
  Claude Code on the web のコンテナは `CONNECT ai-gateway.vercel.sh:443` に **403** を返すため、
  リクエストは送出されず probe は通らない（鍵の問題ではない）。許可リストに追加するか、
  ネットワーク制限のない環境で probe を実行すること。
- `experimental_evaluate` は名前どおり実験的 API で、`ai` SDK のパッチ更新で契約が変わりうる。
  壊れた場合 `interpret` は回答を欠損として扱い `verdict: "unknown"` を返すので、誤って `ship` にはならない。

**前提が崩れる条件**
- **閾値 0.70 / 0.50 / `group_fail_at=2` は較正前の初期値で、根拠がない。**
  `samples.json` と較正スクリプトが未着手のため、この判定を品質の根拠にしてはいけない。
  `jev_ping` と `jev_review` が毎回そう警告する。
- ルーブリックの**問いの良し悪し自体が未検証**。2本立てに差し替えて構造上の縮退は解消したが、
  各 `instructions` が意図した欠陥を実際に捕まえるかは較正（`samples.json`）でしか分からない。
- `scope` の選択は呼び出し側の申告に依存する。図を含む HTML に `article` を指定しても
  サーバーは止めない（内容から図の有無を判定していない）。
- 差し替えで消えた検査がある。暫定ルーブリックにあった `legibility`（スマホ幅・ダークモードの
  コントラスト）と `hierarchy`（視覚階層）は Drive 正本に対応する質問が無いため**落ちた**。
  HTML アーティファクト固有の関心なので、必要なら Drive 側のルーブリックに足してから取り込むこと
  （リポジトリ側だけで足すと Drive と食い違う）。
