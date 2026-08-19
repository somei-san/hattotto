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

タグ push をトリガーに GitHub Actions が自動で universal DMG ビルド → GitHub Release 作成 → Homebrew tap 更新を行います。バージョン更新・コミット・タグ付け・push は [cargo-release](https://github.com/crate-ci/cargo-release) が行います（`cargo install cargo-release` または `brew install cargo-release` で導入）。未処理の dependabot PR が残っているとフック（`scripts/check-dependabot.sh`）が止めるので、先に片付けてください。

```bash
# dry-run で内容を確認してから --execute で実行。patch の代わりに minor / major も指定可
cargo release patch --manifest-path src-tauri/Cargo.toml
cargo release patch --manifest-path src-tauri/Cargo.toml --execute

# 中断からのやり直し（バージョンは上がっているがタグが無い場合）
cargo release tag --manifest-path src-tauri/Cargo.toml --execute
cargo release push --manifest-path src-tauri/Cargo.toml --execute
```

### 初回セットアップ（リポジトリ管理者のみ）

1. GitHub で Fine-grained PAT を作成（scope: `somei-san/homebrew-tap`, Contents: Read and write）
2. `somei-san/hattotto` の Settings > Secrets and variables > Actions に `HOMEBREW_TAP_TOKEN` として登録

