#!/bin/sh
set -eu

binary=${1:?usage: smoke-debian-warden-stdio.sh /path/to/keel}
smoke_root=$(mktemp -d)
input_fifo=$smoke_root/input
output_file=$smoke_root/output
warden_pid=

cleanup() {
  exec 3>&- 2>/dev/null || true
  if [ -n "$warden_pid" ]; then
    kill "$warden_pid" 2>/dev/null || true
    wait "$warden_pid" 2>/dev/null || true
  fi
  rm -rf -- "$smoke_root"
}
trap cleanup EXIT HUP INT TERM

mkfifo "$input_fifo"
KEEL_INTERNAL_WARDEN_STDIO=1 "$binary" <"$input_fifo" >"$output_file" 2>&1 &
warden_pid=$!
exec 3>"$input_fifo"

printf '%s\n' \
  '{"jsonrpc":"2.0","id":"h1","method":"warden.hello","params":{"kernelVersion":"0.0.0","protocolVersion":"1.0.0"}}' \
  >&3

attempt=0
while ! grep -Fq '"wardenVersion"' "$output_file"; do
  if ! kill -0 "$warden_pid" 2>/dev/null; then
    printf 'warden exited before hello response:\n'
    cat "$output_file"
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 200 ]; then
    printf 'timed out waiting for warden hello response:\n'
    cat "$output_file"
    exit 1
  fi
  sleep 0.05
done

# Shutdown is a control-plane admission barrier. Send it only after hello has been accepted so the
# smoke does not ask the Warden to discard the very queued request whose response it is checking.
printf '%s\n' \
  '{"jsonrpc":"2.0","id":"s1","method":"warden.shutdown","params":{}}' \
  >&3
exec 3>&-

set +e
wait "$warden_pid"
warden_status=$?
set -e
warden_pid=
cat "$output_file"
exit "$warden_status"
