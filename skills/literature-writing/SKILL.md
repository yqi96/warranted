---
name: literature-writing
description: Use when writing or revising LaTeX prose that cites published papers — related work, introductions, discussions, or the write-up phase of a survey. Turns citable findings into propositions backed by the paper and cites them as \cite{prop_N}.
---

## Graph Mapping

Never cite a paper directly. A citable finding from a paper first becomes a proposition with that paper in its `evidence.attachments`; LaTeX then cites that proposition with `\cite{prop_N}`, where N is its id. The citation is a pointer into the argument graph, not a bibliography shortcut.

| What you are writing | Where it goes |
|---|---|
| citable finding from a paper | a proposition — the paper in `evidence.attachments` |
| paragraph point | a proposition — the literature propositions in its `evidence.nodes` |
| why those findings support the point | that proposition's `warrant` |
| methodological authority behind the inference | evidence on the warrant — `promote_warrant` first, then attach it there |
| conflicting paper finding | a proposition created with `attacks={node, slot}` |

There is no separate node type for any of these. A proposition is a ground when something else cites it and a claim when it cites something else, and the same node is usually both — the role is the viewpoint, not a property to declare.

Granularity:

- one paper yields multiple propositions when it offers multiple distinct citable findings
- one proposition carries multiple paper attachments when several papers support the same finding
- different findings, populations, methods, measurements, or scopes are separate propositions
- convergence across distinct propositions is the consuming proposition's `warrant`, not a merge into a vague composite

## Obligations

Object-layer work in this channel — search, reading, download, BibTeX, prose edits — is valid only when it creates, judges, cites, or reconciles a proposition the manuscript rests on. A searched paper must become evidence, backing, or a rebuttal, or be discarded with a reason; it is never accumulated as an inert reading list.

| Graph state | Required action |
|---|---|
| No proposition for a load-bearing paragraph thesis | `create_propositions`, or update the existing one |
| A sentence cites a paper for a finding | Reuse a matching proposition, or `create_propositions` with the paper attached |
| A paper provides several relevant findings | One item per distinct finding in the same `create_propositions` call |
| Several papers support the same specific finding | Attach them to the same proposition only when they support the same finding |
| A cited proposition's paper has never been checked against its content | Read the paper, then `update_proposition(evidence={add_attachments: [...]})` and judge it with `set_qualifier` |
| A paragraph thesis has evidence but no `warrant` | `update_proposition(warrant=...)` — the structural check demands it from `possibly` upward |
| The warrant itself needs authority, or is what a source disputes | `promote_warrant`, then attach its backing as evidence on the promoted proposition |
| A paper contradicts a thesis or its warrant | `create_propositions` with `attacks={node, slot}` |
| The text changes the paragraph thesis | Reconcile the proposition's `content` |
| A citation points to the wrong proposition | Point to the correct one, or create one; edit an existing proposition only to fix an error, never to fit the sentence |
| Existing LaTeX uses author-year or legacy `statement_N` keys | Migrate each: identify the finding actually cited, create or reuse its proposition, replace the key with `prop_N`. Never map `statement_7` to `prop_7` by number — the old ids belong to an archived graph |

A citable finding may be a result, definition, taxonomy, dataset description, method claim, limitation, opinion, or argument — but it must be specific enough that citation faithfulness can be checked.

## Citation Contract

For every external citation in `.tex`:

1. the source uses `\cite{prop_N}`
2. the proposition cited as `prop_N` exists and states the exact finding being cited
3. it attaches every source paper supporting it in this citation
4. the sentence's confidence matches the proposition's `qualifier` (see Three Voices)
5. each attached paper's filename stem matches a BibTeX key in the project `.bib`

Clauses 2–3 prove provenance; clause 4 keeps the prose honest about strength. Together they still say nothing about whether the argument is any good — a citation can be perfectly faithful while the thesis it serves stands at `possibly`.

Get faithfulness right while writing: each `\cite{prop_N}` sentence must already represent that proposition at the moment you write it. A mismatch caught late — after the argument has been built on it — can force reworking the paper's logic.

## Writing As Graph Projection

A load-bearing paragraph is a projection of a proposition and the structure under it. A transitional or roadmap paragraph needs no proposition, but must not smuggle in uncited external assertions or unsupported synthesis.

- paragraph thesis matches a proposition's `content`
- sentences reporting papers cite the propositions those papers are attached to
- synthesis language reflects the `warrant`, not a list of sources
- contradictions surface as limitations, disagreements, or boundary conditions, and exist in the graph as rebuttals

Keep three voices distinct:

- **Paper voice** — what a source reports → `\cite{prop_N}` on an attributed sentence. Attribution is faithful at any qualifier, including `unestablished`: the sentence only claims the paper says it. If the proposition stands at `refuted`, the sentence must carry the refutation too.
- **Synthesis voice** — what the body of evidence suggests → a proposition with evidence and a warrant. Here the hedging is load-bearing, because the qualifier is a credibility scale and prose can contradict it without misquoting anything: assert flatly only at `probably` or `certainly`; write "may" or "suggests" at `possibly`; at `unestablished` you have no synthesis to write yet, only attribution.
- **Verdict voice** — what the graph has earned → the qualifier itself, and the rebuttals standing against it.

Do not let a citation carry the argument: attached papers supply evidence; warrants explain why it matters.

## Revision Discipline

Prose and graph are coupled both ways. Any meaning-bearing edit on one side obliges a matching, honest edit on the other; they must never silently diverge.

Recurring cases:

- **Prose asserts something new** → the proposition behind it must exist first; do not write around a missing node.
- **Prose narrows, broadens, or strengthens a thesis** → re-scope the `content` or re-judge the `qualifier` so the graph actually earns the new wording. Scope belongs in `content`; the qualifier carries credibility only.
- **Prose drops a caveat or conflict** → it must reappear as a rebuttal or a lower qualifier, not simply disappear.
- **Evidence is corrected, a qualifier moves, or a rebuttal is added** → update every sentence that depends on it, including its hedging.

The test: if something leaves the prose without reappearing in the graph — or changes in the graph without reaching the prose — that is concealment, not revision.

Writes return warnings, and changing a proposition's evidence or content re-arms every warning previously dismissed on it. Read them. Fix what a warning points at, or `dismiss` it with a reason you are willing to have read back; never edit content until the check stops firing.
