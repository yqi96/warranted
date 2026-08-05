# Warranted

Make AI research agents accountable — give every conclusion a traceable argument graph.

[![Release](https://img.shields.io/github/v/release/yqi96/warranted?color=green)](https://github.com/yqi96/warranted/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
![MCP Server](https://img.shields.io/badge/MCP-server-blue)
![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)
[![Stars](https://img.shields.io/github/stars/yqi96/warranted?style=flat&color=orange)](https://github.com/yqi96/warranted/stargazers)

> [English](README.md) | [简体中文](README.zh-CN.md)

> **Coding agents have compilers and tests. Research agents have Warranted.**

---

## The problem

AI coding agents converge because compilers and tests provide objective failure signals. Research has no equivalent — conclusions live in natural language with no external verifier, so agents routinely declare work complete with no way to know what's missing.

**Warranted** fills that gap. It gives AI agents a persistent argument graph where every Claim requires Grounds and a Warrant, contradictions are recorded as Rebuttals rather than erased, and status can only advance after passing a logic check (`compile`). The result is research reasoning that is auditable, reproducible, and verifiable — not just plausible-sounding.

Good fit for: **paper reproduction, hypothesis verification, multi-step scientific reasoning, research transparency**.

![Warranted Argument Map](docs/assets/screenshot.png)

![Warranted — multi-tree overview](docs/assets/screenshot2.png)

---

## Documentation

New here? Read in this order:

| Doc | What it covers |
|-----|----------------|
| [The Argument Graph](docs/en/concepts.md) | Core concepts — three node types and roles, `compile`, the status lifecycle, and how to talk to the agent in graph terms. **Start here.** |
| [Reproducing a Paper](docs/en/reproduce-a-paper.md) | Scenario guide: verify a paper's claims with an independent argument graph (`/paper-reproduce`). |
| [Writing a Paper](docs/en/write-a-paper.md) | Scenario guide: draft a paper or literature survey where every citation traces to a verified Ground (`/overleaf-setup`, `/literature-writing`). |

Release history: [CHANGELOG.md](CHANGELOG.md)

---

## Setup with Claude Code

**1. Clone and configure**

Install [Bun](https://bun.com/docs/installation) (>= 1.0.0), then:

```bash
git clone https://github.com/yqi96/warranted
cd warranted

# Optional: enable LLM logic review
cp review.json.example review.json
# Edit review.json and fill in apiKey
```

**2. Register with marketplace (once per machine)**

```bash
claude plugin marketplace add $(pwd)
```

**3. Install the plugin in your project**

```bash
cd your-project
claude plugin install warranted@warranted --scope local
```

On launch, `toulmin-researcher` becomes the primary agent and the MCP server starts automatically.

When LLM review is enabled, node definitions are reviewed on creation and `compile_arguments` runs a full logic-chain audit.

> Hitting install or version issues? See [known-working versions](docs/reference/known-working-versions.md) for a verified dependency snapshot.

---

## Visualizer

From the `warranted` directory:

```bash
bun run viz
```

Open `http://localhost:3456` in your browser.

### Interaction

| Action | Effect |
|--------|--------|
| Click a node | Select it (cyan glow ring) |
| Double-click a node | Open detail panel |
| Shift + click | Add to / remove from selection |
| Drag (box mode) | Draw a box to select multiple nodes |
| Drag (pan mode) | Pan the canvas |
| Scroll | Zoom |
| Click empty space | Clear selection |

The **⬚ / ✥** buttons in the toolbar switch between box-select and pan mode.

### Selection as context

The visualizer server tracks the current selection. Once the plugin is running, **every message you send to Claude automatically includes the selected nodes as context** — no need to describe which nodes you mean, just select and ask.

---

## Agents

| Agent | Role |
|-------|------|
| `toulmin-researcher` | Primary agent. Builds and validates the argument graph, identifies structural gaps, drives each Claim toward a well-evidenced conclusion. |
| `toulmin-explorer` | Read-only. Quickly finds nodes, checks verification status, explores argument structure without making changes. |
| `code-experimenter` | Object-layer. Executes bounded coding, reproduction, and experiment tasks and returns evidence reports; does not decide Claim status. |
| `discrepancy-auditor` | Object-layer. Audits a negative outcome before it enters the graph — an unexpected mismatch about to become a Rebuttal, or a claimed blocker about to halt an obligation. |
| `code-optimizer` | Object-layer. Identifies hot paths, benchmarks, and implements targeted performance improvements within a bounded scope; does not decide Claim status. |

---

## Skills

| Skill | Trigger | Role |
|-------|---------|------|
| `paper-reproduce` | `/paper-reproduce` | Paper reproduction workflow. Builds an independent argument graph and verifies paper claims step by step. |
| `literature-writing` | `/literature-writing` | Literature-backed writing workflow — related work, introductions, discussions, survey write-ups. Grounds each citable finding in the argument graph and writes LaTeX with `\cite{statement_N}` citations. Maintains a `.bib` file throughout. |
| `cite-review` | `/cite-review` | Citation-faithfulness audit. Checks every `\cite{statement_N}` against its Statement in parallel, corrects mismatched LaTeX, and reconciles the graph. |
| `academic-writing` | `/academic-writing` | Manuscript-writing umbrella. Projects graph-backed arguments into paper prose across all sections, figures, tables, and citations. |
| `overleaf-setup` | `/overleaf-setup` | One-time setup skill. Installs `leaf`, authenticates, links a local LaTeX directory to an Overleaf project, and writes a Stop hook that auto-pushes on every conversation turn (skips if no files changed). |
