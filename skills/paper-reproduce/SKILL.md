---
name: paper-reproduce
description: Use for reproducing published papers or validating whether a paper's Claims and stated results hold under independent reproduction. Preserve the paper's Claims, map stated results to hypothesis Grounds, enforce verification independence, delegate experiment work to code-experimenter, and route mismatches and claimed blockers to discrepancy-auditor before any Rebuttal or barrier verdict.
---

## Graph Mapping

The paper's argument is the object under test. Extract it into the graph first; reproduction then tests whether those Grounds hold under independent execution.

```
paper conclusion                           -> Claim
paper stated result                        -> hypothesis Statement(Ground role), verification=pending
paper inference from result to conclusion  -> Warrant
paper method/standard behind the inference -> Backing
paper acknowledged exception               -> Rebuttal
```

Granularity:

- extract the Claims whose verdicts matter; do not force the whole paper into one giant Claim
- attach each stated result to the specific Claim it bears on
- distinct results, conditions, populations, or scopes are separate hypothesis Grounds
- a paper sub-Claim used as evidence for another Claim -> reference the sub-Claim's id directly in the consuming Warrant's `ground_ids`

## Obligations

Object-layer work in this channel — implementation, data download, computation, analysis, debugging — is valid only when it extracts, tests, audits, or reconciles a node or Claim status in the reproduction graph. A run not tied to a Ground it verifies or contests is loose work.

| Graph state | Required action |
|---|---|
| A paper conclusion whose verdict matters has no Claim | `create_claim`, status `proposed` |
| A paper-stated result must be tested | `create_statement(source="hypothesis", verification="pending")` |
| A Claim's Grounds have no inference principle | `create_warrant` |
| A Warrant needs authority | `create_statement(...)` from the paper's method or standard, then `update_node(<warrant>, backing_ids={add:[...]})` |
| The paper acknowledges an exception or limitation | `create_statement(rebuttal_for={target_id, target_type})` |
| The initial Claim-Ground-Warrant structure exists | `compile_arguments` — coherence to test, not proof |
| A hypothesis Ground needs an independent test | delegate execution to `code-experimenter` |
| Reproduction output mismatches a Ground | route to `discrepancy-auditor` before any Rebuttal |
| A claimed blocker would halt an obligation | route to `discrepancy-auditor` before accepting it |
| A result supports its Ground | `update_node(verification="verified", attachments=[...])` |
| Reproduction differs but audit finds a setup issue | keep the Ground `pending`; fix and rerun |
| Audit confirms a real contradiction | `create_statement(rebuttal_for=...)`; move the Claim to `disputed`/`refuted` only after compile and evidence assessment |
| A result reveals something the paper never claimed | new observed Statement or Claim; never rewrite the paper Claim |
| A full-scope test looks too slow, large, or costly | do NOT narrow scope for cost or time alone — long-running experiments are expected and accepted; profile via `discrepancy-auditor`, then delegate the fix to `code-optimizer` to make the full test feasible |
| Only a narrower scope is verifiable (after optimization is exhausted) | bound the Claim with a `qualifier` that honestly records the verified scope and degree; the Claim may then be `supported` **within that qualifier** — never present the full, unqualified Claim as `supported` on scoped evidence |

## Fidelity

The graph represents the paper's argument, not an improved version that happens to reproduce.

- Claims are fixed: do not change the conclusion, and do not loosen scope or qualifier to make a result fit. Adding a qualifier that *honestly narrows* the verified scope and degree is not loosening — it is the allowed way to record what reproduction actually established (see the Obligations table).
- Hypothesis Grounds are fixed in logical assertion: do not rewrite what the paper claimed was found. A minor numerical correction is allowed only when it preserves the same assertion and is documented.
- Warrants reflect the paper's reasoning; do not swap them merely to make reproduction easier.
- If the paper's formulation is ambiguous, record the ambiguity — do not silently pick the interpretation most convenient to your implementation.
- A confirmed contradiction stays visible as a Rebuttal or status change; it is never erased by rewriting the Claim or Ground.

## Independence

Verification evidence must be independent of the paper's produced artifacts.

Do not verify a Ground with paper-produced outputs: precomputed results, processed outputs, supplementary result tables, generated datasets, trained weights, cached model outputs, or any artifact the authors created to support the claim.

Author-published code, scripts, and weights may be used only when they are part of the described method rather than the produced result under test. The test:

> Did the paper produce this artifact as its result, or use it as an input/tool?

If the paper produced it, it cannot verify the Ground. It may still be used for debugging or sanity checks only. Such use never constitutes verification evidence and must never be reported as independent verification of the Ground.

<IMPORTANT>
**Zero-tolerance rule: Any use of a paper-produced artifact as verification evidence—however minor, direct or indirect—constitutes an irreversible loss of independence. The verification is void, and the entire verification task must be reported as a failure.**
</IMPORTANT>

## Delegation

Reproduction is long-running and demands isolated context, so delegate substantial object-layer work by default. All delegated workers report evidence only; none set Claim status nor create Rebuttals — you own those graph decisions.

Delegate experiment execution to `code-experimenter`, briefing it with the target hypothesis Ground, the expected paper result, the method to implement, the paper-produced artifacts it must not use as verification (see Independence), and the raw artifacts to return.

Route to `discrepancy-auditor` before the graph accepts any negative verdict: it decides whether a mismatch is a real contradiction or an incidental artifact, and whether a claimed blocker is genuine or a premature stop with a defensible narrower test still available.

Route to `code-optimizer` when a full-scope test is blocked by runtime, memory, or compute cost. It profiles and speeds up the implementation while preserving the method and result semantics exactly, so the full-scope test becomes feasible; it never narrows scientific scope. Cost is an engineering problem to solve, not a reason to shrink a Claim — reach for optimization before scope reduction.

A Claim may stay `proposed` only after its unresolved obligation has passed audit and no defensible narrower verification remains — never as a way to avoid a verdict.

## Documentation

Every tested Ground needs a reproduction report near its code or artifacts, recording: target Ground and paper result; method implemented; data and preprocessing; commands and environment; result artifacts; comparison to the paper; discrepancy/barrier audit outcome if any; and the recommended graph consequence.
