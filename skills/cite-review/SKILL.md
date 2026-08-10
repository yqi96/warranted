---
name: cite-review
description: Use when citations in a LaTeX manuscript need checking against what the cited papers actually say — prose that may overstate, understate, or mischaracterise a source. Not for writing new prose or creating citations; that is literature-writing.
---

## Goal

Every `\cite{statement_N}` in the tex must faithfully represent the content of Statement N. A citation that overstates, understates, or mischaracterises what the Statement says is a citation error.

**Done means**: every citation has been reviewed; every mismatch has been resolved by either (a) creating a corrected Statement and updating the citation, or (b) rewriting or removing the offending LaTeX. Consequences this skill cannot close on its own — a Claim reverted to `proposed`, a stale compile — are named as open gaps, not silently left.

## Phase 1 — Extract In Resident Context

Identify the `.tex` file(s). If the user did not specify a path, find `.tex` files in the project directory.

Scan the tex for every `\cite{...}` containing `statement_N` keys. A single `\cite{}` may carry multiple keys, e.g. `\cite{statement_1, statement_3}`. For each key in each cite, emit one tuple `(statement_id, file_path, line_number)` — a flat list, one entry per statement per cite occurrence. Do not read surrounding text, call `get_node`, or open any PDF here. Hand the list to Phase 2.

## Phase 2 — Parallel per-cite review

Delegate one bounded review per `(statement_id, file_path, line_number)` tuple, all in parallel. Each review is self-contained and answers a single question: **does the citing sentence faithfully represent Statement N?**

The check:

- Extract the sentence(s) carrying the factual claim this cite supports as `latex_claim` — enough that the assertion is unambiguous. If the `\cite{}` lists multiple keys, this review still judges only `statement_id`; siblings share the same `latex_claim`.
- Compare `latex_claim` against Statement N's `content`. **Faithful** means the LaTeX makes no stronger, weaker, or categorically different claim than the Statement; paraphrase is fine, mischaracterisation is not.
- If faithful → `MATCH`.
- On mismatch, read the Statement's attached paper and determine whether `latex_claim` is directly extractable — in text, a table, or a figure — without inference or aggregation.

Each review returns one report in this shape, which Phase 3 consumes:

```
MATCH
statement_id: N
location: <file:line>
```

or

```
MISMATCH
statement_id: N
location: <file:line>
latex_claim: <what the LaTeX asserts>
statement_claim: <what Statement N actually says>
divergence: <one sentence on how they differ>
pdf_verdict: SUPPORTS | DOES_NOT_SUPPORT
pdf_evidence: <verbatim excerpt or figure caption, or "none found">
recommendation:
  if SUPPORTS →
    CREATE_STATEMENT: <exact content string for the new Statement>
  if DOES_NOT_SUPPORT and the paper contains a relevant finding →
    CREATE_STATEMENT: <content for a new Statement based on what the paper does say>
    REWRITE: <corrected latex_claim matching the new Statement>
  if DOES_NOT_SUPPORT and no relevant finding →
    REMOVE_CITE: <corrected sentence with the citation removed>
```

## Phase 3 — Global Reasoning And Correction

Receive all reports and read across them as a whole before acting:

- Are multiple mismatches the same systematic overclaim (e.g. a whole paragraph misrepresenting one paper)? A paragraph rewrite may be more coherent than per-cite patches.
- Are any MISMATCH/DOES_NOT_SUPPORT citations load-bearing to the argument? Flag them explicitly before removing them.
- Do two CREATE_STATEMENT recommendations produce equivalent Statements? Merge into one `create_statement` and update all affected citations.

Then apply corrections:

**MISMATCH with pdf_verdict SUPPORTS, or DOES_NOT_SUPPORT with a relevant finding**

1. `create_statement(source="literature", content=<recommendation.CREATE_STATEMENT>, attachments=[<same PDF path>], verification="verified")`.
2. In the tex, rewrite the sentence to `recommendation.REWRITE` if present, then replace `\cite{statement_OLD}` with `\cite{statement_NEW}`.
3. Leave the original Statement untouched.

**MISMATCH with pdf_verdict DOES_NOT_SUPPORT and no relevant finding**

Apply `recommendation.REMOVE_CITE` — drop the `\cite{}` and use the corrected sentence. No graph writes.

## Phase 4 — Graph Reconciliation

Every tex edit in Phase 3 is a structural change that may open or close graph gaps. Address each before concluding.

**Wire new Statements into the argument chain.** For each Statement created in Phase 3, name the Claim it supports (the paragraph's main assertion).

- If a Warrant already connects the old Statement to that Claim, `update_node` to add the new Statement to the Warrant's `ground_ids`.
- If no Warrant exists, `create_warrant` linking the new Statement to the Claim.

Do not remove the old Statement from existing Warrants.

**Repair orphaned Claims.** For each removed citation, `get_argument` on the Claim that Statement supported and evaluate whether the remaining Grounds still establish it.

- If the Claim is now unsupported, revert it to `proposed` via `update_node` and name this in your summary — a `proposed` Claim is an open gap this skill cannot close unilaterally.
- If the rewrite turned the paragraph's thesis into a materially different proposition, update the Claim's `content` to match. Revise only when the prose genuinely no longer expresses the original Claim, never to paper over the gap a removed citation leaves.

**Propagate structural problems.** If a correction revealed that a paragraph's argument does not hold — a substantive logical gap, not a misquote — record it rather than leaving it implicit:

- a finding that limits the Claim's scope → `create_statement(rebuttal_for={target_id, target_type})`
- a Warrant whose inference principle no longer holds under the corrected Grounds → `update_node` on the Warrant, or replace it
- a Claim the evidence collectively disputes → the Rebuttal above *is* the record; leave the status alone and name it as an open gap. `disputed` requires a **verified** Rebuttal plus a passing compile, and the Rebuttal you just created is `pending` — verifying it is argument-audit work this skill's scope excludes.

**Compile.** Call `compile_arguments` on every Claim this run touched. A stale or failing compile after correction is an open gap — name it in your summary.

## Constraints

**No Statement fabrication.** A new Statement's `content` must be directly extractable from the attached paper. Do not synthesise or generalise.

**One Statement per finding.** If a paper supports multiple distinct findings relevant to a mismatch, create one Statement per finding and decide which each corrected citation should use.

**Graph edits are additive.** Never delete or modify an existing Statement or Warrant. The only non-additive updates permitted: revise a Claim's `content` when the prose has materially changed the asserted proposition, and revert a Claim's `status` to `proposed` when its argument chain is broken.

**Scope.** Review citation accuracy and the graph consequences of correcting it. Do not perform a full argument audit, and do not re-run literature evidence construction.
