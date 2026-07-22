---
name: overleaf-setup
description: One-time setup skill. Configures automatic Overleaf push for a LaTeX directory.
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
        "command": "uv run SKILL_DIR/scripts/overleaf-push.py --dir LATEX_DIR --db DB_PATH --require-ground-cites",
        "timeout": 120,
        "statusMessage": "Checking citations and pushing to Overleaf..."
      }]
    }]
  }
}
```

Replace `LATEX_DIR`, `SKILL_DIR`, and `DB_PATH` with the actual absolute paths before writing.

---

## Step 6 — Done

Tell the user:

> "Hook configured. **Please restart Claude Code** to activate it — hooks only take effect after a restart, and restarting also clears this setup context.
> After restart, Overleaf will be updated automatically at the end of each conversation turn. Turns where no files under `LATEX_DIR` changed are skipped."

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
