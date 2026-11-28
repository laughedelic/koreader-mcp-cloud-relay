#!/usr/bin/env bash
# Test the KOReader plugin's offline memory against a local relay.
#
#   bun run dev                                  # in one terminal
#   test/plugin/run.sh /path/to/mcp.koplugin     # in another
#
# Needs luajit with luasocket, luasec and lua-cjson (on Debian/Ubuntu:
# apt install luajit lua-socket lua-sec lua-cjson) and Node 20 or newer.
# KOReader itself is not needed: its modules are replaced by test/plugin/stubs.
# Takes about two minutes.
set -euo pipefail

plugin=${1:?"usage: $0 /path/to/mcp.koplugin [relay URL]"}
relay=${2:-http://127.0.0.1:8787}
here=$(cd "$(dirname "$0")" && pwd)
flags=$(mktemp -d)
trap 'rm -rf "$flags"' EXIT

export LUA_PATH="$here/stubs/?.lua;$plugin/?.lua;;"
export RELAY_URL=$relay

echo "== snapshot building and large uploads"
luajit "$here/snapshot.lua" "$relay"

echo "== reader and AI app"
luajit "$here/reader.lua" "$flags" "$relay" &
reader=$!
node "$here/app.mjs" "$flags"
wait "$reader"
echo "== all passed"
