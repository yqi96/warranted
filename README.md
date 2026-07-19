# Toulmin MCP Server

Structure AI reasoning with argument graphs — not free-form guessing.

> 中文文档：[docs/README.zh.md](docs/README.zh.md)

---

## What it does

AI agents doing research tend to fail in two ways: conclusions with no supporting evidence, or quietly rewriting prior claims when contradictions arise. Toulmin MCP gives agents a **persistent argument graph**: every Claim requires Grounds and a Warrant, contradictions are recorded as Rebuttals rather than erased, and status can only advance after passing a logic check (`compile`).

Good fit for: **paper reproduction, hypothesis validation, multi-step scientific reasoning**.

![Toulmin Argument Map](docs/screenshot.png)

---

## Setup with Claude Code

**1. Clone and configure**

Install [Bun](https://bun.com/docs/installation) (>= 1.0.0), then:

```bash
git clone <this-repo>
cd toulmin-mcp

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
claude plugin install toulmin-mcp@toulmin-mcp --scope local
```

On launch, `toulmin-researcher` becomes the primary agent and the MCP server starts automatically.

When LLM review is enabled, node definitions are reviewed on creation and `compile_arguments` runs a full logic-chain audit.

---

## Visualizer

From the `toulmin-mcp` directory:

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
