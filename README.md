# Hatto-to — macOS Stickies風 付箋アプリ

「貼っとーと」— Post-it にインスパイアされた、Tauri v2 + Rust 製のネイティブ付箋アプリ。
付箋1枚ごとに独立ウィンドウが開き、macOS Stickies のような使い心地。

## 機能

- 📝 付箋ごとに独立ウィンドウ（フレームレス）
- 🎨 6色カラーテーマ（黄・青・緑・ピンク・紫・グレー）
- 💾 自動保存（テキスト・位置・サイズ・ズーム）
- 🔄 起動時に前回の付箋を復元
- ➕ 新規付箋の追加（ボタン / トレイメニュー / ⌘N）
- 🗑️ ゴミ箱機能（削除した付箋を復元可能・最大20件保持）
- 🔍 付箋ごとのズーム設定（⌘+ / ⌘- / ⌘0）
- 📋 Markdownプレビュー（見出し・箇条書き・チェックボックス・太字・斜体・取消線・コード・引用・番号リスト・区切り線・リンク）
- ✏️ Markdown入力補助（箇条書き・番号リスト等のEnter自動継続）
- 🔗 リッチテキストペースト → Markdown自動変換
- 🖱️ カスタム右クリックメニュー
- ⚙️ 設定画面（デフォルトカラー / 文字サイズ / 表示倍率 / 透過度 / 編集切替方式 / 自動起動）

## インストール

### Homebrew (推奨)

```bash
brew install --cask somei-san/tap/hatto-to
```

### ソースからビルド

前提条件:
- [Rust](https://rustup.rs/) (1.77+)
- Xcode Command Line Tools (`xcode-select --install`)

```bash
# Tauri CLI をインストール（初回のみ）
cargo install tauri-cli --version "^2"

# 開発モードで起動
cargo tauri dev

# プロダクションビルド（DMG 生成）
cargo tauri build
```

## 操作方法

| 操作 | 方法 |
|------|------|
| ウィンドウ移動 | タイトルバーをドラッグ |
| 新規付箋 | `+` ボタン / トレイメニュー / ⌘N |
| 色変更 | `●` ボタン → 色を選択 |
| 削除 | `×` ボタン |
| リサイズ | ウィンドウ端をドラッグ |
| 編集モード | ダブルクリック（Markdown付箋）/ シングルクリック（プレーンテキスト） |
| プレビュー | エディタからフォーカスを外す |
| ゴミ箱 | File → Trash... (⌘⇧T) |
| 右クリックメニュー | 右クリック |

## データ保存先

```
~/Library/Application Support/com.hatto-to.app/
├── notes.json      # 付箋データ
├── settings.json   # 設定
└── trash.json      # ゴミ箱（最大20件）
```

## テスト

```bash
# 初回セットアップ
npm install
npx playwright install chromium

# テスト実行（VRT + UT 全100件）
npm test
```

## 技術スタック

- **Backend:** Rust + Tauri v2
- **Frontend:** Vanilla HTML/CSS/JS（ビルドツール不要）
- **永続化:** JSON ファイル（serde_json）
- **テスト:** Playwright（VRT + UT）
- **ID生成:** uuid v4

## リリース手順

```bash
# 1. ビルド
cargo tauri build

# 2. GitHub Releases にアップロード
gh release create v0.1.0 ./src-tauri/target/release/bundle/dmg/*.dmg
```

## アイコンについて

プロダクションビルドの際は正式な `.icns` ファイルが必要:

```bash
cargo tauri icon path/to/your-icon.png
```
