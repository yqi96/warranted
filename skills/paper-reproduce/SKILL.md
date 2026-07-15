---
name: paper-reproduce
description: Build and verify an independent argument graph to assess whether a paper's claims hold. Use for reproducing published experimental results, validating paper claims, or building argument graphs from academic literature.
---

## Goal

Verify whether the paper's claims are correct. Maintain strict neutrality throughout: supported and disputed are equally valid scientific outcomes.

**Done means**: every Claim has a clear conclusion — supported, disputed, or proposed. `proposed` is the conclusion of last resort when a verdict genuinely cannot be reached; it requires `declare-barrier` skill to have been invoked and is not an exit ramp.

## How to use the Toulmin graph

### Extract the argument structure

Read the paper and extract its argument structure. Every node starts as a hypothesis.

- `create_claim` — the paper's conclusion; initializes as `proposed`, updated to `supported` or `disputed` via `update_node` based on verification results
- `create_ground(source="hypothesis", verification="pending")` — the paper's stated experimental result, written as a declarative finding; initializes as a hypothesis, updated via `update_node` as verification proceeds
- `create_warrant` — the inference principle connecting Ground to Claim
- `create_backing` (if any) — what supports the Warrant's authority
- `create_rebuttal` (if any) — exceptions the paper acknowledges

> **Chained reasoning**: when a sub-Claim serves as evidence for another Claim, use `create_ground(ref_claim_id=sub-Claim.id)`.

Once extracted, run `compile_arguments` to verify the reasoning structure is logically coherent. Re-run it any time you modify the argument structure.

### Drive action from Claims

For each Claim, ask: what is preventing it from being marked supported or disputed? Act independently to remove that blocker, update the graph, and re-examine. Repeat until every Claim has a clear conclusion.

## Constraints

**Independence**

Do not use the paper's produced artifacts — supplementary data, pre-computed outputs, GitHub artifacts — as verification evidence. That is circular reasoning.

Author-published tools (code, scripts, model weights) may be reused as long as they match the paper's described methodology.

The test: *did this paper produce this artifact, or did the paper use it as external input?* If the paper produced it, do not use it — reproduce it independently.

**declare-barrier**

Any time during execution you encounter: cannot / not available / too complex / not feasible / not reproduced — you must invoke the **declare-barrier** skill before proceeding. A Claim may not be left as `proposed` without declare-barrier having been called.

**Description document**

Every Ground gets a description document, placed near the reproduction code. It should explain what was done, what was found, and why you reached your judgment — well enough for someone else (or future you) to follow the reasoning.
