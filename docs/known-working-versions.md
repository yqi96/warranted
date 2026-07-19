# Known-Working Dependency Versions

Snapshot recorded 2026-07-19 after fixing `paths[0] must be string` bug.
All tests pass (`bun test`) with the versions below.

## Runtime

| Runtime | Version |
|---------|---------|
| Bun     | 1.3.14  |
| Node.js | 24.14.1 |

## Dependencies

| Package | Version | Notes |
|---------|---------|-------|
| @anthropic-ai/claude-agent-sdk | 0.3.201 | Also tested: 0.3.215 |
| @modelcontextprotocol/sdk | 1.29.0 | |
| zod | 3.25.76 | |

## Dev Dependencies

| Package | Version |
|---------|---------|
| @types/bun | 1.3.14 |
| typescript | 5.9.3 |

## External Binaries

| Binary | Version | Path |
|--------|---------|------|
| claude (Claude Code) | 2.1.90 | ~/.local/bin/claude |
| claude (SDK bundled) | 2.1.215 | node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude |
