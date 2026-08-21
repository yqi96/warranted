---
name: literature-survey
description: Build a critical or explanatory literature review through iterative, question-driven inquiry. Use when the goal is to explain a field, resolve conflicting studies, trace concepts, test a literature claim, or identify a defensible research gap. Do not use for a simple bibliography, a one-paper summary, or a fixed systematic-review protocol whose primary task is exhaustive screening.
---

# Inquiry Literature Review

Build an explanation, not a pile of paper summaries. Treat search, reading, and extraction as moves made against the current argument. Let discoveries revise the question, concepts, and candidate explanations.

The `toulmin-researcher` is the inquiry owner. It keeps the user-facing conversation, chooses the next uncertainty, integrates results, controls the argument graph, and alone decides qualifiers. Delegate bounded evidence work when doing so protects its working context or supplies an independent challenge.

## Start or Resume

On a new review, establish:

- the phenomenon or disagreement that needs explanation;
- what a useful review should let its reader understand or decide;
- provisional scope and important exclusions;
- any required review convention or deliverable.

Do not freeze a complete taxonomy, search plan, or chapter outline before orientation unless the user explicitly requests a protocol-led systematic review.

On a resumed review, read the compact inquiry state, open tensions, recent changes, and relevant argument neighbourhood. Do not reload the entire source collection into the main context.

Maintain durable state using [references/state.md](references/state.md). The files are working memory, while the Warranted graph contains only propositions whose credibility materially affects the review.

Use the shared literature workspace conventions in that reference. In particular, store source PDFs as `papers/<bibkey>.pdf`; the filename stem is both the BibTeX key and the key that `literature-writing` and the Overleaf push integration resolve from proposition attachments.

## Run Inquiry Rounds

Each round addresses one consequential uncertainty:

1. State the current question or proposition.
2. State what observations would support it and what would defeat, narrow, or reframe it.
3. Choose one research move from [references/research-moves.md](references/research-moves.md).
4. Decide whether to work directly or delegate.
5. Integrate returned evidence into the current explanation.
6. Record what changed and choose the next uncertainty.

A round that finds nothing material may close without adding a graph proposition. Do not create nodes to represent activity.

## Delegate Deliberately

Keep synthesis, conflict resolution, conceptual restructuring, warrants, qualifiers, and prose architecture in the main agent.

Delegate work that is bounded by a stable question and can return through an artifact:

- use `literature-scout` for a single search move;
- use `paper-reader` for question-directed reading without graph writes;
- use `literature-extractor` only for a small set of pivotal papers when their source-grounded findings should enter the graph as unestablished propositions;
- use `toulmin-explorer` to retrieve a relevant graph neighbourhood without loading unrelated graph state;
- use `discrepancy-auditor` for one important apparent contradiction or claimed barrier;
- use `rigor-auditor` only as a completion gate.

Parallelize independent evidence obligations within a round, commonly support search, adversarial search, concept tracing, and method comparison. Integrate the round before dispatching work whose question depends on those results. Do not let multiple agents revise the same synthesis proposition, decide a qualifier, or draft the same argument unit.

Every delegation must satisfy [references/delegation.md](references/delegation.md). Prefer 2–4 purposeful workers over broad fan-out. Parallelism that creates more integration work than discriminating evidence is a loss.

## Read for Argument Change

For a pivotal paper, distinguish:

- what was done and measured;
- what the results directly establish;
- what the authors claim;
- which assumptions connect the two;
- which scope conditions matter;
- how the paper changes the current explanation;
- exact passages, tables, or figures supporting that change.

Do not require a universal extraction form for every paper. The current question determines what must be extracted.

## Use the Argument Graph

Put a proposition in Warranted only when assessing it affects the research question or a downstream conclusion. Attach source material or a question-directed evidence note. Use evidence propositions for source-grounded findings, rebuttals for material counterevidence, and warrants for the reasoning that carries findings to a synthesis claim.

Do not map one paper to one node by default. Do not use the graph as a bibliography, task tracker, or reading log. Subagents may recommend graph consequences, but the main agent interprets them before changing synthesis state. Only the main agent sets or resets a qualifier.

## Write from Stable Argument Units

Draft a section only when a local argument can identify:

- the phenomenon or tension;
- competing explanations;
- discriminating evidence;
- the best current resolution or conditional account;
- residual uncertainty.

Organize prose around explanatory work, not paper-by-paper chronology unless historical development is itself the question. Preserve meaningful disagreement rather than forcing consensus.

When the deliverable is LaTeX, hand stable argument units to `literature-writing` and write them under `manuscript/`. That skill owns the `\cite{prop_N}` citation contract and graph-to-prose consistency. If Overleaf synchronization is requested, run `overleaf-setup` with `manuscript/` as `LATEX_DIR`; do not make the whole review workspace the Overleaf project.

## Stop Responsibly

Consider stopping when new work rarely changes the central explanation, major counterexamples have been handled, concepts have stable boundaries, and remaining uncertainty can be stated precisely. Before completion, run the rigor audit and disclose source-access, search, disciplinary, language, and inference limits.

Do not claim systematic coverage, PRISMA compliance, or an exhaustive research gap unless the corresponding protocol and records actually support that claim.
