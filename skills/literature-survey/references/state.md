# Durable Inquiry State

Keep the main agent's resumable state compact. Recommended layout:

```text
review/
├── state.yaml
├── inquiry.md
├── tensions.md
├── search-log.jsonl
├── papers/
├── notes/
├── evidence/
└── manuscript/
    ├── main.tex
    ├── references.bib
    ├── sections/
    └── leaf.toml
```

Do not create unused files up front. Add them when the inquiry produces content for them. `manuscript/` is the LaTeX project boundary; create it only when writing begins. `leaf.toml` appears only after `overleaf-setup` binds that directory to a project.

## Shared source and manuscript contract

- Store each source paper as `papers/<bibkey>.pdf`. The filename stem must exactly match its entry in `manuscript/references.bib`.
- Attach that PDF path—not merely a reading note—to every proposition cited through `\cite{prop_N}`. The Overleaf push integration derives real BibTeX keys from attached PDF stems.
- Keep `notes/<bibkey>.md` for question-directed interpretation and exact locators. A note may be attached as audit support, but it does not replace the PDF for citation expansion.
- Keep comparison tables and other inquiry artifacts in `evidence/`; do not place them in the LaTeX project unless the manuscript actually includes them.
- Let `literature-writing` own prose-to-graph citation consistency inside `manuscript/`.
- When synchronization is wanted, give `overleaf-setup` the absolute path to `manuscript/` as `LATEX_DIR`. Its staging and hook should not include inquiry state, notes, or the paper library.

## `state.yaml`

Store orientation, not the literature corpus:

```yaml
topic: "..."
purpose: "What the review should explain or enable"
current_question: "The uncertainty selected for the next round"
working_explanations:
  - id: E1
    claim: "..."
    status: tentative | contested | locally-stable
open_tensions:
  - id: T1
    question: "..."
    importance: "Why resolving it could change the synthesis"
recent_changes:
  - "What the last round changed"
next_candidate_moves:
  - type: claim-test
    target: E1
```

Keep entries short and point to graph ids or artifact paths for detail. Rewrite this file as understanding changes; it represents current state, not history.

## History and source records

- `inquiry.md`: dated changes to the research question, scope, and explanatory frame.
- `tensions.md`: unresolved conflicts, anomalies, concept collisions, and their current status.
- `search-log.jsonl`: one record per purposeful search, including its question, query, source, date, selection, and whether it changed understanding.
- `papers/`: source PDFs named by BibTeX key.
- `notes/`: question-directed paper notes named by the same stable BibTeX key where possible.
- `evidence/`: comparison tables or other artifacts that synthesize exact source observations.
- `manuscript/`: the LaTeX project consumed by `literature-writing` and optionally bound by `overleaf-setup`.
- Warranted history: consequential proposition, warrant, rebuttal, and credibility changes.

## Context loading rule

At the start of a round, load only:

1. `state.yaml`;
2. the open tension being addressed;
3. its relevant graph neighbourhood;
4. artifacts directly named by the chosen move.

Retrieve additional material on demand. Do not preload all notes, PDFs, search results, or graph nodes.

## Round close

Record:

```yaml
question: "..."
artifacts_changed: []
graph_changes: []
understanding_change: "strengthened | narrowed | rebutted | reframed | unchanged"
reason: "..."
new_tensions: []
recommended_next_move: "..."
```

An unchanged round is legitimate. Record why it was non-discriminating and avoid manufacturing a graph change.
