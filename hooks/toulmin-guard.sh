#!/usr/bin/env bash
# Toulmin guard: prevent agents from ignoring compile_arguments
# Reads JSON from stdin (Claude Code PreToolUse hook format)
# State file: .toulmin/.hook-state (single integer line)

STATE_FILE=".toulmin/.hook-state"
SOFT_THRESHOLD=5
HARD_THRESHOLD=10

# Read stdin JSON
INPUT=$(cat)
if ! command -v python3 &>/dev/null; then exit 0; fi
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")

# Reset counter on compile_arguments (matches standalone and plugin-installed naming)
# standalone: mcp__toulmin__compile_arguments
# plugin:     mcp__plugin_warranted_toulmin__compile_arguments
if [[ "$TOOL_NAME" == *__compile_arguments && "$TOOL_NAME" == mcp__*toulmin* ]]; then
  echo "0" > "$STATE_FILE"
  exit 0
fi

# All other Toulmin tools: pass silently (no counter change)
if [[ "$TOOL_NAME" == mcp__*toulmin*__* ]]; then
  exit 0
fi

# Non-Toulmin tools: increment counter
COUNTER=0
if [[ -f "$STATE_FILE" ]]; then
  COUNTER=$(cat "$STATE_FILE" 2>/dev/null || echo "0")
fi
COUNTER=$((COUNTER + 1))
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null
echo "$COUNTER" > "$STATE_FILE"

# Query stale count from DB (if sqlite3 and DB exist)
STALE_COUNT=0
if command -v sqlite3 &>/dev/null && [[ -f ".toulmin/argument.db" ]]; then
  STALE_COUNT=$(sqlite3 .toulmin/argument.db \
    "SELECT COUNT(*) FROM nodes WHERE type='claim' AND json_extract(data,'$.stale') IS NOT 0 AND json_extract(data,'$.stale') IS NOT NULL" 2>/dev/null || echo "0")
fi

# No stale claims: always pass silently
if [[ "$STALE_COUNT" -eq 0 ]]; then
  exit 0
fi

# K < SOFT_THRESHOLD: silent pass
if [[ "$COUNTER" -lt "$SOFT_THRESHOLD" ]]; then
  exit 0
fi

# K in [SOFT_THRESHOLD, HARD_THRESHOLD): soft warning via JSON additionalContext (exit 0 = allow)
if [[ "$COUNTER" -lt "$HARD_THRESHOLD" ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"Hint: %d Claim(s) have pending argument chain review. Call compile_arguments soon."}}' "$STALE_COUNT"
  exit 0
fi

# K >= HARD_THRESHOLD: hard block via stderr (exit 2 = block)
echo "Blocked: ${STALE_COUNT} Claim(s) require argument review before continuing. Call compile_arguments now." >&2
exit 2
