#!/usr/bin/env bash
set -euo pipefail

# ビルドした .app が実際に起動できるかを確認する。
# cargo tauri build --debug 実行後、CI から呼び出される想定。

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq が見つかりません" >&2
  exit 1
fi

# notes.json 2 件の判定は初回起動でしか成立しないため、実ユーザーの $HOME から分離する
SMOKE_HOME="$(mktemp -d)"
export HOME="$SMOKE_HOME"

APP_BIN="src-tauri/target/debug/bundle/macos/Hattotto.app/Contents/MacOS/hattotto"
CAPTURE_FILE="$(mktemp -t hattotto-smoke-capture)"
APP_SUPPORT_DIR="$HOME/Library/Application Support/com.hattotto.app"
LOG_DIR="$HOME/Library/Logs/com.hattotto.app"

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: 実行バイナリが見つかりません: $APP_BIN" >&2
  exit 1
fi

echo "起動確認: $APP_BIN をバックグラウンドで起動する"
"$APP_BIN" >"$CAPTURE_FILE" 2>&1 &
APP_PID=$!

echo "起動確認: 初回起動のウェルカム付箋保存とログ出力を待つため 10 秒待機する"
sleep 10

echo "起動確認: プロセスが生存しているか確認する"
if ! kill -0 "$APP_PID" 2>/dev/null; then
  echo "ERROR: アプリが 10 秒以内に終了しました" >&2
  echo "--- capture ---" >&2
  cat "$CAPTURE_FILE" >&2
  exit 1
fi

FAILED=0

echo "起動確認: notes.json に初回起動のウェルカム付箋 2 件があるか確認する"
NOTES_FILE="$APP_SUPPORT_DIR/notes.json"
if [[ ! -f "$NOTES_FILE" ]]; then
  echo "ERROR: notes.json が生成されていません: $NOTES_FILE" >&2
  FAILED=1
elif [[ "$(jq 'length' "$NOTES_FILE")" != "2" ]]; then
  echo "ERROR: notes.json の付箋数が 2 件ではありません" >&2
  cat "$NOTES_FILE" >&2
  FAILED=1
fi

echo "起動確認: capture に ERROR ログが無いか確認する"
if grep -n "ERROR" "$CAPTURE_FILE" >/dev/null 2>&1; then
  echo "ERROR: capture に ERROR ログがあります" >&2
  grep -n "ERROR" "$CAPTURE_FILE" >&2
  FAILED=1
fi

echo "起動確認: capture にロガー初期化失敗が無いか確認する"
if grep -nE "Failed to (attach|initialize) logger" "$CAPTURE_FILE" >/dev/null 2>&1; then
  echo "ERROR: ロガーの初期化に失敗しています" >&2
  grep -nE "Failed to (attach|initialize) logger" "$CAPTURE_FILE" >&2
  FAILED=1
fi

echo "起動確認: ログファイルが生成され ERROR が無いか確認する"
if [[ ! -d "$LOG_DIR" ]] || [[ -z "$(ls -A "$LOG_DIR" 2>/dev/null)" ]]; then
  echo "ERROR: ログファイルが生成されていません: $LOG_DIR" >&2
  FAILED=1
else
  if grep -rn "ERROR" "$LOG_DIR" >/dev/null 2>&1; then
    echo "ERROR: ログファイルに ERROR 行があります" >&2
    grep -rn "ERROR" "$LOG_DIR" >&2
    FAILED=1
  fi
fi

if [[ "$FAILED" != "0" ]]; then
  echo "--- capture ---" >&2
  cat "$CAPTURE_FILE" >&2
  echo "--- logs ---" >&2
  if [[ -d "$LOG_DIR" ]]; then
    cat "$LOG_DIR"/* >&2 2>/dev/null || true
  fi
  kill -TERM "$APP_PID" 2>/dev/null || true
  exit 1
fi

echo "起動確認: プロセスを終了して終了コードを確認する"
kill -TERM "$APP_PID" || true
set +e
wait "$APP_PID"
EXIT_CODE=$?
set -e

if [[ "$EXIT_CODE" != "0" && "$EXIT_CODE" != "143" ]]; then
  echo "ERROR: 終了コードが 0 でも 143 でもありません: $EXIT_CODE" >&2
  cat "$CAPTURE_FILE" >&2
  exit 1
fi

echo "起動確認: 成功"
