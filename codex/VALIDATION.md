# Codex adapter validation — records

Validated locally on 2026-09-18 with Codex CLI 0.155.0, Bun 1.3.14 and Python 3.12.

- Parent identity: `python3 codex/prepare.py --verify` passed. All original tracked files are byte-identical to the parent recorded in `adapter.json`; only `codex/` is added.
- Prompt identity: complete agent file and frontmatter-stripped body SHA-256 passed. A captured native Codex Responses request contains the exact body as developer instructions. Codex built-in instructions remain intact.
- Adapter unit checks: 5 passed, including TOML/path quoting, treatment selection, prompt preservation, fresh-state enforcement, source-change rejection and keeping reviewer secrets out of the task/configuration copies.
- Existing core suite: **358 passed, 0 failed**, using `bun test ./tests` in this branch. TypeScript `--noEmit` passed. Original tests and lockfile are unchanged.
- Native CLI: profile discovery via `codex -p warranted-records mcp list --json`, offline prompt rendering, and `codex exec --strict-config -p warranted-records ... --json` passed.
- Model-visible Warranted tools: **9**, from the actual native CLI request. Guidance had no Warranted MCP; records/full each completed `get_stats` through the real branch server and returned its result to the next model request.
- Treatment behavior is also covered by the unchanged parent suite: records exposes only record operations and does not generate research feedback; full retains structural checks, review and dismiss.

The native CLI test used a local deterministic fake Responses endpoint, with test-only credentials. It exercised actual Codex profile loading, prompt injection, MCP initialization and the tool roundtrip; it did **not** call DeepSeek or a live reviewer. The initial run did not verify a live provider. See the later live check below; research quality and cross-framework effect sizes remain unverified.

The first simultaneous run of the three old suites interfered through their shared `/tmp/warranted-sdk-options` fixtures. The final serial run above passed without changes to the parent sources/tests. Run those suites sequentially across branches.

Reproduce the maintained local checks with the commands in `README.zh-CN.md`. Native CLI integration logs for this implementation were retained locally under `/tmp/warranted-codex-native-ck4b8njt/records/` (ephemeral, not a portable experiment artifact).

## Live provider check and MCP approval correction (2026-09-18)

Using the existing local review configuration's key and exact model `deepseek-flash`, the official Responses endpoint `https://api.deepseek.com/responses` returned HTTP 200 and `RESPONSE_OK`. The review configuration itself was not changed; its `/anthropic` URL remains the reviewer endpoint.

A native Codex full-arm trial then exposed an adapter defect: `approval_policy=never` combined with implicit MCP approval prevented the tool from executing. The adapter now explicitly permits only the configured local Warranted MCP server with `default_tools_approval_mode="approve"`; shell permissions and all parent code/prompt files remain unchanged.

With a fresh generated profile and no command-line approval override, the live full-arm run completed a real `get_stats` call (`status=completed`, `error=null`, `total=0`) and returned `CODEX_DEEPSEEK_MCP_OK`. It exited 0 in 3.99 seconds. The final usage event reports 33,601 input tokens (32,000 cached) and 46 output tokens. This tested the main agent and MCP, not a live `review` call. Guidance/records use the same provider path but were not separately run against the live endpoint in this check.

Correction to the initial offline evidence: merely observing `function_call_output` was insufficient, since approval denial also produces tool output. The strengthened local fixture now requires an actual completed MCP event, no tool error, and a parsed stats result with `total=0`. Do not infer successful tool execution from transport roundtrip or process exit alone.

The live CLI still emitted a missing-model-metadata warning and used fallback metadata for `deepseek-flash`. Provider connectivity is confirmed; pin the appropriate model catalog, context and reasoning settings before formal paper trials. Credentials were supplied in memory through an environment variable, not written into generated configs or logs. The live result artifact is `tmp/codex-live-smoke/20260918-152650/summary.json` in the main local checkout (not committed).
