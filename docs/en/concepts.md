# The Argument Graph

> [English](concepts.md) | [简体中文](../zh-CN/concepts.md)

## What Warranted is for

Most research tools help you work faster. Warranted helps you work with fewer hidden assumptions — every conclusion has a traceable chain of evidence and reasoning. If the chain doesn't hold up, the conclusion can't be marked as supported.

This is not a general-purpose writing assistant. If you want prose polish, use other tools. Warranted is for the structure underneath: what you're claiming, what you're claiming it's based on, and whether that connection survives scrutiny.

---

## Why each constraint exists

AI coding agents converge because compilers and tests fail loudly when the work is wrong. Research has no such signal — a conclusion is just prose, and an agent can declare it sound whenever it decides to. Warranted manufactures the missing signal: each of its constraints turns one way agents cut corners into something that can *fail*.

| The agent's shortcut | The constraint | What it forces |
|---|---|---|
| Labels a conclusion `supported` whenever it decides to | the `compile` gate | `supported` means a chain that was actually checked |
| Cites a paper it never read, or invents a plausible reference | a Ground is `verified` only with an attached source confirmed to support the finding | every citation traces to a document that was examined |
| Moves the goalposts — rewrites the conclusion to match what it got | Claims are immutable in reproduction; a differing result becomes a Rebuttal | you always test the paper's actual claim |
| Buries evidence that contradicts the conclusion | contradictions are recorded as Rebuttals, and can't be erased | the verdict reflects the real state of the evidence |
| Quits early — "not available," "too complex" | `declare-barrier` interrogates the block before accepting it | the exit stays closed unless the barrier is genuinely real |
| "Verifies" a result using the paper's own outputs | the independence rule rejects the paper's own artifacts as evidence | reproduction is actually independent |

Read this way, none of the rules are bureaucratic — each is the answer to a specific failure you'd otherwise have to catch by hand.

---

## The five node types

Warranted implements the [Toulmin model](https://en.wikipedia.org/wiki/Toulmin_model) of argumentation.

**Claim** — a proposition you are asserting. In paper reproduction, this is the paper's conclusion extracted verbatim. In original writing, this is your synthesis judgment. Claims advance from `proposed` to a verdict only after the argument chain passes a logic check.

**Ground** — evidence that supports the Claim. In paper reproduction, this is the paper's stated experimental result (initially a hypothesis, updated as you verify). In literature writing, this is a specific finding from a published paper (with the PDF attached as provenance).

**Warrant** — the inference principle connecting Ground to Claim. This is the hardest node to write correctly.

A Warrant is not a restatement of the support relationship. "Ground 1 and Ground 2 support Claim" is circular — it says the evidence supports the conclusion without explaining *why*. That's not an inference principle, it's just naming the connection.

A Warrant answers: given this type of evidence, by what reasoning does it imply this type of conclusion?

| ❌ Circular (not a Warrant) | ✓ Inference principle (Warrant) |
|---|---|
| "The experimental results support the warming claim" | "Controlled experiments showing a statistically significant treatment effect compared to control provide causal evidence for the tested mechanism" |
| "The three papers all agree, supporting the Claim" | "Convergent findings across independent studies with different methods reduce the probability that any single result is an artifact of methodology" |
| "The benchmark scores show the method is better" | "Lower held-out test error indicates better generalization to unseen data under the same distribution" |

When `compile_arguments` reports that the chain reviewer found the reasoning incoherent, the Warrant is usually the cause — either circular, too vague to evaluate, or genuinely not connecting the specific Grounds to the specific Claim.

A Warrant is linked to specific Grounds — the evidence it is channeling toward the Claim. Multiple Grounds can feed into one Warrant when the inference depends on them together.

**Backing** — support for the Warrant's authority. Used when the inference principle itself needs justification — typically a methodological consensus or meta-analysis.

**Rebuttal** — a documented exception or contradiction. In reproduction, a result that differs from the paper. In writing, a paper with conflicting findings or a known boundary condition of the Claim.

---

## Compile

`compile_arguments` runs a logic audit on a Claim and its entire argument subgraph. It checks:

1. **Structure** (deterministic): is the chain complete? Claim → Warrant → Grounds, with no missing links.
2. **Chain** (LLM): is the reasoning coherent? Does the Warrant actually connect the evidence to the conclusion, or is it circular?

A Claim's status cannot advance to `supported`, `disputed`, or `refuted` unless compile has passed. This is enforced — not advisory. The reason: without this gate, `supported` is just a label the agent applies when it decides to. Enforcing compile means the label corresponds to an argument chain that was actually checked.

Compile runs after the initial structure is built, and again after any structural change.

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

To advance the status again, compile must pass and the evidence must be re-assessed.

---

## Talking to the agent in graph terms

The gates above are mechanical: they confirm a Warrant *exists*, a source is *attached*, a chain *compiles*. What they can't check is judgment — whether the Warrant actually reasons rather than restates, whether the attached paper actually says what the Ground claims, whether a declared barrier is actually real. Those three are your job, and they're exactly where the scenario guides tell you to look.

The graph also gives you precise vocabulary for pointing at what's wrong. Before you learn it, the natural instinct is to describe problems in loose prose — "this doesn't look right," "your result doesn't match the paper," "I'm not sure this is well supported." The agent then has to guess which part you mean.

Naming the node and its state removes that guesswork:

| Vague | Precise (graph terms) |
|---|---|
| "This conclusion isn't really backed up." | "This Claim is `supported`, but its Ground is still `pending`." |
| "Your result is different from the paper." | "You changed the Claim — in reproduction it stays verbatim; the difference is a Rebuttal." |
| "I don't think you actually checked this." | "This Ground has no attached paper — it can't be `verified` yet." |

The precise version points the agent at the root cause instead of a symptom, so it repairs the structure rather than rewording the prose. In the visualizer you can go one step further: select the node and ask about it directly — your selection is sent along automatically, so you don't even need to name it.

The scenario guides list the bad cases you're most likely to hit and what to say for each.

---

## Using Warranted alongside other tools

Warranted manages epistemic structure — what you're claiming, on what basis, with what reasoning. It does not manage prose quality, speed, or breadth of search.

Other tools (ultrathink, general writing assistants) work well alongside Warranted: use them for prose polish, brainstorming, or broad search. Use Warranted for the argument structure that underlies your conclusions. The combination is: other tools help you find and articulate; Warranted makes sure what you're asserting is actually supported.
