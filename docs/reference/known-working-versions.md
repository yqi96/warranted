# Known-Working Dependency Versions

Snapshot refreshed 2026-08-31 on the current development branch. `bun test`
(222 tests) and `bun ./node_modules/typescript/bin/tsc --noEmit` pass with the versions below.

## Runtime

| Runtime | Version |
|---------|---------|
| Bun     | 1.3.14  |
| Node.js | 22.22.1 |

## Dependencies

| Package | Version | Notes |
|---------|---------|-------|
| @anthropic-ai/claude-agent-sdk | 0.3.201 | |
| @modelcontextprotocol/sdk | 1.29.0 | |
| chrome-devtools-mcp | 1.7.0 | Browser MCP upstream, pinned in `package.json` |
| zod | 3.25.76 | |

## Dev Dependencies

| Package | Version |
|---------|---------|
| @types/bun | 1.3.14 |
| typescript | 5.9.3 |

## External Binaries

| Binary | Version | Path |
|--------|---------|------|
| claude (Claude Code) | 2.1.119 | Resolved from `PATH` |
| Chrome / Chromium | not pinned | Required by the browser MCP; executable discovery is platform-specific |

This is a reproducibility snapshot, not a minimum-version guarantee. The browser
executable version was not captured, and browser-backed workflows were not part of
the core test run above.
