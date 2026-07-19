#!/usr/bin/env bash
# Ensure dependencies are installed before starting the MCP server
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$PLUGIN_ROOT" && bun install --frozen-lockfile 2>/dev/null)
exec bun "$PLUGIN_ROOT/src/index.ts" "$@"
