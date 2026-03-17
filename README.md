# Hatto-to — macOS Stickies風 付箋アプリ

「貼っとーと」— Post-it にインスパイアされた、Tauri v2 + Rust 製のネイティブ付箋アプリ。
付箋1枚ごとに独立ウィンドウが開き、macOS Stickies のような使い心地。

## 機能

- 📝 付箋ごとに独立ウィンドウ（フレームレス）
- 🎨 6色カラーテーマ（黄・青・緑・ピンク・紫・グレー）
- 💾 自動保存（テキスト・位置・サイズ）
- 🔄 起動時に前回の付箋を復元
- ➕ 新規付箋の追加（ボタン or トレイメニュー）
- 🗑️ 付箋の削除

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
| 新規付箋 | `+` ボタン / トレイメニュー |
| 色変更 | `●` ボタン → 色を選択 |
| 削除 | `×` ボタン |
| リサイズ | ウィンドウ端をドラッグ |

## データ保存先

```
~/Library/Application Support/com.hatto-to.app/notes.json
```

## 技術スタック

- **Backend:** Rust + Tauri v2
- **Frontend:** Vanilla HTML/CSS/JS（ビルドツール不要）
- **永続化:** JSON ファイル（serde_json）
- **ID生成:** uuid v4
- **依存:** Rust のみ。Node.js 不要。

## リリース手順

```bash
# 1. ビルド
cargo tauri build

# 2. 署名 & 公証（Apple Developer ID が必要）
codesign --sign "Developer ID Application: ..." \
  ./src-tauri/target/release/bundle/macos/Hatto-to.app

xcrun notarytool submit \
  ./src-tauri/target/release/bundle/dmg/Hatto-to_0.1.0_aarch64.dmg \
  --apple-id $APPLE_ID --password $APP_PASSWORD --team-id $TEAM_ID --wait

xcrun stapler staple \
  ./src-tauri/target/release/bundle/dmg/Hatto-to_0.1.0_aarch64.dmg

# 3. GitHub Releases にアップロード
gh release create v0.1.0 ./src-tauri/target/release/bundle/dmg/*.dmg

# 4. Homebrew Tap は GitHub Actions が自動更新
```

## アイコンについて

プロダクションビルドの際は正式な `.icns` ファイルが必要:

```bash
cargo tauri icon path/to/your-icon.png
```
