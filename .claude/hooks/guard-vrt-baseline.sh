#!/bin/bash
# VRT ベースライン画像への書き込みを止める。
#
# ベースラインは `npm run test:update` が撮り直したものだけが正しい。手で書き換えると
# CI のスクリーンショット比較が必ず落ちる。

INPUT=$(cat)
JQ=$(command -v jq || echo /opt/homebrew/bin/jq)
FILE=$(printf '%s' "$INPUT" | "$JQ" -r '.tool_input.file_path // ""')

case "$FILE" in
  */tests/visual/__screenshots__/*)
    echo "VRT ベースラインは直接編集できません: $FILE" >&2
    echo "→ npm run test:update で再生成し、差分画像を確認してからコミットに含める" >&2
    exit 2
    ;;
esac

exit 0
