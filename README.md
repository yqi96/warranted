# Warranted

Make AI research agents accountable — give every conclusion a traceable argument graph.

> 中文文档：[docs/README.zh.md](docs/README.zh.md)

---

## The problem

AI coding agents converge because compilers and tests provide objective failure signals. Research has no equivalent — conclusions live in natural language with no external verifier, so agents routinely declare work complete with no way to know what's missing.

**Warranted** fills that gap. It gives AI agents a persistent argument graph where every Claim requires Grounds and a Warrant, contradictions are recorded as Rebuttals rather than erased, and status can only advance after passing a logic check (`compile`). The result is research reasoning that is auditable, reproducible, and verifiable — not just plausible-sounding.

Good fit for: **paper reproduction, hypothesis verification, multi-step scientific reasoning, research transparency**.

![Warranted Argument Map](docs/screenshot.png)

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
| `toulmin-translator` | Translation layer. Converts natural-language instructions into structured operations and routes them to researcher or explorer. |

---

## Skills

| Skill | Trigger | Role |
|-------|---------|------|
| `paper-reproduce` | `/paper-reproduce` | Paper reproduction workflow. Builds an independent argument graph and verifies paper claims step by step. |
| `declare-barrier` | `/declare-barrier` | Formally declares a task blocker. Before accepting the block, the system checks all known false-blocker patterns. |
