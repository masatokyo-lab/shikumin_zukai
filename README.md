# shikumin_zukai

図解・記事を作るたびに、Jev（TypeSafe AI の判断特化モデル）に**欠陥がないか**検査させ、
落ちた群だけを直して回す環境。判定はすべて記録され、スマホから開けるパネルに同期される。

検査は **①本文 / ②図単体 / ③整合 の3層**に分けて行い、**④公開判断は人間（本人）が行う**。
人間と Jev が「同じものを見て」「同じ群を問う」ように揃えないと、人間の判定が較正データにならないため。

設計の契約は [`docs/HANDOFF-jev-gate.md`](docs/HANDOFF-jev-gate.md)（層分割は付記 G）。
コードとこの README が食い違ったら、HANDOFF を正とする。

| 部品 | 実体 | 役割 |
| --- | --- | --- |
| `zukai-jev` MCP | `mcp/server.js` | 図解／記事を層ごとに Jev に送って検査させる |
| 層の定義 | `mcp/layers.js` | ①②③で人間が見るもの・Jev の入力・問う群。④は人間 |
| 入力の分解 | `mcp/content.js` / `mcp/state.js` | 本文と図を分け、層ごとに Jev に渡す state を組む（本番と較正で共通） |
| Jev クライアント | `mcp/jev.js` | `ai` SDK 7 の `experimental_evaluate`（Vercel AI Gateway 経由） |
| ルーブリック | `rubric-diagram.json`（22問）<br>`rubric-article.json`（18問） | 欠陥質問の正本。Drive「99. Jev連携」の写し。層はここから群を**選ぶだけ** |
| 判定ロジック | `mcp/rubric.js` | ルーブリックの読み込み・層の群選択・群判定・修正リスト |
| 人間の判定の台帳 | `labels/ledger.jsonl` | 層ごとのラベルと④の記録。**本文なし**で commit する |
| 較正 | `mcp/calibrate-core.js` / `npm run calibrate` | 層ごとに閾値をスイープする（HANDOFF 7章） |
| 疎通確認 | `mcp/probe.js` | **最初に実行する。**認証・モデル名・返り値の形を確認 |
| 記録 | `.jev/runs.jsonl` | 毎回の判定。唯一の真実 |
| パネル | [品質ゲートパネル](https://claude.ai/artifact/QU2JMRrKPk7uC5hkrBTsJf) | スマホから稼働状況と判定を見る（Artifact DB） |
| ループ手順 | `.claude/skills/zukai-loop/SKILL.md` | 生成 → 検査 → 修正 → 公開判断の回し方 |
| 図解の例 | `artifacts/jev-loop.html` | この一周そのものの図解（層分割前の図。更新待ち） |

## 検査の層

| 判定 | 人間が見るもの | Jev に渡す入力 | 問う群 | 較正 |
| --- | --- | --- | --- | --- |
| ① 本文 | 本文＋キャプション（図は隠す） | 同じもの（図は［図N：キャプション］）＋依頼内容・元資料 | article 18問（s7 は人間確認） | ○ 本文だけで付けたラベル |
| ② 図単体 | 図1枚だけ | SVG のみ | diagram の g2（6問）＋ g5（2問） | ○ 図ごとのラベル |
| ③ 整合 | 本文全体＋図1枚 | 本文＋SVG 1枚 | diagram の g3（5問） | ○ 本文の版と図の版の組ごと |
| ④ 公開判断 | 図入りの完成品 | 使わない | — | ×（記録はする） |

- diagram の g1 / g4 は①（article）で同じ問いを問うので、図の層では使わない（`jev_ping` の `unused_groups` に出る）。
- ②に元資料を入れないのは、図だけが流通したとき（X など）に「試算」や出典の注記が図の中にあるかを見るため。
- 読者に見えないもの（冒頭の【検査用メタ】、「（画像ファイル：…）」、SVG の `<title>` / `<desc>` / `aria-label`）は
  Jev にも渡さない。特に SVG の `<title>` があると「図のタイトルがあるか」（critical）を見かけ上満たしてしまう。
  外したものは結果の `warnings` と `input.normalization` に出る。
- 反復の変更点（`note`）は記録に残すが Jev には渡さない（較正の入力と本番の入力を揃えるため）。

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
**2026-09-27 時点で、無料枠では Jev を呼べない**（`Free tier users do not have access to this model.
Upgrade to paid credits`）。有料クレジットのチャージが要る。

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
| `PROBE_TOKEN` | 推奨 | `/api/probe` と `/api/calibrate` の実行に `?token=` を要求する |
| `JEV_MODEL` | — | 既定 `typesafe-ai/jev` |

### 2. MCP を読み込む

`.mcp.json` に登録済み。Claude Code をこのディレクトリで起動すれば `jev_*` ツールが生える。
登録時点で起動済みのセッションにはツール定義が反映されないので、**完全再起動が必要**。
`npm install` 前に起動すると MCP は接続に失敗する（依存が無いため）。

| ツール | 用途 |
| --- | --- |
| `jev_ping` | live か stub か、極性・閾値・**層ごとの群構成**、④は人間であることを確認（最初に呼ぶ） |
| `jev_review_all` | **ふだんはこれ。**1記事を ①本文 → 図ごとに ②図単体・③整合 まで全部検査して合否をまとめる |
| `jev_review` | 1層だけ検査する（`layer`: `text` / `figure` / `alignment`）。直した層の確認に使う |
| `jev_label` | ユーザーが**その層と同じものを見て**付けた判定を記録（較正の材料） |
| `jev_ship` | ユーザーの④公開判断を記録（較正には使わない） |
| `jev_decide` | 任意の型付き質問を素で投げる |
| `jev_feed` | 未同期のレコードを取り出す（パネル同期用） |
| `jev_status` | 稼働状況と直近ランの要約 |

**「公開してよいか」を判定するツールは無い。** 誤判定コストが非対称で、かつ評価対象を外部APIに
送りながら「外部に出して良いか」を外部に訊くのは論理矛盾だから（HANDOFF 禁止事項 #4）。
公開判断は本人が行い、責任を持つ。記事ごとの重点（法規の記述・解釈の断定など）もここで人間が見る。

旧 API の `scope` は廃止予定。`scope: "article"` は①として動くが、`scope: "diagram"`
（22問を本文＋全図に一括で当てる検査）は**廃止したのでエラーになる**。

### 3. 回す

「〜の仕組みを図解にして」「〜を検査して」と頼めば `zukai-loop` スキルが起動する。

```
生成 → jev_review_all ─ 不合格 → 落ちた層を直す → 再検査（最大3周。escalate が返ったら止める）
                     └ ①②③すべて合格 → ④ユーザーが公開判断 → jev_ship で記録
```

図の渡し方は2通り:

| 形 | 例 | 渡し方 |
| --- | --- | --- |
| 本文と図が別ファイル | note 原稿（`.md`）と `fig3_tree.svg` など | `figures: [{ path, label: "図3" }, …]`（`label` は本文での呼び名） |
| 図がインライン SVG | `artifacts/<slug>.html` | 省略すれば本文中の SVG をすべて使う（`<figcaption>` がキャプション） |

**画像（PNG / JPEG）は評価できない。** SVG を渡すこと。matplotlib なら `svg.fonttype='none'` で書き出さないと
文字がパスになり、Jev は図の文字を読めない（その場合は警告が出る）。

**検査器の出力は `result: pass / fail` の2値。** 公開してよいかは判定しない。次にやることは `next_action` で返る。

| `next_action` | 返すツール | 意味 |
| --- | --- | --- |
| `fix_and_rereview` | 両方 | 不合格。blocking の項目を直して再検査 |
| `stop_and_escalate` | 両方 | 回しても直らない（上限・停滞・振動）か判定不能。止めて人間に返す |
| `continue_other_layers` | `jev_review` | この層は合格。残りの層へ（④に渡すのは全層合格の後） |
| `hand_to_human` | `jev_review_all` | ①②③すべて合格。④公開判断をユーザーに渡す |

**止めどきはサーバーが判定する。** 層ごと（同じ層・同じ対象の前回と比べる）と、記事全体
（`jev_review_all` の FAIL を「層@図:群」で数えて前回と比べる）の両方で見る。
記事全体でも見るのは、①を直すと③が落ち、③を直すと①が落ちる往復を止めるため。

| トリガー | 条件 |
| --- | --- |
| `retry_limit` | 反復が 3 周に達した |
| `stagnation` | FAIL群の集合が前周と同一 |
| `oscillation` | 前周になかった群がFAIL（総数が減っていても発火） |

比較は**群単位**。項目単位だと誤検出で毎回集合が変わり `oscillation` が常時発火する
（修正指示の方は項目単位の ID を使う）。呼び出し側に履歴の突き合わせを任せると、
忘れた瞬間に静かに発火しなくなるのでサーバーが計算している。
同じ対象は、合格するまで同じ run が続く（呼び直しても反復回数はリセットされない）。

### 4. スマホで見る

Claude が毎回 `jev_feed` の結果をパネルの DB に書き込む。`kind: "review"` が1層ぶんの検査、
`kind: "round"` が `jev_review_all` の記事全体のまとめ。

## ルーブリック

**共通版は作らない。**図が無いと g2（軸・単位）と g3（本文と図の整合）は空振りするため、
対象ごとに2本立てにしている（HANDOFF 3.1）。実体は Google Drive「99. Jev連携」の
同名ファイル v0.4.0 をそのまま取り込んだもので、**Drive 側を正とする**。
層（上の表）はこの2本から群を選ぶだけで、質問文・閾値・critical 指定には手を入れていない。

| 群 | 内容 | diagram | article | 使う層 | critical |
| --- | --- | --- | --- | --- | --- |
| g1_traceability | 主語省略、指示語の曖昧さ、話題転換の不明瞭、読み返しの強制 | 4 | 4 | ①（article） | — |
| g2_figure_labeling | タイトル、軸の意味、単位、ラベル不一致、誤解を招くスケール、凡例 | 6 | — | ② | タイトル、軸の意味、単位 |
| g3_text_figure_alignment | 問いと図の不一致、図種の誤り、時間軸欠落、粒度差、補強不成立 | 5 | — | ③ | 問いと図の不一致、時間軸欠落 |
| g4_granularity_flow | 冒頭の抽象度、前提の飛ばし、問いと情報の粒度不整合、論点混在、抽象度の跳躍 | 5 | 5 | ①（article） | — |
| g5_epistemic | 無標の推測、出典なき具体性（+ article のみ 出典粒度の不一致、結論の誇張） | 2 | 4 | ①（4問）②（2問） | 結論の誇張以外すべて |
| g6_article_structure | 結論先出しの欠如、一般論、リスク欠落、実行不能、定型句 | — | 5 | ① | 結論先出しの欠如 |

判定（層ごと）:

| 条件 | verdict（内訳） | result |
| --- | --- | --- |
| 回答が1つでも欠けている | `unknown` | **fail**（直さず人間に戻す） |
| critical 項目が欠陥、または群内2件以上が欠陥 | `block` | **fail** |
| 欠陥はあるが群FAILなし | `revise` | **pass**（単発の欠陥は参考として `fixes` に残る） |
| 欠陥ゼロ | `ship` | **pass** |

閾値は通常 0.70、critical 指定の質問は 0.50。②と③は `rubric-diagram.json` の閾値を共有する。

**群が構造上どこまで落ちうるかも毎回報告する。**

| 報告 | 意味 |
| --- | --- |
| `unreachable_groups` | critical が無く質問数が `group_fail_at` に届かない。**構造上 FAIL しない** |
| `fragile_groups` | critical が無く slack が 0。**全問一致が必要**で実質ほぼ落ちない |

3つの層とも unreachable / fragile はゼロ（`npm run check` が毎回検査する）。
報告そのものは残してある — 較正でルーブリックをいじったときに再発しうるため。

**なぜ項目別のハードゲートにしないか**：Jev の一致度は約68%。各問の誤検出率を10%と仮定すると、
22問すべてを独立したゲートにした場合「1つも誤検出しない確率」は 0.9^22 ≒ 10%。
ほぼ毎回どこかが誤って `block` になる。群判定と閾値で実効ゲート数を約6に下げている（HANDOFF 3.3）。

`s7_originality`（一次経験の裏打ち、5段階 threshold 4）は①でだけ問い、**判定に算入しない**。
Jev の死角であり、もっともらしい記述を生成すれば通過できてしまうため、人間確認の対象として別枠で返る。
**ここを自動化した時点でこの仕組みの意義が消える**（HANDOFF 禁止事項 #3）。

## 人間の判定と較正

| 記録 | ツール | 何を見て付けるか | 較正 |
| --- | --- | --- | --- |
| 層のラベル | `jev_label` | その層と同じもの（①は図を隠した本文、②は図1枚、③は本文と図1枚） | ○ |
| 公開判断 | `jev_ship` | 図入りの完成品 | ×（どの層も拾えなかった欠陥の手がかりにする） |

- **このリポジトリは public。** 台帳 `labels/ledger.jsonl` には本文を書かない。本文つきの標本は
  `jev_label` が返すので、Drive「99. Jev連携/labels」に保存する。
- ラベルは付けた時点の版（本文・図の SHA-256）にだけ効く。直した版には付け直す。
- 較正は `samples.json`（gitignore。見本は `samples.example.json`）を層ごとに回す:
  `npm run calibrate`（live 必須）/ `npm run calibrate -- --from <回答JSON>`（Jev を呼ばずに再集計）。
  標本の入力は本番と同じ `content.js` / `state.js` で組み直し、検査時の state と一致するかを確かめる。
- Vercel の `/api/calibrate` は `samples.json` をデプロイに含める必要がある。GitHub 連携のデプロイでは
  gitignore された標本は入らない（本文を public に置かないため）。較正は手元（`npm run calibrate`）で回す。

## 確認済みのこと / 未確認のこと

事実と推測を分けておく。

**確認済み**
- MCP の往復と判定ロジックは `npm run check` の 310 項目で通っている（層ごとの群構成と質問数、
  s7 が①だけで判定に入らないこと、図の抽出と［図N］への置き換え、見えない文字の除去、
  層ごとの state の中身、`scope=diagram` の廃止エラー、層×対象ごとの周回とエスカレーション、
  `jev_review_all` の記事全体の周回、`jev_label` の標本から組み直した state が検査時と一致すること、
  台帳に本文が入らないこと、④が較正対象外で記録されること、層ごとの較正集計、など）。
- 自己診断は `ZUKAI_FORCE_STUB=1` で走るので、鍵が置いてあってもネットワークと課金に依存しない。
- API の**型の契約**は `ai@7.0.107` と `@ai-sdk/provider` の `EvaluationModelV4` を読んで確認した。
  `boolean` は `{type,probability}`（P(true)、`value` フィールドは無い）、
  `score` は **0 起点の小数位置 `[0, 水準数-1]`**。`warnings[]` と `rounding` が結果に付く。
- live 疎通は 2026-09-23（Vercel 経由）と 2026-09-26（手元）に通っている（HANDOFF 付記 A）。

**未確認・現在の障害**
- **2026-09-27、この環境から Gateway には届いたが、Jev の呼び出しは無料枠のため拒否された。**
  有料クレジットをチャージするまで、層分割後の検査は stub でしか動作確認できていない。
- 層分割後の各層が、意図した欠陥を実際に捕まえるかは未検証（較正待ち）。
- Jev が SVG の配置・矢印で表した関係（座標）を読めるかは未検証。③の一致率が低ければ入力形式を疑うこと。
- `experimental_evaluate` は名前どおり実験的 API で、`ai` SDK のパッチ更新で契約が変わりうる。
  壊れた場合 `interpret` は回答を欠損として扱い `verdict: "unknown"` を返すので、誤って `ship` にはならない。

**前提が崩れる条件**
- **閾値 0.70 / 0.50 / `group_fail_at=2` は較正前の初期値で、根拠がない。**
  この判定を品質の根拠にしてはいけない。`jev_ping` と `jev_review` が毎回そう警告する。
- g2 の「X軸・Y軸の意味が明示されていないか」（critical）は条件付きの文言になっておらず、
  軸の無いフロー図・ツリー図で誤って立つ疑いがある（2026-09-26 の live で jev-loop.html に g2 が立った。推測）。
  直すなら Drive 正本側。
- 図の指定（呼び名・番号）は呼び出し側の申告に依存する。本文の「図3」と違う図を渡しても止められない。
- 差し替えで消えた検査がある。暫定ルーブリックにあった `legibility`（スマホ幅・ダークモードの
  コントラスト）と `hierarchy`（視覚階層）は Drive 正本に対応する質問が無いため**落ちた**。
  HTML アーティファクト固有の関心なので、必要なら Drive 側のルーブリックに足してから取り込むこと
  （リポジトリ側だけで足すと Drive と食い違う）。
