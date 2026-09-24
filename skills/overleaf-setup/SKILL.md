---
name: overleaf-setup
description: Set up Overleaf synchronization for a LaTeX project with Warranted citation enforcement. Installs/authenticates leaf, binds the local directory to an Overleaf project, and provides an explicit push command with prop_N citations expanded.
---

## Goal

Connect a local LaTeX directory to Overleaf and provide a reusable synchronization command. Run the command when synchronization is requested; setup does not enable automatic end-of-turn pushes.

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

## Step 5 — Prepare the synchronization command

Determine `SKILL_DIR` from this skill's location and `DB_PATH` from the active task's `.toulmin/graph.db`. Use absolute paths.

Resolve the placeholders below to those paths:

```bash
uv run "SKILL_DIR/scripts/overleaf-push.py" \
  --dir "LATEX_DIR" \
  --db "DB_PATH" \
  --require-prop-cites
```

The existing script validates citations and expands `prop_N` keys before pushing staged source. Run it if the user requested a synchronization to this project; otherwise provide the resolved command for later use.

---

## Step 6 — Done

Report the configured Overleaf project, local directory, resolved synchronization command, and whether a push actually succeeded. Explain that future synchronization uses this explicit command. No restart is needed.

---

## Error handling reference

| Error | Fix |
|-------|-----|
| `leaf.toml not found` on push | Re-run Step 4 |
| CSRF / 401 / 403 | Session expired — re-run Step 2 |
| HTTP 422 | Re-run Step 4 |
| `~/.olauth` missing | Not logged in — re-run Step 2 |
| Proposition IDs not in map | The proposition has no PDF attached — attach the paper file in Warranted before the next edit |
| Proposition does not exist | Repoint `prop_N` to an existing proposition; never create a replacement merely to preserve an obsolete number |
| Only non-PDF attachments | Attach the original paper PDF. Notes, tables, and extracted text may remain attached but cannot provide a bibliography key |
| Attached PDF is missing | Restore the file at the reported project-relative path, or update the proposition attachment before retrying |
| PDF stem absent from `.bib` | Rename the PDF so its stem equals the intended BibTeX key, or add the matching entry to the LaTeX project's `.bib` file |
| Several PDF attachments | Supported: `\cite{prop_N}` expands to every distinct PDF stem. Every PDF must exist and every stem must appear in a project `.bib` file |
| Several attachments including notes | Supported: non-PDF attachments remain audit evidence but are ignored for citation expansion; at least one valid original-paper PDF is still required |
| `legacy citation key statement_N` | The key points into the archived Statement graph. Re-identify the finding it cited, create or reuse a proposition, and repoint the key — never map by number |
