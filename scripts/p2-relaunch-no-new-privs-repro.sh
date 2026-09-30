#!/bin/bash
# Starts Conn from source, presses Restart now through its IPC, and checks the
# relaunched main process. NoNewPrivs=1 makes the kernel ignore the setuid bit on
# chrome-sandbox, and on Ubuntu 24.04 an installed build then dies with
# "FATAL:zygote_host_impl_linux.cc(207)] Check failed: . : Invalid argument (22)".
# --no-sandbox keeps this dev run itself alive so the flag can be read.
ROOT=${CONN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
UD=$(mktemp -d /tmp/conn-relaunch-XXXXXX)
PORT=${PORT:-$((20000 + RANDOM % 20000))}
ELECTRON=$ROOT/node_modules/electron/dist/electron

main_pid() {
  pgrep -f -- "--user-data-dir=$UD" | while read -r p; do
    tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- "--type=" || echo "$p"
  done | head -1
}
nnp() { awk '/^NoNewPrivs/ {print $2}' "/proc/$1/status" 2>/dev/null; }
cleanup() { pkill -f -- "--user-data-dir=$UD"; sleep 1; rm -rf "$UD"; }
trap cleanup EXIT

"$ELECTRON" "$ROOT" --no-sandbox --remote-debugging-port="$PORT" --user-data-dir="$UD" >/dev/null 2>&1 &
for _ in $(seq 30); do curl -s --max-time 2 "localhost:$PORT/json/list" | grep -q '"page"' && break; sleep 1; done
sleep 2
before=$(main_pid)

node --input-type=module -e "
const list = await (await fetch('http://localhost:$PORT/json/list')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.conn.updates.relaunch()' } }));
await new Promise((r) => setTimeout(r, 500));
process.exit(0);
"

after=
for _ in $(seq 40); do
  after=$(main_pid)
  [ -n "$after" ] && [ "$after" != "$before" ] && break
  sleep 0.5
done
sleep 2

if [ -z "$after" ] || [ "$after" = "$before" ]; then
  echo "FAIL relaunch started a new main process (before=$before after=$after)"; exit 1
fi
echo "PASS relaunch started a new main process ($before -> $after)"
if [ "$(nnp "$after")" = 0 ]; then
  echo "PASS relaunched Conn can use the setuid sandbox (NoNewPrivs=0)"
else
  echo "FAIL relaunched Conn has NoNewPrivs=$(nnp "$after"), so chrome-sandbox cannot start"; exit 1
fi
