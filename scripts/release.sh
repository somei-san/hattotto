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

# 既存タグチェック
if git tag -l "$TAG" | grep -q .; then
  echo "ERROR: タグ ${TAG} は既に存在します" >&2
  exit 1
fi

# タグを作成して push → GitHub Actions (release.yml) がビルド・リリースを実行
echo "==> タグ ${TAG} を作成して push します..."
git tag "$TAG"
git push origin "$TAG"

echo ""
echo "==> タグ ${TAG} を push しました。"
echo "    GitHub Actions がビルド・リリース・Homebrew tap 更新を自動実行します。"
echo "    進捗: https://github.com/somei-san/hatto-to/actions"
