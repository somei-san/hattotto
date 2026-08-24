# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

「貼っとっと」— macOS Stickies風の付箋デスクトップアプリ。Tauri v2 + Rust バックエンド、Vanilla HTML/CSS/JS フロントエンド。

## ビルド・開発コマンド

ビルド・テスト・コミット前検証のコマンドは [DEVELOPMENT.md](DEVELOPMENT.md) に集約している。開発起動は「ソースからビルド」、テストは「テスト」、lint / clippy / fmt は「コミット前の検証」の節を参照。

前提条件: Rust 1.77+、Xcode Command Line Tools、Node.js（テスト用）

## コミット前の検証

- DEVELOPMENT.md「コミット前の検証」のコマンドを、変更した側（Rust / フロントエンド）に応じてすべて通す
- フォーマッターは未導入。CSS と `tests/visual/*.ts` も lint 対象外

`.claude/settings.json` に登録したフックが一部を自動で回す。`.rs` を編集すると `rust-check.sh` が fmt / clippy を実行し、失敗すれば内容を返す。`tests/visual/__screenshots__/` への書き込みは `guard-vrt-baseline.sh` が止める（ベースラインは再生成でしか正しく作れない）。`cargo test` と `npm test` と `npm run lint` は自分で流す。

## リリース

タグ push をトリガーに GitHub Actions が universal DMG ビルド → Release 作成 → Homebrew tap 更新まで自動実行する。手順は [DEVELOPMENT.md](DEVELOPMENT.md) を参照。

## テスト（VRT + UT + E2E）

実行コマンドは DEVELOPMENT.md「テスト」を参照。フロントエンド（`src/note.js`, `src/settings.html`, `src/markdown.js` 等）を変更したら必ずテストを走らせること。ベースライン更新が必要なら `npm run test:update` で更新してコミットに含める。

### テストファイル構成
`tests/unit/` は node の単体テスト（`node --test`）、`tests/visual/` は Playwright（全一覧は `ls tests/visual/*.spec.ts` を参照）。Playwright 側でファイル名から区別できるのは E2E（`*-e2e.spec.ts`）のみで、VRT と UT は名前では分かれない。

- 単体テスト — `tests/unit/*.test.js`。ブラウザを起動しない node のテスト。`src/` の関数（DOM にもアプリの状態にも触らないものだけ）を `require` して呼ぶものと、リポジトリ内ファイルの整合性照合（Tauri コマンド名・日英 README の構成）がある
- VRT — `toHaveScreenshot` によるスクリーンショット比較（`note.spec.ts` / `settings.spec.ts` / `trash.spec.ts`）。ベースラインは `tests/visual/__screenshots__/darwin/` の 1 セットで、更新経路は `npm run test:update` だけ。CI も同じ macOS で走らせている（`visual-test.yml` の `runs-on`）。手元の macOS を上げたらランナーのピンも上げる
  - 等幅フォント内の日本語はスクリーンショットに入れない。CJK のフォールバックが手元と CI ランナーで揃わず、ピクセル差が出る
- UT — 上記以外の非 E2E spec。リッチテキストから Markdown への変換、アクセシビリティ、コンテキストメニュー等。DOM が要る単体テストはこちらに置く
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
- `src/i18n.rs` — ネイティブ側 UI 文言の言語ごとの表記（`Msg` の表）と表示言語の解決。`Msg` を増やすと訳の付け忘れがコンパイルエラーになる
- `tauri.conf.json` — Tauri 設定。`frontendDist` は `../src` を指す。`withGlobalTauri: true` で `window.__TAURI__` を使用
- `capabilities/default.json` — Tauri v2 のパーミッション定義

### フロントエンド (`src/`)
HTML はマークアップと `<style>` だけを持ち、スクリプトは同名の `.js` にある。すべて classic script で、`utils.js` → `i18n.js` →〔`markdown.js` → `note-lines.js`〕→ ページ固有の `.js` の順に読む（〔〕内は `note.html` だけ）。同一ページ内でグローバルスコープを共有する。

この読み込み順は `eslint.config.mjs` にも書いてある。各 `.js` の `globals` が「そのファイルより先に読まれるファイルの識別子」だけを持つので、`settings.js` から `renderMarkdown` を呼ぶような誤りは `no-undef` で落ちる。`<script>` の並びを変えたら設定側も直すこと。

- `note.html` / `note.js` — 付箋ウィンドウ。常に Markdown を描画し、キャレットのある行だけ生 Markdown の `.raw-editor` に差し替える（以降この状態を「生表示」と呼ぶ）。ほかにリッチテキストペースト変換、カスタム右クリックメニュー、入力補助
- `settings.html` / `settings.js` — 設定画面。デフォルトカラー / 透過度 / 表示ボタン制御（前面表示・ピン・新規・カラー）/ 削除確認 / 言語 / 自動起動
- `trash.html` / `trash.js` — ゴミ箱ウィンドウ。削除した付箋の一覧・復元・全削除
- `note-lines.js` — 生 Markdown の行を扱う純粋関数（行頭マーカー長・リスト継続のプレフィックス・ブロック内オフセット）。DOM に触らないので `tests/unit/` から `require` できる
- `markdown.js` — Markdown レンダリング（`window.renderMarkdown`）。`note.js` の表示とテストで共有。`utils.js` の `escapeHtml()` に依存。各要素に `data-line`（フェンスは `data-line-end` も）を付け、ソース行と DOM 要素を対応づける
- `utils.js` — 各 HTML 共通のユーティリティ（`escapeHtml` / toast など）
- `i18n.js` — フロントエンド側 UI 文言（`window.I18N`）。`data-i18n` / `data-i18n-html` / `data-i18n-title` / `data-i18n-aria-label` / `data-i18n-doc-title` 属性を `applyDom()` が差し替える
- `colors.css` — 6色カラーテーマの共通パレット（CSS 変数）

### データモデル
（正確なフィールドは `src-tauri/src/model.rs` を参照）
- `Note`: id, content, color, x, y, width, height, zoom, pinned, deleted_at
- `Settings`: default_color, opacity, bring_all_to_front, show_pin_button, show_new_button, show_color_button, confirm_before_delete, language

表示言語は `Settings.language`（`auto` / `ja` / `en`）で決まる。OS ロケールの解釈は Rust 側の `i18n::system_language()` に一本化されており、`get_settings` コマンドが `Settings` に `system_language`（`"ja"` / `"en"`）を添えて返す。フロントエンドは `navigator.language` を直接見ず、`I18N.resolve(language, systemLanguage)` にこの値を渡して `auto` を解決する。文言テーブルはネイティブ側 `src-tauri/src/i18n.rs` とフロントエンド側 `src/i18n.js` に分かれて存在する。

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
