# Reproducing a Paper

> [English](reproduce-a-paper.md) | [简体中文](../zh-CN/reproduce-a-paper.md)

## Goal

Verify whether a paper's claims are correct by building an independent argument graph. Run `/paper-reproduce` to start. **Done** means every Claim has a verdict — `supported`, `disputed`, or `refuted`. `proposed` is acceptable only when `declare-barrier` has been invoked and a genuine barrier confirmed.

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

**Claims are immutable.** A Claim encodes exactly what you are verifying. If reproduction yields a different result, the difference belongs in a Rebuttal — not in a modified Claim. Changing the Claim changes what you're testing. Grounds allow minor numerical corrections (e.g., 42.3 → 42.1 from seed or implementation variance), but the finding a Ground asserts is fixed for the same reason.

**Grounds start as hypotheses.** A Ground initializes as `verification="pending"`. It is `verified` when an independent reproduction has been completed and a description document is attached. A Ground without a description document is incomplete.

**Independence.** If the paper produced an artifact — supplementary data, pre-computed outputs, model weights — you cannot use it as verification evidence. That is circular. Author-published code may be reused as long as it matches the paper's described methodology. The test: *did this paper produce this artifact, or did the paper use it as external input?*

---

## declare-barrier

Agents give up too easily — they hit "the data isn't available" or "this is too complex" and stop. `declare-barrier` is built around that instinct: it presents itself as the official, sanctioned way to declare a task blocked, which is exactly why an agent reaches for it. But instead of granting the exit, it interrogates the claimed barrier against eight recurring patterns of false barriers. The only way "out" is to prove the barrier is real — which, far more often, means discovering it wasn't.

Any time the agent encounters "cannot / not available / too complex / not feasible", it must invoke `/declare-barrier` before accepting the block. The skill produces a classification:

- **Class A** — false barrier, path is clear, proceed immediately
- **Class B** — scope reduction: define the narrower sub-task and execute it (the declaration alone is not the deliverable)
- **Class C** — genuine barrier, only after all four hard conditions are met

A Claim may not remain `proposed` without `declare-barrier` having been invoked. If a Claim is still `proposed` when everything else is done, you can invoke `/declare-barrier` yourself to force the assessment.

---

## Graph states to watch

These states are visible in the graph or the visualizer and signal that something needs attention.

| State | What it means |
|-------|--------------|
| A `Ground` has `verification='pending'` while its Claim is `supported` | The conclusion rests on unverified evidence |
| A `Ground` has no description document | Reproduction is incomplete regardless of verification status |
| A `Claim` is `proposed` with no active work remaining | `declare-barrier` has not been invoked |
| A `Claim`'s compile is `stale` | Something in the argument chain was modified — rerun `compile_arguments` |
| A `Rebuttal` exists but the `Claim` is `supported` | A contradiction has been recorded; the verdict may need reassessment |

---

## When the agent goes off track

These are the failures you'll actually see, and the most direct way to name each one. Describing the graph state gets to the root faster than describing the symptom.

**The agent gave up without invoking `declare-barrier`.** It left a Claim `proposed`, or said a step "wasn't feasible," but you never saw a barrier assessment. Invoke it yourself: `/declare-barrier`. Most of the time the assessment finds the barrier was false and the work continues.

**The agent reported a conclusion that doesn't match the paper.** Somewhere along the way it quietly rewrote the Claim to fit what it managed to reproduce. Say: *"In reproduction the Claim must stay verbatim to the paper. If your result differs, that's a Rebuttal — don't change the Claim."* This is the most common drift, and it's invisible unless you compare the Claim node against the paper's wording.

**A Claim is `supported` but one of its Grounds is still `pending`.** The verdict is resting on evidence that was never independently reproduced. Select that Ground in the visualizer and ask: *"This Ground isn't verified — why is the Claim supported?"* Either the reproduction is missing, or the Ground is leaning on an artifact the paper itself produced — which can't count as verification.

**The Warrant just restates that the Grounds support the Claim.** Something like "the experimental results support the conclusion" isn't an inference principle — it names the connection instead of explaining it, and that's the usual reason a chain check fails. Say: *"This Warrant is circular. State the inference principle — given this kind of evidence, by what reasoning does it imply this conclusion?"*

**The agent called a Claim `supported`, but its compile is `stale`.** It changed something in the chain — a Ground, the Warrant — which reverts the Claim to `proposed` and marks the compile stale, then reported success anyway. Say: *"The compile is stale — re-run `compile_arguments` and re-assess the evidence before this is `supported`."*

**The agent declared a Class B barrier and stopped.** Class B is a scope *reduction*, not an exit — the narrower sub-task still has to be defined and executed. Say: *"Class B means do the reduced task, not just declare it. What's the narrower version, and where's its result?"*
