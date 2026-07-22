---
name: overleaf-sync
description: One-time setup skill. Configures automatic Overleaf push for a LaTeX directory — installs leaf, authenticates, inits the project, and writes the auto-push hook to settings.local.json. After setup, every .tex edit in the configured directory triggers a push automatically. Run this skill once; restart Claude Code when done.
---

## Goal

Configure automatic Overleaf push so that every `.tex` edit triggers a push without further agent involvement. The skill ends when the hook is written to `settings.local.json` and the user has been told to restart Claude Code.

---

## Step 1 — Install

```bash
uv tool install overleaf-for-agents
```

Verify:

```bash
leaf --version
```

---

## Step 2 — Authenticate

```bash
leaf login
```

A browser window opens. Tell the user: "Log in to Overleaf and wait for your project dashboard to appear. Let me know when ready."

Verify after confirmation:

```bash
leaf list
```

**Fallback** — if `leaf login` fails (no Chrome / CDP error):
1. Ask the user to open https://www.overleaf.com, log in, then go to DevTools → Application → Cookies → copy the value of `overleaf_session2` (starts with `s%3A`)
2. Write the value to `~/.olauth`
3. Retry `leaf list`

---

## Step 3 — Choose or create project, and local directory

Ask the user whether they want to sync to an existing project or create a new one.

**Existing project**: run `leaf list`, show the output, ask which project to use. Record `PROJECT_ID` (24-char hex).

**New project**: ask for a project name, then run:
```bash
leaf create "NAME"
```
Record `PROJECT_ID` from the output.

Also ask which local directory contains the LaTeX files. Record `LATEX_DIR` (absolute path).

---

## Step 4 — Init

```bash
leaf init --project PROJECT_ID --dir LATEX_DIR
```

This writes `leaf.toml` into `LATEX_DIR`. The push script copies it into staging on each run.

---

## Step 5 — Write the hook

Determine `SKILL_DIR` (absolute path to `${CLAUDE_PLUGIN_ROOT}/skills/overleaf-sync`) and `DB_PATH` (absolute path to `.toulmin/argument.db`).

Merge the following into `.claude/settings.local.json`, preserving any existing hooks:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "uv run SKILL_DIR/scripts/overleaf-push.py --dir LATEX_DIR --db DB_PATH",
        "timeout": 120,
        "statusMessage": "Pushing to Overleaf..."
      }]
    }]
  }
}
```

Replace `LATEX_DIR`, `SKILL_DIR`, and `DB_PATH` with the actual absolute paths before writing.

The hook fires once when Claude Code stops. The script skips the push automatically if no files changed since the last push (tracked via `LATEX_DIR/.overleaf-last-push`).

---

## Step 6 — Done

Tell the user:

> "Hook configured. **Please restart Claude Code** to activate it — hooks only take effect after a restart, and restarting also clears this setup context.
> After restart, every time Claude Code stops it will push any changed files under `LATEX_DIR` to Overleaf automatically. Sessions with no file changes are skipped."

The skill is complete. Do not proceed further.

---

## Error handling reference

| Error | Fix |
|-------|-----|
| `leaf.toml not found` on push | Re-run Step 4 |
| CSRF / 401 / 403 | Session expired — re-run Step 2 |
| HTTP 422 | Re-run Step 4 |
| `~/.olauth` missing | Not logged in — re-run Step 2 |
| Ground IDs not in map | Ground has no attachment — attach paper file in Warranted before the next edit |
