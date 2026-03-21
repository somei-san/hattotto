# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

「貼っとーと」— macOS Stickies風の付箋デスクトップアプリ。Tauri v2 + Rust バックエンド、Vanilla HTML/CSS/JS フロントエンド。

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
cargo clippy --manifest-path src-tauri/Cargo.toml
```

前提条件: Rust 1.77+、Xcode Command Line Tools、Node.js（テスト用）

## テスト（VRT + UT）

```bash
# Playwright インストール（初回のみ）
npm install
npx playwright install chromium

# テスト実行（VRT + UT 全100件）
npm test

# スナップショット更新（UI変更後）
npm run test:update

# レポート表示
npm run test:report
```

**重要**: フロントエンド（`src/note.html`, `src/settings.html` 等）を変更したら必ずテストを走らせること。ベースライン更新が必要なら `npm run test:update` で更新してコミットに含める。

### テストファイル構成
- `tests/visual/note.spec.ts` — 付箋のVRT（色、テキスト、Markdown、カラーピッカー、透過度）
- `tests/visual/settings.spec.ts` — 設定画面のVRT
- `tests/visual/html-to-markdown.spec.ts` — リッチテキスト→Markdown変換のUT
- `tests/visual/has-markdown-syntax.spec.ts` — Markdown記法検出のUT
- `tests/visual/markdown-autocontinue.spec.ts` — 箇条書き自動継続のUT
- `tests/visual/fixtures.ts` — Tauri API モック・テストフィクスチャ

## アーキテクチャ

### バックエンド (`src-tauri/`)
- `src/lib.rs` — アプリ全体のロジック。データモデル、永続化(JSON)、Tauri コマンド、ウィンドウ管理、システムトレイ、メニューがこの1ファイルに集約
- `src/main.rs` — エントリポイント。`lib.rs` の `run()` を呼ぶだけ
- `tauri.conf.json` — Tauri 設定。`frontendDist` は `../src` を指す。`withGlobalTauri: true` で `window.__TAURI__` を使用
- `capabilities/default.json` — Tauri v2 のパーミッション定義

### フロントエンド (`src/`)
- `note.html` — 付箋ウィンドウ。Markdownプレビュー、リッチテキストペースト変換、カスタム右クリックメニュー、入力補助
- `settings.html` — 設定画面。デフォルトカラー/文字サイズ/表示倍率/透過度/編集切替方式/自動起動
- `trash.html` — ゴミ箱ウィンドウ。削除した付箋の一覧・復元・全削除
- `index.html` — 空のデフォルトページ

### データモデル
- `Note`: id, content, color, x, y, width, height, zoom
- `Settings`: default_color, font_size, zoom, opacity, edit_on_single_click

### データフロー
- 各付箋は独立したウィンドウ（`note-{uuid}` ラベル）として開かれる
- フロントエンドから `window.__TAURI__.core.invoke()` でRust側の Tauri コマンドを呼び出し
- 状態は `AppState`（notes, settings, trash の3つの `Mutex`）で管理
- 永続化先: `~/Library/Application Support/com.hatto-to.app/`
  - `notes.json` — 付箋データ
  - `settings.json` — 設定
  - `trash.json` — ゴミ箱（最大200件）

### Tauri コマンド一覧
- 付箋: `get_note`, `update_note_content`, `update_note_color`, `update_note_geometry`, `update_note_zoom`, `delete_note`, `create_note`
- 設定: `get_settings`, `update_settings`, `open_settings`
- ゴミ箱: `get_trash`, `restore_note`, `empty_trash`, `open_trash`

### アプリメニュー
- File: New Note (⌘N), Trash... (⌘⇧T) — ネイティブアイコン付き
- Edit: Undo/Redo/Cut/Copy/Paste/Select All
- View: Zoom In (⌘=) / Zoom Out (⌘-) / Actual Size (⌘0)

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
