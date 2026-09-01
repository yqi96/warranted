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
112 NOINFO. The manifest retains the original three labels for audit and
subgroup reporting. Binary scoring treats SUPPORT as positive and combines
CONTRADICT and NOINFO as negative; the reviewer is not required to distinguish
the two reasons for a negative verdict.

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

Scoring never calls a model and requires an explicit run directory:

```bash
bun run eval:scifact:score -- --run-dir <run-directory>
```

Interrupted runs, missing cases, or reviewer errors are rejected by default.
`--allow-incomplete` preserves missing/error cases in the end-to-end denominator
and reports coverage separately; completed-only accuracy is labeled as such.

Outputs include:

- binary Accuracy, Macro-F1, support recall, combined-negative recall, and
  false-supported rate, plus separate CONTRADICT and NOINFO rejection recall;
- claim bootstrap 95% intervals for the primary suite;
- end-to-end accuracy, coverage, reviewer failure rate, and latency summaries;
- accepted/rejected finding protocol rates;
- independent attachment/verbatim/locator checks and gold-rationale quote hits;
  the latter excludes NOINFO and any other case without a gold rationale;
- per-case CSV with claim, document IDs, Q1/Q2, combined verdict, and audit flags.

The current Agent SDK audit does not expose token usage, so the scorer marks it
unavailable rather than estimating it. The matched direct-reviewer control from
the paper plan is a separate experiment and is not implemented by this Warranted
arm.

Generated fixtures, databases, audits, and scores live under
`experiments/evaluation/outputs/` by default and are ignored by Git.
