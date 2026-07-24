# Examples

Real paper-reproduction cases, each verified with an independent Warranted argument graph.

A reproduction produces three kinds of files. We treat them differently so the repo stays small:

| Kind | Example | How it's stored | Why |
|------|---------|-----------------|-----|
| **Argument graph** | `graph.json` | Committed (normal git) | This *is* the deliverable — small, diffable, the whole point. |
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
3. Build the argument graph, then export it to `<paper-key>/graph.json`.
4. Fill in `README.md` (what the paper claims, what you found) and `manifest.md` (where the inputs came from).

The exported graph is committed even though the repo root ignores `*.db` — see `examples/.gitignore`. Prefer `graph.json` over `graph.db` when the exporter allows: it diffs cleanly in review.
