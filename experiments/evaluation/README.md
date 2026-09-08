# Evaluation harnesses

This directory contains evaluation adapters and runners that exercise production
Warranted code without putting benchmark-specific logic in the MCP server.

- `common/` contains fixture and manifest utilities shared across benchmarks.
- `scifact/` evaluates the independent `review` path on prebuilt SciFact graphs.
- `vitaminc/` evaluates dependency-change handling with bidirectional replays.
- `outputs/` contains generated databases, model outputs, audits, and scores and
  is intentionally ignored by Git.

Downloaded upstream data remains under `experiments/benchmarks/` and is described
by `experiments/BENCHMARKS.md`. Evaluation code must not edit those pinned assets.
