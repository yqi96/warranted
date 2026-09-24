# v0.6.0 Codex adapter validation

Validated on 2026-09-24 with Codex CLI 0.155.0, Bun 1.3.14 and Python 3.12.

## Provenance and scope

- Direct parent: `v0.6.0`, commit `bc7937ac06b1fd0ea2bd948b3d57ddd359436b3b`.
- Branch: `codex/v0.6.0-codex`; derived independently, not from an experimental arm.
- Main research prompt SHA-256: `cdbce5d84ddd6c468022cfc38c20681668a902948e1c2ad76a3c6901c869659e`.
- The main and all eight specialist prompt bodies are copied byte-for-byte after removing their original YAML frontmatter. Model aliases are not translated; specialists inherit the selected Codex model.
- Existing runtime, review, browser, citation and push implementation files are unchanged.
- Two existing documentation files change directly for the Codex-only Overleaf workflow: `skills/overleaf-setup/SKILL.md` and `skills/literature-survey/references/state.md`. No parallel Overleaf skill or compatibility overlay is generated.

## Checks

| Check | Result |
| --- | --- |
| `python3 codex/prepare.py --verify` | Parent tag, prompt hashes and unchanged parent files verified, with the two declared skill edits excluded |
| `python3 -m unittest discover -s codex -p test_prepare.py -v` | 8 passed |
| `bun test` | 454 passed, 4 skipped, 0 failed; skips require external data/provider diagnostic fixtures |
| `bunx --no-install tsc --noEmit` | Passed |
| Overleaf skill quick validation | Passed |
| Usage guide Bash and zsh syntax | Passed |
| Native `debug prompt-input` | Exact main prompt and all 7 Warranted skills discovered; no personal OMX instructions injected |
| Native `mcp list --json` | Both configured MCP services enabled |
| Native `codex exec` with local fake Responses endpoint | Main request advertised 11 Warranted and 31 browser tools, plus all 8 custom roles |
| Actual Warranted MCP call | `get_stats` completed with no error and `total=0` |
| Actual native custom-role invocation | Spawned `toulmin-explorer`, verified its exact prompt body and inherited model, called `get_stats`, and returned its result to the parent |

The native smoke tests used the real Codex binary and unmodified Warranted MCP processes. Only the model responses were supplied by a loopback HTTP fixture using a dummy key. They prove configuration discovery, protocol/tool roundtrips and role behavior, not model reasoning quality or research completion. They made no real model, reviewer or Overleaf calls; browser tools were enumerated, but interactive website operation was not exercised.

## Confirmed runtime limitation

Codex 0.155.0 does **not** apply role-level `mcp_servers` restrictions. A `toulmin-explorer` role configured with only its three original graph tools and a disabled browser still received all 42 parent MCP tools in its actual model request. Moving MCP declarations to the base configuration or registering the role explicitly did not change this behavior.

This agrees with the release's [role override implementation](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/core/src/agent/role.rs#L32-L119): MCP configuration is not among the applied overrides. The general [subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) lists MCP configuration as a supported role field, so this adapter relies on the measured release behavior rather than treating successful TOML parsing as enforcement.

The final adapter omits ineffective MCP role overrides, preserves original allowlists as provenance in `preparation.json`, and records `subagent_mcp_allowlists=not_enforced_by_codex_0_155_0`. Role responsibilities remain in the original prompts; they do not create hard tool isolation. This branch is **not** a claim of tool-permission equivalence between frameworks. Experiments requiring that property need a separate solution before execution.

Other deliberate framework differences are the inherited specialist model, Codex native tools/system instructions/built-in skills, disabled native web search by default, absence of the visualizer selection hook, and explicit Overleaf synchronization. Internal reviewer code and its `usage` / `modelUsage` accounting are unchanged.
