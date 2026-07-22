# The Argument Graph

## What Warranted is for

Most research tools help you work faster. Warranted helps you work with fewer hidden assumptions — every conclusion has a traceable chain of evidence and reasoning. If the chain doesn't hold up, the conclusion can't be marked as supported.

This is not a general-purpose writing assistant. If you want prose polish, use other tools. Warranted is for the structure underneath: what you're claiming, what you're claiming it's based on, and whether that connection survives scrutiny.

---

## The five node types

Warranted implements the [Toulmin model](https://en.wikipedia.org/wiki/Toulmin_model) of argumentation.

**Claim** — a proposition you are asserting. In paper reproduction, this is the paper's conclusion extracted verbatim. In original writing, this is your synthesis judgment. Claims advance from `proposed` to a verdict only after the argument chain passes a logic check.

**Ground** — evidence that supports the Claim. In paper reproduction, this is the paper's stated experimental result (initially a hypothesis, updated as you verify). In literature writing, this is a specific finding from a published paper (with the PDF attached as provenance).

**Warrant** — the inference principle connecting Ground to Claim. Not "these grounds support the claim" (that's circular) — but the reasoning rule that makes the inference valid: "given [condition], [evidence type] implies [conclusion direction]."

**Backing** — support for the Warrant's authority. Used when the inference principle itself needs justification — typically a methodological consensus or meta-analysis.

**Rebuttal** — a documented exception or contradiction. In reproduction, a result that differs from the paper. In writing, a paper with conflicting findings or a known boundary condition of the Claim.

---

## Compile

`compile_arguments` runs a logic audit on a Claim and its entire argument subgraph. It checks:

1. **Structure** (deterministic): is the chain complete? Claim → Warrant → Grounds, with no missing links.
2. **Chain** (LLM): is the reasoning coherent? Does the Warrant actually connect the evidence to the conclusion, or is it circular?

A Claim's status cannot advance to `supported`, `disputed`, or `refuted` unless compile has passed. This is enforced — not advisory.

Run compile after building the initial structure. Run it again after any structural change.

---

## Status lifecycle

```
proposed
   │
   ▼ (compile passes + evidence assessed)
supported / disputed / refuted
   │
   ▼ (any node in the argument chain is modified)
proposed  ← back here, automatically
```

When a node in the argument chain is mutated, the Claim's compile state becomes `stale` and its status reverts to `proposed`. The tool response tells you which Claim was affected and why. This is intentional: a modification to the evidence or reasoning invalidates the prior verdict.

To advance the status again: run `compile_arguments`, then re-assess.

---

## Using Warranted alongside other tools

Warranted manages epistemic structure — what you're claiming, on what basis, with what reasoning. It does not manage prose quality, speed, or breadth of search.

Other tools (ultrathink, general writing assistants) work well alongside Warranted: use them for prose polish, brainstorming, or broad search. Use Warranted for the argument structure that underlies your conclusions. The combination is: other tools help you find and articulate; Warranted makes sure what you're asserting is actually supported.
