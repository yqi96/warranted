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

Apply `literature-survey` whenever a passage uses published papers as evidence. `literature-survey` governs the literature evidence channel inside academic writing; this umbrella governs manuscript-level projection and cross-section consistency.

## Graph Translation Contract

Write the manuscript as a projection of the graph, not as a parallel argument.

Every load-bearing paragraph must have one paragraph Claim. A paragraph Claim may be new, reused, or revised, but it must be explicit before finalizing the paragraph. Transitional, roadmap, and signposting paragraphs do not need Claims; they must not introduce external facts, result interpretations, or synthesis claims.

Use this projection map:

| Manuscript unit | Graph source |
|---|---|
| Section thesis | section-level Claim, usually supported by paragraph Claims used as Grounds (pass each paragraph Claim's id into the Warrant's `ground_ids`) |
| Paragraph thesis | Claim |
| Reported paper finding | `source="literature"` Ground + `\cite{statement_N}` |
| This-study result | `source="observed"` Ground + figure/table/source-data/method artifact |
| Reason why evidence matters | Warrant prose |
| Method/statistical authority | Backing or Methods/Statistics text linked to the Warrant it supports |
| Limitation, disagreement, boundary condition | Rebuttal |

Do not write around a missing graph node. If the prose needs a scientific assertion, create or repair the graph first.

## Voice Separation

Keep four voices distinct:

- **Source voice**: what published work reports -> literature Ground.
- **Result voice**: what this study observed -> observed Ground.
- **Inference voice**: what the evidence implies -> Claim + Warrant.
- **Verdict voice**: what the graph has earned -> Claim status after compile and evidence assessment.

Do not use source or result voice to smuggle in inference. Sentences such as "Together, these findings show..." are Claim/Warrant prose, not citation prose.

## Revision Protocol

When editing existing manuscript text:

1. Identify the paragraph Claim.
2. List every cited `statement_N`, figure, table, or source-data reference supporting it.
3. Check whether the paragraph's synthesis language matches the Warrant.
4. If the text narrows, broadens, or changes the thesis, update the Claim or create a new Claim.
5. If an edit removes evidence, reassess the Claim status and compile state.
6. If an edit introduces a limitation or contradiction, create or update a Rebuttal.

Text edits that change argument meaning are graph edits. Do not leave them as prose-only changes.

