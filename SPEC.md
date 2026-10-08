# 会議探偵 — 決めごと事件簿（kaigi-tantei） 共通仕様

打ち合わせで「決めたいこと」を事件の手がかりに見立てて解いていく、ローカル専用の推理ゲーム風ツール。
依存ゼロ（Node 24 標準モジュールのみ / フロントはバニラ JS）。UI はすべて日本語。

## ディレクトリ
```
kaigi-tantei/
  server.js              # Node 標準 http。127.0.0.1:5178。静的配信 + 事件ファイル API
  start.bat              # ダブルクリックで server 起動 + ブラウザで開く
  data/cases/<id>.json   # 事件ファイル（セーブデータ）
  public/
    index.html
    css/style.css
    js/*.js              # ES modules
    assets/manifest.json # 画像セットの目録（tools が生成）
    assets/bg/*.jpg      # 背景 1536x1024
    assets/chars/*.png   # 人物（透過・トリミング済み）
    assets/items/*.png   # 道具（透過・トリミング済み）
  tools/
    asset-spec.json      # 生成する画像の定義（プロンプト + 各コマのメタデータ）
    generate-assets.mjs  # OpenAI Images API を叩いて tools/raw/ に保存
    slice_sheets.py      # raw のシートを切り分け → public/assets/ + manifest.json
    raw/                 # 生成された生画像
```

## assets/manifest.json（画像側とアプリ側の契約）
```json
{
  "version": 1,
  "themes": [
    { "id": "snack", "name": "つまみ食い", "weight": 3,
      "titlePlaces": ["給湯室", "冷蔵庫前"], "titleNouns": ["プリン消失", "おやつ横領"] }
  ],
  "backgrounds": [
    { "id": "bg_snack_pantry", "theme": "snack", "name": "オフィスの給湯室",
      "file": "assets/bg/bg_snack_pantry.jpg", "width": 1536, "height": 1024, "floorY": 0.86 }
  ],
  "characters": [
    { "id": "ch_office_1", "label": "冷や汗の新人社員", "expression": "nervous",
      "themes": ["office", "snack"], "file": "assets/chars/ch_office_1.png", "width": 412, "height": 900 }
  ],
  "items": [
    { "id": "it_snack_1", "label": "食べかけのプリン",
      "themes": ["snack", "party"], "file": "assets/items/it_snack_1.png", "width": 380, "height": 300 }
  ]
}
```
- `themes` に `"any"` が入っている素材はどのテーマでも使ってよい。
- `floorY` = 背景画像の高さに対する「床（人物の足元）」の位置（0〜1）。
- テーマ ID: `snack, office, mansion, train, museum, cafe, onsen, harbor, camp, party`

## 事件ファイル（data/cases/<id>.json）
```json
{
  "id": "20261008-153012-ab12",
  "title": "給湯室プリン消失事件",
  "createdAt": "ISO8601", "updatedAt": "ISO8601",
  "status": "setup | investigating | solved | closed",
  "items": [
    { "title": "次回リリース日", "detail": "営業と開発で合意したい", "decision": "", "solvedAt": null }
  ],
  "summary": "",
  "scene": {
    "themeId": "snack", "backgroundId": "bg_snack_pantry",
    "targets": [ { "type": "character|item", "assetId": "ch_office_1",
                   "x": 0.32, "y": 0.86, "h": 0.55, "flip": false, "z": 3 } ],
    "notes":   [ { "x": 0.08, "y": 0.12, "rot": -4, "color": "yellow" } ]
  }
}
```
- `items[i]` ↔ `scene.targets[i]` ↔ `scene.notes[i]` が同じインデックスで対応。
- target の x,y はステージ幅/高さに対する割合。x=横中心、y=足元（下端）、h=高さ（ステージ高さ比）。
- id は `^[0-9A-Za-z_-]{1,64}$`。

## API（server.js）
- `GET    /api/cases`       → `[{id,title,status,createdAt,updatedAt,total,solved}]`（updatedAt 降順）
- `GET    /api/cases/:id`   → 事件ファイル
- `PUT    /api/cases/:id`   → body の JSON をそのまま保存（id 検証・2MB 上限）→ `{ok:true}`
- `DELETE /api/cases/:id`
- それ以外は public/ の静的配信（パストラバーサル防止、Content-Type 付与）。
