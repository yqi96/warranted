# SciFact review evaluation

This harness tests Warranted's production `review` path on prebuilt argument
graphs. It does not ask an agent to construct the graph. The builder creates the
proposition, attachments, warrant, and SQLite database deterministically through
the production service layer; the runner copies each fixture and invokes
`runReview` directly.

## Primary endpoint

The primary suite is a claim-level oracle-cited-abstracts binary adapter. Every
SciFact claim becomes exactly one target, and all of that claim's unique cited
abstracts (plus any evidence-only abstract, if present) are attached to the same
target. Claims are never expanded into claim–abstract pairs:

```text
target.content              = SciFact claim
target.evidence.attachments = ["evidence/<doc-id>.md", ...]
target.warrant              = one fixed label-independent principle
target.qualifier            = unestablished
```

The dev split contains 300 claim-level cases: 124 SUPPORT, 64 CONTRADICT, and
112 NOINFO. `goldLabel` in the frozen fixture manifest is the original SciFact
claim label and is retained only for provenance and subgroup reporting. It is
not the pass/fail label of the materialized graph: a source-SUPPORT claim can
still have an unrelated cited abstract attached as an asserted evidence edge.

The scoring label is therefore a separate `graphExpectedVerdict`. Every
materialized attachment is treated as an asserted evidence edge. Every
attachment must be relevant, and the attachment set must actually support the
claim's direction, entities or population, intervention or exposure, outcome,
quantity, and scope. Explicit contradiction, a truly unrelated attachment, or
a key unsupported detail makes the graph fail. Multiple attachments may jointly
supply the support.

One production `review` call produces both component verdicts. The benchmark
adapter maps them to one binary prediction:

```text
supported     iff Q1=pass and Q2=pass
not-supported otherwise
```

This is not the official SciFact three-way or retrieval leaderboard task. It
measures local attachment-grounded review after all cited abstracts are given.

An optional `q2-oracle` diagnostic creates one case per document-level
alternative gold rationale set for SUPPORT and CONTRADICT only. Rationale
sentences become direct evidence propositions at `certainly`, with their
abstract identity retained in the proposition content. NOINFO has no gold
rationale and is therefore absent from this diagnostic. Its expanded diagnostic
unit does not change the one-claim-one-case primary endpoint.

## Gold isolation and content locks

Reviewer-visible case directories contain only the project:

```text
project/
  evidence/<doc-id>.md
  evidence/<another-doc-id>.md
  .toulmin/graph.db
```

Gold labels, per-document rationale indices, manifests, results, and review configuration
remain outside the reviewer working directory. Case IDs and graph notes do not
contain labels. Each attachment and database is SHA-256 locked in the fixture
manifest; the live run locks that manifest and `results.jsonl`; scoring rechecks
the fixture files, archived databases, event payloads, audit files, and hashes.

The Agent SDK working directory is not an OS sandbox. This layout prevents
accidental gold leakage; a claim against an adversarial reviewer would require a
container or a path allow-list.

For every live case, the reviewer must complete a full `Read` of every
attachment in the verdict-producing attempt. Missing, partial, truncated, or
denied reads make the review unavailable and record no successful review event.
The trace proves that the tool delivered the attachment to the model; it cannot
prove that the model used every sentence in its reasoning.

## Build fixtures

Building has no model cost. A small deterministic fixture set:

```bash
bun run eval:scifact:build -- --per-label 2
```

The full primary dev suite:

```bash
bun run eval:scifact:build
```

Optional diagnostic:

```bash
bun run eval:scifact:build -- \
  --modes primary,q2-oracle \
  --per-label 20 \
  --seed 20260901 \
  --out-dir /tmp/scifact-fixtures
```

Output directories are never overwritten.

Fixture schema v2 keeps a legacy `expected.verdict` for compatibility. It maps
the SciFact source label mechanically (`SUPPORT -> pass`, otherwise `fail`) and
is not graph gold. The validator enforces this legacy mapping. A future builder
contract may change only under a new fixture schema version.

The audit layer independently derives a metadata-only `mechanicalGraphVerdict`
and records it alongside the semantic decision. That diagnostic is never used
as final gold. A release must first produce:

- a complete adjudications JSONL in fixture-manifest order;
- a consensus document that records the votes and final rule for every case;
- an adjudication bundle that hash-locks the fixture manifest, the exact
  mechanical and semantic policies, the adjudications JSONL, and the consensus.

Create the final overlay without changing the frozen fixture or graph:

```bash
bun run eval:scifact:audit-labels -- \
  --fixtures <fixture-manifest.json> \
  --bundle <adjudication-bundle.json> \
  --out <adjudicated-overlay.json>
```

`audit-labels` verifies every bundle hash, count, case ID, order, consensus
decision, and policy before writing. The overlay records the bundle,
adjudications, consensus, fixture, and policy provenance. The scorer repeats
the complete validation and rejects provisional, partial, reordered, or
unbundled overlays.

## Dry-run and live review

The runner is dry-run by default. It validates all fixture hashes but does not
load credentials or call a model:

```bash
bun run eval:scifact:run -- \
  --fixtures /tmp/scifact-fixtures/fixture-manifest.json
```

A bounded live smoke test requires explicit authorization and configuration:

```bash
bun run eval:scifact:run -- \
  --fixtures /tmp/scifact-fixtures/fixture-manifest.json \
  --limit 3 \
  --live \
  --review-config review.json
```

A live run of the entire selected manifest additionally requires `--all`.
There is no outer retry. The production parser may make one fallback attempt,
so dry-run reports both normal and worst-case call counts. The actual model that
produced each verdict is recorded; fallback results are not attributed to the
primary model.

Each case runs from a fresh private database copy. Success requires exactly one
new review event, unchanged evidence, a complete attachment-read trace, an audit
record, and agreement between the return value, event payload, and archived DB.

## Score

Scoring never calls a model and requires an explicit run directory plus the
fully adjudicated overlay:

```bash
bun run eval:scifact:score -- \
  --run-dir <run-directory> \
  --label-overlay <adjudicated-overlay.json>
```

Interrupted runs, missing cases, or reviewer errors are rejected by default.
`--allow-incomplete` preserves missing/error cases in the end-to-end denominator
and reports coverage separately; completed-only accuracy is labeled as such.

Outputs include:

- binary Accuracy, Macro-F1, graph-pass recall, graph-fail recall, and
  false-supported rate;
- `contradictGraphFailRecall` and `noInfoGraphFailRecall`: within each SciFact
  source subgroup, recall restricted to cases whose adjudicated
  `graphExpectedVerdict=fail`; source-negative cases adjudicated as graph pass
  belong to graph-pass recall instead and are excluded from these denominators;
- claim bootstrap 95% intervals for the primary suite;
- end-to-end accuracy, coverage, reviewer failure rate, and latency summaries;
- accepted/rejected finding protocol rates;
- independent attachment/verbatim/locator checks and gold-rationale quote hits;
  the latter excludes NOINFO and any other case without a gold rationale;
- per-case CSV with both source and graph labels, document IDs, Q1/Q2, combined
  verdict, and audit flags;
- `score-manifest.json`, which hash-locks the run manifest, results, optional
  recovery provenance, fixture manifest, overlay, adjudication bundle, summary,
  and per-case CSV.

The current Agent SDK audit does not expose token usage, so the scorer marks it
unavailable rather than estimating it. The matched direct-reviewer control from
the paper plan is a separate experiment and is not implemented by this Warranted
arm.

Generated fixtures, databases, audits, and scores live under
`experiments/evaluation/outputs/` by default and are ignored by Git.
