#!/usr/bin/env bash
# UserPromptSubmit hook — injects selected propositions into Claude prompts
# Reads selection state from the running visualizer server (localhost:3456)

VIZ_BASE="http://localhost:3456"

# Fetch current selection; if server is not running, exit silently
selection=$(curl -sf "${VIZ_BASE}/viz/selection" 2>/dev/null)
if [ $? -ne 0 ]; then
  exit 0
fi

# Count selected nodes
node_count=$(echo "$selection" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(len(d.get('nodes', [])))
except Exception as e:
    import sys; print(0, file=sys.stderr)
    print(0)
" 2>/dev/null)

if [ "$node_count" = "0" ]; then
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

# Build proposition list
node_lines=$(echo "$selection" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    lines = []
    for n in d.get('nodes', []):
        qualifier = str(n.get('qualifier', 'unestablished')).upper()
        content = str(n.get('content', ''))[:80]
        lines.append(f\"  Proposition #{n['id']} [{qualifier}]: {content}\")
    print('\n'.join(lines))
except Exception:
    pass
" 2>/dev/null)

# Output additionalContext JSON
output=$(python3 -c "
import json, sys
project = sys.argv[1]
nodes = sys.argv[2]
ctx = '[Visualizer Selection]\nProject: ' + project + '\n' + nodes
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'UserPromptSubmit',
        'additionalContext': ctx
    }
}))
" "$project_path" "$node_lines")

echo "$output"
