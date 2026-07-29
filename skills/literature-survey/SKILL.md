---
name: literature-survey
description: Use for literature-backed surveys, related work, introductions, discussions, or prose whose evidence comes from published papers. Translate citable propositions into verified literature Grounds and cite them as \cite{statement_N}.
---

## Graph Mapping

Never cite a paper directly. A citable proposition from a paper first becomes a `source="literature"` Statement (Ground role); LaTeX then cites that Statement with `\cite{statement_N}`, where N is the Statement's id. The citation is a pointer into the argument graph, not a bibliography shortcut.

```
citable proposition from a paper -> literature Statement (Ground role)
paragraph point                  -> Claim
why findings support the point   -> Warrant
methodological authority         -> Statement (Backing role)
conflicting paper finding        -> Statement (Rebuttal role)
```

Granularity:

- one paper yields multiple Grounds when it offers multiple distinct citable propositions
- one Ground carries multiple paper attachments when several papers support the same proposition
- different findings, populations, methods, measurements, or scopes are separate Grounds
- convergence across distinct Grounds is a Warrant's job, not a merge into a vague composite Ground

## Obligations

Object-layer work in this channel — search, reading, download, BibTeX, prose edits — is valid only when it creates, verifies, cites, or reconciles a literature Statement (Ground role), or a Claim built from such Statements. A searched paper must become a Ground, Backing, or Rebuttal, or be discarded with a reason; it is never accumulated as an inert reading list.

| Graph state | Required action |
|---|---|
| No Claim for a load-bearing paragraph thesis | `create_claim`, or update the existing Claim |
| A sentence cites a paper for a proposition | Reuse a matching literature Statement, or `create_statement(source="literature")` and attach the paper |
| A paper provides several relevant propositions | One `create_statement(source="literature")` per distinct proposition |
| Several papers support the same specific finding | Attach them to the same Statement only when they support the same proposition |
| A literature Statement is cited but not verified | Check the paper supports it, then `update_node(verification="verified", attachments=[...])` |
| A Claim has Grounds but no Warrant | `create_warrant(ground_ids=[...])` |
| A Warrant needs authority | `create_statement(...)`, then `update_node(<warrant>, backing_ids={add:[...]})` |
| A paper contradicts the Claim or Warrant | `create_statement(rebuttal_for={target_id, target_type})` |
| The text changes the paragraph thesis | Reconcile the Claim |
| A citation points to the wrong Ground | Point to the correct Statement, or create one; edit an existing Statement only to fix an error, never to fit the sentence |
| Existing LaTeX uses author-year keys | Migrate each: identify the cited proposition, create/reuse its literature Statement, replace the key with `statement_N` |

A citable proposition may be a result, definition, taxonomy, dataset description, method claim, limitation, opinion, or argument — but it must be specific enough that citation faithfulness can be checked.

## Citation Contract

For every external citation in `.tex`:

1. the source uses `\cite{statement_N}`
2. the Statement cited as `statement_N` exists, is `source="literature"`, and is `verified`
3. that Statement states the exact proposition being cited
4. that Statement attaches every source paper supporting it in this citation
5. each attached paper's filename stem matches a BibTeX key in the project `.bib`

This contract proves provenance, not argument strength — a citation can be faithful while the Claim stays unsupported.

Get faithfulness right while writing: each `\cite{statement_N}` sentence must already represent that Statement at the moment you write it. A mismatch caught late — after the argument has been built on it — can force reworking the paper's logic.

## Writing As Graph Projection

A load-bearing paragraph is a projection of a Claim and its supporting structure. A transitional or roadmap paragraph needs no Claim, but must not smuggle in uncited external assertions or unsupported synthesis.

- paragraph thesis matches a Claim
- sentences reporting papers cite literature Grounds
- synthesis language reflects the Warrant, not a list of sources
- contradictions surface as limitations, disagreements, or boundary conditions, and exist in the graph as Rebuttals

Keep three voices distinct:

- **Paper voice** — what a source reports → literature Ground + `\cite{statement_N}`
- **Synthesis voice** — what the body of evidence suggests → Claim + Grounds + Warrant
- **Verdict voice** — what the graph has earned → Claim status

Do not let a citation carry the argument: citations supply Grounds; Warrants explain why they matter.

## Revision Discipline

Prose and graph are coupled both ways. Any meaning-bearing edit on one side obliges a matching, honest edit on the other; they must never silently diverge.

Recurring cases:

- **Prose asserts something new** → the Ground or Claim behind it must exist first; do not write around a missing node.
- **Prose narrows, broadens, or strengthens a thesis** → re-scope or re-status the Claim so the graph actually earns the new wording.
- **Prose drops a caveat or conflict** → it must reappear as a Rebuttal or a status change, not simply disappear.
- **A Ground is corrected, a status flips, or a Rebuttal is added** → update every sentence that depends on it.

The test: if something leaves the prose without reappearing in the graph — or changes in the graph without reaching the prose — that is concealment, not revision.
