# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

「Hatto-to（貼っと）」— macOS Stickies風の付箋デスクトップアプリ。Tauri v2 + Rust バックエンド、Vanilla HTML/CSS/JS フロントエンド。Node.js 不要。

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

前提条件: Rust 1.77+、Xcode Command Line Tools

## アーキテクチャ

### バックエンド (`src-tauri/`)
- `src/lib.rs` — アプリ全体のロジック。データモデル(`Note`)、永続化(JSON)、Tauri コマンド、ウィンドウ管理、システムトレイすべてがこの1ファイルに集約
- `src/main.rs` — エントリポイント。`lib.rs` の `run()` を呼ぶだけ
- `tauri.conf.json` — Tauri 設定。`frontendDist` は `../src` を指す。`withGlobalTauri: true` で `window.__TAURI__` を使用
- `capabilities/default.json` — Tauri v2 のパーミッション定義

### フロントエンド (`src/`)
- `note.html` — 付箋ウィンドウの UI と JS。CSS・JS はすべてインライン（ビルドツール不使用）
- `index.html` — 空のデフォルトページ（実際の UI は note.html）

### データフロー
- 各付箋は独立したウィンドウ（`note-{uuid}` ラベル）として開かれる
- フロントエンドから `window.__TAURI__.core.invoke()` でRust側の Tauri コマンドを呼び出し
- 状態は `AppState`（`Mutex<Vec<Note>>`）で管理し、変更のたびに `~/Library/Application Support/com.hatto-to.app/notes.json` に永続化
- Tauri コマンド: `get_note`, `update_note_content`, `update_note_color`, `update_note_geometry`, `delete_note`, `create_note`

## 主要な依存関係

- `tauri` v2 (tray-icon feature)
- `serde` / `serde_json` — シリアライズ
- `uuid` v4 — 付箋ID生成
- `dirs` — OS標準のデータディレクトリ取得
