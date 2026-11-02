#!/usr/bin/env bash
# 啟動雪隧車道伺服器（背景執行）。會先依 pidfile 停掉前一個實例。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
PIDFILE=data/server.pid
LOG=data/server.log
export PORT="${PORT:-3410}"

if [[ -f "$PIDFILE" ]]; then
  OLD=$(cat "$PIDFILE" 2>/dev/null || true)
  if [[ -n "$OLD" ]] && kill -0 "$OLD" 2>/dev/null && grep -q "server/index.js" "/proc/$OLD/cmdline" 2>/dev/null; then
    echo "停止先前的實例 (pid $OLD)"
    kill "$OLD" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$OLD" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$OLD" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

setsid nohup node server/index.js >>"$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
sleep 0.5
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "已啟動 pid $(cat "$PIDFILE") → http://127.0.0.1:${PORT}  （log: $LOG）"
else
  echo "啟動失敗，請查看 $LOG" >&2
  rm -f "$PIDFILE"
  exit 1
fi
