---
name: paper-reproduce
description: Use for reproducing published papers or validating whether a paper's Claims and stated results hold under independent reproduction. Preserve the paper's Claims, map stated results to hypothesis Grounds, enforce verification independence, delegate experiment work to code-experimenter, and route mismatches and claimed blockers to discrepancy-auditor before any Rebuttal or barrier verdict.
---

## Graph Mapping

The paper's argument is the object under test. Extract it into the graph first; reproduction then tests whether those Grounds hold under independent execution.

```
paper conclusion                           -> Claim
paper stated result                        -> hypothesis Ground, verification=pending
paper inference from result to conclusion  -> Warrant
paper method/standard behind the inference -> Backing
paper acknowledged exception               -> Rebuttal
```

Granularity:

- extract the Claims whose verdicts matter; do not force the whole paper into one giant Claim
- attach each stated result to the specific Claim it bears on
- distinct results, conditions, populations, or scopes are separate hypothesis Grounds
- a paper sub-Claim used as evidence for another Claim -> `create_ground(ref_claim_id=sub_claim_id)`

## Obligations

Object-layer work in this channel — implementation, data download, computation, analysis, debugging — is valid only when it extracts, tests, audits, or reconciles a node or Claim status in the reproduction graph. A run not tied to a Ground it verifies or contests is loose work.

| Graph state | Required action |
|---|---|
| A paper conclusion whose verdict matters has no Claim | `create_claim`, status `proposed` |
| A paper-stated result must be tested | `create_ground(source="hypothesis", verification="pending")` |
| A Claim's Grounds have no inference principle | `create_warrant` |
| A Warrant needs authority | `create_backing` from the paper's method or standard |
| The paper acknowledges an exception or limitation | `create_rebuttal` |
| The initial Claim-Ground-Warrant structure exists | `compile_arguments` — coherence to test, not proof |
| A hypothesis Ground needs an independent test | delegate execution to `code-experimenter` |
| Reproduction output mismatches a Ground | route to `discrepancy-auditor` before any Rebuttal |
| A claimed blocker would halt an obligation | route to `discrepancy-auditor` before accepting it |
| A result supports its Ground | `update_node(verification="verified", attachments=[...])`, reassess the Claim after compile |
| Reproduction differs but audit finds a setup issue | keep the Ground `pending`; fix and rerun |
| Audit confirms a real contradiction | `create_rebuttal`; move the Claim to `disputed`/`refuted` only after compile and evidence assessment |
| A result reveals something the paper never claimed | new observed Ground or Claim; never rewrite the paper Claim |
| Only a narrower scope can be tested | record scoped evidence; do not let scoped success make the broader Claim `supported` |

## Fidelity

The graph represents the paper's argument, not an improved version that happens to reproduce.

- Claims are fixed: do not change conclusion, scope, or qualifier to fit your results.
- Hypothesis Grounds are fixed in logical assertion: do not rewrite what the paper claimed was found. A minor numerical correction is allowed only when it preserves the same assertion and is documented.
- Warrants reflect the paper's reasoning; do not swap them merely to make reproduction easier.
- If the paper's formulation is ambiguous, record the ambiguity — do not silently pick the interpretation most convenient to your implementation.
- A confirmed contradiction stays visible as a Rebuttal or status change; it is never erased by rewriting the Claim or Ground.

## Independence

Verification evidence must be independent of the paper's produced artifacts.

Do not verify a Ground with paper-produced outputs: precomputed results, processed outputs, supplementary result tables, generated datasets, trained weights, cached model outputs, or any artifact the authors created to support the claim.

Author-published code, scripts, and weights may be used only when they are part of the described method rather than the produced result under test. The test:

> Did the paper produce this artifact as its result, or use it as an input/tool?

If the paper produced it, it cannot verify the Ground. It may still serve sanity checks, debugging, or a narrower sub-step — but that narrower check must not be reported as independent verification of the original Ground.

## Delegation

Reproduction is long-running and demands isolated context, so delegate substantial object-layer work by default. Both workers report evidence only; neither sets Claim status nor creates Rebuttals — you own those graph decisions.

Delegate experiment execution to `code-experimenter`, briefing it with the target hypothesis Ground, the expected paper result, the method to implement, the paper-produced artifacts it must not use as verification (see Independence), and the raw artifacts to return.

Route to `discrepancy-auditor` before the graph accepts any negative verdict: it decides whether a mismatch is a real contradiction or an incidental artifact, and whether a claimed blocker is genuine or a premature stop with a defensible narrower test still available.

A Claim may stay `proposed` only after its unresolved obligation has passed audit and no defensible narrower verification remains — never as a way to avoid a verdict.

## Documentation

Every tested Ground needs a reproduction report near its code or artifacts, recording: target Ground and paper result; method implemented; data and preprocessing; commands and environment; result artifacts; comparison to the paper; discrepancy/barrier audit outcome if any; and the recommended graph consequence.
