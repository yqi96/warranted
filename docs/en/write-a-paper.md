# Writing a Paper

> [English](write-a-paper.md) | [简体中文](../zh-CN/write-a-paper.md)

## Goal

Use `/literature-writing` to write or revise LaTeX prose whose load-bearing statements trace to the argument graph. Use `/literature-survey` first when the task is an inquiry-led review of a larger literature, then hand the resulting synthesis to `/literature-writing`.

A sound handoff has:

- a proposition for every cited paper finding;
- the source paper attached to that proposition;
- synthesis propositions whose evidence references those findings;
- warrants explaining why the evidence supports each synthesis;
- prose strength that matches each proposition's qualifier;
- contradictions represented as rebuttal propositions rather than edited away.

There is no compile step. Structural warnings are recomputed automatically, and `get_stats` provides the final settlement view.

## Setup once: `overleaf-setup`

`/overleaf-setup` installs and authenticates the `leaf` CLI, links a local LaTeX directory to an Overleaf project, and writes the Stop hook that stages and pushes source changes.

The hook enforces proposition citations. Restart Claude Code after setup.

## Map prose to the graph

Every graph node is a proposition:

| What the manuscript needs | Graph representation |
|---|---|
| a finding reported by a paper | proposition with the paper in `evidence.attachments` |
| a paragraph's synthesis point | proposition with the relevant finding propositions in `evidence.nodes` |
| why those findings support the point | that proposition's `warrant` |
| evidence about the reasoning principle itself | promote the warrant, then attach evidence to the promoted proposition |
| a conflicting finding or boundary condition | proposition created with `attacks={node, slot}` |

A proposition is a ground when another proposition cites it and a claim when its own credence is being judged. These are perspectives, not different node types.

Revise a proposition when the asserted scope genuinely changes. Do not rewrite it merely to hide contradictory evidence; record the contradiction in the rebuttal slot and judge the qualifier the full evidence earns.

## The `\cite{prop_N}` standard

Draft citations by proposition id:

```latex
\cite{prop_42}
```

The Overleaf push hook resolves proposition 42 in `.toulmin/graph.db`, finds its attached paper PDFs, and replaces `prop_42` with the corresponding bibliography keys in the staged copy.

| Element | Example |
|---|---|
| `.bib` key | `vaswani2017attention` |
| attached PDF | `vaswani2017attention.pdf` |
| draft citation | `\cite{prop_42}` |

Every cited proposition must exist, have at least one attached PDF that still exists, and have a matching key in a project `.bib` file. Multiple attached PDFs expand to multiple keys; non-PDF attachments remain audit evidence but are ignored for citation expansion.

This creates an auditable chain:

```text
manuscript sentence ──\cite{prop_N}──► proposition ──attachment──► paper
```

The chain proves provenance, not credibility. Attaching a paper does not automatically raise a qualifier, and creating a proposition does not trigger LLM review.

## Match prose strength to qualifiers

- **Paper voice:** “Smith et al. report X” may cite a proposition at any qualifier because the sentence attributes a report. If it is `refuted`, the sentence must also carry that fact.
- **Synthesis voice:** “The evidence suggests X” needs a synthesis proposition with evidence and a warrant. Use tentative language at `possibly`; assert plainly only at `probably` or `certainly`.
- **Unestablished:** do not present an `unestablished` synthesis as a conclusion. Attribution to what a paper reports is still possible.

Run `/cite-review` to check both content faithfulness and strength alignment. It may correct prose or graph links, but qualifier changes remain deliberate judgments.

## States to watch

| State | Meaning |
|---|---|
| cited proposition has no attached PDF | the citation has no source artifact and push is blocked |
| PDF stem has no matching bibliography key | citation expansion cannot produce valid LaTeX |
| synthesis proposition has empty evidence or warrant at a positive qualifier | structural warning: the asserted strength lacks visible support |
| evidence content or qualifier changed after a judgment | re-check warning: the old judgment rested on a different premise |
| material finding remains `unestablished` | use attribution only, or judge it deliberately before relying on it |
| unresolved review finding | semantic concern remains visible until replaced by a later review or dismissed with a reason |

Before delivery, run `get_stats`, resolve material red items, and ensure the manuscript's hedging still matches the graph.
