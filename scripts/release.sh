#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TAURI_CONF="$PROJECT_ROOT/src-tauri/tauri.conf.json"

# バージョン決定: 引数があればそれを使い、なければ tauri.conf.json から取得
if [[ $# -ge 1 ]]; then
  VERSION="$1"
else
  VERSION="$(jq -r '.version' "$TAURI_CONF")"
  echo "==> tauri.conf.json のバージョンを使用: $VERSION"
fi

# semver バリデーション
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: 不正なバージョン形式: $VERSION (x.y.z 形式で指定してください)" >&2
  exit 1
fi

TAG="v${VERSION}"
CARGO_TOML="$PROJECT_ROOT/src-tauri/Cargo.toml"

# 既存タグチェック
if git tag -l "$TAG" | grep -q .; then
  echo "ERROR: タグ ${TAG} は既に存在します" >&2
  exit 1
fi

# 依存の更新はここで拾う（dependabot は定期実行しない設定。.github/dependabot.yml 参照）。
# バージョン更新のコミットより前に置くこと。後ろだと中断時に未 push のコミットが残り、
# その間に dependabot PR をマージすると再実行時の push が分岐して失敗する。
OPEN_BOT_PRS="$(gh pr list --repo somei-san/hattotto --author "app/dependabot" --state open --json number --jq 'length')"
if [[ "$OPEN_BOT_PRS" != "0" ]]; then
  echo "ERROR: dependabot の PR が ${OPEN_BOT_PRS} 件残っています。片付けてからリリースしてください" >&2
  gh pr list --repo somei-san/hattotto --author "app/dependabot" --state open >&2
  exit 1
fi

# 端末が無いときは確認できないので、黙って飛ばさず警告を出す。制御端末を持たない
# 経路（パイプ越し、CI やエージェント経由の非対話実行）では /dev/tty も開けず、聞く手段が無い。
if [[ -t 0 ]]; then
  read -r -p "Dependabot の Check for updates は押しましたか? [y/N] " reply
  if [[ ! "$reply" =~ ^[yY]$ ]]; then
    echo "中断しました。Insights → Dependency graph → Dependabot で押してください" >&2
    exit 1
  fi
else
  echo "WARNING: 端末が無いので Check for updates の確認を省略しました" >&2
fi

# バージョンを各設定ファイルに反映
CURRENT="$(jq -r '.version' "$TAURI_CONF")"
if [[ "$CURRENT" != "$VERSION" ]]; then
  echo "==> バージョンを $CURRENT → $VERSION に更新..."

  # tauri.conf.json
  jq --arg v "$VERSION" '.version = $v' "$TAURI_CONF" > "${TAURI_CONF}.tmp" && mv "${TAURI_CONF}.tmp" "$TAURI_CONF"

  # Cargo.toml (パッケージセクションの version のみ置換)
  sed -i '' "s/^version = \"${CURRENT}\"/version = \"${VERSION}\"/" "$CARGO_TOML"

  # Cargo.lock を更新
  (cd "$PROJECT_ROOT/src-tauri" && cargo check --quiet 2>/dev/null)

  # バージョン更新をコミット
  git -C "$PROJECT_ROOT" add "$TAURI_CONF" "$CARGO_TOML" "$PROJECT_ROOT/src-tauri/Cargo.lock"
  git -C "$PROJECT_ROOT" commit -m "📦️ バージョンを $VERSION に上げる"
  echo "==> バージョン更新をコミットしました"
fi

# タグを作成して push → GitHub Actions (release.yml) がビルド・リリースを実行
echo "==> タグ ${TAG} を作成して push します..."
git tag "$TAG"
git push origin main "$TAG"

echo ""
echo "==> タグ ${TAG} を push しました。"
echo "    GitHub Actions がビルド・リリース・Homebrew tap 更新を自動実行します。"
echo "    進捗: https://github.com/somei-san/hattotto/actions"
