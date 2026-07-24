# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/yqi96/warranted/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/yqi96/warranted/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yqi96/warranted/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yqi96/warranted/releases/tag/v0.1.0
