# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Scenario-based documentation: `The Argument Graph` (concepts), `Reproducing a Paper`, and `Writing a Paper` guides, in English and Simplified Chinese.
- A `Documentation` section in the README linking the reading path.
- This changelog.

### Changed
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

[Unreleased]: https://github.com/yqi96/warranted/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/yqi96/warranted/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yqi96/warranted/releases/tag/v0.1.0
