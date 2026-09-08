# Warranted

Make AI research agents accountable — give every conclusion a traceable argument graph.

[![Release](https://img.shields.io/github/v/release/yqi96/warranted?color=green)](https://github.com/yqi96/warranted/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
![MCP Server](https://img.shields.io/badge/MCP-server-blue)
![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)
[![Stars](https://img.shields.io/github/stars/yqi96/warranted?style=flat&color=orange)](https://github.com/yqi96/warranted/stargazers)

> [English](README.md) | [简体中文](README.zh-CN.md)

> **Code has compilers and tests. Research needs failure signals too.**

## What it does

Warranted gives a research agent a persistent, auditable argument graph. The graph has one node type: a **proposition**. Every proposition has five slots:

| Slot | Meaning |
|---|---|
| `content` | the statement being judged |
| `evidence` | attached files and references to other propositions |
| `warrant` | why that evidence supports the content, inline or promoted to its own proposition |
| `rebuttals` | propositions that attack the content or warrant |
| `qualifier` | one credibility scale: `refuted → unestablished → possibly → probably → certainly` |

Ground, backing, claim, and rebuttal are viewpoints, not node types. The same proposition can be evidence for one conclusion, a conclusion in its own right, and a rebuttal somewhere else.

Structural checks are deterministic and automatic. They return **non-blocking warnings** for incomplete evidence, missing attachments, changed dependencies, and similar conditions. They do not rewrite qualifiers or prevent the agent from recording a judgment. An explicit `review` call can ask a separate LLM for a semantic second opinion about source faithfulness and inference validity. Findings are advisory; they remain pending until a later review replaces them or they are dismissed with a reason.

## Documentation

| Doc | What it covers |
|---|---|
| [The Argument Graph](docs/en/concepts.md) | propositions, five slots, qualifiers, warnings, findings, and the 11-tool surface |
| [Reproducing a Paper](docs/en/reproduce-a-paper.md) | rebuild a paper's evidential chain using independently produced evidence |
| [Writing a Paper](docs/en/write-a-paper.md) | write LaTeX whose `\cite{prop_N}` citations trace to propositions and attached papers |
| [Research Framework](docs/en/research-framework.md) | how the primary agent, specialists, graph, and object-layer work divide responsibility |

The detailed contracts live in [docs/design.md](docs/design.md) and [docs/api.md](docs/api.md). Release history is in [CHANGELOG.md](CHANGELOG.md).

> **Development-branch compatibility note:** commit `90c7acb` replaced the released 0.5.0 three-node/compile model with the proposition model described above. Old `.toulmin/argument.db` files remain read-only historical archives; current runs use `.toulmin/graph.db` and do not mechanically migrate old verdicts. The 0.5.0 terminology remains in the changelog only as release history.

## Setup with Claude Code

Install [Bun](https://bun.com/docs/installation) (>= 1.0.0), Node.js, and a Chrome/Chromium browser, then:

```bash
git clone https://github.com/yqi96/warranted
cd warranted

# Optional: enable explicit third-party LLM review
cp review.json.example review.json
# Edit review.json and fill in apiKey; baseUrl is optional.
```

The plugin launchers run `bun install --frozen-lockfile`. The browser MCP uses the pinned `chrome-devtools-mcp` dependency and starts isolated browser sessions on demand.

Register and install the plugin:

```bash
claude plugin marketplace add $(pwd)
cd your-project
claude plugin install warranted@warranted --scope local
```

On launch, `toulmin-researcher` becomes the primary agent. Two stdio MCP servers start automatically:

- `toulmin` stores the current graph at `<project>/.toulmin/graph.db` and exposes the 11 graph tools.
- `browser` provides process-isolated Chrome sessions for browser-assisted research.

Review is never triggered merely by creating or editing a proposition. It runs only when the agent deliberately calls `review`, and only when `review.json` supplies a usable `apiKey`.

> Hitting install or version issues? See [known-working versions](docs/reference/known-working-versions.md).

## Tool surface

| Group | Tools |
|---|---|
| Write | `create_propositions`, `update_proposition`, `set_qualifier`, `promote_warrant`, `delete_proposition` |
| Read | `get_argument`, `find_propositions`, `get_stats`, `get_history` |
| Opinion | `review`, `dismiss` |

Writes validate content, referenced ids, and attachment existence. Structural warnings and review findings remain visible on reads; they advise rather than gate writes.

## Visualizer

```bash
bun run viz
```

Open `http://localhost:3456`. The visualizer reads `.toulmin/graph.db`, colors propositions by qualifier, shows warning/finding badges, and can switch to another project's `graph.db`.

| Action | Effect |
|---|---|
| Click a node | select it |
| Double-click a node | open its detail panel |
| Shift + click | add to or remove from the selection |
| Drag in box mode | select several nodes |
| Drag in pan mode | move the canvas |
| Scroll | zoom |
| Click empty space | clear the selection |

The UserPromptSubmit hook injects the current visualizer selection into later Claude prompts when the visualizer is running on its default port.

## Agents

| Agent | Role |
|---|---|
| `toulmin-researcher` | primary agent; controls the graph, coordinates research, and makes qualifier judgments |
| `toulmin-explorer` | fast read-only graph lookup and navigation |
| `code-experimenter` | bounded implementation, reproduction, and experiment execution |
| `code-optimizer` | makes full-scope experiments feasible without changing their semantics |
| `discrepancy-auditor` | audits one mismatch or claimed blocker before graph consequences are accepted |
| `rigor-auditor` | completion-level audit of whether the overall research is exhausted and worth reporting |
| `literature-scout` | performs one bounded browser-assisted literature search move and writes a durable search artifact |
| `paper-reader` | reads specified papers against one inquiry question and writes evidence notes |
| `literature-extractor` | records paper findings as propositions with source attachments; does not judge qualifiers |

## Skills

| Skill | Trigger | Role |
|---|---|---|
| `literature-survey` | `/literature-survey` | iterative, question-driven critical literature review |
| `paper-reproduce` | `/paper-reproduce` | independent reproduction and graph-based judgment of a paper's claims |
| `literature-writing` | `/literature-writing` | literature-backed LaTeX writing with `\cite{prop_N}` citations |
| `cite-review` | `/cite-review` | checks citation content and strength against propositions and qualifiers |
| `overleaf-setup` | `/overleaf-setup` | one-time Overleaf sync and proposition-citation enforcement |
| `browser` | `/browser` | safe operation of an isolated Chrome session through the browser MCP |
| `paper-download-browser` | `/paper-download-browser` | authorized browser-assisted paper download when direct HTTP is insufficient |

## Development

There is no separate build artifact: Bun executes the TypeScript sources directly, while TypeScript is configured for strict, no-emit checking.

```bash
bun test
bun ./node_modules/typescript/bin/tsc --noEmit
bun run agent-eval             # dry-run; add --live only when model cost is intended
```
