# Reproducing a Paper

## Goal

Verify whether a paper's claims are correct by building an independent argument graph. **Done** means every Claim has a verdict — `supported`, `disputed`, or `refuted`. `proposed` is acceptable only when `declare-barrier` has been invoked and a genuine barrier confirmed.

---

## The graph in this scenario

The graph represents the paper's argument, not a new one. Every node is extracted from the paper.

| Node | What it represents | Initial state |
|------|--------------------|---------------|
| **Claim** | The paper's conclusion, extracted verbatim | `proposed` |
| **Ground** | The paper's stated experimental result | `source="hypothesis"`, `verification="pending"` |
| **Warrant** | The inference principle connecting Ground to Claim | — |
| **Backing** | Support for the Warrant's authority | — |
| **Rebuttal** | A contradiction found during reproduction | — |

**Claims are immutable.** A Claim encodes exactly what you are verifying. If reproduction yields a different result, the difference belongs in a Rebuttal — not in a modified Claim. Changing the Claim changes what you're testing.

**Grounds start as hypotheses.** A Ground initializes as `verification="pending"`. To verify it: reproduce the result independently, write a description document explaining what was done and what was found, then mark it `verified`. A Ground without a description document is incomplete.

**Independence.** If the paper produced an artifact — supplementary data, pre-computed outputs, model weights — you cannot use it as verification evidence. That is circular. Author-published code may be reused as long as it matches the paper's described methodology. The test: *did this paper produce this artifact, or did the paper use it as external input?*

---

## declare-barrier

Any time the agent encounters "cannot / not available / too complex / not feasible", it must invoke `/declare-barrier` before accepting the block. The skill interrogates the claimed barrier against eight recurring patterns of false barriers and produces a classification:

- **Class A** — false barrier, path is clear, proceed immediately
- **Class B** — scope reduction: define the narrower sub-task and execute it (the declaration alone is not the deliverable)
- **Class C** — genuine barrier, only after all four hard conditions are met

A Claim may not remain `proposed` without `declare-barrier` having been invoked. If a Claim is still `proposed` when everything else is done, you can invoke `/declare-barrier` yourself to force the assessment.

---

## Graph states to watch

These states are visible in the graph or the visualizer and signal that something needs attention.

| State | What it means |
|-------|--------------|
| A `Claim`'s content differs from the paper's original wording | Claims are immutable — differences belong in a Rebuttal, not the Claim |
| A `Ground` has `verification='pending'` while its Claim is `supported` | The conclusion rests on unverified evidence |
| A `Ground` has no description document | Reproduction is incomplete regardless of verification status |
| A `Claim` is `proposed` with no active work remaining | `declare-barrier` has not been invoked |
| A `Claim` is `stale` | Something in the argument chain was modified — rerun `compile_arguments` |
| A `Rebuttal` exists but the `Claim` is `supported` | A contradiction has been recorded; the verdict may need reassessment |
