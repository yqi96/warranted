#!/usr/bin/env bash
# UserPromptSubmit hook — injects selected Toulmin nodes into Claude prompts
# Reads selection state from the running visualizer server (localhost:3456)

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=".toulmin/operation.log"
VIZ_BASE="http://localhost:3456"
TS=$(date '+%Y-%m-%d %H:%M:%S')

log() { echo "[$TS] viz-hook: $*" >> "$LOG"; }

log "hook fired (pwd=$(pwd))"

# Fetch current selection; if server is not running, log and exit silently
selection=$(curl -sf "${VIZ_BASE}/viz/selection" 2>/dev/null)
if [ $? -ne 0 ]; then
  log "server not reachable at ${VIZ_BASE} — skipping"
  exit 0
fi

log "selection response: $selection"

# Count selected nodes
node_count=$(echo "$selection" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(len(d.get('nodes', [])))
except Exception as e:
    import sys; print(0, file=sys.stderr)
    print(0)
" 2>>"$LOG")

log "node_count=$node_count"

if [ "$node_count" = "0" ]; then
  log "no nodes selected — skipping injection"
  exit 0
fi

# Fetch current db path and derive project root (strip /.toulmin/... suffix)
db_info=$(curl -sf "${VIZ_BASE}/viz/current-db" 2>/dev/null)
project_path=$(echo "$db_info" | python3 -c "
import sys, json, re
try:
    d = json.load(sys.stdin)
    p = d.get('path', '')
    p = re.sub(r'/\.toulmin(/.*)?$', '', p)
    print(p)
except Exception:
    print('')
" 2>/dev/null)

# Build node list
node_lines=$(echo "$selection" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    lines = []
    for n in d.get('nodes', []):
        ntype = str(n.get('type', '')).upper()
        content = str(n.get('content', ''))[:80]
        lines.append(f\"  Node #{n['id']} [{ntype}]: {content}\")
    print('\n'.join(lines))
except Exception:
    pass
" 2>/dev/null)

# Output additionalContext JSON
output=$(python3 -c "
import json, sys
project = sys.argv[1]
nodes = sys.argv[2]
ctx = '[Toulmin Visualizer Selection]\nProject: ' + project + '\n' + nodes
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'UserPromptSubmit',
        'additionalContext': ctx
    }
}))
" "$project_path" "$node_lines")

log "output: $output"
echo "$output"
