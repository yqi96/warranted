---
name: auto-research
description: Use for open-ended autonomous research where you must generate the research questions and propositions yourself from provided data and reference material. Route the goal through a Framing step, create falsifiable propositions, attach observed and literature evidence, actively seek disconfirming evidence before setting qualifiers, and close only after explicit graph inspection and rigor audit.
---

## Channel

You are handed a research goal plus reference material and data, and no fixed argument to extract. The graph is the counterweight. Every question you raise gets a structural home, and every conclusion must be earned through proposition content, evidence, warrant, rebuttal handling, and qualifier judgment - never asserted because the analysis "looked right."

Current Warranted graphs use one node type: Proposition. Each proposition has five slots:

- `content`
- `evidence` with local attachments and/or referenced proposition ids
- `warrant`, either inline text or a promoted proposition
- `rebuttals`, represented by propositions that attack content or warrant
- `qualifier`: `refuted`, `unestablished`, `possibly`, `probably`, or `certainly`

The persistent graph lives in `.toulmin/graph.db`. Use the current 11-tool surface: `create_propositions`, `update_proposition`, `set_qualifier`, `promote_warrant`, `delete_proposition`, `get_argument`, `find_propositions`, `get_stats`, `get_history`, `review`, and `dismiss`. Do not invent retired node-type helper tools or retired completion gates.

## Framing Router

The first decision is where the proposition targets come from. Test each input assertion: **could it be shown false?**

- **Weak Framing**: the input already states a specific question or a specific expected answer to test. Cast the question's answer as a proposition with `create_propositions`. If the user supplied an expected answer, record it as a proposition too, usually with `unestablished` until evidence exists. Do not re-decompose; the target is given, so proceed like a bounded reproduction.
- **Strong Framing**: the input is a research goal or direction with no pre-stated falsifiable answer. Decompose it into a small set of answerable research questions, then create one load-bearing proposition per answer whose qualifier matters. Because nothing external fixes the target, the falsification obligation below is mandatory before any supporting evidence run.
- **Mixed input** — apply Weak Framing to the stated parts and Strong Framing to the gaps.

Keep the initial proposition set small and load-bearing. Creating propositions you never test is the same failure as testing none.

## Graph Mapping

```
research goal / question                     -> one or more research questions
a falsifiable answer to a question           -> proposition whose qualifier will be judged
a result computed from the given data        -> proposition, with local artifacts in evidence.attachments
a citable proposition from a reference       -> proposition, with the source file in evidence.attachments
another proposition used as support          -> referenced id in evidence.nodes
"what result would show this false"          -> pre-registered refutation condition, later tested as a rebuttal candidate
why the evidence authorizes the content      -> warrant text, or a promoted warrant proposition
the method or standard behind the inference  -> proposition cited from evidence.nodes or warrant
a confirmed conflict against content/warrant -> proposition created with attacks={node, slot}
```

Granularity:

- one research question yields one proposition whose qualifier matters; do not force the whole goal into one giant proposition
- distinct results, conditions, populations, measurements, or scopes are separate propositions
- one data file yields multiple propositions when it supports multiple distinct results
- convergence across a computed result and a literature source belongs in the warrant, not in one vague composite proposition
- a sub-result used as evidence for another proposition goes into the consumer's `evidence.nodes`

## Obligations

Object-layer work in this channel - data analysis, computation, coding, reference reading, download, debugging - is valid only when it frames, tests, audits, or reconciles a proposition. A run not tied to a proposition it advances or a refutation condition it probes is loose work.

| Graph state | Required action |
|---|---|
| Input is a bare research goal | Framing (strong): derive research questions; `create_propositions` per question answer |
| Input states a specific question or expected answer | Framing (weak): create the answer proposition and record the expected answer as a separate `unestablished` proposition when useful |
| A proposition has no refutation condition | before any evidence run, record what result would falsify it as a planned rebuttal candidate; no supporting run may precede this |
| A proposition needs evidence from data | delegate to `code-experimenter`; record the result as a proposition with artifacts in `evidence.attachments` |
| A proposition needs support from a reference | read the reference; create a proposition with the source attachment, then cite it from `evidence.nodes` |
| Evidence exists but the inference principle is missing | add inline `warrant`, or `promote_warrant` when the warrant itself needs evidence |
| A warrant needs authority | create or reuse a method/standard proposition and cite it from evidence or from the promoted warrant proposition |
| The structure exists | call `review` explicitly when semantic review is configured and useful; otherwise use `get_argument`/`get_stats` to inspect warnings and findings |
| A result mismatches the expectation, or a blocker is claimed | route to `discrepancy-auditor` before any rebuttal or stop |
| Computed data and literature disagree | create a proposition with `attacks={node, slot}`; never drop one side silently |
| A proposition has independent evidence | `update_proposition` with attachments or evidence nodes, then `set_qualifier` with a note |
| Audit finds the mismatch was a setup issue | leave the proposition `unestablished`; fix and rerun |
| Audit confirms a real contradiction | create an attacking proposition; set the target to `refuted` only after weighing the rebuttal evidence |
| A result reveals something never asked | create a new proposition; never bend an existing proposition to fit the finding |
| A full-scope analysis is too slow, large, or costly | do NOT narrow scope for cost alone; profile via `discrepancy-auditor`, then delegate the fix to `code-optimizer` |
| Only a narrower scope is supportable after optimization | narrow the proposition content, warrant, or rebuttal explicitly before setting the qualifier |
| Ambiguity with no one to ask | pick the most defensible reading and record it in `note`, warrant text, or proposition content; never pause, never silently choose |
| Every touched proposition has current qualifier, warnings/findings are settled or named, and review/audit are complete | do NOT declare done yet; route the whole effort to `rigor-auditor`; only a `SUFFICIENT` verdict closes the research, `INSUFFICIENT_*` sends you back with named work |

## Falsification Discipline

Autonomous research picks its own targets, so confirmation bias is the dominant failure mode. Counter it structurally, not by good intentions.

- Every target proposition carries a refutation condition **before** evidence is gathered: state, in graph terms, what computed or literature result would force `set_qualifier(refuted)` or a narrower content rewrite.
- Actively test that condition. Pursuing only supporting evidence is not a test — a run that can only confirm proves nothing. Design at least one analysis whose plausible outcomes include failure.
- A negative or surprising result never becomes a rebuttal proposition or a stop until `discrepancy-auditor` has ruled out an object-layer artifact.
- A proposition reaches `possibly`, `probably`, or `certainly` only after: its registered refutation condition was tested and did not fire, its structural warnings are understood, and surviving rebuttals are weighed. Absent those, it stays `unestablished`.



## Delegation

Research here is long-running and mixes data and references, so run it dual-core and delegate substantial object-layer work by default. All workers report evidence only; none set qualifiers or create rebuttals unless explicitly briefed to do that graph work.

- `toulmin-explorer` — survey the graph before adding propositions: which propositions already exist, which warnings/findings remain pending, where a result already lives.
- `code-experimenter` — the **data core**. Implement the analysis over the given data and return raw artifacts that become evidence propositions. Brief it with the target proposition, the method to implement, the allowed data and compute budget, the artifacts to return, and any reference-produced artifact it must not use as verification.
- `toulmin-researcher` — the **argument core**. Runs the Framing -> evidence -> falsification -> qualifier loop and owns every graph judgment.
- `discrepancy-auditor` — gate before the graph accepts any negative verdict or any claimed blocker: real contradiction, or object-layer artifact / premature stop. Operates at the single-node level.
- `code-optimizer` — when a full-scope analysis is blocked by runtime, memory, or compute. It preserves method and result semantics exactly and never narrows scientific scope; cost is an engineering problem, reached for before scope reduction.
- `rigor-auditor` — the **completion gate**. Before you declare the research done, it judges the whole effort on two axes — was it exhausted (竭尽全力), and is the outcome worth reporting (价值). It is strict by default and biased toward "not done"; it returns `SUFFICIENT` / `INSUFFICIENT_EFFORT` / `INSUFFICIENT_VALUE` with concrete required work, and does not set qualifiers.

## Autonomy Without Clarification

There may be no one to answer questions. This does not license silent choices.

- When the goal, data, or method is ambiguous, make the most defensible assumption and proceed — but record it in proposition content, warrant text, or a `note` so the choice is auditable.
- When an analysis fails, debug it or route it to `discrepancy-auditor`; a failure is not a verdict and not a reason to stop.
- Never pause for confirmation, and never narrow a proposition merely to make progress. Record what you decided and why, so a reader can see the reasoning even though no one was asked.

## Completion

Done is defined by the graph, not by the deliverable, and not by "a result exists." Whatever the task asks you to produce, the research is complete only when **all** of the following hold:

- every touched target proposition has an explicit qualifier judgment, or is left `unestablished` with a recorded reason;
- every registered refutation condition was tested, or explicitly deferred with a reason;
- every pending structural warning is cleared or dismissed with a reason; every review finding is replaced by a later review, dismissed with a reason, or carried into the deliverable as an open limitation;
- any semantic second opinion needed for the proposition has been requested with `review`;
- **`rigor-auditor` returns `SUFFICIENT`** on the whole effort.

The first checks prove the graph is inspectable; they do not prove the research was *worth doing* or that you *went all-out*. Producing an answer is necessary, never sufficient — an agent that generates its own targets will otherwise stop at the first plausible result and call it done. So before declaring completion, delegate the whole research to `rigor-auditor` with the goal, the full graph, the deliverable, and what was and was not attempted.

- `INSUFFICIENT_EFFORT` → the ceiling was not reached. Execute the specific stronger analyses, broader scopes, or higher-power tests it names, then re-audit. Do not narrow a proposition to escape the demand.
- `INSUFFICIENT_VALUE` → the outcome is trivial or dodges the goal. Make the stronger proposition the evidence already supports, or answer the additional question it names, then re-audit.
- `SUFFICIENT` → complete. Carry its named residual limitations into the deliverable's disclosed caveats.

"It looks done" is not a completion signal. An `unestablished` load-bearing proposition, a refutation condition never tested, an unresolved warning/finding, or an unaddressed `INSUFFICIENT_*` verdict is an open gap — name it rather than closing the task over it.

## Output As Graph Projection

The task's deliverable — report, constraint, numeric limit, answer, whatever the prompt specifies — is a projection of the graph, not a parallel narrative. This skill fixes no deliverable format; the prompt does. But every conclusion in the output must trace to a proposition whose qualifier is visible, every reported result to evidence attachments or evidence propositions, every "therefore" to warrant text, and every caveat to rebuttal or scoped proposition content.

Keep the voices distinct:

- **Result voice** — what the data analysis found -> evidence proposition with artifacts
- **Source voice** — what a reference reports -> evidence proposition with source attachment
- **Inference voice** — what the evidence implies -> target proposition + warrant
- **Judgment voice** — what the graph has earned -> qualifier after inspection, rebuttal handling, and optional review

A statement in the output with no home in the graph is concealment, not synthesis.
