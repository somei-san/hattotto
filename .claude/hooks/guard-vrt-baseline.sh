#!/bin/bash
# VRT ベースライン画像への書き込みを止める。
#
# ベースラインは darwin が `npm run test:update`、linux が visual-test.yml の
# workflow_dispatch でしか生成できない。linux 側は macOS 上では描画結果が違うため
# 原理的に正しく作れず、手で書き換えると CI のスクリーンショット比較が必ず落ちる。

INPUT=$(cat)
JQ=$(command -v jq || echo /opt/homebrew/bin/jq)
FILE=$(printf '%s' "$INPUT" | "$JQ" -r '.tool_input.file_path // ""')

case "$FILE" in
  */tests/visual/__screenshots__/*)
    echo "VRT ベースラインは直接編集できません: $FILE" >&2
    echo "→ darwin: npm run test:update で再生成し、差分画像を確認してからコミットに含める" >&2
    echo "→ linux: visual-test.yml の workflow_dispatch (update_snapshots) から更新する" >&2
    exit 2
    ;;
esac

exit 0
