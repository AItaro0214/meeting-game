# 会議探偵 — 決めごと事件簿

打ち合わせの「決めたいこと」を事件の手がかりに見立てて解いていく推理ゲーム風の打ち合わせツール。

## 公開版（GitHub Pages）
https://aitaro0214.github.io/meeting-game/

事件ファイルはそのブラウザの localStorage に保存されます（端末間の共有なし）。持ち出しは振り返り画面の「JSON をダウンロード」、取り込みは事件簿の「事件ファイル（JSON）を読み込む」。
`main` に push すると `.github/workflows/pages.yml` が `public/` をデプロイします。

## ローカル起動
`start.bat` をダブルクリック（または `node server.js` → http://127.0.0.1:5178 ）。Node 18+ / 依存パッケージなし。

## 使い方
1. **新しい事件を立件する** → 事件名（🎲でランダム命名）と手がかり（項目＋詳細、最大 8 個）を入力
2. **捜査開始** → ランダムな現場に黒塗りの人物・道具が登場。付箋をクリックして決定事項を書き「解決！」→ パリン！
3. 全部解決すると **事件の全貌** が出るのでまとめを書いて「事件を閉じる」
4. 事件簿からいつでも振り返り（Markdown / JSON ダウンロード、捜査再開も可）

## データ
- 事件ファイル: ローカル起動時は `data/cases/<id>.json`、サーバーなし（GitHub Pages）ではブラウザの localStorage（変更のたびに自動保存）
- 仕様: `SPEC.md`

## 画像セットの作り直し / 追加
環境変数 `GPT API` に OpenAI キーがある状態で:
```
node tools/generate-assets.mjs                 # 未生成分だけ生成（tools/raw/）
node tools/generate-assets.mjs --only <jobId> --force   # 特定シートを作り直し
python tools/slice_sheets.py                   # 切り出し → public/assets/ + manifest.json
```
### 音声（ナレーション・ジングル・効果音）
環境変数 `GeminiAPI` がある状態で:
```
node tools/generate-audio.mjs          # ナレーション（gemini-3.8-flash-tts / ja-jp-storyteller-4）+ ジングル（lyria-3-clip）
python tools/make_sfx.py               # 効果音（numpy 合成）
node tools/generate-audio.mjs --manifest-only
```
セリフは `tools/voice-lines.json`（start / solve / lastOne / allSolved / closed）。追加すればランダムに出ます。

### 画像
素材・テーマ・タイトル語句は `tools/asset-spec.json` に定義。モデルは gpt-image-2.5-sunburst（透過 PNG）。
