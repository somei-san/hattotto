#!/bin/bash
# Rust を編集した直後に、build.yml と同じ fmt / clippy を回す。
#
# CI で落ちる内容を編集直後に返すのが目的なので、オプションは build.yml に揃える。
# --all-targets を外すとテストコードの警告を CI だけが検出する状態になる。

INPUT=$(cat)
JQ=$(command -v jq || echo /opt/homebrew/bin/jq)
FILE=$(printf '%s' "$INPUT" | "$JQ" -r '.tool_input.file_path // ""')

case "$FILE" in
  *.rs) ;;
  *) exit 0 ;;
esac

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
MANIFEST="$ROOT/src-tauri/Cargo.toml"
[ -f "$MANIFEST" ] || exit 0

# Homebrew の rustup は keg-only で PATH に載らないため、見つからなければ実体を直接見る
CARGO=$(command -v cargo || echo /opt/homebrew/opt/rustup/bin/cargo)
[ -x "$CARGO" ] || exit 0

if ! FMT_OUT=$("$CARGO" fmt --manifest-path "$MANIFEST" --check 2>&1); then
  echo "cargo fmt --check に失敗しました。cargo fmt で整形してください" >&2
  printf '%s\n' "$FMT_OUT" | tail -40 >&2
  exit 2
fi

if ! CLIPPY_OUT=$("$CARGO" clippy --manifest-path "$MANIFEST" --all-targets -- -D warnings 2>&1); then
  echo "cargo clippy に失敗しました" >&2
  printf '%s\n' "$CLIPPY_OUT" | tail -40 >&2
  exit 2
fi

exit 0
