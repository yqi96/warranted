---
name: paper-reproduce
description: Build and verify an independent argument graph to assess whether a paper's claims hold. Use for reproducing published experimental results, validating paper claims, or building argument graphs from academic literature.
---

Extract the paper's argument structure. Verify every node through independent execution.

## Core Principle

The paper's argument is what you're evaluating. Extract it into a Toulmin graph — every Ground starts as `source="hypothesis"` + `verification="pending"`, every Claim as `proposed`. Your job is to verify whether the paper's claims hold through independent work.

**Strict constraints on independent reproduction**: All results published by the author are forbidden and must not be used as evidence for Grounds — this includes numbers, figures, and any form of published result files (supplementary data, output.npy on GitHub, pre-computed artifacts, etc.). Using the author's results to verify the author's conclusions is circular reasoning. However, tools published by the author (code, scripts, model weights) may be used — as long as they match the paper's description. The distinction is: results are "what was done" (must produce yourself), tools are "how it was done" (may be reused).

## Procedure

### Phase 1: Extract the Argument Graph

Read the paper and extract the author's argument structure. Nothing is accepted yet:

1. **Claim**: What conclusion is the paper making? → `create_claim`
2. **Ground**: What evidence does the paper appeal to? → `create_ground(source="hypothesis", verification="pending")`
3. **Warrant**: What reasoning connects their Ground to their Claim? → `create_warrant`
4. **Backing** (if any): What supports their Warrant? → `create_backing`
5. **Rebuttal** (if any): What exceptions does the paper acknowledge? → `create_rebuttal`

> **Chained reasoning**: When a sub-Claim serves as evidence for another Claim, use `create_ground(ref_claim_id=sub-Claim.id)`.

### Phase 2: Node-by-Node Verification

Use `get_argument` to review the graph. Verify each node:

**Ground verification** (produce independent evidence):

```
hypothesis + pending
    ↓ Design and execute verification
    Task: Obtain data → Write scripts → Run → Save outputs + README
    ↓ Results are reproducible
    observed + verified + attachments
```

- Can verify → `update_node(source="observed", verification="verified", attachments=[...])`
- Cannot verify (data unavailable, method opaque, results diverge) → Keep `hypothesis + pending`. Add a README explaining what prevented verification. This is a valid scientific outcome — the goal is honest documentation, not forced success.

**Claim adjudication** (conclusion assessment):

- All Grounds verified + Warrant sound → `update_node(status="supported")`
- Some Grounds unverifiable → Keep `proposed`. Document why. Unverifiable claims are honest findings, not failures.
- Results contradict the paper → `update_node(status="disputed")`. Contradiction is information.

### Phase 3: Global Review

After verification:

1. `get_stats` to see overall progress
2. `get_argument(claim_id)` to examine each Claim's argument
3. Check for orphan nodes (Claims without Warrants, Warrants without Grounds)
4. Confirm all Claim statuses are reasonably adjudicated

## Checklist

- [ ] Every `verified` Ground has attachments
- [ ] Unverifiable Grounds remain `hypothesis + pending` with documented reasons; Claim status reflects evidence honestly
- [ ] All Claim statuses reasonably adjudicated
