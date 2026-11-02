#!/usr/bin/env bash
# 停止由 scripts/start.sh 啟動的伺服器（只處理 pidfile 記錄的程序）。
set -euo pipefail
cd "$(dirname "$0")/.."
PIDFILE=data/server.pid
if [[ ! -f "$PIDFILE" ]]; then
  echo "沒有執行中的實例（找不到 $PIDFILE）"
  exit 0
fi
PID=$(cat "$PIDFILE" 2>/dev/null || true)
if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null && grep -q "server/index.js" "/proc/$PID/cmdline" 2>/dev/null; then
  kill "$PID"
  for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$PID" 2>/dev/null || true
  echo "已停止 pid $PID"
else
  echo "pid $PID 已不在執行"
fi
rm -f "$PIDFILE"
