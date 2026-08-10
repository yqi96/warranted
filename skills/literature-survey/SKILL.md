---
name: literature-survey
description: Use when surveying literature at scale — dozens to hundreds of papers — to build a taxonomy, locate a gap, establish a trend, or screen a large candidate pool. Not for prose; hand off to literature-writing for the write-up.
---

## Phases

| Phase | Ends when | Graph state produced |
|---|---|---|
| 1. Scope | The protocol Statement exists | One `meta:protocol` Statement holding question, criteria, planned search |
| 2. Screen | No row in `screening.csv` is still `PENDING`, and every `INCLUDED` row has a `paper:` tag | Candidate ledger on disk; tag ledger of inclusions; protocol Statement updated with actual counts |
| 3. Extract | Every `INCLUDED` tag has statements or a terminal status | Pending Statements carrying only `paper:` tags |
| 4. Classify | No Statement has a `paper:` tag without a `theme:` tag | Converged theme vocabulary; every Statement classified |
| 5. Synthesize | Every Claim has a verdict — or is `proposed` for a reason written into its Warrant — every theme either carries a Rebuttal or says in its Warrant why its evidence is consistent, and compiles are fresh | Multi-root DAG; everything attached to it verified |

Build no Warrants before phase 5. Adding a Ground to a Warrant invalidates that Claim and every Claim above it, so any argument structure built during ingestion gets recompiled on every subsequent batch.

Phases 3 and 4 alternate. Run phase 4 every 3–5 extraction batches — never extract everything and classify at the end. A taxonomy built once, at the end, is dominated by whatever you read last.

## Phase 1 — Scope

Before any search, create the protocol Statement:

```
create_tags([
  {name: "meta:protocol", description: "Survey protocol and screening record"},
  {name: "meta:conflict",  description: "Statement conflicts with another finding; resolve in phase 5"},
])
create_statement(
  source="observed", verification="pending", tags=["meta:protocol"],
  content="<research question> | Inclusion: <criteria> | Exclusion: <criteria> | Planned search: <venues, years, queries>"
)
```

This node is not bookkeeping. It becomes the Backing of the coverage Warrant in phase 5, it is the only place the survey's scope survives a lost session, **and it is the text every screening subagent is given verbatim.** Write the criteria in it in full — not a summary of them. A criterion you compress here is a criterion the screeners never receive.

Also decide, now, the **closed list of exclusion reason codes** — `LANG`, `VENUE`, `YEAR`, `OFF-TOPIC`, `NOT-PRIMARY`, and whatever else this survey needs. Fix it before the first candidate is seen, for the same reason the criteria are fixed now: several screeners with no memory of each other write into one column that a coverage audit later counts. Free-form reasons across four dispatches produce four names for the same exclusion, and `EXCLUDED — not English` / `EXCLUDED — non-english` / `EXCLUDED — language` cannot be aggregated. **This is the closed-vocabulary discipline you already apply to `theme:` tags, applied to a CSV column — with no registry to enforce it, so it holds only if every brief carries the same list.**

In phase 1 the Statement is a placeholder: its content is a search you intend to run, which is a plan rather than an observation. Phase 2 replaces the plan with what the search actually returned, and that is the version phase 5 verifies. Create it anyway now — the scope has to have a home before the first query runs.

## Phase 2 — Search and screen

**The screening is delegated; the criteria, the reason codes, the tag registry, and the audit are not.** Read that division before dispatching anything, because what you keep is exactly what the coverage argument later rests on.

`screening.csv` lives next to the graph database — the same directory the review process resolves attachment paths against. Say the directory in every brief, and use that same path when you attach the file and when you `grep` it on resume; a path that only resolves from someone's working directory produces a failed `grep`, and **a failed `grep` is indistinguishable from a file that was never written.**

### Two dispatch modes

`literature-searcher` runs in one of two modes, and the difference matters more than it looks:

- **Mode A — search and screen. Runs exactly once per survey.** No file exists yet. The searcher runs the queries, writes every candidate it found with `decision=PENDING`, and *then* rewrites decisions in place. It returns the path, the total row count, the decided row count, and the reason-code distribution — never the candidate list.
- **Mode B — screen only.** A file exists with `PENDING` rows. The searcher is given the path, an explicit row range, the criteria verbatim, and the reason-code list. It **runs no queries and adds no rows**; it decides `PENDING` rows inside its range and touches nothing else.

Mode A writes `PENDING` first and decides second, and that two-step is not a formality: it is what makes an interrupted run resumable by Mode B instead of by a second search.

**Dispatch Mode B sequentially, one at a time, in ranges of about 150 rows.** Never in parallel: the CSV has no locking, and two concurrent writers lose rows silently — and rows are the one quantity in this survey that cannot be rebuilt. Six hundred candidates do not fit in one subagent's context either, which is why the range exists at all; a screener that runs out of context dies with every decision it had not yet written.

Every brief carries, verbatim: the inclusion and exclusion criteria **copied from the protocol Statement** (copy the text, do not restate it — the reviewer later checks the CSV against that Statement, so a paraphrase means the screener was judging against criteria the reviewer never sees), the closed reason-code list, the row range, the file path, and the two prohibitions: change no row that is not `PENDING`, and change the total row count not at all.

### After every dispatch, reconcile two counts

> Record the **total row count** and the **decided row count** (rows whose `decision` is not `PENDING`) before dispatching. When the subagent returns, check both: **the total must be unchanged** — if it changed, the searcher wrote rows it had no business writing; and **the decided count must have gone up** — not merely "not down". Either mismatch: stop and do not continue phase 2.

Both numbers are needed, and "gone up" rather than "not gone down" is the point. An unchanged decided count is exactly what a screener that ran out of context and wrote nothing leaves behind — indistinguishable, from the outside, from a screener that had nothing to do. And checking only the total misses the worst case: re-running the same queries returns roughly the same number of candidates, so a whole-file overwrite leaves the total looking perfectly normal while every `decision` has gone back to `PENDING`. **This reconciliation is the only moment at which damage to the coverage denominator is detectable.**

### Then the parts that stay with you

```
# after Mode A returns:
update_node(<protocol>, attachments=["screening.csv"])
# spot-audit: read 15-20 decided rows spread across the dispatches,
#   check each code against the criteria
# then read the INCLUDED rows out of the file yourself and register them, in batches
create_tags([
  {name: "paper:<key>", description: "INCLUDED — <one-line placement>"},
  ...
], namespace_cardinality="dense")
```

**The included rows come from the file, not from the subagent's reply.** A screener returns counts and a reason distribution only — never rows — because returning two hundred of them would put back the context cost the whole phase exists to avoid. So `grep INCLUDED` the file and work from that. This is the largest thing still on your side of the boundary, around 8k tokens for two hundred papers, and it is not removable: a tag name needs the paper's bibkey and a description needs its placement, so both need the row. Delegating the screening does not delegate this.

**The spot-audit is not optional.** It is the only first-person element left in the coverage argument: the criteria were fixed in advance and every exclusion carries a code, but nobody has judged any individual exclusion except the subagent whose context is gone. Fifteen to twenty rows spread across the dispatches costs about a thousand tokens. Skip it and the survey's denominator is a number no one has looked at.

**If this survey's central claim is a gap claim — "no prior work does Z" — screen the candidates that plausibly do Z yourself.** Those exclusions are not housekeeping; they *are* the argument, and delegating them delegates the claim. The `query` column makes the split mechanical: take the rows from the queries that targeted Z, hand the rest to Mode B by range.

Three status words for `paper:` tag descriptions, exactly these, at the start: `INCLUDED`, `READ-NO-FINDING`, `MERGED`. They are read back on resume; free-form descriptions break recovery. `MERGED` is written in phase 4 and is explained there.

Tag names: `paper:` + the bibkey lowercased with every character outside `[a-z0-9_-]` replaced by `-`, disambiguated with `-2` on collision. The tag is an organizational handle, **not** the citation key — the citation key is the attachment filename `<bibkey>.pdf`. Never reconstruct a bibkey from a tag.

Then close the protocol Statement:

```
update_node(<protocol>, content="<... | Executed: N candidates, M included, K excluded (reason distribution) | Screening: delegated, spot-audited at <n> rows>")
```

Say in that sentence that the screening was delegated and how many rows you audited. The reviewer verifying this Statement checks it against the CSV, and a sentence that reads as a first-person judgment of four hundred exclusions is a sentence the CSV cannot support.

**Do not pass `attachments` in that call.** The parameter replaces the whole array rather than appending, and attachments are not part of the structural change that invalidates a compile — so dropping the CSV here produces no error, no warning, and no compile finding. The file is the only record of four hundred exclusions.

That file is the answer to "why didn't you consider X" — the question a survey's coverage claim has to survive. Do not create Statements for excluded papers and do not tag them: a rejection is a row, not a proposition, and tagging every candidate would triple the vocabulary you have to read past for the rest of the survey.

## Phase 3 — Batch extraction

Delegate to `literature-extractor`, 5 papers per subagent, up to 6 in parallel. Its brief must fix every field below:

| Brief field | Value |
|---|---|
| Toulmin obligation | Acquire literature Statements for the survey's evidence pool |
| Papers | PDF paths **relative to the project root** — the directory the graph database sits under — one `paper:` tag per paper, stated explicitly. The papers directory must be **inside** that root: the reviewer that later verifies these Statements runs with the project root as its working directory and can only read what is under it |
| Question | Which propositions in these papers bear on `<the survey question>` |
| Allowed writes | `create_statements` only, **one call per paper**; `tags` may contain only the `paper:` tag given for that paper, plus `meta:conflict` where it applies |
| Content of each Statement | The proposition, plus the **scale of the evidence behind it** (n, number of benchmarks, number of model families — whatever the paper reports; write "not reported" when it reports none) and its **polarity**: positive, null, or boundary |
| Report format | Per paper: statements created (ids), advisory theme keywords, conflicts flagged, **every warning the tool returned, copied verbatim (or `no warnings`)**, `READ-NO-FINDING` or `FAILED: <reason>` |

State in every brief, verbatim:

- Do not invent, register, or assign a `theme:` tag. Return theme keywords as plain words in the report; the main agent owns classification.
- Create every Statement with `source="literature"` and `verification="pending"`. Do not pass `verified`. A survey's evidence pool is other people's findings; you are not recording observations of your own. The tool will *warn* rather than refuse if you pair a `paper:` tag with `source="observed"` — that combination is legitimate in reproduction work, but in extraction it always means the source field is wrong. Treat the warning as a hard stop: fix it and resend the call.
- **Copy every warning the tool returns into your report, verbatim, even the ones you already fixed.** You are the only one who sees the tool's return text — the main agent sees your report and nothing else. A warning you silently resolve leaves no trace, and a warning you silently ignore is indistinguishable from one that never happened.
- One `create_statements` call per paper. The call is atomic — if any item is rejected, nothing from that paper is written and you resend the whole call after fixing it. Batching five papers into one call means one bad item costs you all five.
- Pass `limit` on every `search_nodes` call (20 is enough). Without it, a common term matches hundreds of nodes and floods your context before you have read the papers.
- Do not link Statements to anything. No warrants, no claims, no rebuttals.
- Carry the evidence scale and the polarity in the sentence itself. "Improves task success" is not a proposition — "improves task success by 3.2 points averaged over 12 benchmarks (positive)" is. Without the scale, the main agent cannot tell a twelve-benchmark result from an anecdote when it later selects which Statements license a generalization, and a Statement that generalizes past what the paper reported will fail its own verification.
- Flag `meta:conflict` only for what you can actually see: a paper that contradicts itself, or one that explicitly reports failing to reproduce a named prior work. Two papers in your own batch that clash also count. **Write the other work's bibkey into the sentence** — the tag survives a lost session, your report does not, and a conflict flag with no pointer just means someone re-investigates from scratch. Do not go searching the graph for conflicts; papers extracted in parallel are not in the graph yet, so the search cannot succeed and the main agent handles it in phase 5. Do not try to record any of this as a Rebuttal — a Rebuttal must target a Claim or Warrant, and at extraction time none exist yet.
- Every Statement must attach its paper as `<bibkey>.pdf` under the agreed papers directory, written as a project-root-relative path. Three failure modes ride on this: a Statement with no attachment can never be verified; a path that only resolves inside your working directory is unresolvable weeks later; and a path that resolves *outside* the project root cannot be read by the reviewer at all. None of the three shows a symptom until phase 5.

On each report:

- `FAILED` entries → re-dispatch that paper. Resending is safe: a rejected batch wrote nothing, so a re-dispatch cannot duplicate Statements. A failed paper's tag stays at zero nodes, which is also how a later session finds it.
- A `paper:` + `source="observed"` warning in the report's warnings field → re-dispatch that paper. The service layer lets that combination through because it is correct in reproduction work; **this report field is the only place a survey ever sees it.** If a report's warnings field is missing entirely, treat that as a failed report and re-dispatch — an extractor that does not transcribe warnings is one whose warnings you have no way to read.
- `READ-NO-FINDING` → `update_tag("paper:<key>", description="READ-NO-FINDING — <why>")`. Without this the paper looks unextracted forever.
- Advisory keywords → carry them into phase 4; they are input to your judgment, not a vote.

Extraction volume: 2–3 propositions per paper is normal. A subagent returning 10 statements from one paper is transcribing, not extracting — the brief's question was too loose.

## Phase 4 — Incremental taxonomy

Run this loop every 3–5 batches, in this order:

1. `list_tags(prefix="theme:")` — read the counts before looking at new material. A theme at 1–2 nodes after several batches is probably a false category; a theme past ~40 probably needs splitting.

   **This step is the only defense against category drift, so do not skip it.** The closed vocabulary catches spelling drift, not conceptual drift: registering `theme:long-term-recall` in batch 9 when `theme:episodic-memory` has held that content since batch 3 raises no near-match warning, because the two names are nowhere near each other. Nothing but reading the existing counts will catch that.
2. `merge_tags` near-duplicates immediately; `rename_tag` when a category's real content has drifted from its name. Do not defer vocabulary repairs to the end — later batches will be classified against the broken vocabulary.
3. `list_statements(tag="paper:*", without_tag="theme:*", limit=50)` — the unclassified backlog. **Always leave `offset` at 0.** Classifying removes items from this result set, so paging forward with `offset=50` skips fifty unclassified Statements that shifted down. Re-query from 0 after each `tag_nodes` call; the header count tells you the backlog is shrinking.
4. Classify. New category → `create_tag("theme:x", "<what belongs here, what does not>")`. The description is the category's definition; write it so a later session can classify against it.
5. `tag_nodes(node_ids=[...], add=["theme:x"])` — one call per theme, not one per Statement.

Deduplicate while classifying, not while extracting. Parallel subagents cannot see each other, so two papers reporting the same finding produce two near-identical Statements. When `search_nodes` shows a duplicate: keep one, `update_node(<keeper>, attachments=[<union of both>])`, then `delete_node` the other. `attachments` **replaces** the array — pass the union or you silently drop a paper.

**When deleting the last remaining Statement of a paper, write the paper's tag back to `MERGED` in the same breath:**

```
update_tag("paper:<key>", description="MERGED — propositions folded into #<keeper id>")
```

A confirmatory study whose every proposition duplicates an earlier paper's loses all of its Statements this way, and among two hundred papers that is routine rather than rare. `node_tags` rows go with the deleted nodes through `ON DELETE CASCADE`, so that paper's tag drops to zero nodes — which the resume table reads as *not extracted*. Without the writeback you re-dispatch it, it produces the same propositions, you deduplicate them again, and the next session finds it at zero again. Each turn of that loop costs a real subagent. **The keeper's id is not optional**: without it a coverage audit asking "did you read this one?" has no answer, because the paper's only trace is a status word.

A Statement may carry several theme tags. Forcing one tag per Statement fabricates a partition that the evidence does not have.

**If classifying exposes a coverage gap that needs more candidates, that is a new search, not a repair of the old one.** Write the new candidates to a *new* file and record the decision in the protocol Statement: what the gap was, which queries you added, how many candidates came back. Never append to `screening.csv`. Its row count is the denominator every coverage claim rests on; once rows arrive from two different searches the table cannot say which row came from which, and the denominator degrades silently — the one failure mode this whole arrangement exists to prevent.

## Phase 5 — Synthesis, verification, compile

Verify first, build the DAG second, compile third, settle status last. Verification comes before the Warrant exists, and that ordering is doing real work — see Verification discipline.

### Selecting Grounds

Per theme, in this order:

```
list_statements(tag="theme:x")          # read all of it — select evidence and spot counterexamples in one pass
verify_statements(ids=[8-12 candidates])  # BEFORE the Warrant exists
create_claim(...)
create_warrant(ground_ids=[the ones that passed], backing_ids=[...])
update_tag("theme:x", claim_id=<claim>)   # category and Claim point at each other
```

**Verify the candidates before you build the Warrant, not after.** Verification fails routinely — `Verified 165/168` is the normal outcome — and at a per-Statement pass rate around 0.9, a Warrant carrying eight Grounds passes cleanly only about 43% of the time. Verify afterwards and you spend most themes removing a Ground from a Warrant, which reverts that Claim *and every Claim above it* to `proposed`/`stale`, invalidates the compile, and leaves the Warrant's prose ("these eight studies…") describing a set that no longer exists — so you edit the prose, which is another structural change, which invalidates it again. Verify first and a failed candidate is simply not selected: no structural change, no cascade, and the Warrant's text is accurate the first time it is written.

Select 8–12 candidates to end up with 6–10 Grounds. The extra verifications are not waste — a representative Statement that verified but did not make the ground set is almost certainly one the write-up will cite, and citing it requires it verified anyway. You are paying that bill early at one review each, instead of late at one review plus a recompile of the whole ancestor chain.

Pass `backing_ids` when you create the Warrant, not afterwards. Attaching a Backing later is a structural change: it invalidates that Claim and every Claim above it, so a Backing added after the compile costs a full recompile of the chain. The same goes for Rebuttals — see below.

Membership and grounding are different relations, and collapsing them is the single most expensive mistake available here:

- `theme:x` says a Statement **belongs to** the category. That is the coverage record.
- `ground_ids` says a Statement **licenses** the generalization. That is the argument.

Ground on the Statements that establish the claim across the range that matters — the strongest, the earliest, the boundary cases, the ones a skeptic would demand. The extraction contract requires each Statement to carry its evidence scale and its polarity, which is what makes "the strongest" and "the boundary cases" readable off the list instead of a guess. Without those fields the only thing distinguishing forty similar Statements is how confidently each is worded, and selecting by confidence of wording is selecting by rhetoric. The Warrant then has to say why *those* license the generalization, which is a real inference principle; "these forty papers all say X" is a tally, not a Warrant. The other thirty stay theme-tagged and pending: they are what the category's count and the coverage argument rest on, and a counterexample among them is a Rebuttal, not a silent omission.

Grounding the whole theme instead costs three ways: every Statement becomes load-bearing, so nothing is saved by creating them pending; `supported` then requires all forty verified rather than eight; and a forty-Ground Warrant is too large for anyone, reviewer or human, to actually assess.

### Building upward

Cross-cutting Claims (the taxonomy, the trend, the gap) take the theme Claims' ids as `ground_ids`. The coverage Warrant — the one licensing any "no prior work does Z" — takes the `meta:protocol` Statement as its Backing, and carries the search's known boundaries as Rebuttals: unindexed venues, language limits, the preprint cutoff date. A coverage boundary belongs on the graph as a Rebuttal, not as a hedge in the prose.

**The coverage Warrant must also say that the screening was delegated.** Its Backing is a protocol Statement whose exclusion decisions were made by subagents against fixed criteria, spot-audited at a stated number of rows — not judged one by one. That is a sound basis for a coverage claim and a weaker one than a per-row judgment, and the Warrant is where the difference gets stated. A Warrant that reads as though four hundred exclusions were each considered is asserting more than the Backing can carry.

**Attach `screening.csv` to each of those boundary Rebuttals too.** They are `observed` Statements and a Statement cannot be marked `verified` without attachments, so a boundary Rebuttal with nothing attached can never reach the state the handoff requires of it — and the reviewer would have nothing to read. The CSV is not a stand-in: its `venue`, year, and `query` columns **are** the evidence for "unindexed venues are not covered" and "preprints stop at 2026-03", so the reviewer opens the same file it already opens for the Backing and checks these against it at no additional cost.

**Verify the protocol Statement and the boundary Rebuttals before you create the coverage Warrant** — the same rule as Grounds, for the same reason, and stated as one rule so you never have to work out which parts of the graph a given failure would invalidate:

```
verify_statements(ids=[<the meta:protocol Statement>, <the boundary Rebuttal Statements>])
create_warrant(claim_id=<coverage claim>, ground_ids=[...], backing_ids=[<protocol>])
# then attach the Rebuttals, then compile
```

The protocol Statement is the single most likely thing in the whole survey to fail its review: verifying it is the one moment anyone opens `screening.csv` and checks its candidate and inclusion counts against the sentence, and that sentence — `Executed: N candidates, M included` — is a number you wrote by hand from counts a subagent reported. When it fails, the only repair is rewriting the Statement's content, and content is a structural change. Verify first and that repair costs nothing, because nothing is resting on it yet. **Where it gets genuinely expensive is the other path**: if a protocol or boundary Statement slips through to the final sweep below and is verified — or repaired — after the upper Claims have compiled, then editing its content invalidates the coverage Claim and everything above it, at the very top of the tree.

**Attach every Rebuttal before you compile the Claim it targets.** A Rebuttal created with `create_statement(rebuttal_for=...)` does not invalidate an already-passed compile, so one added afterwards is invisible to the chain review — and a Claim can then be marked `disputed` on the strength of a compile that never saw it.

A Claim that takes lower Claims as Grounds counts them as settled once they have earned a verdict — `supported` or `disputed`, but not `proposed` and not `refuted`. So **settle each level before compiling the one above it**, and do not skip a level. Compiling too early gives you a warning naming the Ground Claim that has no verdict yet; the hard stop comes when you try to set the status.

A `disputed` theme does not block the Claims above it, and that is deliberate. A cross-cutting Claim usually draws on a theme's *scope* rather than its truth: that a mechanism family exists and assumes unbounded storage is what licenses "no family works under a fixed budget," and neither of those two facts is what the dispute is about. **When a Ground Claim is `disputed`, say in the Warrant what you draw from it** — compile warns you that you are resting on a contested conclusion, but whether that draw survives the dispute is your judgment, not the reviewer's: the logic review is never shown a Ground's status or what its dispute contests. If what you need from that theme *is* the contested proposition, then the dispute reaches your Claim too, and the honest move is a Rebuttal on your Claim, not a Warrant that stays quiet about it.

A `refuted` theme does block. The proposition is dead, and continuing to rest on it would be citing a conclusion the survey itself defeated. What usually survives is narrower — that the family exists in the literature, that it was tried — and that is a different Claim. Reground on it, or on the theme's Statements directly.

If a theme Claim honestly stays `proposed`, every Claim resting on it stays `proposed` too; that is the correct propagation, not an obstacle to route around.

**When an upper Claim will not settle, the fix is downward, never sideways.** Marking `supported` requires *some* Warrant with all Grounds verified — so hanging a second, small Warrant off that Claim with two directly-attached Statements will make the error go away, and the graph will look fine afterwards. It is not fine: the verdict then rests on two pieces of ad-hoc evidence while the Warrant carrying the actual synthesis contributes nothing to it. Go settle the lower Claims instead. A cross-cutting conclusion that has to route around the conclusions it generalizes over is not a cross-cutting conclusion.

Most theme Warrants will have no Backing, and compile will say so for each one. That warning is expected here — supply a Backing where the inference principle is genuinely contestable, and leave the rest. Manufacturing twenty Backings to silence twenty warnings is exactly the ritual compliance this graph exists to prevent.

Batch your revisions. Adding a Ground to a settled Claim invalidates it and every Claim above it, reverting their statuses. Adding three Grounds one at a time recompiles the whole ancestor chain three times.

### Conflicts and counterexamples

Finding the contradictions is your job here, not the extractors'. They read five papers each, six batches in flight, and the thirty papers being read at the same moment are by construction invisible to one another — none of their Statements are in the graph yet. Batches are cut in screening order, not by topic, so two papers from the same category rarely land in the same batch. What comes back tagged `meta:conflict` is therefore the small, high-signal set they could see without searching: a paper contradicting itself, a paper reporting a failure to reproduce a named prior work, a clash inside one batch.

The category-level conflicts surface in the pass you are already making. You read the whole theme to select Grounds; that is the moment two mutually exclusive findings in one category are visible at zero marginal cost, and it is the only moment they are. Read for both at once. `search_nodes("no significant")` and similar catch null results the extraction contract required to be marked as such.

Then resolve what you have. **Either way, clear the tag** — `meta:conflict` means "flagged, not yet handled", and a resolved conflict that keeps the tag reads as unhandled forever, sending every later session back to re-investigate something already on the graph:

- **It does contradict a Claim or a Warrant.** The conflicting proposition is *already a Statement in the graph* — phase 3 extracted it, with its `paper:` tag and its PDF attached. Attach that Statement as a Rebuttal: `update_node(<target>, rebuttal_ids={add: [<that Statement's id>]})`. Then `tag_nodes(node_ids=[id], remove=["meta:conflict"])`.
- **It is not actually a conflict** → `tag_nodes(node_ids=[id], remove=["meta:conflict"])`.

**Do not `create_statement(rebuttal_for=...)` here.** That creates a *second copy* of a finding the graph already holds: you would verify the same paper twice, the two sentences would drift apart, and when the finding is later overturned only one of them gets knocked back — the other stays quietly in place. `create_statement(rebuttal_for=)` is for propositions that genuinely do not exist yet, such as the coverage boundaries. Reusing the existing Statement is also correct *independently of any fix*: `rebuttal_ids` counts as a structural change and invalidates the compile today, whereas `create_statement(rebuttal_for=)` only does so once the invalidation gap is closed.

A theme whose evidence genuinely conflicts ends up `disputed`, and that is a result, not a failure — a twelve-category survey with zero disputed themes is more suspicious than one with two. It does not strand the cross-cutting Claims above it; see Building upward for what their Warrants then have to say.

**The completion condition is per theme, not per tag: each theme's Claim either carries a Rebuttal, or its Warrant says why the evidence in that category is consistent.** "The conflict register is empty" is not the test, and it is worth understanding why, because the reasoning generalizes. An empty register is exactly what you get when nobody looked — the worse the detection, the cleaner the gate passes, and a checked-off completion condition then stands in for a guarantee this survey never earned. A real completion condition distinguishes "we did not look" from "we looked and found none." The per-theme version leaves a different mark on the graph in each case. The register-empty version leaves the same mark in both.

### Verifying and compiling

Verification happens per theme, before that theme's Warrant exists (see Selecting Grounds), and the coverage Backing and boundary Rebuttals are verified before the coverage Warrant exists (see Building upward). **Everything here has already been verified by the time you arrive.** What is left is the compile order and the sweep that catches whatever the earlier passes missed:

```
compile_arguments(claim_ids=[<leaf claims>])              # leaves first
update_node(<leaf claim>, status=...)                     # status is gated on a passed compile
compile_arguments(claim_ids=[<claims above them>])        # then upward, once their grounds are settled
update_node(<upper claim>, status=...)
# final sweep — should come back empty:
list_statements(role="ground",   verification="pending")
list_statements(role="backing",  verification="pending")
list_statements(role="rebuttal", verification="pending")
```

**Two of the three roles are not Grounds, and nothing in the system will ever remind you about them.** `supported` checks Grounds; nothing checks Backings or Rebuttals. The `meta:protocol` Statement is a *Backing*, and verifying it is the single act that makes someone actually open `screening.csv` and check the candidate and inclusion counts against what the Statement claims. Nothing else in this protocol ever opens that file: attachments are not part of the compile hash, a wrong path produces no error, and an unverified Statement is never reviewed. Skip this and the coverage argument — the whole basis for "no prior work does Z" — rests on counts a subagent reported and nobody read back. The coverage boundaries are *Rebuttals* and fall outside the Ground query for the same reason.

The three-role sweep at the end is a check, not a worklist. It should return nothing. **Anything it returns is expensive**, and that is the point of running it last rather than relying on it: the Claims above have already compiled, so verifying a straggler now — and rewriting it if the review fails — invalidates them and everything above them.

Never call `compile_arguments` with no arguments at this scale — it fans out across every Claim at once. Pass `claim_ids` in subtree-sized batches.

**A batch will come back short — `Verified 165/168` is the normal outcome, not an anomaly.** Because you verify before building, a failure is cheap: sort by cause, fix what is fixable, and select from what passed.

- **The attachment is missing or the path no longer resolves.** The extraction contract was not honored for that paper. Fix the path and re-verify. Never narrow the Claim around a bookkeeping failure.
- **The paper does not actually say what the Statement says.** Then the Statement is wrong, and the fix is to rewrite its content so it is faithful to the source, then re-verify. Nothing is attached yet, so this costs one review.
- **Neither is fixable** — paper withdrawn, PDF unreadable, the finding simply not in the text. Leave the Statement `pending` and select a different candidate. This is the ordinary case and it needs no explanation in the Warrant, because the Warrant was never written to include it.

Verify one theme's candidate set together rather than in id order. `supported` requires **every** Ground of some Warrant to be verified, so progress is per theme: verifying across themes in id order leaves every theme at 90% and no Claim able to settle.

**One thing gets harder under this ordering, and you have to compensate for it deliberately.** When verification came after the Warrant, dropping an inconvenient Ground left a mark — a structural change, a recompile, a Claim knocked back to `proposed`. Now, declining to select a candidate leaves no mark at all. So the rule that used to be about removal is now about selection: **a Statement that verifies fine but disagrees with the Claim does not get quietly left out of the ground set.** It becomes a Rebuttal, and the Claim's status follows the evidence. That is what the per-theme completion condition above is for — it is the only thing standing where the recompile used to stand.

If a candidate genuinely cannot be verified and the Claim's evidence base is gutted without it, the honest move is to build the Warrant on what you have and **leave the Claim `proposed`, with the reason written into it**. **A `proposed` Claim with a recorded reason is a finished survey's legitimate output** — one unverifiable paper does not entitle anyone to a verdict the evidence did not earn.

Statements that were classified but not selected as Grounds stay `pending` and stay in the graph. They are not leftovers: they are the category's count and the reading record the coverage argument rests on. Do not verify them here, and never delete them to tidy the graph — deleting them removes the denominator from every coverage claim you are about to make.

## Tag discipline

- The vocabulary is closed. An unregistered tag is an error with a near-match suggestion; the error is the mechanism, not an obstacle. When you hit it, decide: reuse the suggested tag, or register a genuinely new category. Never register a near-synonym to get past the error.
- Namespaces: `paper:` mechanical, one per **included** paper. `theme:` yours alone, registered only in phase 4. `meta:` process nodes — `meta:protocol` and `meta:conflict`.
- Tags never invalidate a compile. Tagging, retagging, renaming, and merging are free after a Claim has compiled.
- A `theme:` tag with a `claim_id` and its Claim must stay consistent: if you refute or delete the Claim, `update_tag` the category or merge it away.

## Verification discipline

Everything is created `pending`. In phase 5 you verify the Grounds the argument rests on — roughly 100–150 of them, not the several hundred you extracted. That deferral is the saving.

It is not the whole bill. Every Statement the write-up cites must also be `verified`, whether or not it is a Ground, so the eventual total is closer to the number of papers you cite. Phase 5 covers the Grounds; `literature-writing` verifies the rest as it decides what to cite. Do not front-load all of it here — you would be verifying Statements that never get cited.

Three service-layer gates already enforce the honest order, so do not fight them:

- A Claim cannot be marked `supported`/`disputed`/`refuted` until its compile has passed.
- A Claim cannot be marked `supported` unless some Warrant has **all** its Grounds `verified` — where a Ground that is itself a Claim counts as verified once it is `supported` or `disputed`.
- A Statement cannot be marked `verified` without attachments.

One hole they do not cover: `compile_arguments` skips the chain review when the argument hash is unchanged, and verification is not part of that hash. So if you revert an already-verified Ground to `pending` after its Claim was marked `supported`, nothing re-checks the Claim — compile keeps reporting no change. When you revert a Ground, re-examine every Claim that uses it yourself; `get_argument` on the Ground lists them.

That same property is why the phase 5 order matters: verify **before** the compile you intend to trust, since verifying afterwards will not make it stale and will not prompt a re-check. Verifying before the Warrant exists satisfies this for free, and avoids the recompile cascade that late verification failures otherwise trigger.

A Claim whose Grounds are all still pending may compile clean. That is a structural pass, not evidence.

## Resuming after an interruption

Session loss and compaction are expected at this scale. Progress lives entirely in the graph; reconstruct it, do not recall it:

1. `get_stats` — the scale block tells you the phase, **except during phase 2**. Until the first `create_tags` call there are no tags, no Statements, and no Claims, so every counter in that block reads zero and the only one that moves is `Attachments` — which goes 0 → 1 when the CSV is attached and then never moves again. **Screening 0% done and screening 100% done are byte-identical readings.** What actually locates you in phase 2 is rows 1–3 of the table below.
2. `list_statements(tag="meta:protocol")` — the question and criteria, verbatim.
3. `list_tags(prefix="theme:")` — the taxonomy as it stands, with its category definitions.

Then read the state directly:

| Signal | Meaning | Queue |
|---|---|---|
| `screening.csv` does not exist | No search has run, or the Mode A dispatch died before writing | Phase 2, **Mode A** |
| `screening.csv` has rows still marked `PENDING` | A screening dispatch did not finish. **The candidate list is intact — do not search again** | Phase 2, **Mode B** over the `PENDING` ranges |
| `screening.csv` has more `INCLUDED` rows than there are `paper:` tags | Screening finished; tag registration did not | Phase 2, registration on the difference |
| `paper:` tag exists | Already screened in — do not re-search this paper | — |
| Description starts `READ-NO-FINDING` | Terminal — do not re-read | — |
| Description starts `MERGED` | Terminal — the paper was read and its propositions were folded into the keeper node named in the description. Do not re-dispatch | — |
| Description starts `INCLUDED`, node count 0 | Not extracted, or extraction failed. There is no half-extracted state — the write is atomic | Phase 3 |
| Statement has `paper:*` but no `theme:*` | Not classified | Phase 4 |
| `theme:` tag with no `claim_id` | The category has no Claim yet | Phase 5 |
| Statement attached to the argument (any role), `pending` | Not verified | Phase 5 |
| Statement tagged `meta:conflict` | Conflict flagged but unresolved | Phase 5 |
| Claim `passed` with all Grounds verified, still `proposed` | Only the verdict is missing — **set the status, do not re-compile** | Phase 5 |
| Claim with stale compile | Argument changed after its last pass | Phase 5 |

**`PENDING` rows mean a subagent died, not that you were mid-screening — and the two call for opposite repairs.** You never screen this file yourself (except the gap-claim subset you deliberately kept), so a half-decided file is not your unfinished work; it is a dispatch that ran out of context. `grep -n PENDING` gives you the row numbers, and those ranges go straight into a Mode B brief. **What you must not do is regenerate the file.** A half-`PENDING` file looks like a damaged artifact that ought to be rebuilt, and rebuilding it is the one irreversible mistake available in phase 2: the decisions in it are reproducible from written criteria, but the candidate list is not — re-running the queries returns a different set, and a coverage claim resting on an irreproducible number that has silently changed is not auditable. **Mode A runs exactly once per survey.** A second Mode A dispatch is legitimate only as a *new file* for a *new* search (phase 4's coverage gap), never over `screening.csv`.

**A `paper:` tag at zero nodes has three possible causes, and the description is the only thing that separates them**: never extracted, extraction failed, or deduplicated to nothing. The first two are indistinguishable and do not need to be distinguished — both are repaired by re-dispatching, and re-dispatch is safe because a rejected batch wrote nothing. The third is *not* repaired by re-dispatching, which is why it gets its own status word. This whole reading rests on one arrangement: the tag is registered **before** the paper's Statements are written, so "tag present, count zero" is a state that can physically occur. Merge tag registration into the write and it never occurs — and every distinction in this paragraph disappears with it.

The first three rows are a `grep` and a count over the CSV, not a graph query — `get_stats` reports what the graph knows and does not parse this file. Run them against the path you attached, next to the database; a `grep` that fails because the path is wrong looks exactly like a file that was never written.

**Count two numbers before every screening dispatch, and check both when the subagent returns.**

> Record the **total row count** and the **decided row count** (rows whose `decision` is not `PENDING`). When the subagent returns: **the total must be unchanged** — a Mode B dispatch adds no rows and a changed total means it wrote what it had no business writing; and **the decided count must have gone up** — not merely "not gone down".

Both numbers are needed, and "gone up" is the strict form for a reason. A decided count that did not move is exactly what a screener that exhausted its context and wrote nothing leaves behind, and from the outside that is indistinguishable from a screener that found nothing to do — so treat an unmoved count as a failed dispatch and re-dispatch the range. Checking only the total misses the worse case: re-running the same queries returns roughly the same number of candidates, so a whole-file overwrite leaves the total looking normal while every `decision` has gone back to `PENDING`. The decided count is the discriminating quantity. **Either mismatch: stop, and do not continue phase 2 — this is the only moment at which damage to the coverage denominator is detectable.**

The verdict row carries a warning because the wrong move there looks so reasonable: a screen full of `proposed` Claims invites a re-compile, and a re-compile returns `no-change` because the hash has not moved. Nothing is wrong; the verdict was simply never set. Set it.

Two of these rows exist because the obvious reading of the others is wrong. **When phase 4 has just finished and phase 5 has not started, every phase-5 signal reads zero** — no Warrants exist, so no Statement is in a ground role — which is indistinguishable from a finished survey. The `theme:` tag with no `claim_id` is what tells them apart. Likewise a Claim that compiled and had its Grounds verified but never got a verdict looks identical to one that was created five minutes ago; only its `compile_status` separates them.

The cost of an interruption is the batch or the screening range in flight. If you find yourself unable to tell what was done, the tag descriptions were written loosely — fix them with `update_tag` as you go, not the recovery procedure.

## Handoff to literature-writing

Hand off when every theme Claim and every cross-cutting Claim has a fresh compile and either a verdict or a written reason for staying `proposed`; when everything attached to those Claims — Grounds, Backings, Rebuttals — is `verified`; and when every theme either carries a Rebuttal or states in its Warrant why its evidence is consistent. Switch to `literature-writing` for the prose.

**The `meta:protocol` Statement is `verified` by the time you hand off.** It is the coverage Warrant's Backing, and verifying it is what causes `screening.csv` to be opened and its row counts checked against the numbers in the Statement. Until then, nothing in this protocol has ever confirmed that the file exists, resolves, or is non-empty — attachments are outside the compile hash and unverified Statements are never reviewed. The survey's most consequential argument would otherwise ship with unexamined evidence.

Do not start drafting before the Claims are settled in that sense. The prose projects the argument; drafting against a Claim that is still open on the evidence means writing sentences whose thesis has not been earned, then rewriting them when a compile finding lands. A Claim left `proposed` on purpose is not an obstacle to the write-up — it is a result, and the prose should say so rather than assert more than the graph supports.

Three things carry across:

- `theme:` tags with their `claim_id` map sections to Claims.
- Statements left `pending` are the classified-but-not-grounded pool. Citing one is normal — it just has to be verified first, which is `literature-writing`'s own obligation. Budget for it: a survey citing 200 papers needs 200 verified Statements, and phase 5 only got you the Grounds.
- If a `pending` Statement turns out to carry a paragraph's whole thesis, that is a synthesis gap rather than a citation gap. Return to phase 5, ground the Claim on it properly, and recompile — do not let a Warrant-less Statement hold up an argument in the prose.

**And one thing the prose must not overstate**: the screening was delegated. The coverage section says what the criteria were, what the reason distribution was, and how many rows were audited. It does not say or imply that each excluded candidate was individually considered.

Coming back for a Ground is expensive: adding one to a settled Warrant reverts that Claim and every Claim above it, so the price is one verification plus a recompile of the whole ancestor chain. That cost belongs in phase 5's selection, not here. When you pick the 6–10 Grounds, include the ones you can already tell the write-up will lean on — two extra verifications then are cheaper than one reflow later.