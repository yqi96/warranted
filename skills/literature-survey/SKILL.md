---
name: literature-survey
description: Use when surveying literature at scale — dozens to hundreds of papers — to build a taxonomy, locate a gap, establish a trend, or screen a large candidate pool. Not for prose; hand off to literature-writing for the write-up.
---

## Two records, one rule

A survey at this scale produces two different kinds of state, and keeping them apart is what the whole protocol rests on:

- **Propositions go in the graph.** What a paper found, what a category comprises, what the corpus supports — each is a statement someone could dispute, so each is a proposition with evidence, a warrant, and a qualifier.
- **Bookkeeping goes in the ledger files on disk.** Which candidates were seen, which were excluded and why, which included papers have been extracted, which were merged away. None of that is a proposition. It is the record that makes the coverage argument checkable, and it lives in two CSVs next to the graph database.

The graph has no tags, no categories, and no status labels to hang bookkeeping on — a node is a proposition or it does not exist. When you catch yourself wanting to mark a paper, you want a ledger row. When you catch yourself wanting to write a fact down, you want a proposition.

Both ledgers attach to the protocol proposition as evidence, so the coverage argument can actually be read against them.

| File | Header | Written by | Mutable |
|---|---|---|---|
| `screening.csv` | `title \| query \| venue \| decision` | `literature-searcher` only | Only `PENDING` → a decision. Rows never added or removed |
| `extraction.csv` | `bibkey \| status \| conflict \| note` | you only | Freely — it is a worklist |

## Phases

| Phase | Ends when | State produced |
|---|---|---|
| 1. Scope | The protocol proposition exists | One proposition holding question, criteria, planned search |
| 2. Screen | No row in `screening.csv` is `PENDING`, and every `INCLUDED` row has a row in `extraction.csv` | Candidate ledger and extraction worklist on disk; protocol proposition updated with actual counts |
| 3. Extract | Every `extraction.csv` row is past `INCLUDED` | Paper findings in the graph, all at `unestablished` |
| 4. Classify | Every extracted finding belongs to a category proposition | Converged categories; every finding classified |
| 5. Synthesize | Every generalization carries a qualifier — or stays `unestablished` for a reason written into its warrant — and every category either carries a rebuttal or says in its warrant why its evidence is consistent | Multi-root DAG, judged bottom-up |

Build no generalizations before phase 5. Every batch changes their evidence sets, and each change re-arms every warning you had dismissed on them — cheaper than the old recompile cascade, and still pure churn.

Phases 3 and 4 alternate. Run phase 4 every 3–5 extraction batches — never extract everything and classify at the end. A taxonomy built once, at the end, is dominated by whatever you read last.

## Phase 1 — Scope

Before any search, create the protocol proposition:

```
create_propositions([{
  content: "<research question> | Inclusion: <criteria> | Exclusion: <criteria> | Planned search: <venues, years, queries>"
}])
```

This node is not bookkeeping — it is the assertion that the corpus was defined and searched a particular way, and it is the thing a coverage claim ultimately rests on. It is also the only place the survey's scope survives a lost session, **and it is the text every screening subagent is given verbatim.** Write the criteria in it in full — not a summary. A criterion you compress here is a criterion the screeners never receive.

Also decide, now, the **closed list of exclusion reason codes** — `LANG`, `VENUE`, `YEAR`, `OFF-TOPIC`, `NOT-PRIMARY`, and whatever else this survey needs. Fix it before the first candidate is seen, for the same reason the criteria are fixed now: several screeners with no memory of each other write into one column that a coverage audit later counts. Free-form reasons across four dispatches produce four names for the same exclusion, and `EXCLUDED — not English` / `EXCLUDED — non-english` / `EXCLUDED — language` cannot be aggregated. Nothing enforces the list; it holds only if every brief carries it verbatim.

In phase 1 this proposition is a placeholder: its content describes a search you intend to run, which is a plan rather than a fact. Phase 2 replaces the plan with what the search actually returned, and that is the version phase 5 judges. Create it anyway now — the scope has to have a home before the first query runs. It stays `unestablished` until then; a plan has earned nothing.

## Phase 2 — Search and screen

**The screening is delegated; the criteria, the reason codes, the ledgers, and the audit are not.** Read that division before dispatching anything, because what you keep is exactly what the coverage argument later rests on.

`screening.csv` lives next to the graph database — the same directory `review` resolves attachment paths against. Say the directory in every brief, and use that same path when you attach the file and when you `grep` it on resume; a path that only resolves from someone's working directory produces a failed `grep`, and **a failed `grep` is indistinguishable from a file that was never written.**

### Two dispatch modes

`literature-searcher` runs in one of two modes, and the difference matters more than it looks:

- **Mode A — search and screen. Runs exactly once per survey.** No file exists yet. The searcher runs the queries, writes every candidate it found with `decision=PENDING`, and *then* rewrites decisions in place. It returns the path, the total row count, the decided row count, and the reason-code distribution — never the candidate list.
- **Mode B — screen only.** A file exists with `PENDING` rows. The searcher is given the path, an explicit row range, the criteria verbatim, and the reason-code list. It **runs no queries and adds no rows**; it decides `PENDING` rows inside its range and touches nothing else.

Mode A writes `PENDING` first and decides second, and that two-step is not a formality: it is what makes an interrupted run resumable by Mode B instead of by a second search.

**Dispatch Mode B sequentially, one at a time, in ranges of about 150 rows.** Never in parallel: the CSV has no locking, and two concurrent writers lose rows silently — and rows are the one quantity in this survey that cannot be rebuilt. Six hundred candidates do not fit in one subagent's context either, which is why the range exists at all; a screener that runs out of context dies with every decision it had not yet written.

Every brief carries, verbatim: the inclusion and exclusion criteria **copied from the protocol proposition** (copy the text, do not restate it — the reviewer later checks the CSV against that proposition, so a paraphrase means the screener was judging against criteria the reviewer never sees), the closed reason-code list, the row range, the file path, and the two prohibitions: change no row that is not `PENDING`, and change the total row count not at all.

### After every dispatch, reconcile two counts

> Record the **total row count** and the **decided row count** (rows whose `decision` is not `PENDING`) before dispatching. When the subagent returns, check both: **the total must be unchanged** — if it changed, the searcher wrote rows it had no business writing; and **the decided count must have gone up** — not merely "not down". Either mismatch: stop and do not continue phase 2.

Both numbers are needed, and "gone up" rather than "not gone down" is the point. An unchanged decided count is exactly what a screener that ran out of context and wrote nothing leaves behind — indistinguishable, from the outside, from a screener that had nothing to do. And checking only the total misses the worst case: re-running the same queries returns roughly the same number of candidates, so a whole-file overwrite leaves the total looking perfectly normal while every `decision` has gone back to `PENDING`. **This reconciliation is the only moment at which damage to the coverage denominator is detectable.**

### Then the parts that stay with you

```
update_proposition(<protocol>, evidence={add_attachments: ["screening.csv"]})
# spot-audit: read 15-20 decided rows spread across the dispatches,
#   check each code against the criteria
# then read the INCLUDED rows out of the file yourself and open extraction.csv,
#   one row per included paper: bibkey | INCLUDED | | <one-line placement>
```

**The included rows come from the file, not from the subagent's reply.** A screener returns counts and a reason distribution only — never rows — because returning two hundred of them would put back the context cost the whole phase exists to avoid. So `grep INCLUDED` the file and work from that. This is the largest thing still on your side of the boundary, around 8k tokens for two hundred papers, and it is not removable: an `extraction.csv` row needs the paper's bibkey and its placement, so both need the row. Delegating the screening does not delegate this.

Do not add a column to `screening.csv` and do not record extraction status in it. Its row count is the coverage denominator; a file that is simultaneously an immutable record and a mutable worklist will eventually be edited as the latter.

**The spot-audit is not optional.** It is the only first-person element left in the coverage argument: the criteria were fixed in advance and every exclusion carries a code, but nobody has judged any individual exclusion except the subagent whose context is gone. Fifteen to twenty rows spread across the dispatches costs about a thousand tokens. Skip it and the survey's denominator is a number no one has looked at.

**If this survey's central claim is a gap claim — "no prior work does Z" — screen the candidates that plausibly do Z yourself.** Those exclusions are not housekeeping; they *are* the argument, and delegating them delegates the claim. The `query` column makes the split mechanical: take the rows from the queries that targeted Z, hand the rest to Mode B by range.

`extraction.csv` conventions, read back on resume, so keep them exact:

- `bibkey` — the paper's BibTeX key. The attachment filename is `<bibkey>.pdf`; never reconstruct one from the other by transformation.
- `status` — one of `INCLUDED`, `EXTRACTED`, `NO-FINDING`, `MERGED`, exactly these words.
- `conflict` — empty, or the other paper's bibkey while a flagged conflict is unresolved, or `RESOLVED`.
- `note` — placement for `INCLUDED`, the reason for `NO-FINDING`, the keeper proposition's id for `MERGED`.

Then close the protocol proposition:

```
update_proposition(<protocol>,
  content="<... | Executed: N candidates, M included, K excluded (reason distribution) | Screening: delegated, spot-audited at <n> rows>",
  evidence={add_attachments: ["extraction.csv"]})
```

Say in that sentence that the screening was delegated and how many rows you audited. Phase 5 reviews this proposition against the CSVs, and a sentence that reads as a first-person judgment of four hundred exclusions is a sentence the CSV cannot support.

`add_attachments` appends; there is no way to pass an attachment list that silently drops what was already there. That footgun is gone from the interface — do not carry forward habits built around it, such as recomputing a union before every update.

`screening.csv` is the answer to "why didn't you consider X" — the question a survey's coverage claim has to survive. Do not create propositions for excluded papers: a rejection is a ledger row, not a proposition, and a graph carrying four hundred non-findings is one you have to read past for the rest of the survey.

## Phase 3 — Batch extraction

Delegate to `literature-extractor`, 5 papers per subagent, up to 6 in parallel. Its brief must fix every field below:

| Brief field | Value |
|---|---|
| Obligation | Acquire the survey's evidence pool from these papers |
| Papers | PDF paths **relative to the project root** — the directory the graph database sits under — one bibkey per paper, stated explicitly. The papers directory must be **inside** that root: `review` runs with the project root as its working directory and can only read what is under it |
| Question | Which propositions in these papers bear on `<the survey question>` |
| Allowed writes | `create_propositions` only, **one call per paper** |
| Content of each proposition | The finding, plus the **scale of the evidence behind it** (n, number of benchmarks, number of model families — whatever the paper reports; write "not reported" when it reports none) and its **polarity**: positive, null, or boundary |
| Report format | Per paper: propositions created (ids), duplicates found, advisory category keywords, conflicts flagged, **every warning the tool returned, copied verbatim including its id (or `no warnings`)**, `NO-FINDING` or `FAILED: <reason>` |

State in every brief, verbatim:

- Do not invent or assign a category. Return category keywords as plain words in the report; the main agent owns classification.
- **Leave `warrant` empty.** Everything you create lands at `unestablished`, which is correct: a survey's evidence pool is other people's findings, and the warrant answers "why does this evidence carry this content" — a question that is not due until someone judges it. That judgment is the main agent's.
- **Copy every warning the tool returns into your report, verbatim and with its id, even the ones you already fixed.** You are the only one who sees the tool's return text — the main agent sees your report and nothing else. A warning you silently resolve leaves no trace, and a warning you silently ignore is indistinguishable from one that never happened. The ids are content-derived hashes; a retyped id addresses nothing.
- One `create_propositions` call per paper. The call is atomic — if any item is rejected, nothing from that paper is written and you resend the whole call after fixing it. Batching five papers into one call means one bad item costs you all five.
- Pass `limit` on every `find_propositions` call (20 is enough). Without it, a common term matches hundreds of nodes and floods your context before you have read the papers.
- Do not link propositions to anything. No evidence references, no attacks.
- Carry the evidence scale and the polarity in the sentence itself. "Improves task success" is not a proposition — "improves task success by 3.2 points averaged over 12 benchmarks (positive)" is. Without the scale, the main agent cannot tell a twelve-benchmark result from an anecdote when it later selects which findings license a generalization, and a generalization built past what the papers reported is one `review` will break.
- Flag a conflict only for what you can actually see: a paper that contradicts itself, or one that explicitly reports failing to reproduce a named prior work. Two papers in your own batch that clash also count. **Write the other work's bibkey into the report.** Do not go searching the graph for conflicts; papers extracted in parallel are not in the graph yet, so the search cannot succeed and the main agent handles it in phase 5. Do not record any of this with `attacks` — the target usually does not exist yet.
- Every proposition must attach its paper as `<bibkey>.pdf` under the agreed papers directory, written as a project-root-relative path. Three failure modes ride on this: a proposition with no attachment can never be judged above `unestablished`; a path that only resolves inside your working directory is unresolvable weeks later; and a path that resolves *outside* the project root cannot be read by `review` at all. Only the third announces itself, as a portability warning at write time.

On each report:

- `FAILED` entries → re-dispatch that paper. Resending is safe: a rejected batch wrote nothing, so a re-dispatch cannot duplicate propositions. The paper stays at `INCLUDED` in `extraction.csv`, which is how a later session finds it.
- Warnings → read every one. Fix what it points at, or `dismiss` it with a reason. If a report's warnings field is missing entirely, treat that as a failed report and re-dispatch — an extractor that does not transcribe warnings is one whose warnings you have no way to read.
- `NO-FINDING` → set that row's status to `NO-FINDING` with the reason in `note`. Without it the paper looks unextracted forever.
- Conflicts → write the other bibkey into the flagging paper's `conflict` column. That column is the phase-5 worklist; the finding itself is an ordinary proposition and needs no marker in the graph.
- Otherwise → set the row to `EXTRACTED`.
- Advisory keywords → carry them into phase 4; they are input to your judgment, not a vote.

Extraction volume: 2–3 propositions per paper is normal. A subagent returning 10 from one paper is transcribing, not extracting — the brief's question was too loose.

## Phase 4 — Incremental taxonomy

A category is a proposition, not a label. Two per category, and the split between them is the most consequential structure in the survey:

- **The roster** — "Category X, as screened, comprises the following findings." Its `evidence.nodes` are *every* finding in the category; its warrant is the classification pass itself. This is the coverage record.
- **The generalization** — what the category actually supports. Built in phase 5, on 6–10 selected findings plus the roster. This is the argument.

Membership and grounding are different relations, and collapsing them is the single most expensive mistake available here. Grounding a generalization on all forty findings costs three ways: every finding becomes load-bearing, so `probably` then requires all forty judged past `unestablished` rather than eight; a forty-member evidence slot is too large for anyone, `review` or human, to assess; and the survey loses the denominator its coverage claim rests on.

Run this loop every 3–5 batches, in this order:

1. `find_propositions(query="comprises the following findings")`, or whatever phrasing your rosters share — read the existing categories and their sizes **before looking at new material**. A category at 1–2 findings after several batches is probably false; one past ~40 probably needs splitting.

   **This step is the only defense against category drift, so do not skip it.** Nothing in the system enforces a closed vocabulary any more — there is no registry to collide with and no near-match warning to hit. Creating "long-term recall" in batch 9 when "episodic memory" has held that content since batch 3 is a write that succeeds silently. Reading the existing rosters first is the entire mechanism.
2. Repair the vocabulary immediately. Merge a near-duplicate by folding its members into the keeper — `update_proposition(<keeper>, evidence={add_nodes: [...]})` — then `delete_proposition` the empty roster. Rename by rewriting the keeper's `content`. Do not defer vocabulary repairs to the end; later batches get classified against the broken version.
3. `find_propositions(qualifier=["unestablished"], limit=50)` and take the findings not yet in any roster — the unclassified backlog. **Always leave `offset` at 0.** Classifying removes items from this result set, so paging forward with `offset=50` skips fifty findings that shifted down. Re-query from 0 after each classification pass.
4. Classify. New category → `create_propositions` for its roster, with content that says what belongs in it and what does not. That sentence is the category's definition; write it so a later session can classify against it.
5. `update_proposition(<roster>, evidence={add_nodes: [...]})` — one call per category, not one per finding.

A finding may sit in several rosters. Forcing one category per finding fabricates a partition the evidence does not have.

Deduplicate while classifying, not while extracting. Parallel subagents cannot see each other, so two papers reporting the same finding produce two near-identical propositions. When `find_propositions` shows a duplicate: keep one, `update_proposition(<keeper>, evidence={add_attachments: [<the other's PDF>]})`, then `delete_proposition` the other. Read the affected-propositions list the delete returns — every roster the deleted node sat in is now marked for recheck, and every warning you had dismissed on those rosters has re-armed.

**When deleting the last remaining proposition of a paper, write its ledger row back in the same breath:** status `MERGED`, `note` = the keeper proposition's id. A confirmatory study whose every finding duplicates an earlier paper's loses all of its propositions this way, and among two hundred papers that is routine rather than rare. Without the writeback the row still says `EXTRACTED` while nothing of that paper is in the graph, and the next session cannot tell it from a paper whose findings were deleted by mistake. **The keeper's id is not optional**: without it, a coverage audit asking "did you read this one?" has no answer.

**If classifying exposes a coverage gap that needs more candidates, that is a new search, not a repair of the old one.** Write the new candidates to a *new* file and record the decision in the protocol proposition: what the gap was, which queries you added, how many candidates came back. Never append to `screening.csv`. Its row count is the denominator every coverage claim rests on; once rows arrive from two different searches the table cannot say which row came from which, and the denominator degrades silently — the one failure mode this whole arrangement exists to prevent.

## Phase 5 — Synthesis and judgment

Judge bottom-up. A proposition may only reach `probably` or `certainly` when every proposition in its evidence stands at something other than `unestablished`, so the order is forced: findings, then rosters and generalizations, then the cross-cutting conclusions above them. Nothing blocks you from doing it in the wrong order — the check flags, it does not refuse — but a top-down pass just means judging everything twice.

### Selecting evidence

Per category, in this order:

```
get_argument(<roster>)                     # read all of it — select evidence and spot counterexamples in one pass
# judge the 8-12 candidates individually: write each one's warrant, then set_qualifier
create_propositions([{content: <the generalization>, warrant: <why those findings license it>,
                      evidence: {nodes: [<the selected ones>, <the roster>]}}])
```

**Judge the candidates before you build the generalization, not after.** Not because a late change is expensive — it is not, the structural check just recomputes — but because a generalization written over an unjudged set describes a set you have not looked at. "These eight studies establish…" is a sentence you can only write honestly after reading the eight.

Judging a candidate is two acts, and the first is easy to skip: **write its warrant.** Extraction left it empty on purpose, and a proposition without one cannot honestly stand at `possibly` or above — the structural check will say so. The warrant for a literature finding is the principle that lets this paper's report carry this content, and writing it is where you notice that the content generalizes past what the paper measured.

Where the content is a paraphrase you did not personally check against the PDF, call `review` on it before judging: Q1 is exactly the question "does the attachment really say this". It is slow and expensive, so spend it where the paraphrase is load-bearing, not across the whole pool.

Select 8–12 candidates to end up with 6–10 in the evidence slot. The extra judgments are not waste — a representative finding you judged but did not select is almost certainly one the write-up will cite, and citing it requires a judged proposition anyway.

Ground on the findings that establish the claim across the range that matters — the strongest, the earliest, the boundary cases, the ones a skeptic would demand. The extraction contract requires each finding to carry its evidence scale and its polarity, which is what makes "the strongest" and "the boundary cases" readable off the list instead of a guess. Without those fields the only thing distinguishing forty similar findings is how confidently each is worded, and selecting by confidence of wording is selecting by rhetoric. The warrant then has to say why *those* license the generalization, which is a real inference principle; "these forty papers all say X" is a tally, not a warrant. The other thirty stay in the roster at `unestablished`: they are what the category's count and the coverage argument rest on, and a counterexample among them is a rebuttal, not a silent omission.

### Building upward

Cross-cutting conclusions (the taxonomy, the trend, the gap) take the category generalizations' ids as evidence. The coverage conclusion — the one licensing any "no prior work does Z" — takes the protocol proposition as evidence, and carries the search's known boundaries as rebuttals: unindexed venues, language limits, the preprint cutoff date. A coverage boundary belongs on the graph as a rebuttal, not as a hedge in the prose.

**The coverage warrant must say that the screening was delegated.** Its evidence is a protocol proposition whose exclusion decisions were made by subagents against fixed criteria, spot-audited at a stated number of rows — not judged one by one. That is a sound basis for a coverage claim and a weaker one than a per-row judgment, and the warrant is where the difference gets stated. A warrant that reads as though four hundred exclusions were each considered is asserting more than the evidence can carry.

**Attach `screening.csv` to each boundary rebuttal too.** Its `venue`, year, and `query` columns **are** the evidence for "unindexed venues are not covered" and "preprints stop at 2026-03". A boundary rebuttal with nothing attached cannot be judged past `unestablished`, and the coverage conclusion cannot reach `refuted` on rebuttals that are themselves unestablished — nor should you want it to.

**`review` the protocol proposition, and judge it, before you build the coverage conclusion on it.** It is the single most likely thing in the whole survey to be wrong: its sentence — `Executed: N candidates, M included` — is a number you wrote by hand from counts a subagent reported, and `review`'s Q1 is the one moment anyone opens `screening.csv` and checks those counts against the sentence. Nothing else in this protocol ever opens that file. Skip it and the survey's most consequential argument ships on numbers nobody read back.

A conclusion resting on a category generalization held at `possibly` is structurally fine — the check only requires evidence past `unestablished` — so **the honesty here is entirely yours.** Say in the warrant what you draw from a contested category. Usually a cross-cutting conclusion draws on a category's *scope* rather than its truth: that a mechanism family exists and assumes unbounded storage is what licenses "no family works under a fixed budget," and neither of those is what the dispute is about. If what you need *is* the contested proposition, the dispute reaches your conclusion too, and the honest move is a rebuttal on it rather than a warrant that stays quiet.

A `refuted` category is a harder case and the check will not stop you either: `refuted` propositions are legitimate evidence, because what you rely on is that the refutation is true. So resting on one is allowed and sometimes right — but then the warrant must say so explicitly ("because X was refuted…"), and what survives is narrower than what the category originally claimed: that the family exists in the literature, that it was tried. If your conclusion needs the dead proposition itself, reground on the category's findings directly.

If a category generalization honestly stays `unestablished`, everything resting on it is capped at `possibly`; that is the correct propagation, not an obstacle to route around.

**When an upper conclusion will not settle, the fix is downward, never sideways.** Attaching two convenient findings directly to it will get its evidence past `unestablished` and the graph will look fine afterwards. It is not fine: the verdict then rests on two pieces of ad-hoc evidence while the structure carrying the actual synthesis contributes nothing. Go judge the categories instead. A cross-cutting conclusion that has to route around the conclusions it generalizes over is not a cross-cutting conclusion.

### Conflicts and counterexamples

Finding the contradictions is your job here, not the extractors'. They read five papers each, six batches in flight, and the thirty papers being read at the same moment are by construction invisible to one another — none of their findings are in the graph yet. Batches are cut in screening order, not by topic, so two papers from the same category rarely land in the same batch. What comes back flagged is therefore the small, high-signal set they could see without searching.

The category-level conflicts surface in the pass you are already making. You read the whole roster to select evidence; that is the moment two mutually exclusive findings in one category are visible at zero marginal cost, and it is the only moment they are. Read for both at once. `find_propositions(query="no significant")` and similar catch the null results the extraction contract required to be marked as such.

Then resolve what the `conflict` column lists, and **clear the column either way** — an unresolved flag that was in fact resolved sends every later session back to re-investigate something already on the graph:

- **It does contradict a generalization or its warrant.** The conflicting finding *is already a proposition in the graph* — phase 3 extracted it, with its PDF attached. Point it at the target: `update_proposition(<target>, rebuttals={add: [<that finding's id>]})`. Then set the row's `conflict` to `RESOLVED`.
- **It is not actually a conflict** → set the row to `RESOLVED` and say why in `note`.

**Do not create a new proposition with `attacks` here.** That makes a *second copy* of a finding the graph already holds: the two sentences drift apart, and when the finding is later overturned only one of them is knocked back. `attacks` is for propositions that genuinely do not exist yet, such as the coverage boundaries.

A category whose evidence genuinely conflicts ends up held down by a rebuttal, and that is a result, not a failure — a twelve-category survey with zero contested categories is more suspicious than one with two.

**The completion condition is per category, not per ledger column: each category's generalization either carries a rebuttal, or its warrant says why the evidence in that category is consistent.** "The conflict column is empty" is not the test, and it is worth understanding why, because the reasoning generalizes. An empty register is exactly what you get when nobody looked — the worse the detection, the cleaner the gate passes, and a checked-off completion condition then stands in for a guarantee this survey never earned. A real completion condition distinguishes "we did not look" from "we looked and found none." The per-category version leaves a different mark on the graph in each case. The column-empty version leaves the same mark in both.

### Settling

```
get_stats     # the red list: unresolved findings, structural violations, propositions marked for recheck
```

There is no compile. Structural checks recompute after every change, for free, and warnings you dismissed re-arm by themselves the moment the underlying facts move — so there is nothing to run and nothing to keep fresh. What there is instead is a list to read, and reading it is the last act of phase 5.

Settle every entry: fix what it points at, or `dismiss` it with your reason. A flag is a prompt, not a refusal; dismissing one you judge unfounded is a normal exercise of judgment. What is not normal is leaving the list unread, or editing content until an entry stops appearing.

**One thing got harder when the old verification gates went away, and you have to compensate deliberately.** Nothing now refuses a qualifier, and declining to select a candidate leaves no mark at all. So: **a finding that holds up but disagrees with the generalization does not get quietly left out of the evidence set.** It becomes a rebuttal, and the qualifier follows the evidence. The per-category completion condition above is the only thing standing where the gate used to stand.

If a category's evidence base is genuinely too thin, the honest move is to build the generalization on what you have and **leave it `unestablished`, with the reason written into its warrant**. A survey that ends with an unestablished conclusion and a recorded reason is a finished survey — one unreadable paper does not entitle anyone to a verdict the evidence did not earn.

Findings that were classified but not selected stay `unestablished` and stay in the graph. They are not leftovers: they are the category's count and the reading record the coverage argument rests on. Never delete them to tidy the graph — deleting them removes the denominator from every coverage claim you are about to make.

## Judgment discipline

Everything is created `unestablished`. In phase 5 you judge the findings the argument rests on — roughly 100–150 of them, not the several hundred you extracted. That deferral is the saving.

It is not the whole bill. Every finding the write-up asserts flatly must also stand at `probably` or better, whether or not it is in an evidence slot, so the eventual total is closer to the number of papers you cite. Phase 5 covers the argument; `literature-writing` judges the rest as it decides what to cite. Do not front-load all of it here — you would be judging findings that never get cited.

**No gate enforces any of this.** Only three things are ever refused: empty content, a reference to a node that does not exist, and an attachment path that is missing at write time. Everything else — a proposition at `certainly` with no evidence, a generalization built on unestablished findings, a `refuted` conclusion whose rebuttals are themselves unestablished — is written, flagged red, and left standing for you to settle. The old service-layer gates that used to make the honest order the only available order are gone by design. The order is now discipline, and the graph's memory of whether you kept it is the event log.

## Resuming after an interruption

Session loss and compaction are expected at this scale. Progress lives in the ledgers and the graph; reconstruct it, do not recall it:

1. `get_stats` — the counts locate you in phases 3–5, **but not in phase 2**. Until the first extraction there are no propositions but the protocol one, so every counter reads the same at 0% screened and at 100% screened. What actually locates you in phase 2 is rows 1–3 below.
2. `find_propositions(query="<the research question's distinctive terms>")` → the protocol proposition: the question and criteria, verbatim.
3. Read the category rosters — the taxonomy as it stands, with its definitions.

Then read the state directly:

| Signal | Meaning | Queue |
|---|---|---|
| `screening.csv` does not exist | No search has run, or the Mode A dispatch died before writing | Phase 2, **Mode A** |
| `screening.csv` has rows still marked `PENDING` | A screening dispatch did not finish. **The candidate list is intact — do not search again** | Phase 2, **Mode B** over the `PENDING` ranges |
| `screening.csv` has more `INCLUDED` rows than `extraction.csv` has rows | Screening finished; registration did not | Phase 2, registration on the difference |
| `extraction.csv` row at `INCLUDED` | Not extracted, or extraction failed. There is no half-extracted state — the write is atomic | Phase 3 |
| Row at `NO-FINDING` | Terminal — do not re-read | — |
| Row at `MERGED` | Terminal — the paper was read and its findings folded into the proposition named in `note`. Do not re-dispatch | — |
| Row at `EXTRACTED`, `conflict` non-empty and not `RESOLVED` | Conflict flagged but unresolved | Phase 5 |
| Finding in no roster | Not classified | Phase 4 |
| Roster with no generalization citing it | The category has no conclusion yet | Phase 5 |
| Proposition in an evidence slot, still `unestablished` | Not judged | Phase 5 |
| `get_stats` red list non-empty | Warnings or findings never settled | Phase 5 |

**`PENDING` rows mean a subagent died, not that you were mid-screening — and the two call for opposite repairs.** You never screen this file yourself (except the gap-claim subset you deliberately kept), so a half-decided file is not your unfinished work; it is a dispatch that ran out of context. `grep -n PENDING` gives you the row numbers, and those ranges go straight into a Mode B brief. **What you must not do is regenerate the file.** A half-`PENDING` file looks like a damaged artifact that ought to be rebuilt, and rebuilding it is the one irreversible mistake available in phase 2: the decisions in it are reproducible from written criteria, but the candidate list is not — re-running the queries returns a different set, and a coverage claim resting on an irreproducible number that has silently changed is not auditable. **Mode A runs exactly once per survey.** A second Mode A dispatch is legitimate only as a *new file* for a *new* search (phase 4's coverage gap), never over `screening.csv`.

**An `EXTRACTED` row whose paper has no propositions in the graph means deduplication, not failure** — and that is exactly the case `MERGED` exists to name. If you find one, the writeback was skipped: trace the keeper if you can, and repair the row rather than re-dispatching the paper. Re-dispatching produces the same duplicates you already deleted, and the next session finds the same empty row again.

The first four rows are `grep` and counts over the CSVs, not graph queries — `get_stats` reports what the graph knows and does not parse these files. Run them against the path you attached, next to the database; a `grep` that fails because the path is wrong looks exactly like a file that was never written.

**Count two numbers before every screening dispatch, and check both when the subagent returns.**

> Record the **total row count** and the **decided row count** (rows whose `decision` is not `PENDING`). When the subagent returns: **the total must be unchanged** — a Mode B dispatch adds no rows and a changed total means it wrote what it had no business writing; and **the decided count must have gone up** — not merely "not gone down".

Both numbers are needed, and "gone up" is the strict form for a reason. A decided count that did not move is exactly what a screener that exhausted its context and wrote nothing leaves behind, and from the outside that is indistinguishable from a screener that found nothing to do — so treat an unmoved count as a failed dispatch and re-dispatch the range. Checking only the total misses the worse case: re-running the same queries returns roughly the same number of candidates, so a whole-file overwrite leaves the total looking normal while every `decision` has gone back to `PENDING`. The decided count is the discriminating quantity. **Either mismatch: stop, and do not continue phase 2 — this is the only moment at which damage to the coverage denominator is detectable.**

Two of these rows exist because the obvious reading of the others is wrong. **When phase 4 has just finished and phase 5 has not started, every phase-5 signal reads empty** — no generalizations exist, so nothing is in an evidence slot — which is indistinguishable from a finished survey. The roster with no generalization is what tells them apart. Likewise, a survey whose red list is empty may be one that was settled carefully or one that never called `get_stats`; the event log separates them and nothing else does.

The cost of an interruption is the batch or the screening range in flight. If you find yourself unable to tell what was done, the ledger notes were written loosely — fix them as you go, not the recovery procedure.

## Handoff to literature-writing

Hand off when every category generalization and every cross-cutting conclusion carries a qualifier or a written reason for staying `unestablished`; when everything in their evidence slots stands past `unestablished`; when every category either carries a rebuttal or states in its warrant why its evidence is consistent; and when `get_stats` comes back with nothing unsettled. Switch to `literature-writing` for the prose.

**The protocol proposition has been reviewed and judged by the time you hand off.** It is the coverage conclusion's evidence, and reviewing it is what causes `screening.csv` to be opened and its row counts checked against the numbers in the sentence. Nothing else in this protocol ever confirms that the file exists, resolves, or is non-empty — a write-time attachment check proves a path existed once, not that anyone read it.

Do not start drafting before the conclusions are settled in that sense. The prose projects the argument; drafting against a conclusion still open on the evidence means writing sentences whose thesis has not been earned, then rewriting them when the judgment lands. A conclusion left `unestablished` on purpose is not an obstacle to the write-up — it is a result, and the prose should say so rather than assert more than the graph supports.

Three things carry across:

- The category rosters map sections to conclusions: each roster's members are the section's reading record, and the generalization citing it is the section's thesis.
- Findings left `unestablished` are the classified-but-not-selected pool. Citing one is normal — the citing sentence just has to attribute it ("Smith et al. report…") rather than assert it, which is `literature-writing`'s own contract. Budget for the rest: a survey citing 200 papers that asserts findings flatly needs 200 judged propositions, and phase 5 only got you the argument's.
- If an unestablished finding turns out to carry a paragraph's whole thesis, that is a synthesis gap rather than a citation gap. Return to phase 5 and put it in the generalization's evidence properly — do not let a warrant-less finding hold up an argument in the prose.

**And one thing the prose must not overstate**: the screening was delegated. The coverage section says what the criteria were, what the reason distribution was, and how many rows were audited. It does not say or imply that each excluded candidate was individually considered.
