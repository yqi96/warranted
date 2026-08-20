---
name: paper-reproduce
description: Use when reproducing a published paper, or judging whether its conclusions hold under independent execution — including a run that disagrees with the paper, or one that appears blocked. Not for testing a hypothesis of your own.
---

## Graph Mapping

The paper's argument is the object under test. Extract it into the graph first; reproduction then tests whether it holds under independent execution.

| Element of the paper | Where it goes |
|---|---|
| paper conclusion | a proposition — its `content` is the conclusion verbatim |
| paper stated result | a proposition of its own, referenced in the conclusion's `evidence` |
| paper inference from result to conclusion | the conclusion's `warrant` |
| paper method or standard behind that inference | evidence on the warrant — `promote_warrant` first, then attach the method there |
| paper acknowledged exception | a proposition created with `attacks={node, slot}` |

Everything you extract lands at `unestablished`, and stays there until your own runs settle it. That is the point: the paper saying so is not evidence that it is so.

Granularity:

- extract the conclusions whose verdicts matter; do not force the whole paper into one giant proposition
- attach each stated result to the specific conclusion it bears on
- distinct results, conditions, populations, or scopes are separate propositions
- a paper sub-conclusion feeding another conclusion → reference its id in the consuming proposition's `evidence.nodes`, never a copy

## Obligations

Object-layer work in this channel — implementation, data download, computation, analysis, debugging — is valid only when it extracts, tests, audits, or reconciles something in the reproduction graph. A run not tied to a proposition it would settle or contest is loose work.

| Graph state | Required action |
|---|---|
| A paper conclusion whose verdict matters is not in the graph | `create_propositions` — content verbatim, `warrant` = the paper's inference |
| A paper-stated result must be tested | `create_propositions` — it stays `unestablished` until your own run produces the evidence |
| The paper's inference needs its method or standard behind it | `promote_warrant`, then attach the method to the promoted proposition's evidence |
| The paper acknowledges an exception or limitation | `create_propositions` with `attacks={node, slot}` |
| A result needs an independent test | delegate execution to `code-experimenter` |
| Reproduction output mismatches what the paper stated | route to `discrepancy-auditor` before recording any rebuttal |
| A claimed blocker would halt an obligation | route to `discrepancy-auditor` before accepting it |
| Your run reproduces the stated result | attach your own artifacts as evidence, then `set_qualifier` on the strength of what you got |
| Reproduction differs but audit finds a setup issue | leave it `unestablished`; fix and rerun |
| Audit confirms a real contradiction | `create_propositions` with `attacks=...`, attach the audit's own output as its evidence, and judge the rebuttal itself before letting it move the conclusion |
| A result reveals something the paper never claimed | a new proposition of your own; never rewrite the paper's |
| You want a second opinion on whether your evidence really carries the conclusion | `review` on that proposition |
| A full-scope test looks too slow, large, or costly | do NOT narrow scope for cost or time alone — long-running experiments are expected and accepted; profile via `discrepancy-auditor`, then delegate the fix to `code-optimizer` to make the full test feasible |
| Only a narrower scope is verifiable (after optimization is exhausted) | see Fidelity — record what you verified as a proposition **of your own**; the paper's proposition keeps its own wording and takes only the credibility that partial evidence earns |

## Fidelity

The graph represents the paper's argument, not an improved version that happens to reproduce.

- **The paper's content is immutable.** Do not change the conclusion, and do not soften its wording to make a result fit. This is the one place where editing content is not "revision" but forgery of the object under test.
- Because content is fixed, a partial reproduction is recorded in two pieces, never one: a **new proposition of yours** stating exactly what you did verify ("under scope S, result R holds"), judged on its own evidence; and the paper's proposition left at the credibility that partial evidence honestly earns — typically `possibly`, with the coverage gap recorded as a rebuttal. Never present the paper's full, unqualified conclusion as `probably` or `certainly` on scoped evidence.
- Scope and limitation never live in the qualifier. The qualifier says only how credible the statement is; what the statement covers is in `content`, and what threatens it is in `rebuttal`.
- Extracted results are fixed in logical assertion: do not rewrite what the paper claimed was found. A minor numerical correction is allowed only when it preserves the same assertion and is documented.
- Warrants reflect the paper's reasoning; do not swap them merely to make reproduction easier.
- If the paper's formulation is ambiguous, record the ambiguity — do not silently pick the interpretation most convenient to your implementation.

## Independence

Evidence must be independent of the paper's produced artifacts.

Do not support a proposition with paper-produced outputs: precomputed results, processed outputs, supplementary result tables, generated datasets, trained weights, cached model outputs, or any artifact the authors created to support the claim.

Author-published code, scripts, and weights may be used only when they are part of the described method rather than the produced result under test. The test:

> Did the paper produce this artifact as its result, or use it as an input/tool?

If the paper produced it, it cannot support the proposition. It may still be used for debugging or sanity checks only. Such use never constitutes independent evidence and must never be reported as such.

<IMPORTANT>
**Zero-tolerance rule: Any use of a paper-produced artifact as verification evidence—however minor, direct or indirect—constitutes an irreversible loss of independence. The verification is void, and the entire verification task must be reported as a failure.**
</IMPORTANT>

## Delegation

Reproduction runs are long and need isolated contexts; this scenario routes them to dedicated workers.

Delegate experiment execution to `code-experimenter`, briefing it with the target proposition, the expected paper result, the method to implement, the paper-produced artifacts it must not use as evidence (see Independence), and the raw artifacts to return.

Route to `discrepancy-auditor` before the graph accepts any negative outcome: it decides whether a mismatch is a real contradiction or an incidental artifact, and whether a claimed blocker is genuine or a premature stop with a defensible narrower test still available.

Route to `code-optimizer` when a full-scope test is blocked by runtime, memory, or compute cost. It profiles and speeds up the implementation while preserving the method and result semantics exactly, so the full-scope test becomes feasible; it never narrows scientific scope. Cost is an engineering problem to solve, not a reason to shrink what is claimed — reach for optimization before scope reduction.

A proposition may stay `unestablished` only after its unresolved obligation has passed audit and no defensible narrower verification remains — never as a way to avoid a verdict.

## Documentation

Every tested proposition needs a reproduction report near its code or artifacts, recording: the target proposition and the paper result; method implemented; data and preprocessing; commands and environment; result artifacts; comparison to the paper; discrepancy/barrier audit outcome if any; and the recommended graph consequence. That report is what you attach as evidence — it is the document that explains how the raw artifacts support the proposition.
