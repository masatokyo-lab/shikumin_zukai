---
name: zukai-loop
description: 仕組み図解アーティファクトを作る/直すときの反復ループ。Jev (zukai-jev MCP) で毎周品質を検査し、判定をスマホ用ダッシュボードに同期する。図解・ポンチ絵・仕組み図・説明用アーティファクトの作成依頼、および既存図解の改善依頼で使う。
---

# 図解 生成 → Jev 検査 → 修正 ループ

生成したら必ず検査する。検査せずに「できました」と言わない。

## 0. モードを最初に確かめる

`jev_ping` を呼ぶ。`mode` が `stub` なら **スコアはダミー** なので、ユーザーに一行で伝える:

> Jev の APIキーが未設定のため stub モードです。以下のスコアは品質判断には使えません。

`live` なら以降のスコアは実判定。ここを曖昧にしない。

## 1. 図解を作る

- 出力先は `artifacts/<slug>.html`。単一 HTML、インライン SVG、外部依存なし。
- ライト/ダーク両対応、スマホ幅で読めること（ルーブリックの `legibility` で直接見られる）。
- Artifact として公開する場合は `artifact-design` スキルを先に読む。

## 2. `jev_review` で検査する

```
jev_review({ task, artifact_path, source_material, note })
```

- `task` は依頼内容そのまま。`source_material` は元資料。**これを省くと裏付け判定 (`grounded`) が効かない。**
- 返る `verdict` は `ship` / `revise` / `block` / `unknown`。
- `fixes` に落ちた項目と、それが何を見ているかが入る。

## 3. 直す

`fixes` のうち `blocking: true`（構造・因果・ラベル・裏付け）から先に直す。可読性や密度の微調整はその後。

直したら `note` に変更点を書いて再度 `jev_review`。`run_id` は自動で引き継がれ、`iteration` が増える。

**スコアが前周より下がったら、その変更は捨てて前の版に戻す。** 反復は単調改善でなければ意味がない。

## 4. 止めどき

- `verdict === "ship"` → 完了。
- **3 周して `ship` にならなければ止める。** それ以上回すのは、ルーブリックが合っていないか元資料が足りないかのどちらか。どちらかを述べてユーザーに判断を仰ぐ。
- `jev_next_action === "more_input"` が返ったら即座に止めて、何の資料が足りないかを聞く。
- 軽く「出せるか」だけ見たいときは `jev_gate`（ゲート2項目のみ、安い）。

## 5. 毎周ダッシュボードへ同期する

検査のたびに、スマホから見えるダッシュボードへ反映する。これをやらないと「Jev が動いているのが見える」状態にならない。

1. `jev_feed({ since_seq })` を呼ぶ（初回は `0`、以降は前回の `next_since_seq`）。
2. 返った `records` を `ArtifactData` の `batch` で 1 回にまとめて書く:
   - collection `evals`、`doc_id` は `String(seq)`、中身はレコードそのまま。
   - collection `status`、`doc_id` は `"current"`、中身は `state` に `mode` / `model` / `synced_at` を足したもの。
3. パネルの URL は README.md の表にある（`.jev/dashboard-url.txt` にも控えてある）。無ければ `dashboard/index.html` を `capabilities: {db: {}}` 付きで publish し、URL を両方に書いてユーザーに渡す。

`status` は毎回上書きする — これがスマホ側の「稼働中 / 待機中」表示になる。

## 禁止

- stub モードのスコアを根拠に品質を語ること。
- 検査を飛ばして完成を報告すること。
- ルーブリックに通すためだけに図解から情報を削ること（`density` は上がるが `structure` が落ちる。落ちなければ検査が甘い）。
