# Examples

Real paper-reproduction cases, each documented with an independent Warranted proposition graph.

A reproduction produces three kinds of files. We treat them differently so the repo stays small:

| Kind | Example | How it's stored | Why |
|------|---------|-----------------|-----|
| **Argument graph** | `.toulmin/graph.db` | Committed (normal git) | This is the authoritative artifact read by the current MCP server and visualizer. |
| **Input data** | `data/*.csv`, model weights | Git LFS (`data/**`) | Versioned but kept out of the main pack. Huge public datasets should be *linked* in `manifest.md`, not stored. |
| **Regenerable output** | `build/`, `outputs/`, LaTeX aux | Ignored | Re-runnable from the case. Never commit. |

## Getting the data

Cases use [Git LFS](https://git-lfs.com) for anything under a case's `data/` folder. Once per machine:

```bash
git lfs install
```

Then pull the actual files (a plain clone only fetches pointer stubs):

```bash
git lfs pull
```

> GitHub's free LFS quota is 1 GB storage / 1 GB bandwidth per month. For large public datasets, prefer linking the source in the case's `manifest.md` over committing the bytes.

## Adding a case

1. Copy the template: `cp -r _template examples/<paper-key>`
2. Put input data under `<paper-key>/data/` (auto-tracked by LFS).
3. Start Warranted with `--db-path examples/<paper-key>/.toulmin/graph.db`, then build the graph with the normal proposition tools. Keeping the database under `.toulmin/` makes attachment paths resolve from the case directory.
4. Stop the server cleanly before committing so SQLite checkpoints the WAL into `graph.db`.
5. Fill in `README.md` (the target proposition and qualifier, evidence, warrant, rebuttals, and what you found) and `manifest.md` (where the inputs came from).

Commit `.toulmin/graph.db`; `examples/.gitignore` explicitly keeps that file while excluding its transient WAL/SHM companions. The current 11-tool API has no graph-export command, so do not promise or invoke one. A case may additionally commit a JSON snapshot only when it includes and documents its own reproducible exporter.
