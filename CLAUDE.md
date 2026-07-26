# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

「貼っとっと」— macOS Stickies風の付箋デスクトップアプリ。Tauri v2 + Rust バックエンド、Vanilla HTML/CSS/JS フロントエンド。

## ビルド・開発コマンド

```bash
# Tauri CLI インストール（初回のみ）
cargo install tauri-cli --version "^2"

# 開発モード起動
cargo tauri dev

# プロダクションビルド（DMG生成）
cargo tauri build

# Rust 側のチェック・テスト
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

前提条件: Rust 1.77+、Xcode Command Line Tools、Node.js（テスト用）

## コミット前の検証

- Rust を変更したら `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` と `cargo test ...` を通す（CI の `build.yml` が `-D warnings` で落とすため、警告も修正する）。整形は `cargo fmt --manifest-path src-tauri/Cargo.toml`
- フロントエンド（`src/*`）を変更したら `npm test` を通す。UI 変更でベースラインが変わったら `npm run test:update` の差分もコミットに含める
- JS/CSS 専用のリンター・フォーマッターは未導入（`npm` スクリプトは Playwright のみ）

## リリース

タグ push をトリガーに GitHub Actions が universal DMG ビルド → Release 作成 → Homebrew tap 更新まで自動実行する。手順は [DEVELOPMENT.md](DEVELOPMENT.md) を参照。

## テスト（VRT + UT + E2E）

```bash
# Playwright インストール（初回のみ）
npm install
npx playwright install chromium

# テスト実行
npm test

# スナップショット更新（UI変更後）
npm run test:update

# レポート表示
npm run test:report
```

**重要**: フロントエンド（`src/note.html`, `src/settings.html`, `src/markdown.js` 等）を変更したら必ずテストを走らせること。ベースライン更新が必要なら `npm run test:update` で更新してコミットに含める。

### テストファイル構成
すべて `tests/visual/` 配下（全一覧は `ls tests/visual/*.spec.ts` を参照）。ファイル名で区別できるのは E2E（`*-e2e.spec.ts`）のみで、VRT と UT は名前では分かれない。

- VRT — `toHaveScreenshot` によるスクリーンショット比較（`note.spec.ts` / `settings.spec.ts` / `trash.spec.ts`）。ベースラインは `tests/visual/__screenshots__/{darwin,linux}/`
- UT — 上記以外の非 E2E spec。Markdown 変換・記法検出・レンダリング、アクセシビリティ、コンテキストメニュー等の単体テスト
- E2E（`*-e2e.spec.ts`）— 行の生表示切替・ペースト・オートセーブ・削除・ズーム・IME ガード等の振る舞いテスト
- `fixtures.ts` — Tauri API モック・テストフィクスチャ

## アーキテクチャ

### バックエンド (`src-tauri/`)
機能ごとにモジュール分割されている（`src/lib.rs` は `run()` で全体を組み立てるだけ）。

- `src/lib.rs` — `run()`。プラグイン登録・状態初期化・各モジュールの組み立て
- `src/main.rs` — エントリポイント。`lib.rs` の `run()` を呼ぶだけ
- `src/model.rs` — データモデル（`Note` / `Settings`）と `AppState`
- `src/commands.rs` — Tauri コマンド定義
- `src/persistence.rs` — JSON ファイルの読み書き（notes / settings / trash）
- `src/window.rs` — 付箋ウィンドウの生成・管理
- `src/menu.rs` — アプリメニュー
- `src/tray.rs` — システムトレイ
- `tauri.conf.json` — Tauri 設定。`frontendDist` は `../src` を指す。`withGlobalTauri: true` で `window.__TAURI__` を使用
- `capabilities/default.json` — Tauri v2 のパーミッション定義

### フロントエンド (`src/`)
- `note.html` — 付箋ウィンドウ。常に Markdown を描画し、キャレットのある行だけ生 Markdown の `.raw-editor` に差し替える（以降この状態を「生表示」と呼ぶ）。ほかにリッチテキストペースト変換、カスタム右クリックメニュー、入力補助
- `settings.html` — 設定画面。デフォルトカラー / 透過度 / 表示ボタン制御（前面表示・ピン・新規・カラー）/ 削除確認 / 自動起動
- `trash.html` — ゴミ箱ウィンドウ。削除した付箋の一覧・復元・全削除
- `index.html` — 空のデフォルトページ
- `markdown.js` — Markdown レンダリング（`window.renderMarkdown`）。note.html の表示とテストで共有。`utils.js` の `escapeHtml()` に依存。各要素に `data-line`（フェンスは `data-line-end` も）を付け、ソース行と DOM 要素を対応づける
- `utils.js` — 各 HTML 共通のユーティリティ（`escapeHtml` / toast など）
- `colors.css` — 6色カラーテーマの共通パレット（CSS 変数）

### データモデル
（正確なフィールドは `src-tauri/src/model.rs` を参照）
- `Note`: id, content, color, x, y, width, height, zoom, pinned, deleted_at
- `Settings`: default_color, opacity, bring_all_to_front, show_pin_button, show_new_button, show_color_button, confirm_before_delete

### データフロー
- 各付箋は独立したウィンドウ（`note-{uuid}` ラベル）として開かれる
- フロントエンドから `window.__TAURI__.core.invoke()` でRust側の Tauri コマンドを呼び出し
- 状態は `AppState`（notes, settings, trash の3つの `Mutex`）で管理
- 永続化先: `~/Library/Application Support/com.hattotto.app/`
  - `notes.json` — 付箋データ
  - `settings.json` — 設定
  - `trash.json` — ゴミ箱（最大200件）

### Tauri コマンド一覧
（登録元は `src-tauri/src/lib.rs` の `generate_handler!`）
- 付箋: `get_note`, `update_note_content`, `update_note_color`, `update_note_geometry`, `update_note_zoom`, `update_note_pinned`, `delete_note`, `create_note`
- 設定: `get_settings`, `update_settings`, `open_settings`
- ゴミ箱: `get_trash`, `get_trash_max`, `restore_note`, `empty_trash`, `open_trash`
- メニュー: `show_context_menu`

### アプリメニュー
- File: New Note (⌘N), Trash... (⌘⇧T) — ネイティブアイコン付き
- Edit: Undo/Redo/Cut/Copy/Paste/Select All
- View: Zoom In (⌘=) / Zoom Out (⌘-) / Actual Size (⌘0)

## ユビキタス言語

コメント・識別子・ドキュメントで使う語はコード側の呼称に揃える。

| 概念 | コード上の呼称 | 表記 |
|---|---|---|
| 付箋 | `Note` / `note` | 「付箋」（「メモ」「ノート」と混在させない） |
| ゴミ箱 | `trash` | 「ゴミ箱」 |
| 設定 | `Settings` / `settings` | 「設定」 |
| 表示倍率 | `zoom` | 「ズーム」/「表示倍率」 |
| 透過度 | `opacity` | 「透過度」 |

## 主要な依存関係

### Rust
- `tauri` v2 (tray-icon feature)
- `tauri-plugin-shell` — 外部リンクをブラウザで開く
- `tauri-plugin-autostart` — ログイン時自動起動
- `serde` / `serde_json` — シリアライズ
- `uuid` v4 — 付箋ID生成
- `dirs` — OS標準のデータディレクトリ取得

### Node.js（テスト用のみ）
- `@playwright/test` — VRT + UT
- `serve` — テスト用ローカルサーバー
