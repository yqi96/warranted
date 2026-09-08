# Warranted Research Framework

Warranted separates two kinds of work:

- the **argument layer** records propositions, evidence, warrants, rebuttals, qualifiers, warnings, findings, and history;
- the **object layer** searches, reads, codes, experiments, analyzes, and inspects artifacts.

The primary `toulmin-researcher` owns the graph and the final qualifier judgments. Specialists return evidence or audits; they do not silently decide graph consequences.

## Working contract

Before object-layer work begins, identify:

1. the proposition or unresolved graph condition that creates the obligation;
2. what result would support, defeat, or narrow it;
3. which artifacts must come back;
4. who is allowed to change the graph and judge the qualifier.

After the work, return durable evidence to the relevant proposition, update its warrant or rebuttals when necessary, and make qualifier changes explicitly. Structural warnings are non-blocking signals, not permission to ignore a changed premise. `review` is an explicit third-party opinion, not an automatic gate or authoritative verdict.

## Agents

| Agent | Layer | Responsibility |
|---|---|---|
| `toulmin-researcher` | argument | controls the graph, coordinates research, and makes qualifier judgments |
| `toulmin-explorer` | argument, read-only | locates propositions and inspects their current neighbourhood |
| `code-experimenter` | object | implements methods, runs experiments, and returns auditable artifacts |
| `code-optimizer` | object | reduces runtime or memory cost without changing the tested semantics |
| `discrepancy-auditor` | boundary | audits one mismatch or claimed blocker before it becomes a rebuttal or accepted exit |
| `rigor-auditor` | completion | judges whether the overall effort was exhausted and is worth reporting |
| `literature-scout` | object | performs one bounded browser-assisted search move and writes a search artifact |
| `paper-reader` | object | reads specified papers against one question and writes source-grounded notes |
| `literature-extractor` | boundary | records paper findings as propositions with attachments; does not judge qualifiers |

## Workflow skills

| Skill | Purpose |
|---|---|
| `literature-survey` | iterative inquiry across a literature, using search and reading moves chosen by the current argument |
| `paper-reproduce` | independent implementation and execution against a paper's evidential obligations |
| `literature-writing` | project the graph into literature-backed LaTeX with `\cite{prop_N}` |
| `cite-review` | compare cited prose with proposition content and qualifier strength |
| `overleaf-setup` | install proposition-aware Overleaf synchronization |
| `browser` | operate one isolated Chrome session safely |
| `paper-download-browser` | obtain an authorized paper through browser navigation when direct download is insufficient |

## Completion

Use `get_stats` before reporting or handoff. A meaningful completion statement explains:

- which propositions were judged and on what evidence;
- which rebuttals or semantic findings remain material;
- which warnings were repaired or dismissed, with reasons;
- which propositions remain `unestablished` and what evidence is still missing.

There is no compile phase. Current structural state is derived on read, and graph history records changes and judgments as append-only events.
