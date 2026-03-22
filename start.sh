#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3391}"

echo "╔══════════════════════════════════════════════════╗"
echo "║        Claude Dashboard - Starting...            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Start the Node.js server
echo "[*] Starting dashboard server on port $PORT..."
cd "$DIR"
node server.js &
SERVER_PID=$!
echo "[+] Server PID: $SERVER_PID"

# Wait for server to be ready
sleep 1
if curl -sf http://localhost:$PORT/ > /dev/null 2>&1; then
  echo "[+] Dashboard is live at http://localhost:$PORT"
else
  echo "[!] Server may still be starting..."
fi

# If TUNNEL_TOKEN is set, start cloudflared with named tunnel
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  echo "[*] Starting cloudflared tunnel (named)..."
  "$DIR/cloudflared" tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" &
  TUNNEL_PID=$!
  echo "[+] Tunnel PID: $TUNNEL_PID"
elif [ "${QUICK_TUNNEL:-}" = "1" ]; then
  echo "[*] Starting cloudflared quick tunnel..."
  "$DIR/cloudflared" tunnel --no-autoupdate --url "http://localhost:$PORT" &
  TUNNEL_PID=$!
  echo "[+] Quick tunnel PID: $TUNNEL_PID"
else
  echo "[i] No tunnel configured. Set TUNNEL_TOKEN or QUICK_TUNNEL=1"
  echo "[i] Dashboard available at: http://localhost:$PORT"
fi

echo ""
echo "Press Ctrl+C to stop"

# Trap to clean up
cleanup() {
  echo ""
  echo "[*] Shutting down..."
  kill $SERVER_PID 2>/dev/null || true
  [ -n "${TUNNEL_PID:-}" ] && kill $TUNNEL_PID 2>/dev/null || true
  wait
  echo "[+] Done"
}
trap cleanup INT TERM

# Wait for server process
wait $SERVER_PID
