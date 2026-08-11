# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — behavior changes that affect existing graphs and existing call sites

See the [Upgrading to 0.5.0](README.md#upgrading-to-050) section for the three actions that surface these.

**Graph-state changes (a full `compile_arguments` after upgrading surfaces them):**

- **Claim-type Grounds are now judged by their own status.** A Claim used as a Ground counts as satisfied only when its own `status` is `supported` or `disputed`. Previously compile treated every claim-type Ground as satisfied unconditionally while the `update_node(status=)` gate treated it as never satisfied — the two disagreed, and the practical effect was that no Claim above the bottom layer of a multi-layer graph could be marked `supported`. Existing graphs where a `supported` Claim sits on a `proposed` or `refuted` sub-Claim will start reporting an error on the next compile. Sitting on a `disputed` sub-Claim does **not** error: a recorded evidence conflict is a settled end state, and the upper layer draws scope from it rather than truth value.
- **Claim status changes now propagate upward as a status recheck, not a recompile.** Whether a Claim counts as verified evidence for the layer above depends on its own status, so changing it can pull the basis out from under the Claims above it. Each of those Claims is rechecked against the gate its *current* status requires, and only the ones that genuinely fail are reverted to `proposed`; a Claim that still has another Warrant with all Grounds verified keeps its verdict. The compile records are deliberately left `passed` — no node's content or relations changed, so the logic review would return the same answer. Warnings name the proximate cause at each hop ("Claim #child no longer counts as verified evidence"), not the original node several hops down. Restating a status that is already set changes nothing.
- **`disputed` and `refuted` now require a verified Rebuttal**, symmetrically with `supported` requiring verified Grounds. A `pending` Rebuttal records a conflict nobody has checked, and it no longer moves a Claim. Creating the Rebuttal is unchanged; it is the status call that is gated. Existing graphs carrying `disputed`/`refuted` on unverified Rebuttals are not rewritten — the gate applies to the next write.
- **Withdrawing a Statement's verification now reverts the Claims that rested on it.** Setting a `verified` Statement back to `pending` previously left an unbacked `supported` Claim standing. The same recheck-and-revert path described above now runs, with the compile record again left `passed`: re-verify the Statement and the status can be set back without recompiling.
- **A compile that does not pass now takes the Claim's verdict with it.** After `compile_arguments` runs, a Claim left without a `passed` compile record has a `supported`/`disputed`/`refuted` status reverted to `proposed`, and the call reports it. This enforces the rule that already governed the write path — a non-`proposed` status requires a passed compile — at every moment rather than only at the instant of the write, so "settle the Claim first, compile later and fail" no longer leaves a combination the write gate itself forbids. It covers `failed`, `stale`, and the case of no record at all. Reverts propagate upward the same way a status change does: the demoted Claim no longer counts as verified evidence, the layer above is rechecked against its own gate, and only genuine failures revert. A Claim already at `proposed` is untouched, and a `passed` compile changes no status.
- **The compile verdict lives in one place.** `data.compile_status` is gone from the Claim node; the verdict — `passed`, `failed`, `stale` — is only in `compile_state`. The external surface is unchanged: `list_claims(compile_status=)` still filters, and node output still reports `compile_status`, both derived from `compile_state`. But the field also left the Merkle hash input, which is correct (a review outcome is not part of the argument's form) and has one upgrade consequence: every existing Claim's argument hash changes, so the first `compile_arguments` after upgrading re-runs the review instead of short-circuiting on `no-change`.

**Call-habit changes (these fail on the write path; compile can never surface them):**

- `create_statement`'s `source` is now **required** — it no longer defaults to `observed`.
- `source="literature"` now **requires attachments** at creation. This was already promised in the tool's own parameter description and simply was not enforced.
- Every path in `attachments` must resolve from the review working directory. URLs therefore do not qualify.
- When the review infrastructure itself errors, the Statement now falls back to `verification="pending"` and reports the error, instead of silently resting at `verified`.
- `update_node(attachments=[])` against an already-`verified` Statement now errors. It previously succeeded silently, leaving a verified Statement with no evidence.

**Response-shape changes (read paths return different fields):**

- `get_argument` returns **one statement shape for all three roles**. Ground, Backing and Rebuttal are a single node type; only the Ground shape used to carry `source`/`verification`, so a caller rejected by the verified-Rebuttal gate could not see from the output which Rebuttal was still pending. Both keys are now present on every role (optional, because 0.4-era nodes never wrote them and the migration does not invent them). Rebuttal lines carry the target's id, a Warrant's own view now renders the Rebuttals attacking it, and the `rebuttals` field on a statement-rooted view is gone — `create_statement` only accepts a Claim or Warrant as a Rebuttal target, so that field could never be non-empty.

**Review configuration changes (these affect how the server is started, not the graph):**

- The reviewer subprocess now runs isolated (`settingSources: []`) and no longer reads `~/.claude/settings.json` or any project settings. The file passed to `--review-config` must therefore be self-sufficient: a deployment that worked because the gateway address happened to sit in the user's own settings must now put that address in the config's `baseUrl`. Environment variables from the shell that started the server are still inherited.
- `debounceMs` is removed from the review config. Nothing read it.
- `maxTurns` and `maxConcurrency` are validated as positive integers when the config loads, and an invalid value warns and falls back to the default instead of being accepted. `maxConcurrency: 0` previously set the concurrency gate to zero width, which hung the first review permanently with no request ever sent.

### Added

- `mapLimit` concurrency cap (`src/concurrency.ts`) shared by compile, `verify_statements`, and `create_statements`. Default 4 concurrent review sessions, overridable via the `WARRANTED_REVIEW_CONCURRENCY` environment variable. A bare `compile_arguments` over 25 Claims previously fired roughly 78 Agent SDK calls at once.

### Fixed

- `create_statement(rebuttal_for=)` now invalidates the target Claim's compiled state, matching `update_node(rebuttal_ids={add})`. Previously the same graph operation invalidated at one entry point and not the other, so a Claim could be marked `disputed` on the strength of a compile that never saw the Rebuttal.
- Compile's no-change short-circuit now runs `structuralPreCheck` and `structuralQualityCheck` before returning. Reverting a verified Ground to `pending` does not change the argument hash, so the short-circuit previously made the "grounds may have been reverted to pending after status was set" check unreachable — the Claim rested at `supported` and compile reported `no-change` indefinitely.
- Compile now reports claim-type Grounds by their actual status (`has no verdict yet` / `is refuted` / `is disputed`) instead of skipping them entirely or reporting a flat "not supported". These are deterministic structural findings; the logic reviewer is deliberately not shown a Ground's status (see below).
- `delete_node` now invalidates every Claim that depended on a *collaterally* deleted node, not just the one named in the call. A Statement that was a Backing of one Warrant and a Ground of another was deleted as the first Warrant's collateral, silently stripped from the second Warrant's ground set by `ON DELETE CASCADE`, and left that Warrant's Claim resting at `supported`/`passed` over a ground set that no longer existed. The returned warnings now name every Claim invalidated this way.
- Collateral deletion now keeps a Warrant's `data.ground_ids` and the `warrant_grounds` rows in agreement. `ON DELETE CASCADE` removed only the relation row, leaving a dangling id in the JSON that compile reads — which then reported `Ground #N ... not found` on a graph the delete had already handled. This applies to deleted Claims as well as Statements, since a Claim can occupy the Ground role.
- A `delete_node` that fails no longer leaves the pre-delete invalidation behind. `delete_node(claim_id)` without `cascade=true` is rejected, but the invalidation had already reverted that Claim's `status` to `proposed` and dropped its `compile_state` — a call that reported an error had silently downgraded the graph. Invalidation and deletion are now one transaction.
- `update_node(ground_ids={add})` now runs the circular-chain-reasoning check. A support cycle rejected by `create_warrant` was accepted by adding the same claim-type Ground afterwards.
- **The configured credentials now actually reach the reviewer.** `apiKey` was required — a config without it disabled reviews — and documented as being handed to the Agent SDK, but nothing in `src/` passed it: the SDK spawns a subprocess, so what authenticated every review was the ambient shell environment, and the deployment only worked because the two configurations happened to agree. `apiKey` and `baseUrl` are now passed explicitly (on top of the inherited environment, taking precedence over it), and the credential is set as both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` because first-party endpoints read the first and gateways commonly accept only the second.
- The reviewer subprocess no longer writes session transcripts into the user's `~/.claude` history. Review sessions are machine-to-machine calls; they were accumulating there as if they were the user's own conversations.
- `compile_arguments` no longer fails outright when no review model is configured. It ran the structural checks, then returned "Review not configured" as an error — which made `passed` unreachable, and with it every non-`proposed` status in the whole graph. It now passes on the structural checks alone and attaches a warning saying the logic was not examined and how to configure a model.
- `compile_arguments` reports what actually happened instead of guessing. Every marked-stale outcome was rendered as "incomplete structure", which was false whenever the structure was complete; the outcome is now named directly (structure-incomplete / check-failed / passed-unreviewed / auto-reviewed / no-change). Relatedly, "marked stale" is now reported only when a row really changed — the underlying update is scoped to `verdict = 'passed'`, so whether anything moved depends on the stored verdict, not on the call site.
- Neither reviewer is shown the answer it is being asked for. The chain reviewer no longer receives a Ground's `status` or `verification` (whether a Claim is settled, and how a Ground's credibility weighs against a Rebuttal's, is the main agent's call, not the logic reviewer's), and the statement-evidence reviewer no longer receives the `verification` value whose correctness is the entire question it is answering. In both cases the field was removed from the prompt's input type rather than the reviewer being told to ignore it. The chain reviewer still sees a Ground's *type*: resting on a lower conclusion is a different inference shape from resting on raw evidence, and shape is its remit.
- A deleted Claim's `compile_state` row no longer outlives it, and can no longer be inherited. `compile_state.claim_id` had no foreign key, the table rebuild resets `sqlite_sequence` so ids do get reused, and the gate only asks whether the verdict is `passed` — so a brand-new Claim could read a deleted Claim's `passed` record as its own and be treated as compiled when it never was. Legacy databases get the constraint through a one-time rebuild.
- The `nodes` table rebuild is now a single transaction with rollback on failure, and no longer fires on freshly created databases. It previously ran with no transaction, so a mid-way failure left the table replaced and its FTS triggers gone — after which the database opened, accepted writes, and silently indexed nothing. The `PRAGMA foreign_keys = OFF` is now issued outside the transaction, because SQLite ignores that pragma inside one and the rebuild's `DROP TABLE nodes` would cascade child rows away.
- A Warrant's ground set has one record. It was stored twice — as `warrant_grounds` rows and as a `ground_ids` array inside the Warrant's data blob — and the two review layers read different halves, so they could disagree about what the argument even is: `create_warrant(ground_ids=[S1,S1,S2])` gave the review prompt three Grounds and `get_argument` two, and a no-op `update_node(ground_ids: {})` moved the argument hash. The `ground_ids` input parameter and the `groundIds` output field are unchanged.
- `toulmin-explorer` and `literature-extractor` can now use their MCP tools. Their tool allowlists named the server-side tool names, but a plugin's bundled server is namespaced as `mcp__plugin_<plugin>_<server>__<tool>`, so those entries resolved to nothing: `toulmin-explorer` listed only such names and would refuse to launch, and `literature-extractor` launched with `Read`/`Grep` alone, silently missing `create_statements` — its entire deliverable.
- Three prompts no longer describe behavior the system does not have. `toulmin-explorer` taught the four-node ontology the Statement refactor replaced and omitted `statement` from its node-type list, so an explorer asked to find evidence could not issue the query that returns it. `cite-review` instructed a `disputed` status call that its own constraints forbid and the gate would reject. `toulmin-researcher` had the verification causality backwards — marking `verified` is what *triggers* the review, not something permitted after it passes — and now also states that a `disputed`/`refuted` verdict needs a verified Rebuttal.
- Skill descriptions are trigger signal again. Three of them spent most of their length restating their own internal pipeline, which bears nothing on the only decision a reader makes at that moment: whether to enter the skill. What is left is the situations a user actually arrives with and the boundary against the nearest neighbouring skill.
- **`get_stats` no longer reports a wrong Ground count.** The `Grounds:` line counted statements carrying a `source` field rather than statements attached to a Warrant. That was approximately right while `source` was optional; 0.5.0 made it required, so the condition became true of every Statement and the line degenerated into "how many Statements exist" — Backings, Rebuttals and Statements attached to nothing were all counted as Grounds, while a Claim serving as a Ground was not counted at all. The output printed two Ground totals, the wrong one first. The superseded lines (`Grounds:` with its `by_source`/`by_verification` breakdown, `Backings:`, `Rebuttals:`, and the duplicate `Claims:`) are removed rather than repaired: `Roles:` already answers the same question from the relation tables, which is where role membership is actually recorded, and `list_statements` answers the source/verification breakdown with node lines instead of a bare number. `rebuttals.by_target_type` stays — whether a Rebuttal attacks a Claim or a Warrant is a distribution nothing else reports. The three role counts now share one implementation, so "which node types may hold this role" and "what counts as verified" each have a single definition; the previous per-role SQL tested `verification != 'verified'`, which is true of every Claim row and would have counted every claim-type Backing or Rebuttal as permanently pending once Claims are allowed to hold those roles.
- The advice to "set `ANTHROPIC_API_KEY`" is gone from the three places users read it. It could not work: `--review-config <file>` is the only way to enable review, and neither the argument parser nor the config loader reads any environment variable.

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
