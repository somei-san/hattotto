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

インストール済みの貼っとっとが起動していると、開発ビルドは起動せずに終了します。単一インスタンスの判定はアプリ識別子で行うため、実行ファイルの場所が違っても同じアプリとみなされます。開発時はインストール版を終了してから起動してください。

## テスト

```bash
# 初回セットアップ
npm install
npx playwright install chromium webkit

# テスト実行（node の単体テスト → Playwright の順、chromium + webkit 両方）
npm test

# 単体テストだけ（ブラウザを起動しないので速い）
npm run test:unit

# 特定エンジンだけ（実機は WKWebView なので webkit 差分の切り分けに使う）
npm run test:chromium
npm run test:webkit

# スナップショット更新（UI 変更後）
npm run test:update

# レポート表示
npm run test:report
```

## コミット前の検証

Rust を変更したら:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

フロントエンド（`src/*`）を変更したら:

```bash
npm run lint
npm test
```

警告も整形の崩れも CI で落ちるため、手元で通してからコミットする。UI 変更でスクリーンショットのベースラインが変わったら `npm run test:update` で更新し、差分画像を確認してからコミットに含める。

## ログ

`~/Library/Logs/com.hattotto.app/` にログファイルが出力される。不具合の追跡はまずここを見る。
上限 1MB・直近 1 世代のみ保持（超えたら古い世代を破棄して書き直す）。

## 技術スタック

- **Backend:** Rust + Tauri v2
- **Frontend:** Vanilla HTML/CSS/JS（ビルドツール不要）
- **永続化:** JSON ファイル（serde_json）
- **テスト:** Playwright（VRT + UT）
- **ID生成:** uuid v4

## リリース手順

タグ push をトリガーに GitHub Actions が自動で universal DMG ビルド → GitHub Release 作成 → Homebrew tap 更新を行います。バージョン更新・コミット・タグ付け・push は [cargo-release](https://github.com/crate-ci/cargo-release) が行います（`cargo install cargo-release` または `brew install cargo-release` で導入）。未処理の dependabot PR が残っているとフック（`scripts/check-dependabot.sh`）が止めるので、先に片付けてください。

上げ幅は第 1 引数で指定します。次のバージョンは `Cargo.toml` の現在値から計算されるので、番号そのものは書きません。

| 引数 | 0.3.1 のとき |
|---|---|
| `patch` | 0.3.2 |
| `minor` | 0.4.0 |
| `major` | 1.0.0 |

```bash
# dry-run で内容を確認する（--execute を付けるまで何も起きない）
cargo release patch --manifest-path src-tauri/Cargo.toml

# 確認できたら実行する
cargo release patch --manifest-path src-tauri/Cargo.toml --execute

# 中断からのやり直し（バージョンは上がっているがタグが無い場合）
cargo release tag --manifest-path src-tauri/Cargo.toml --execute
cargo release push --manifest-path src-tauri/Cargo.toml --execute
```

### 初回セットアップ（リポジトリ管理者のみ）

1. GitHub で Fine-grained PAT を作成（scope: `somei-san/homebrew-tap`, Contents: Read and write）
2. `somei-san/hattotto` の Settings > Secrets and variables > Actions に `HOMEBREW_TAP_TOKEN` として登録

