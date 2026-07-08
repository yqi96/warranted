---
name: paper-reproduce
description: Build and verify an independent argument graph to assess whether a paper's claims hold. Use for reproducing published experimental results, validating paper claims, or building argument graphs from academic literature.
---

Build a sound argument first; execution only judges whether the argument holds.

## Goal

Verify whether the paper's claims are correct — nothing more, nothing less. Maintain strict neutrality throughout: a confirmed claim and a refuted claim are equally valid scientific outcomes. Approach the work with an objective perspective, free from any preference for a particular result. Problems encountered, dead ends reached, and failures along the way are part of the record — document them honestly, without sugarcoating.

## Two phases, one priority

**Phase 1 (Extract)** is the scientific thinking chain. It maps the paper's logical structure: what is claimed, what evidence the paper appeals to, and whether the inference from evidence to conclusion is sound. This is the primary scientific work — do not rush it to get to coding.

**Phase 2 (Verify)** is execution: independently reproduce the results that Phase 1 identified as Grounds, then update the graph with what you actually found.

A poorly-structured Phase 1 makes Phase 2 meaningless — you will produce numbers with no clear argumentative target.

## Phase 1: Extract the argument graph

Read the paper and extract its argument structure. Nothing is accepted yet — every node starts as a hypothesis.

1. **Claim**: What conclusion is the paper making? → `create_claim`
2. **Ground**: What result does the paper appeal to as evidence? → `create_ground(source="hypothesis", verification="pending")`
3. **Warrant**: What inference principle connects Ground to Claim? → `create_warrant`
4. **Backing** (if any): What supports the Warrant's authority? → `create_backing`
5. **Rebuttal** (if any): What exceptions does the paper acknowledge? → `create_rebuttal`

> **Chained reasoning**: When a sub-Claim serves as evidence for another Claim, use `create_ground(ref_claim_id=sub-Claim.id)`.

6. **Plan verification**: Step back and look at the graph as a whole. Determine dependency order (if Claim B depends on sub-Claim A, verify A first). For each Ground, check whether you understand what kind of evidence would confirm or refute it — if not, go back and clarify. Articulate what result would support the Claim and what would refute it, before running anything. This is not a one-shot gate — revisit these questions after each Ground you verify. New results may change how you approach the rest.

### What to write in a Phase 1 Ground

A Phase 1 Ground restates the paper's claimed result as the specific thing you will independently compute or observe. **Writing the paper's result here is not circular** — it is defining the hypothesis you are testing. The verification in Phase 2 is what makes it independent evidence.

**The content must describe a computation output as a finding, not the data that was used or the method that was applied.**

Write Phase 1 Grounds in the same declarative form as observed Grounds. `source="hypothesis"` already encodes that this is pending — do not add hedging language ("is expected to", "should", "假设", "预期") to the content. The content reads as a result in both cases; the `source` field is what distinguishes them.

| Wrong (input/method description) | Wrong (hedging in content) | Right (declarative result) |
|---|---|---|
| "The authors used 500 proxy records screened by FDR." | "CPS is expected to yield a variance ratio near 1.0." | "CPS applied to the proxy network yields a GMST reconstruction whose bandpass-filtered variance ratio against model simulations falls near 1.0." |
| "Logistic regression was applied to the patient cohort." | "The model is expected to achieve AUC > 0.85." | "The model achieves AUC > 0.85 on the held-out test set." |

If you cannot state a Ground as a declarative result, you have not yet identified what the paper is actually claiming as evidence.

## Phase 2: Node-by-node verification

Use `get_argument` to review the graph. For each `pending` Ground, produce the result independently:

```
hypothesis + pending
    ↓  Obtain data → write script → run → save outputs + description document
    ↓  Result is reproducible
    observed + verified + attachments
```

- Reproducible → `update_node(source="observed", verification="verified", attachments=[...])`
- Cannot verify → keep `hypothesis + pending`. Document what blocked you and why. Honest accounting of a dead end is a valid scientific outcome.

### The description document

Every Ground — whether verified or stuck — gets a description document. Its purpose is reproducibility of *your own work*: someone else (or future you) should be able to read it and understand what you did, what happened, and why you reached your judgment. Write it for that audience. There is no fixed template — include what matters: data sources, scripts, results, obstacles, reasoning. Omit what doesn't. The description document has no fixed location — place it in the script's directory, a sibling directory, or wherever fits your workspace. What matters is that a reader can find it by looking near the code.

**Claim adjudication after verifying its Grounds:**

| Evidence state | Action |
|---|---|
| All Grounds verified + Warrant sound | `update_node(status="supported")` |
| Some Grounds unverifiable | keep `proposed`; document why |
| Independent results contradict the paper | `update_node(status="disputed")` — contradiction is information |

### Strict constraint: author's results are forbidden in Phase 2

You **MUST NOT** use the paper's published result files — supplementary data, pre-computed outputs, GitHub artifacts — as verification evidence. That is circular reasoning.

Author-published **tools** (code, scripts, model weights) may be reused, as long as they match the paper's description.

**BEFORE USING ANY ARTIFACT ENCOUNTERED DURING REPRODUCTION, STOP AND APPLY THIS TEST:**

> "Did this paper *produce* this artifact, or did the paper *use* it as external input?"

If the paper produced it, **DO NOT USE IT** — go reproduce it independently instead. If the paper consumed it as external input (pre-existing datasets, instrumental records, third-party model archives), it may be reused.

**THIS JUDGMENT IS MADE AT THE MOMENT OF FIRST ENCOUNTER AND IS ABSOLUTE. THERE ARE NO EXCEPTIONS.**

## Phase 3: Global review

1. `get_stats` — check overall progress
2. `get_argument(claim_id)` — inspect each Claim's full argument chain
3. Check for orphan nodes: Claims without Warrants, Warrants without Grounds
4. Confirm all Claims are assessed — judge, don't modify
5. Read through your description documents — do they tell a coherent story? If a document is vague or hand-wavy, the verification behind it probably was too.

## When things don't work out

Reproduction is hard. These are common situations and how to think about them:

- **Data unavailable**: Try to find equivalent public data. If none exists, the Ground stays `pending` — but explain specifically what data gap blocks you, not just "data not available."
- **Method description is vague**: Make a reasonable interpretation, document your assumption, and run with it. Note in the description document that the result is assumption-dependent. This is information, not failure.
- **Results diverge from the paper**: This is the interesting case. Don't assume you made a mistake — but do check your work carefully. If the divergence is real, the Claim moves toward `disputed`. Record the discrepancy quantitatively.
- **Computationally infeasible**: Scale down if a smaller experiment still tests the same Ground. If it doesn't, document why and leave it `pending`.

The key principle: **every outcome is data**. A failed reproduction with a clear explanation is more valuable than a suspicious success.

## Checklist

- [ ] Every `verified` Ground has attachments and a description document (located near the script — same directory or sibling)
- [ ] Every `pending` Ground has a description document explaining what blocks it
- [ ] All Claims assessed — judge the author's claims, don't modify them
- [ ] Description documents are specific enough for someone to follow your reasoning
- [ ] No author-produced results were used as verification evidence
