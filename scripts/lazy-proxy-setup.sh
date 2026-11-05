#!/usr/bin/env bash
# Lazy egress, called once by run-with-model-fallback.mjs when Default started on Fusion with
# WARP skipped (WARP_LAZY=1) and the chain now reaches a free OpenCode model. Same order as the
# startup step: WARP IPv6, else the DataImpulse relay, else the runner network. Restarts
# `opencode serve` behind the chosen 127.0.0.1 relay (the session lives on disk).
# dataimpulse-proxy.sh stdout carries ::add-mask:: lines; it is discarded (not step stdout).
# Exit 0 = WARP, 3 = DataImpulse, 1 = unchanged (runner network).
set -uo pipefail
set +x
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${OPENCODE_BIN:?}" "${OPENCODE_WEB_DIR:?}"
tmp="${RUNNER_TEMP:-/tmp}"
record() { LAZY_RESULT="$1" node -e 'const fs=require("fs"),f=process.env.OPENCODE_WEB_DIR+"/warp-status.json";let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
fs.writeFileSync(f,JSON.stringify({...s,lazy:process.env.LAZY_RESULT}))' 2>/dev/null || true; }
proxy="$(bash "$here/warp-proxy.sh" "$tmp/warp" "$OPENCODE_BIN" 2>&2 | tail -n 1)"
if [[ "$proxy" == http://127.0.0.1:* ]] && bash "$here/start-opencode-serve.sh" "$proxy" --wait; then
  echo "lazy proxy: WARP ready" >&2; record warp; exit 0
fi
work="$tmp/dataimpulse-lazy"
if bash "$here/dataimpulse-proxy.sh" "$work" "$OPENCODE_BIN" "$OPENCODE_WEB_DIR" > /dev/null \
  && proxy="$(cat "$work/proxy-url" 2>/dev/null)" && [[ "$proxy" == http://127.0.0.1:* ]] \
  && bash "$here/start-opencode-serve.sh" "$proxy" --wait; then
  echo "lazy proxy: DataImpulse ready" >&2; record dataimpulse; exit 3
fi
bash "$here/start-opencode-serve.sh" "" --wait >/dev/null 2>&1 || true
echo "lazy proxy: unavailable; runner network" >&2; record none; exit 1
