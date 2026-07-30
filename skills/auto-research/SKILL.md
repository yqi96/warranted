---
name: auto-research
description: Use for open-ended autonomous research where you must generate the research questions and Claims yourself from provided data and reference material. Route the goal through a Framing step, propose falsifiable Claims, produce observed Grounds from the data and literature Grounds from the references, actively seek disconfirming evidence before any verdict, and let compile gate completion.
---

## Channel

You are handed a research goal plus reference material and data, and no fixed argument to extract. The graph is the counterweight. Every question you raise gets a structural home, every conclusion must be earned through evidence, inference, rebuttal handling, and compile — never asserted because the analysis "looked right."

## Framing Router

The first decision is where the Claims come from. Test each input proposition: **could it be shown false?**

- **Weak Framing** — the input already states a specific question or a hypothesis to test. Cast the question's answer as a Claim; cast a user-stated hypothesis as a `source="hypothesis"` Statement (verification `pending`). Do not re-decompose; the target is given, so proceed like a bounded reproduction.
- **Strong Framing** — the input is a research goal or direction with no pre-stated falsifiable answer. Decompose it into a small set of answerable research questions, then `create_claim` (status starts `proposed`) — one Claim per question whose verdict matters. Because nothing external fixes the target, the falsification obligation below is mandatory before any evidence run.
- **Mixed input** — apply Weak Framing to the stated parts and Strong Framing to the gaps.

Keep the initial Claim set small and load-bearing. Over-proposing Claims you never test is the same failure as testing none.

## Graph Mapping

```
research goal / question                     -> one or more research questions
a falsifiable answer to a question           -> Claim (status=proposed)
a proposed or expected answer                -> Statement(source="hypothesis", verification="pending")
a result computed from the given data        -> Statement(source="observed") as Ground
a citable proposition from a reference       -> Statement(source="literature") as Ground or Backing
"what result would show this Claim false"    -> a pre-registered refutation condition, tested as a Rebuttal candidate
why the evidence authorizes the conclusion   -> Warrant
the method or standard behind the inference  -> Statement as Backing
a confirmed conflict against Claim or Warrant-> Statement(rebuttal_for={target_id, target_type})
```

Granularity:

- one research question yields one Claim whose verdict matters; do not force the whole goal into one giant Claim
- distinct results, conditions, populations, measurements, or scopes are separate observed Grounds
- one data file yields multiple observed Grounds when it supports multiple distinct propositions
- convergence across an observed Ground and a literature Ground is a Warrant's job, not a merge into one vague composite Ground
- a sub-Claim used as evidence for another Claim -> reference the sub-Claim's id directly in the consuming Warrant's `ground_ids`

## Obligations

Object-layer work in this channel — data analysis, computation, coding, reference reading, download, debugging — is valid only when it frames, tests, audits, or reconciles a node or Claim status. A run not tied to a Claim it advances or a refutation condition it probes is loose work.

| Graph state | Required action |
|---|---|
| Input is a bare research goal | Framing (strong): derive research questions; `create_claim` (proposed) per question |
| Input states a specific question or a hypothesis | Framing (weak): `create_claim` for the question's answer; `create_statement(source="hypothesis", verification="pending")` for a stated hypothesis |
| A proposed Claim has no refutation condition | before any evidence run, register what result would falsify it (as a planned Rebuttal candidate); no supporting run may precede this |
| A Claim needs evidence from the data | delegate to `code-experimenter`; result → `create_statement(source="observed")` |
| A Claim needs support from a reference | read the reference; `create_statement(source="literature")` and attach the source |
| A Claim's Grounds have no inference principle | `create_warrant(ground_ids=[...])` |
| A Warrant needs authority | `create_statement(...)` from a method or standard, then `update_node(<warrant>, backing_ids={add:[...]})` |
| The Claim-Ground-Warrant structure exists | `compile_arguments` — coherence to test, not proof |
| An observed result mismatches the expectation, or a blocker is claimed | route to `discrepancy-auditor` before any Rebuttal or stop |
| An observed and a literature Ground disagree | `create_statement(rebuttal_for=...)`; never drop one side silently |
| A Ground is confirmed by independent evidence | `update_node(verification="verified", attachments=[...])` |
| Audit finds the mismatch was a setup issue | keep the Ground `pending`; fix and rerun |
| Audit confirms a real contradiction | `create_statement(rebuttal_for=...)`; move the Claim to `disputed`/`refuted` only after compile and evidence assessment |
| A result reveals something never asked | new observed Statement or Claim; never bend an existing Claim to fit the finding |
| A full-scope analysis is too slow, large, or costly | do NOT narrow scope for cost alone; profile via `discrepancy-auditor`, then delegate the fix to `code-optimizer` |
| Only a narrower scope is supportable (after optimization) | bound the Claim with a `qualifier` that honestly records the verified scope and degree; `supported` holds only **within that qualifier** |
| Ambiguity with no one to ask | pick the most defensible reading, record it in the Claim's `qualifier` or a note; never pause, never silently choose |
| Every Claim carries a verdict and compile is current | do NOT declare done yet — route the whole effort to `rigor-auditor`; only a `SUFFICIENT` verdict closes the research, `INSUFFICIENT_*` sends you back with named work |

## Falsification Discipline

Autonomous research picks its own targets, so confirmation bias is the dominant failure mode. Counter it structurally, not by good intentions.

- Every proposed Claim carries a refutation condition **before** evidence is gathered: state, in graph terms, what observed or literature result would force it to `disputed` or `refuted`.
- Actively test that condition. Pursuing only supporting Grounds is not a test — a run that can only confirm proves nothing. Design at least one analysis whose plausible outcomes include failure.
- A negative or surprising result never becomes a Rebuttal or a stop until `discrepancy-auditor` has ruled out an object-layer artifact.
- A Claim reaches `supported` only after: its registered refutation condition was tested and did not fire, `compile_arguments` passes, and the surviving Rebuttals are weighed. Absent any of these, it stays `proposed` — never as a way to dodge a verdict.



## Delegation

Research here is long-running and mixes data and references, so run it dual-core and delegate substantial object-layer work by default. All workers report evidence only; none set Claim status nor create Rebuttals — the Toulmin layer owns those.

- `toulmin-explorer` — survey the graph before adding nodes: which Claims already exist, which Grounds are still `pending`, where a proposition already lives.
- `code-experimenter` — the **data core**. Implement the analysis over the given data and return raw artifacts that become `observed` Grounds. Brief it with the target Claim or Ground, the method to implement, the allowed data and compute budget, the artifacts to return, and any reference-produced artifact it must not use as verification.
- `toulmin-researcher` — the **argument core**. Runs the Framing → evidence → falsification → verdict loop and owns every Claim status.
- `discrepancy-auditor` — gate before the graph accepts any negative verdict or any claimed blocker: real contradiction, or object-layer artifact / premature stop. Operates at the single-node level.
- `code-optimizer` — when a full-scope analysis is blocked by runtime, memory, or compute. It preserves method and result semantics exactly and never narrows scientific scope; cost is an engineering problem, reached for before scope reduction.
- `rigor-auditor` — the **completion gate**. Before you declare the research done, it judges the whole effort on two axes — was it exhausted (竭尽全力), and is the outcome worth reporting (价值). It is strict by default and biased toward "not done"; it returns `SUFFICIENT` / `INSUFFICIENT_EFFORT` / `INSUFFICIENT_VALUE` with concrete required work, and does not set status.

## Autonomy Without Clarification

There may be no one to answer questions. This does not license silent choices.

- When the goal, data, or method is ambiguous, make the most defensible assumption and proceed — but record it in the Claim's `qualifier` or a note so the choice is auditable.
- When an analysis fails, debug it or route it to `discrepancy-auditor`; a failure is not a verdict and not a reason to stop.
- Never pause for confirmation, and never narrow a Claim merely to make progress. Record what you decided and why, so a reader can see the reasoning even though no one was asked.

## Completion

Done is defined by the graph, not by the deliverable, and not by "a result exists." Whatever the task asks you to produce, the research is complete only when **all** of the following hold:

- every proposed Claim has a compiled verdict (`supported`, `disputed`, or `refuted`), is honestly bounded by a `qualifier`, or is explicitly parked with a recorded reason;
- every registered refutation condition was tested, or explicitly deferred with a reason;
- `compile_arguments` is current on every Claim this run touched;
- **`rigor-auditor` returns `SUFFICIENT`** on the whole effort.

The first three checks prove the graph is *coherent*; they do not prove the research was *worth doing* or that you *went all-out*. Producing an answer is necessary, never sufficient — an agent that generates its own targets will otherwise stop at the first plausible result and call it done. So before declaring completion, delegate the whole research to `rigor-auditor` with the goal, the full graph, the deliverable, and what was and was not attempted.

- `INSUFFICIENT_EFFORT` → the ceiling was not reached. Execute the specific stronger analyses, broader scopes, or higher-power tests it names, then re-audit. Do not narrow a Claim to escape the demand.
- `INSUFFICIENT_VALUE` → the outcome is trivial or dodges the goal. Make the stronger Claim the evidence already supports, or answer the additional question it names, then re-audit.
- `SUFFICIENT` → complete. Carry its named residual limitations into the deliverable's disclosed caveats.

"It looks done" is not a completion signal. An uncompiled Claim, a refutation condition never tested, or an unaddressed `INSUFFICIENT_*` verdict is an open gap — name it rather than closing the task over it.

## Output As Graph Projection

The task's deliverable — report, constraint, numeric limit, answer, whatever the prompt specifies — is a projection of the graph, not a parallel narrative. This skill fixes no deliverable format; the prompt does. But every conclusion in the output must trace to a compiled Claim, every reported result to an `observed` or `literature` Ground, every "therefore" to a Warrant, every caveat to a Rebuttal or `qualifier`.

Keep the voices distinct:

- **Result voice** — what the data analysis found → `observed` Ground
- **Source voice** — what a reference reports → `literature` Ground
- **Inference voice** — what the evidence implies → Claim + Warrant
- **Verdict voice** — what the graph has earned → Claim status after compile

A statement in the output with no home in the graph is concealment, not synthesis.
