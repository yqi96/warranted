---
name: literature-survey
description: Synthesize what a body of literature says about a research question. Builds an argument graph where external findings are Grounds (with paper attachments) and your independent conclusions are Claims. Use when surveying a topic, synthesizing evidence across papers, or assessing whether a research claim is settled.
---

## Goal

Write a literature survey whose claims are grounded in the argument graph. The tex and the graph are coupled throughout: each `\cite{ground_<N>}` in the tex links to a Ground node that holds the cited finding and its source paper. The graph is the quality mechanism — compile verifies the argument chain, verified Grounds confirm the evidence is in hand, and the citation linkage ensures the text faithfully represents what the papers say.

There is no fixed workflow. Use the graph and the writing together however the work demands.

**Done means**:
- every Ground is `verified`; every Claim has status `supported`, `disputed`, or `refuted`; every Claim has passed `compile_arguments`
- the tex is logically coherent: the argument flows, and each citation's surrounding text faithfully represents its Ground

`proposed` is the initial state for Claims, not a resting place.

## How to use the Toulmin graph

### Extract the argument structure

Two entry points are equally valid:

**Framework-first**: formulate your research conclusions as Claims (`proposed`), then find literature to populate Grounds. Revise Claims based on what the evidence actually shows.

**Evidence-first**: collect papers first. Each paper's relevant finding becomes a Ground. After accumulating Grounds, identify the pattern and formulate Claims.

Node mappings:

- `create_claim` — your independent synthesis conclusion; `proposed` initially, advances after `compile_arguments` passes and evidence is assessed as sufficient
- `create_ground(source="literature")` — a finding, result, opinion, or argument from a specific paper; one paper can produce multiple Grounds; attach the paper file as the provenance record
- `create_warrant` — the inference principle connecting the body of Grounds to the Claim
- `create_backing` (if any) — methodological consensus or meta-analysis that legitimizes the Warrant's authority
- `create_rebuttal` (if any) — a paper with contradicting findings, or a documented boundary condition of the Claim

> **Chained reasoning**: when a sub-Claim's conclusion serves as evidence for another Claim, use `create_ground(ref_claim_id=sub-Claim.id)`.

Run `compile_arguments` after building the initial structure. Re-run it any time you modify the argument structure.

### Drive action from Claims

For each Claim, ask: what is preventing it from being marked `supported`, `disputed`, or `refuted`? Act independently to remove that blocker, update the graph, and re-examine. Repeat until every Claim has a clear status.

- Grounds missing → search for papers, extract findings
- Grounds not yet verified → attach paper files, then batch-mark `verified`
- Argument chain incomplete → add Warrant or Backing
- `compile_arguments` fails → fix the chain structure

## Writing

Write the survey in `.tex`, citing Grounds by ID — `\cite{ground_42}` — rather than managing bib keys while writing. This keeps the text coupled to the argument graph.

Name each paper using its bib key as soon as it is downloaded: `vaswani2017attention.pdf`. It makes three identifiers converge on one string throughout the process:

| Element | Value |
|---------|-------|
| `.bib` entry key | `vaswani2017attention` |
| Local paper file | `/path/to/vaswani2017attention.pdf` |
| Ground attachment | `/path/to/vaswani2017attention.pdf` |

**Maintain the `.bib` file as you go.** Every time you add a paper, add its BibTeX entry to the project `.bib` file immediately — do not batch this at the end. The bib key must match the filename stem exactly. Required fields: `author`, `title`, `year`, and venue (`journal`, `booktitle`, or `url` for preprints). A Ground whose attachment has no matching `.bib` entry is incomplete.

**Synthesize, don't enumerate.** Each paragraph makes a claim and marshals evidence for it. The structure is: claim → evidence → inference. Do not write "Paper A says X. Paper B says Y." — that is a list, not a survey.

**Claim-first.** Open each paragraph with the point it establishes. Citations follow as evidence; they do not precede the point.

**Attribute precisely.** Distinguish three voices:
- What a paper reports: "Smith et al. found that..." / `\cite{ground_N}`
- What the evidence collectively shows: "The evidence suggests..."
- What you conclude: "We argue..." / a Claim node

Never let these blur. A citation is not your argument; it is your evidence.

**No assertion without citation.** If a claim cannot be grounded in a cited paper, it belongs in a Claim node (your own synthesis, requiring a full argument chain) or it does not belong in the text. "Many studies have shown..." without a citation is not permitted.

**No padding.** Delete: "It is worth noting that", "Interestingly,", "It is well-known that", "As mentioned above". Every sentence carries weight or is cut.

**Acknowledge contradictions.** When evidence conflicts, report it directly. Conflicting Grounds become Rebuttals in the graph and are named explicitly in the text.

**Tense discipline.** Present tense for established findings and general principles. Past tense for specific experimental actions ("trained on", "evaluated over").

## Constraints

**Attribution boundary**: information from papers — whether results, claims, or opinions — is always stored as a Ground, not a Claim. Only your independent synthesis conclusions are Claims.

**Attachment is provenance**: `source="literature"` Grounds do not require a separate description document. The attached paper file is the provenance record.

**Claim revision discipline**: revising a Claim is legitimate when the evidence genuinely does not support the original formulation. It is not legitimate to revise a Claim to avoid reporting contradicting evidence. When a Claim is revised, the revision must be motivated by the evidence; if conflicting Grounds exist, record them as Rebuttals and let the Claim status reflect the state of the evidence.
