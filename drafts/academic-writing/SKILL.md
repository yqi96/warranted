---
name: academic-writing
description: Use when drafting or revising manuscript text that must project graph-backed scientific arguments into paper prose across Introduction, Related Work, Results, Discussion, Methods, figures, tables, source data, and citation handles.
---

## Load Required References

Use this skill as the manuscript-writing umbrella. Before drafting or revising a manuscript section, read the relevant reference file(s):

- `references/introduction-related-work.md` for Introduction, Background, Related Work, literature review, and literature-heavy Discussion passages.
- `references/results.md` for Results text, figure/table-linked result paragraphs, captions that state findings, and source-data references.
- `references/discussion.md` for Discussion, Conclusion, limitations, implications, and mixed literature/result synthesis.
- `references/methods-statistics.md` for Methods, Statistical Analysis, reproducibility, protocol, and analysis-authority prose.

Apply `literature-writing` whenever a passage uses published papers as evidence. `literature-writing` governs the literature evidence channel inside academic writing; this umbrella governs manuscript-level projection and cross-section consistency.

## Graph Translation Contract

Write the manuscript as a projection of the graph, not as a parallel argument.

Every load-bearing paragraph must have one paragraph proposition. A paragraph proposition may be new, reused, or revised, but it must be explicit before finalizing the paragraph. Transitional, roadmap, and signposting paragraphs do not need propositions; they must not introduce external facts, result interpretations, or synthesis claims.

Use the current Warranted contract: one Proposition node with `content`, `evidence`, `warrant`, `rebuttals`, and `qualifier`, stored in `.toulmin/graph.db`. Manuscript citations to graph-backed propositions use `\cite{prop_N}` handles. Do not use retired statement handles, node-type language, or retired completion gates.

Use this projection map:

| Manuscript unit | Graph source |
|---|---|
| Section thesis | section-level proposition, usually supported by paragraph propositions in `evidence.nodes` |
| Paragraph thesis | proposition content + qualifier |
| Reported paper finding | evidence proposition with source attachment + `\cite{prop_N}` |
| This-study result | evidence proposition with figure/table/source-data/method artifact |
| Reason why evidence matters | warrant text or promoted warrant proposition |
| Method/statistical authority | method/standard proposition cited from evidence or warrant |
| Limitation, disagreement, boundary condition | rebuttal proposition, usually created with `attacks={node, slot}` |

Do not write around a missing graph node. If the prose needs a scientific assertion, create or repair the graph first.

## Voice Separation

Keep four voices distinct:

- **Source voice**: what published work reports -> evidence proposition with source attachment.
- **Result voice**: what this study observed -> evidence proposition with data or figure artifact.
- **Inference voice**: what the evidence implies -> target proposition + warrant.
- **Judgment voice**: what the graph has earned -> qualifier after evidence and rebuttal assessment.

Do not use source or result voice to smuggle in inference. Sentences such as "Together, these findings show..." are proposition/warrant prose, not citation prose.

## Revision Protocol

When editing existing manuscript text:

1. Identify the paragraph proposition.
2. List every cited `prop_N`, figure, table, or source-data reference supporting it.
3. Check whether the paragraph's synthesis language matches the warrant.
4. If the text narrows, broadens, or changes the thesis, update the proposition or create a new one.
5. If an edit removes evidence, reassess the qualifier and inspect current warnings/findings.
6. If an edit introduces a limitation or contradiction, create or update a rebuttal proposition.

Text edits that change argument meaning are graph edits. Do not leave them as prose-only changes.
