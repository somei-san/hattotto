# 開発ガイド

## ソースからビルド

前提条件:
- [Rust](https://rustup.rs/) (1.77+)
- Xcode Command Line Tools (`xcode-select --install`)

```bash
# 開発モードで起動
cargo run --manifest-path src-tauri/Cargo.toml

# プロダクションビルド（DMG 生成、リリースは別手順あるので普通は使わない）
cargo install tauri-cli --version "^2"   # 初回のみ
cargo tauri build
```

フロントエンドは静的ファイルをそのまま読むため、開発起動に Tauri CLI は不要です（DMG ビルド時のみ必要）。

## テスト

```bash
# 初回セットアップ
npm install
npx playwright install chromium

# テスト実行（VRT + UT + E2E）
npm test

# スナップショット更新（UI 変更後）
npm run test:update
```

## 技術スタック

- **Backend:** Rust + Tauri v2
- **Frontend:** Vanilla HTML/CSS/JS（ビルドツール不要）
- **永続化:** JSON ファイル（serde_json）
- **テスト:** Playwright（VRT + UT）
- **ID生成:** uuid v4

## リリース手順

タグ push をトリガーに GitHub Actions が自動で universal DMG ビルド → GitHub Release 作成 → Homebrew tap 更新を行います。

```bash
# tauri.conf.json / Cargo.toml / Cargo.lock の更新からコミット・タグ・push まで
# スクリプトが行います
./scripts/release.sh 0.2.0

# バージョン省略時は tauri.conf.json の現在のバージョンを使用
./scripts/release.sh
```

### 初回セットアップ（リポジトリ管理者のみ）

1. GitHub で Fine-grained PAT を作成（scope: `somei-san/homebrew-tap`, Contents: Read and write）
2. `somei-san/hattotto` の Settings > Secrets and variables > Actions に `HOMEBREW_TAP_TOKEN` として登録

