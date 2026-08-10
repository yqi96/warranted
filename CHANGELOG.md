# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — behavior changes that affect existing graphs and existing call sites

See the [Upgrading to 0.5.0](README.md#upgrading-to-050) section for the two actions that surface these.

**Graph-state changes (a full `compile_arguments` after upgrading surfaces them):**

- **Claim-type Grounds are now judged by their own status.** A Claim used as a Ground counts as satisfied only when its own `status` is `supported` or `disputed`. Previously compile treated every claim-type Ground as satisfied unconditionally while the `update_node(status=)` gate treated it as never satisfied — the two disagreed, and the practical effect was that no Claim above the bottom layer of a multi-layer graph could be marked `supported`. Existing graphs where a `supported` Claim sits on a `proposed` or `refuted` sub-Claim will start reporting an error on the next compile. Sitting on a `disputed` sub-Claim does **not** error: a recorded evidence conflict is a settled end state, and the upper layer draws scope from it rather than truth value.
- **Claim status changes now propagate upward.** Changing a Claim's status invalidates the compiled state of every Claim above it (the Claim itself is exempt, unless the same call also changed `content` or a relation). Consequence for ordering: "compile every layer first, then settle statuses bottom-up" no longer works — settling a lower status invalidates the upper compile, and setting the upper status then reports `argument has not been compiled or is stale`. The working order is layer-by-layer interleaving: compile a layer, settle a layer, move up. Restating a status that is already set changes nothing and triggers no recompile.

**Call-habit changes (these fail on the write path; compile can never surface them):**

- `create_statement`'s `source` is now **required** — it no longer defaults to `observed`.
- `source="literature"` now **requires attachments** at creation. This was already promised in the tool's own parameter description and simply was not enforced.
- Every path in `attachments` must resolve from the review working directory. URLs therefore do not qualify.
- When the review infrastructure itself errors, the Statement now falls back to `verification="pending"` and reports the error, instead of silently resting at `verified`.
- `update_node(attachments=[])` against an already-`verified` Statement now errors. It previously succeeded silently, leaving a verified Statement with no evidence.

### Added

- `mapLimit` concurrency cap (`src/concurrency.ts`) shared by compile, `verify_statements`, and `create_statements`. Default 4 concurrent review sessions, overridable via the `WARRANTED_REVIEW_CONCURRENCY` environment variable. A bare `compile_arguments` over 25 Claims previously fired roughly 78 Agent SDK calls at once.

### Fixed

- `create_statement(rebuttal_for=)` now invalidates the target Claim's compiled state, matching `update_node(rebuttal_ids={add})`. Previously the same graph operation invalidated at one entry point and not the other, so a Claim could be marked `disputed` on the strength of a compile that never saw the Rebuttal.
- Compile's no-change short-circuit now runs `structuralPreCheck` and `structuralQualityCheck` before returning. Reverting a verified Ground to `pending` does not change the argument hash, so the short-circuit previously made the "grounds may have been reverted to pending after status was set" check unreachable — the Claim rested at `supported` and compile reported `no-change` indefinitely.
- Compile now reports claim-type Grounds by their actual status (`has no verdict yet` / `is refuted` / `is disputed`) instead of skipping them entirely or reporting a flat "not supported". The chain-review prompt renders each Ground's type and status, and its factually-true precondition now opens an explicit exception for claim-type Grounds so the reviewer can judge what the Warrant draws from a contested lower conclusion.
- `delete_node` now invalidates every Claim that depended on a *collaterally* deleted node, not just the one named in the call. A Statement that was a Backing of one Warrant and a Ground of another was deleted as the first Warrant's collateral, silently stripped from the second Warrant's ground set by `ON DELETE CASCADE`, and left that Warrant's Claim resting at `supported`/`passed` over a ground set that no longer existed. The returned warnings now name every Claim invalidated this way.
- Collateral deletion now keeps a Warrant's `data.ground_ids` and the `warrant_grounds` rows in agreement. `ON DELETE CASCADE` removed only the relation row, leaving a dangling id in the JSON that compile reads — which then reported `Ground #N ... not found` on a graph the delete had already handled. This applies to deleted Claims as well as Statements, since a Claim can occupy the Ground role.
- A `delete_node` that fails no longer leaves the pre-delete invalidation behind. `delete_node(claim_id)` without `cascade=true` is rejected, but the invalidation had already reverted that Claim's `status` to `proposed` and dropped its `compile_state` — a call that reported an error had silently downgraded the graph. Invalidation and deletion are now one transaction.
- `update_node(ground_ids={add})` now runs the circular-chain-reasoning check. A support cycle rejected by `create_warrant` was accepted by adding the same claim-type Ground afterwards.

## [0.4.3] - 2026-08-03

### Changed
- `GroundSource` enum collapsed from `{literature, observed, hypothesis}` to `{literature, observed}` — `source` is an evidence-type axis, not a provenance-origin axis. Paper-reproduction statements (self-produced or independent reproduction) are now `source="observed"`, with `verification="pending"` alone carrying the not-yet-confirmed state. Compile checks B2/B6/C2/C3 (hypothesis-specific) collapsed into their literature/observed equivalents B1/C1. An idempotent DB migration converts existing `hypothesis` rows to `observed`. Docs, skills, and agent prompts (`paper-reproduce`, `toulmin-researcher`, `rigor-auditor`, `code-experimenter`) updated to match.
- `review-llm.ts`: `callAgent()` no longer bypasses permissions for the headless compile/review Agent SDK call — `permissionMode` switched from `bypassPermissions` to `dontAsk`. Denied tool calls are now logged via `console.warn` instead of being silently dropped, since `allowedTools` already whitelists the only tools (`Read`/`Glob`/`Grep`) this agent needs.

### Fixed
- Compile: vacuous-truth bug where a Warrant whose grounds are all claim-type (filtered down to an empty grounds list) spuriously tripped the "all grounds pending" check.

### Removed
- `auto-research` and `academic-writing` skills moved out of the shipped `skills/` directory back into `drafts/` — not ready for release, iteration continues there.

## [0.4.2] - 2026-08-03

### Added
- `auto-research` skill: open-ended autonomous research channel that generates its own falsifiable Claims from provided data and references, with a Framing router splitting goal-only (strong) from question/hypothesis-given (weak) inputs.
- `rigor-auditor` agent: completion gate for autonomous research — judges the whole effort on exhaustiveness and outcome value before a result can close the task, biased toward "not done".

### Changed
- `discrepancy-auditor`: barrier claims now split into reflexively-rejected excuses (code/complexity/planning gaps — never real barriers) versus claims that must be investigated with tools before classification; `REAL_BARRIER` criteria generalized beyond algorithm/data unavailability.
- `toulmin-researcher`: added a Toulmin-layer Operations section naming the four atomic operations (Create Claim, Acquire Statement, State Warrant, Compile-and-settle) plus a task-to-composition table for translating incoming requests into graph operations.
- Docs (`README.md`, `README.zh-CN.md`, `docs/en`, `docs/zh-CN`, wiki) further aligned to the three-node-type/statement-role model; `paper-reproduce` independence hardened — any paper-produced artifact used as verification evidence voids the verification.
- `.gitignore`: now ignores all of `.omc` except `.omc/wiki`.

### Fixed
- Visualizer: role filter now falls back to a Statement's `primary_role` when `data.roles` is empty, so statements without an explicit roles array remain visible under role filtering.

## [0.4.1] - 2026-07-30

### Added
- `code-optimizer` agent: object-layer agent for targeted code optimization; identifies hot paths, benchmarks, and implements improvements within a bounded scope without touching the Toulmin layer.

### Changed
- `toulmin-researcher`: delegation guidance sharpened — explicit bounded-task contract required for each subagent dispatch (obligation, target nodes, allowed sources, required report format); experiment traceability section added (unexpected results must enter the graph before the obligation is closed).
- Skills and agents aligned to v0.4.0 statement model; `\cite{ground_N}` citation keys renamed to `\cite{statement_N}` throughout skills, agents, and `overleaf-push.py`.

### Fixed
- `update_node`: `ground_ids` writes now update both `warrant_grounds` relation table and `data.ground_ids` JSON field — dual-storage divergence that silently broke `get_argument` results (Bugs 1/2/3).
- Visualizer: `drawNodeShape` now handles tree-display types `ground`, `backing`, and `rebuttal` correctly — previously fell through to the default branch.
- Visualizer: pan, zoom, and node positions now persist across SSE reconnects — state is restored from `nodePositionMap` after each graph refresh.
- `update_node`: modifying `verification` or `source` on a Statement no longer triggers `invalidateCompiledClaims` — only structural changes (`content`, `ground_ids`, `backing_ids`, `rebuttal_ids`) invalidate compiled Claims.

## [0.4.0] - 2026-07-28

### Added
- `create_statement`: unified Statement creator that replaces `create_ground`, `create_backing`, and `create_rebuttal`. Accepts `source`, `verification`, `attachments`, and an optional `rebuttal_for` attachment to simultaneously place the Statement in the Rebuttal role.
- `update_node`: `backing_ids {add, remove}` and `rebuttal_ids {add, remove}` incremental update fields, replacing the need for separate creation tools.
- Direct Claim-as-Ground: Claim nodes can now be passed directly in `ground_ids`, eliminating the `ref_claim_id` proxy-node pattern. The DB migration `migrateRefClaimIdData` converts legacy proxy nodes on startup.

### Changed
- `list_grounds` renamed to `list_statements` — the tool now lists all Statement-type nodes regardless of role.
- Three-type node model: `nodes.type` is now `claim | warrant | statement`. Ground, Backing, and Rebuttal are **roles** a Statement plays, determined by relation tables (`warrant_grounds`, `warrant_backings`, `rebuttal_targets`), not a stored type field.
- Compile chain-reviewer: rebuttal targets are now derived from `rebuttal_targets` relation table instead of stale `data.target_id` JSON field.
- Statement terminology propagated through all content strings, tool descriptions, and review system.

### Removed
- `create_ground`, `create_backing`, `create_rebuttal` MCP tools — replaced by `create_statement`.

## [0.3.0] - 2026-07-25

### Added
- `academic-writing` skill: the manuscript-writing umbrella that projects graph-backed arguments into paper prose across Introduction, Related Work, Results, Discussion, Methods, figures, tables, source data, and citation handles, with per-section reference files.
- `cite-review` skill: audits citation faithfulness in LaTeX; extracts every `\cite{ground_N}`, delegates per-cite checks in parallel, reasons across the reports, then corrects the text and reconciles the graph.
- `code-experimenter` and `discrepancy-auditor` object-layer agents. `code-experimenter` executes bounded coding, reproduction, and experiment tasks and returns evidence reports. `discrepancy-auditor` challenges a negative outcome before it enters the graph — both an unexpected mismatch about to become a Rebuttal and a claimed blocker about to halt an obligation.
- Paper-reproduction example scaffold under `examples/` (case template + manifest), with a `.gitattributes` Git LFS rule for `examples/**/data/**`.
- Scenario-based documentation: `The Argument Graph` (concepts), `Reproducing a Paper`, and `Writing a Paper` guides, in English and Simplified Chinese.
- A `Documentation` section in the README linking the reading path.
- This changelog.

### Changed
- Sharpened the `toulmin-researcher` "object-driven restructuring" anti-pattern: the prohibition now targets concealment (revising so a contradiction disappears) rather than all structural change, so author-led Claim revision is legitimate under a visibility test. Individual tasks may still impose stricter rules (reproduction fixes Claims verbatim).
- `paper-reproduce`: delegates object-layer work to the `code-experimenter` and `discrepancy-auditor` agents rather than inlining execution and audit methodology; the discrepancy audit now also covers claimed blockers (the former `declare-barrier` skill, merged into `discrepancy-auditor` as a barrier-audit mode).
- `literature-survey`: made the paragraph↔Claim coupling explicit, symmetric to the citation↔Ground coupling.
- Restructured `docs/` by language (`en/`, `zh-CN/`) with `reference/` and `assets/` folders; added bidirectional language switchers across all docs.
- Moved the Chinese README to the repository root as `README.zh-CN.md`.

## [0.2.0] - 2026-07-22

### Added
- `overleaf-setup` skill (setup wizard + auto-push pipeline; links a local LaTeX directory to an Overleaf project via a Stop hook).
- `literature-survey` skill: grounds external findings in the graph and drafts LaTeX with `\cite{ground_N}` citations, maintaining a `.bib` file.
- Citation enforcement in the Overleaf hook (only `\cite{ground_N}` keys are accepted).
- Literature-source Grounds: definition review is skipped, the attachment requirement is relaxed, and pending-ground hints are differentiated by source type.
- `get_node` tool; `list_grounds` (renamed from `list_ground`) with source/verification filters.
- Auto-sync of reference-Ground verification with the referenced Claim's status.

### Changed
- Renamed skill `overleaf-sync` → `overleaf-setup`.

### Fixed
- `invalidateCompiledClaims` now reverts Claim status to `proposed` when the argument chain is modified.
- Guard `saveReviewFile` calls when the review directory is null.
- Expand `ref_claim` Ground content during chain review.

## [0.1.0] - 2026-07-19

### Added
- Initial **Warranted** release (rebranded from `toulmin-mcp`).
- Claude Code plugin packaging with marketplace support.
- Visualizer: multi-node selection, box/pan modes, double-click detail panel, selection glow.
- `UserPromptSubmit` hook that injects the current node selection as context.
- Bilingual README and a known-working dependency versions snapshot.

[Unreleased]: https://github.com/yqi96/warranted/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/yqi96/warranted/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/yqi96/warranted/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/yqi96/warranted/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yqi96/warranted/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yqi96/warranted/releases/tag/v0.1.0
