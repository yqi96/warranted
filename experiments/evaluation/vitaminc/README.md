# VitaminC temporal-revalidation evaluation

This harness tests one narrow mechanism: after a proposition's referenced
evidence changes, does Warranted expose the stale dependency, and does the
normal research agent autonomously inspect and correctly repair the judgment?

The v2 formal pilot is pinned to seed `20260901`, two cases per direction
(four cases total), and contains two independently scored natural transitions:

- `SUP_TO_REF`: the old evidence supports the claim; the revised evidence refutes it.
- `REF_TO_SUP`: the old evidence refutes the claim; the revised evidence supports it.

The adapter never manufactures the second direction by reversing a pair. It
uses only the dataset's original `_1 -> _2` and `_3 -> _4` order. The formal
fixture builder uses real Wikipedia revisions, equal direction quotas, and
disjoint revision clusters. Synthetic revisions are excluded because the dev
split contains no comparable synthetic `REF_TO_SUP` stratum.

## What this pilot can and cannot show

It can measure:

- whether the seeded graph raises the intended downstream `R2` and no confounding warning;
- post-update label and relation accuracy;
- stale-use rate;
- whether the agent read the affected argument before writing;
- whether it rebaselined the claim and ended with a structurally clean graph;
- process failures, turns, tokens, latency, and reported cost.

Every selected case is a verdict-changing revision. Therefore this pilot does
**not** establish selective-revalidation cost savings or warning false-positive
rate. Those claims require a separately frozen label-preserving/control set and
an Always-revalidate comparison. `No-maintenance` is included only as a
deterministic boundary baseline.

## Agent under test

The live treatment is the repository's primary agent definition:

`agents/toulmin-researcher.md`

It runs through Claude Code with a required full model ID and explicit effort.
The evaluator passes only this user prompt:

> 请继续处理当前研究，并告诉我结论。

The prompt does not mention revisions, warnings, labels, or required graph
edits. Built-in filesystem, shell, browser, session-resume, and slash-command
tools are disabled. The agent receives only a clean-room copy of the graph,
`evidence/current.txt`, and seven Toulmin operations. Claude `--bare` also
disables hooks, auto-memory, background prefetch, keychain/OAuth access, and
automatic `CLAUDE.md` discovery.

The child process receives an explicit environment allowlist for execution,
locale, TLS/proxy, and the configured Claude provider. The process artifact
records only the passed environment key names, never credential values.

## Environment

Required:

- Bun and the repository dependencies (`bun install`);
- the downloaded VitaminC fact-verification and revision-flagging files;
- for live runs, Claude Code and a full model ID;
- `ANTHROPIC_API_KEY`, or an explicitly configured Bedrock, Claude Platform on
  AWS, Vertex, or Foundry provider. OAuth/keychain auth is intentionally
  unavailable in clean-room mode.

The formal runner is pinned to the official `dev` fact-verification and
flagging SHA-256 values. Before any formal live call, it re-hashes both files,
rebuilds the adapter/candidate audits and eligible population, repeats the
seeded selection, verifies every private replay-to-opaque-ID mapping, and
reconstructs each expected graph/attachment for semantic equality so a
self-resealed input cannot smuggle evaluator gold into the clean room.
Environment-configured custom API base URLs, headers, and HTTP(S) proxies are
rejected; the selected direct/Bedrock/Claude-Platform-on-AWS/Vertex/Foundry
provider, resolved Claude executable path, binary hash, and CLI/stream versions
are sealed in the run artifacts.

A live evaluation also requires the fixture to have been prepared from a clean,
committed checkout. Development dry-runs may use a dirty tree, but live mode
rejects such a manifest; commit the final evaluator implementation and prepare
the fixtures again before collecting study results.

The default input files are:

```text
experiments/benchmarks/vitaminc/data/vitaminc/dev.jsonl
experiments/benchmarks/vitaminc/data/vitaminc_flagging/dev.jsonl
```

Run all deterministic checks first:

```bash
bun test experiments/evaluation/vitaminc
bunx tsc --noEmit
```

## 1. Freeze fixtures

Fixture preparation and model execution are separate commands. Preparation
creates public projects plus a sealed private gold mapping:

```bash
bun experiments/evaluation/vitaminc/prepare.ts \
  --split dev \
  --per-direction 2 \
  --seed 20260901 \
  --out-dir /tmp/vitaminc-pilot
```

Each public project contains only:

```text
public/case-<opaque>/project/.toulmin/graph.db
public/case-<opaque>/project/evidence/current.txt
```

The graph is frozen immediately after `e0 -> e1`. At handoff it contains
exactly one pending warning: `R2` on the claim. Direction, labels, source IDs,
and gold text mapping stay under `private/` and are never copied into an agent
clean room.

Preparation also seals the public manifest, the private mapping, every graph
and evidence attachment, the fixture-building implementation, and an adapter
audit from raw input rows through temporal-pair and duplicate exclusions.
Formal live mode rejects any other seed or per-direction sample size; changing
those values requires an explicit protocol/version change. Development dry-runs
may still be prepared separately while iterating.

## 2. Validate with a dry run

Dry-run is the default and makes zero model calls:

```bash
bun experiments/evaluation/vitaminc/run.ts \
  --fixtures /tmp/vitaminc-pilot/fixture-manifest.json \
  --run-dir /tmp/vitaminc-pilot-dry
```

This rechecks fixture hashes, copies and seals each database, exercises the
offline scorer, and materializes the expected No-maintenance result.

## 3. Run an external-provider diagnostic

An Anthropic-compatible endpoint may be exercised only as a non-primary
diagnostic. The settings file must be a private regular JSON file. The runner
loads only its top-level `model` and a narrow allowlist of `env` keys; hooks,
plugins, permissions, agent teams, and every credential value are excluded
from the archived artifacts. Use explicit public case IDs for an odd-sized
smoke test:

```bash
bun experiments/evaluation/vitaminc/run.ts \
  --fixtures /tmp/vitaminc-pilot/fixture-manifest.json \
  --run-dir /tmp/vitaminc-deepseek-diagnostic \
  --live \
  --case case-<opaque-1> \
  --case case-<opaque-2> \
  --case case-<opaque-3> \
  --diagnostic-settings "$HOME/.claude/settings.json.deepseek" \
  --claude-path /absolute/path/to/claude \
  --claude-sha256 <observed-cli-sha256> \
  --effort max \
  --max-turns 20 \
  --max-budget-usd 2 \
  --max-total-budget-usd 6
```

This mode may run from a dirty development checkout, but always writes
`mode=external-provider-diagnostic`, keeps the formal primary fields null, and
places observations only in the diagnostic section. Formal Claude runs still
reject custom endpoints and non-Claude model IDs.

## 4. Run a bounded live pilot

Live mode may incur cost. Use a small independently prepared fixture set first:

```bash
export ANTHROPIC_API_KEY='...'

# Resolve this from the trusted Claude installation, record it before the run,
# and substitute the resulting lowercase digest below.
command -v claude
sha256sum /absolute/path/to/claude

bun experiments/evaluation/vitaminc/run.ts \
  --fixtures /tmp/vitaminc-pilot/fixture-manifest.json \
  --run-dir /tmp/vitaminc-pilot-live \
  --live \
  --all \
  --claude-path /absolute/path/to/claude \
  --claude-sha256 <pre-registered-sha256> \
  --model claude-opus-4-6 \
  --effort max \
  --max-turns 12 \
  --timeout 600 \
  --max-budget-usd 2 \
  --max-total-budget-usd 8
```

For a bounded subset of a larger fixture set, use `--limit <n>` or repeat
`--case case-<opaque>`. Automatic `--limit` pilots must be even and are sampled
equally from both directions; use an explicit `--case` for a one-case smoke
test. Selecting all fixtures or more than 20 cases requires `--all`, even if a
very large `--limit` happens to cover the full set. Model aliases such as
`opus` are rejected. A subset live run is always labeled as pilot/smoke-test
diagnostics and cannot populate the primary estimate; the primary result
requires the complete sealed fixture set in manifest order.

Formal live mode resolves the executable, compares it with the supplied
pre-registered SHA-256 before the first call, and checks the same binary again
before sealing results. This pins the chosen executable but is not publisher
code-signing: the evaluator host and the source used to approve that digest
remain part of the trusted computing base.

The per-case budget has a non-overridable $2 ceiling. The runner also refuses
to start when the selected cases' worst-case spend exceeds
`--max-total-budget-usd` (default $20). A systemic first-case failure, any
later authentication/MCP/model/tool/output failure, two consecutive timeouts
or max-turn failures, or a reported batch-budget breach stops the remainder.
A successful formal process must report a non-negative per-case cost no greater
than its cap; missing cost data is an invalid process rather than silent budget
undercoverage. Its reported turn count must likewise be an integer from 1
through the configured `--max-turns` cap.

## Outputs

Each run writes:

- `run-manifest.json`: fixture, prompt, model, effort, tool surface, source
  hashes, and completion status;
- `results.jsonl`: one intention-to-treat process and graph score per case;
- `summary.json`: overall, direction-stratified, and revision-type summaries,
  plus the deterministic No-maintenance boundary;
- `cases/<opaque>/`: raw stream, stderr, paired tool trace, answer, process
  record, final database, before/after graph dumps, and offline score.

Every raw stream/trace/process file and every graph/score artifact is recorded
with a SHA-256 in `results.jsonl`; the final manifest then seals the results and
summary hashes.

Only a non-aborted formal live run over the complete sealed corpus in its
manifest order publishes a primary `overall` estimate. Aborted runs are marked
`incomplete-not-for-primary-analysis`; completed subsets are marked
`partial-live-not-for-primary-analysis`. Both keep observations only under a
clearly labeled diagnostic section. Deterministic fake-CLI integration runs are
likewise marked `test-harness` and can never populate the primary estimate. If
normal artifact archival fails after a paid call, the complete anonymous
scratch is retained under the case's `recovery/` directory.

A successful process must also contain exactly one initialization event and one
terminal result event, advertise only the sealed tool surface, and pair every
tool call with exactly one later result. Malformed or extra tool activity is an
invalid process even when the final database happens to look correct.

`autonomousSuccess` is deliberately strict. It requires a completed process, a
successful contextual read before the first successful write, a post-seed
claim rejudgment, the exact gold relation with no extra edges, the correct
post-update label, no protocol violation, and no pending structural warning.
