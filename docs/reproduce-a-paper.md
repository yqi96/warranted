# Reproducing a Paper

## Goal

Verify whether a paper's claims are correct by building an independent argument graph. The outcome is a verdict for each Claim — `supported`, `disputed`, or `refuted`. `proposed` means the evidence is still incomplete, not that the question is unanswerable.

---

## The graph in this scenario

The graph represents the paper's argument, not a new one. Every node is extracted from the paper and remains fixed throughout reproduction.

| Node | What it represents | Initial state |
|------|--------------------|---------------|
| **Claim** | The paper's conclusion, extracted verbatim | `proposed` |
| **Ground** | The paper's stated experimental result | `source="hypothesis"`, `verification="pending"` |
| **Warrant** | The inference principle connecting Ground to Claim | — |
| **Backing** | Support for the Warrant's authority | — |
| **Rebuttal** | A contradiction found during reproduction | — |

Two constraints to internalize:

**Claims are immutable.** A Claim encodes exactly what you are verifying. If your reproduction yields a different result, that difference belongs in a Rebuttal — not in a modified Claim. Changing the Claim changes what you're testing.

**Grounds start as hypotheses.** A Ground initializes as `verification="pending"` because you haven't verified it yet. As you reproduce each result, you update the Ground: attach a description document, then mark it `verified`. A Ground without a description document is incomplete.

---

## Workflow

### 1. Extract

Run `/paper-reproduce`. The agent reads the paper and builds the initial graph: Claims extracted verbatim, Grounds initialized as pending hypotheses, Warrant connecting them.

### 2. Reproduce

For each Ground, independently reproduce the stated result. The test for independence: if the paper produced this artifact (data file, pre-computed output, model weights), you cannot use it as verification — reproduce it from scratch. Author-published code is fine to reuse as long as it matches the paper's described methodology.

Update each Ground as you work: attach the description document, then set `verification="verified"`. Run `compile_arguments` after the graph is built, and again after any structural change.

### 3. Assess

Once all Grounds are verified, assess each Claim: does the evidence support it, dispute it, or refute it? Update Claim status via `update_node`.

### 4. When you can't proceed: `declare-barrier`

Any time the agent encounters "cannot / not available / too complex / not feasible" — it must invoke `/declare-barrier` before accepting the block. The skill runs through eight recurring patterns of false barriers and produces a classification:

- **Class A** — false barrier, path is clear, implement immediately
- **Class B** — scope reduction, execute the narrowed sub-task (declaring Class B without executing the sub-task is invalid)
- **Class C** — real barrier, only after all four hard conditions are met

A Claim may not remain `proposed` at the end without `declare-barrier` having been invoked. If you reach the end and a Claim is still `proposed`, you can invoke `declare-barrier` yourself to force the assessment.

---

## When something seems off

The graph gives you a precise language to describe problems. These translations reduce the back-and-forth.

---

**You feel:** "The agent's conclusion doesn't quite match the paper."

The problem is likely the Claim content was modified. In this scenario, Claims must be verbatim from the paper.

**Say:** "What is the current content of Claim #N? Compare it against the paper's original wording. If it has been changed, revert it — differences go in a Rebuttal, not in the Claim."

---

**You feel:** "The agent says it's done but I'm not sure the work actually holds up."

Check whether Grounds are verified.

**Say:** "How many Grounds still have `verification='pending'`? A Claim cannot be considered supported on unverified evidence."

---

**You feel:** "The agent gave up on something and moved on."

A Claim in `proposed` state at the end of the workflow signals this.

**Say:** "Claim #N is still `proposed`. Has `declare-barrier` been invoked for this Claim? If not, invoke it now."

---

**You feel:** "The agent declared it was blocked but didn't actually do anything about it."

`declare-barrier` Class B requires executing the narrowed sub-task — the declaration is not the deliverable.

**Say:** "The `declare-barrier` classification for Claim #N was Class B. Where are the results of the narrowed sub-task? Class B without sub-task execution is treated as Class C."

---

**You feel:** "I'm not sure the reproduction is actually independent."

Check the description documents attached to the Grounds.

**Say:** "For Ground #N — what was the source of verification? Was any data or output from the paper itself used? Supplementary data or pre-computed outputs produced by the paper cannot be used as verification evidence."

---

**You feel:** "The results are clearly different from the paper but the Claim is marked supported."

The contradiction should be a Rebuttal.

**Say:** "If your result contradicts the paper's stated Ground, create a Rebuttal documenting the discrepancy. Then reassess Claim #N — it should be `disputed` or `refuted`, not `supported`."
