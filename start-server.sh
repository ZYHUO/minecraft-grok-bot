#!/usr/bin/env bash
# Start / stop Paper Minecraft server (offline) for Grok Bot multi-player control.
# Usage:
#   ./start-server.sh          # background start
#   ./start-server.sh --fg     # foreground
#   ./start-server.sh --stop   # stop cleanly
#   ./start-server.sh --status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
LOG_DIR="$ROOT/logs"
PID_FILE="$LOG_DIR/server.pid"          # wrapper (auto-restart loop)
JAVA_PID_FILE="$LOG_DIR/server-java.pid" # actual java process
LOG_FILE="$LOG_DIR/server.log"

MIN_RAM="${MIN_RAM:-1G}"
MAX_RAM="${MAX_RAM:-4G}"
AUTO_RESTART="${AUTO_RESTART:-1}"

mkdir -p "$LOG_DIR" "$SERVER_DIR"

is_pid_alive() {
  local p="${1:-}"
  [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null
}

# Kill Paper java by PID file, then fall back to pattern match under SERVER_DIR.
stop_java() {
  local jp=""
  if [[ -f "$JAVA_PID_FILE" ]]; then
    jp="$(cat "$JAVA_PID_FILE" 2>/dev/null || true)"
  fi
  if is_pid_alive "$jp"; then
    echo "[server] Stopping java pid=$jp ..."
    kill "$jp" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      is_pid_alive "$jp" || break
      sleep 0.5
    done
    if is_pid_alive "$jp"; then
      echo "[server] Force kill java pid=$jp"
      kill -9 "$jp" 2>/dev/null || true
    fi
  fi
  # Fallback: any paper.jar java still running from this install
  local extra
  extra="$(pgrep -f "java.*${SERVER_DIR}/paper.jar" 2>/dev/null || true)"
  if [[ -z "$extra" ]]; then
    extra="$(pgrep -f 'java.*paper\.jar' 2>/dev/null || true)"
  fi
  if [[ -n "$extra" ]]; then
    echo "[server] Stopping leftover paper java: $extra"
    # shellcheck disable=SC2086
    kill $extra 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -9 $extra 2>/dev/null || true
  fi
  rm -f "$JAVA_PID_FILE"
}

stop_wrapper() {
  local wp=""
  if [[ -f "$PID_FILE" ]]; then
    wp="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  if is_pid_alive "$wp"; then
    echo "[server] Stopping wrapper pid=$wp ..."
    kill "$wp" 2>/dev/null || true
    sleep 0.5
    kill -9 "$wp" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

cmd_stop() {
  # Disable auto-restart first by killing wrapper, then java
  stop_wrapper
  stop_java
  echo "[server] Stopped."
}

cmd_status() {
  local wp jp
  wp="$(cat "$PID_FILE" 2>/dev/null || true)"
  jp="$(cat "$JAVA_PID_FILE" 2>/dev/null || true)"
  echo "wrapper_pid=${wp:-none} alive=$(is_pid_alive "${wp:-}" && echo yes || echo no)"
  echo "java_pid=${jp:-none} alive=$(is_pid_alive "${jp:-}" && echo yes || echo no)"
  pgrep -af 'paper\.jar' 2>/dev/null || echo "(no paper.jar process)"
}

if [[ "${1:-}" == "--stop" ]]; then
  cmd_stop
  exit 0
fi
if [[ "${1:-}" == "--status" ]]; then
  cmd_status
  exit 0
fi

if ! command -v java >/dev/null 2>&1; then
  echo "[server] ERROR: java not found. Install OpenJDK 21:"
  echo "  sudo apt-get update && sudo apt-get install -y openjdk-21-jre-headless"
  exit 1
fi

if [[ ! -f "$SERVER_DIR/paper.jar" ]]; then
  echo "[server] paper.jar missing — downloading Paper 1.20.4 ..."
  bash "$SERVER_DIR/download-paper.sh"
fi

[[ -f "$SERVER_DIR/eula.txt" ]] || echo "eula=true" > "$SERVER_DIR/eula.txt"
if [[ ! -f "$SERVER_DIR/server.properties" ]]; then
  echo "[server] ERROR: server.properties missing"
  exit 1
fi

# Already running?
if [[ -f "$JAVA_PID_FILE" ]]; then
  OLD_JP="$(cat "$JAVA_PID_FILE" 2>/dev/null || true)"
  if is_pid_alive "$OLD_JP"; then
    echo "[server] Already running (java pid $OLD_JP). Stop with: $0 --stop"
    exit 0
  fi
fi
if [[ -f "$PID_FILE" ]]; then
  OLD_WP="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_pid_alive "$OLD_WP"; then
    echo "[server] Wrapper alive (pid $OLD_WP) but java missing — cleaning and restarting"
    stop_wrapper
    stop_java
  else
    rm -f "$PID_FILE"
  fi
fi

cd "$SERVER_DIR"

run_once() {
  echo "[server] Starting Paper (Xms=$MIN_RAM Xmx=$MAX_RAM) ..."
  # shellcheck disable=SC2086
  java -Xms"$MIN_RAM" -Xmx"$MAX_RAM" \
    -XX:+UseG1GC \
    -XX:+ParallelRefProcEnabled \
    -XX:MaxGCPauseMillis=200 \
    -XX:+UnlockExperimentalVMOptions \
    -XX:+DisableExplicitGC \
    -XX:+AlwaysPreTouch \
    -jar paper.jar --nogui &
  local jpid=$!
  echo "$jpid" > "$JAVA_PID_FILE"
  echo "[server] java pid=$jpid" >> "$LOG_FILE"
  wait "$jpid"
  local code=$?
  rm -f "$JAVA_PID_FILE"
  return $code
}

if [[ "${1:-}" == "--fg" ]]; then
  # Foreground: still track java pid for --stop from another shell
  run_once
  exit $?
fi

# Background + optional auto-restart (wrapper writes its own PID)
(
  # Ensure killing this wrapper does not leave us ignoring signals forever
  trap 'exit 0' TERM INT
  while true; do
    echo "===== $(date -Is) server start =====" >> "$LOG_FILE"
    set +e
    run_once >> "$LOG_FILE" 2>&1
    CODE=$?
    set -e
    echo "===== $(date -Is) server exit code=$CODE =====" >> "$LOG_FILE"
    if [[ "$AUTO_RESTART" != "1" ]]; then
      break
    fi
    # If wrapper is being stopped, exit loop
    echo "[server] Restarting in 5s ..." >> "$LOG_FILE"
    sleep 5 || break
  done
  rm -f "$PID_FILE"
) &
echo $! > "$PID_FILE"

echo "[server] Started in background"
echo "  wrapper pid: $(cat "$PID_FILE")"
echo "  java pid:    $(cat "$JAVA_PID_FILE" 2>/dev/null || echo '(starting…)')"
echo "  log:         $LOG_FILE"
echo "  address:     127.0.0.1:25565 (online-mode=false)"
echo "  stop:        $0 --stop"
echo "  status:      $0 --status"
