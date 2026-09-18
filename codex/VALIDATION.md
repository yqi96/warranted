# Codex adapter validation — guidance

Validated locally on 2026-09-18 with Codex CLI 0.155.0, Bun 1.3.14 and Python 3.12.

- Parent identity: `python3 codex/prepare.py --verify` passed. All original tracked files are byte-identical to the parent recorded in `adapter.json`; only `codex/` is added.
- Prompt identity: complete agent file and frontmatter-stripped body SHA-256 passed. A captured native Codex Responses request contains the exact body as developer instructions. Codex built-in instructions remain intact.
- Adapter unit checks: 5 passed, including TOML/path quoting, treatment selection, prompt preservation, fresh-state enforcement, source-change rejection and keeping reviewer secrets out of the task/configuration copies.
- Existing core suite: **354 passed, 0 failed**, using `bun test ./tests` in this branch. TypeScript `--noEmit` passed. Original tests and lockfile are unchanged.
- Native CLI: profile discovery via `codex -p warranted-guidance mcp list --json`, offline prompt rendering, and `codex exec --strict-config -p warranted-guidance ... --json` passed.
- Model-visible Warranted tools: **0**, from the actual native CLI request. Guidance had no Warranted MCP; records/full each completed `get_stats` through the real branch server and returned its result to the next model request.
- Treatment behavior is also covered by the unchanged parent suite: records exposes only record operations and does not generate research feedback; full retains structural checks, review and dismiss.

The native CLI test used a local deterministic fake Responses endpoint, with test-only credentials. It exercised actual Codex profile loading, prompt injection, MCP initialization and the tool roundtrip; it did **not** call DeepSeek or a live reviewer. Real provider protocol/model compatibility, research quality and cross-framework effect sizes remain unverified.

The first simultaneous run of the three old suites interfered through their shared `/tmp/warranted-sdk-options` fixtures. The final serial run above passed without changes to the parent sources/tests. Run those suites sequentially across branches.

Reproduce the maintained local checks with the commands in `README.zh-CN.md`. Native CLI integration logs for this implementation were retained locally under `/tmp/warranted-codex-native-ck4b8njt/guidance/` (ephemeral, not a portable experiment artifact).
