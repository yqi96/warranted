---
name: cite-review
description: Use when citations in a LaTeX manuscript need checking against what the cited papers actually say — prose that may overstate, understate, or mischaracterise a source. Not for writing new prose or creating citations; that is literature-writing.
---

## Goal

Every `\cite{prop_N}` in the tex must faithfully represent proposition N on **two axes**:

- **Content** — the sentence asserts what the proposition's `content` says. Stronger, weaker, or categorically different is a citation error.
- **Strength** — the sentence's confidence matches the proposition's `qualifier`. Asserting flatly what the graph holds at `possibly` is a citation error even when the content matches word for word.

The second axis exists because the qualifier is a single credibility scale: the graph now states how much it believes each proposition, so prose can contradict it without misquoting it.

**Done means**: every citation reviewed on both axes; every mismatch resolved by (a) a corrected proposition plus a repointed citation, (b) rewritten or removed LaTeX, or (c) a qualifier change you actually judged and can defend. Consequences this skill cannot close on its own — a new proposition left `unestablished`, a conclusion whose evidence you removed, an unjudged rebuttal — are named as open gaps, not silently left.

## Phase 1 — Extract In Resident Context

Identify the `.tex` file(s). If the user did not specify a path, find `.tex` files in the project directory.

Scan the tex for every `\cite{...}` containing `prop_N` keys. A single `\cite{}` may carry multiple keys, e.g. `\cite{prop_1, prop_3}`. For each key in each cite, emit one tuple `(proposition_id, file_path, line_number)` — a flat list, one entry per proposition per cite occurrence. Do not read surrounding text, call `get_argument`, or open any PDF here. Hand the list to Phase 2.

**Legacy `statement_N` keys are stale, not renamed.** They point into the retired Statement ontology, whose graph is archived read-only. Never assume `statement_7` means `prop_7` — the number would silently land on an unrelated proposition. Re-identify what each legacy key was citing, find or create the proposition that says it, and repoint the key. Report any key you cannot re-identify instead of guessing.

## Phase 2 — Parallel per-cite review

Delegate one bounded review per `(proposition_id, file_path, line_number)` tuple, all in parallel. Each review is self-contained and answers a single question: **does the citing sentence faithfully represent proposition N, in content and in strength?**

The check:

- Extract the sentence(s) carrying the factual claim this cite supports as `latex_claim` — enough that the assertion is unambiguous. If the `\cite{}` lists multiple keys, this review still judges only `proposition_id`; siblings share the same `latex_claim`.
- Compare `latex_claim` against proposition N's `content`. **Faithful** means the LaTeX makes no stronger, weaker, or categorically different claim; paraphrase is fine, mischaracterisation is not.
- Compare the sentence's confidence against proposition N's `qualifier`:

  | The sentence | Faithful when the qualifier is |
  |---|---|
  | attributes to the source ("Smith et al. report X") | any band — the sentence claims only that the paper says it. `refuted` is faithful **only if** the sentence also carries the refutation |
  | hedges ("X may hold", "evidence suggests X") | `possibly`, `probably`, `certainly` |
  | asserts flatly ("X holds") | `probably`, `certainly` |

  Citing an `unestablished` proposition for anything but an attributed report is a strength mismatch. So is hedging what the graph holds at `certainly` — under-reporting is also a divergence between prose and graph.
- If both axes are faithful → `MATCH`.
- On a content mismatch, read the proposition's attached paper and determine whether `latex_claim` is directly extractable — in text, a table, or a figure — without inference or aggregation.

Each review returns one report in this shape, which Phase 3 consumes:

```
MATCH
proposition_id: N
location: <file:line>
```

or

```
MISMATCH
proposition_id: N
location: <file:line>
axis: CONTENT | STRENGTH | BOTH
latex_claim: <what the LaTeX asserts, and how strongly>
proposition_content: <what proposition N actually says>
proposition_qualifier: <its current band>
divergence: <one sentence on how they differ>
pdf_verdict: SUPPORTS | DOES_NOT_SUPPORT | N/A        # N/A for a pure strength mismatch
pdf_evidence: <verbatim excerpt or figure caption, or "none found">
recommendation:
  if axis is STRENGTH only →
    REWRITE: <corrected sentence whose confidence matches the current qualifier>
  if SUPPORTS →
    CREATE_PROPOSITION: <exact content string for the new proposition>
  if DOES_NOT_SUPPORT and the paper contains a relevant finding →
    CREATE_PROPOSITION: <content for a new proposition based on what the paper does say>
    REWRITE: <corrected latex_claim matching the new proposition>
  if DOES_NOT_SUPPORT and no relevant finding →
    REMOVE_CITE: <corrected sentence with the citation removed>
```

## Phase 3 — Global Reasoning And Correction

Receive all reports and read across them as a whole before acting:

- Are multiple mismatches the same systematic overclaim (e.g. a whole paragraph misrepresenting one paper)? A paragraph rewrite may be more coherent than per-cite patches.
- Are any MISMATCH/DOES_NOT_SUPPORT citations load-bearing to the argument? Flag them explicitly before removing them.
- Do two CREATE_PROPOSITION recommendations produce equivalent propositions? Merge into one `create_propositions` item and update all affected citations.
- Do several strength mismatches point the same way? A manuscript that flatly asserts a dozen `possibly` propositions has a systematic confidence problem, and reporting it as one finding is more useful than twelve rewrites.

Then apply corrections:

**Content mismatch, pdf_verdict SUPPORTS, or DOES_NOT_SUPPORT with a relevant finding**

1. `create_propositions` with `content=<recommendation.CREATE_PROPOSITION>` and `evidence={attachments: [<same PDF path>]}`. Write the `warrant` only if you can state the general principle that lets this paper support this content; leave it empty otherwise.
2. In the tex, rewrite the sentence to `recommendation.REWRITE` if present, then replace `\cite{prop_OLD}` with `\cite{prop_NEW}`.
3. Leave the original proposition untouched.

The new proposition lands at `unestablished` — `create_propositions` takes no qualifier. **Do not reflexively `set_qualifier` it up.** Confirming a paper says something establishes provenance, not credibility, and this review saw one PDF and one sentence, not the evidence picture that a band is a judgment about. Either judge it deliberately and say what the judgment rests on, or leave it `unestablished`, make the citing sentence an attributed report, and name it as an open gap.

**Content mismatch, pdf_verdict DOES_NOT_SUPPORT and no relevant finding**

Apply `recommendation.REMOVE_CITE` — drop the `\cite{}` and use the corrected sentence. No graph writes.

**Strength mismatch only**

The default fix is the prose: apply `recommendation.REWRITE` so the sentence claims what the graph believes. Changing the qualifier instead is a judgment about the whole evidence picture, not a citation repair — do it only when this review actually surfaced the evidence that moves the band, and say so. If you believe the band is wrong but cannot justify moving it from what you saw here, name it as an open gap.

## Phase 4 — Graph Reconciliation

Every tex edit in Phase 3 is a structural change that may open or close graph gaps. Address each before concluding.

**Wire new propositions into the argument.** For each proposition created in Phase 3, name the proposition the paragraph's thesis corresponds to, then `update_proposition(<that proposition>, evidence={add_nodes: [<new id>]})`. Do not remove the old proposition from any evidence slot — corrections are additive.

If the paragraph's thesis has no proposition at all, that is a writing gap rather than a citation error: name it and leave it to `literature-writing`. If the consuming proposition has an empty `warrant`, note it — the structural check will flag it the moment anyone tries to carry that proposition to `possibly` or above.

**Repair conclusions that lost evidence.** For each removed citation, `get_argument` on the proposition whose evidence slot the removed proposition sat in, and judge whether the remaining evidence still carries it.

- If it no longer does, `set_qualifier` down to the band the remaining evidence earns, and name this in your summary.
- If the rewrite turned the paragraph's thesis into a materially different proposition, update that proposition's `content` to match. Revise only when the prose genuinely no longer expresses the original proposition, never to paper over the gap a removed citation leaves.

You do not have to track which propositions need rechecking: changing an evidence slot changes the proposition's fingerprint, so its structural warnings recompute and every previously dismissed warning on it re-arms by itself. Read what comes back.

**Propagate structural problems.** If a correction revealed that a paragraph's argument does not hold — a substantive logical gap, not a misquote — record it rather than leaving it implicit:

- a finding that limits what a proposition can claim → `create_propositions` with `attacks={node, slot: "content"}`
- a warrant whose inference no longer holds under the corrected evidence → `update_proposition(warrant=...)`, or, if the warrant was promoted, edit the promoted proposition instead
- a proposition the corrected evidence collectively disputes → the rebuttal above *is* the record; leave the qualifier alone and name it as an open gap. `refuted` requires every rebuttal to stand at `possibly` or better, and the one you just created is `unestablished`; judging it is argument-audit work this skill's scope excludes.

**Settle.** Call `get_stats` and report what is red after your run: unresolved findings, structural violations, propositions marked for recheck. There is no compile step — structural checks recompute after every change on their own. If a correction leaves you unsure whether a proposition's evidence still carries it, `review` that proposition for a second opinion; the findings it returns are yours to settle, not the skill's to close.

## Constraints

**No fabrication.** A new proposition's `content` must be directly extractable from the attached paper. Do not synthesise or generalise.

**One proposition per finding.** If a paper supports multiple distinct findings relevant to a mismatch, create one proposition per finding and decide which each corrected citation should use.

**Graph edits are additive.** Never edit an existing proposition's `content` or `warrant` to make it fit the sentence — the corrected citation gets a *new* proposition and the original is left standing. The only non-additive changes permitted here: lowering a qualifier whose evidence you just removed, and revising a consuming proposition's `content` when the prose has materially changed the asserted thesis.

**Flags are read, not silenced.** Writes return warnings; read every one. Fix what it points at, or `dismiss` it with your reason. Editing content until a check stops firing is the one repair that is never allowed.

**Scope.** Review citation accuracy and the graph consequences of correcting it. Do not perform a full argument audit, and do not re-run literature evidence construction.
