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

## When something seems off

The graph gives you a precise language to describe problems. These translations reduce the back-and-forth.

---

**You feel:** "The agent's conclusion doesn't quite match the paper."

The Claim content may have been modified. In this scenario, Claims must be verbatim from the paper.

**Say:** "What is the current content of Claim #N? Compare it against the paper's original wording. If it has been changed, revert it — differences go in a Rebuttal, not in the Claim."

---

**You feel:** "The agent says it's done but I'm not sure the work holds up."

Check whether Grounds are actually verified.

**Say:** "How many Grounds still have `verification='pending'`? A Claim cannot be considered supported on unverified evidence."

---

**You feel:** "The agent gave up on something and moved on."

A Claim in `proposed` state signals this.

**Say:** "Claim #N is still `proposed`. Has `declare-barrier` been invoked for this Claim? If not, invoke it now."

---

**You feel:** "The agent declared it was blocked but didn't actually do anything about it."

`declare-barrier` Class B requires executing the narrowed sub-task — the declaration is not the deliverable.

**Say:** "The `declare-barrier` classification for Claim #N was Class B. Where are the results of the narrowed sub-task? Class B without sub-task execution is treated as Class C."

---

**You feel:** "I'm not sure the reproduction is actually independent."

Check the description documents attached to Grounds.

**Say:** "For Ground #N — what was the source of verification? Was any data or output produced by the paper itself used? Supplementary data or pre-computed outputs cannot be used as verification evidence."

---

**You feel:** "The results are clearly different from the paper but the Claim is marked supported."

The contradiction should be a Rebuttal.

**Say:** "If your result contradicts the paper's stated Ground, create a Rebuttal documenting the discrepancy. Then reassess Claim #N — it should be `disputed` or `refuted`, not `supported`."
