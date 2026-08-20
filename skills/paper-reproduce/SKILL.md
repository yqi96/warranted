---
name: paper-reproduce
description: Use when independently reproducing a published paper or judging whether its reported experimental results and core conclusions hold under a new implementation and execution. Covers extracting the paper's argument into the Toulmin graph, planning independent evidence, executing required experiments, auditing mismatches or blockers, and deciding whether reproduction succeeded. Not for summarizing a paper or testing a hypothesis of your own.
---

# Paper Reproduction

Treat reproduction as rebuilding the paper's evidential chain with independently produced evidence.

The reference paper tells you **what must be reproduced**. It is not evidence that its experimental results or conclusions are true. Reproduction succeeds only when a verified implementation and a fresh execution can positively establish the required core claims, either directly or through intermediate result propositions.

## 1. Extract the Paper's Argument

Read the paper, figures, tables, methods, and supplements before executing anything. Extract only the argument needed for the reproduction target.

Build the graph at the depth required by the paper's argument. This two-level shape is common, not mandatory:

```text
fresh artifacts A ── evidence ──► experimental-result proposition A ─┐
                                                                     ├─ evidence ─► core claim
fresh artifacts B ── evidence ──► experimental-result proposition B ─┘
```

A single proposition is enough when fresh artifacts directly support the core claim and no intermediate assertion needs a separate judgment:

```text
verified code + fresh execution logs + raw outputs
                         │ evidence
                         ▼
                     core claim
```

Use additional layers when experimental results support sub-claims that in turn support broader conclusions:

```text
fresh artifacts A → result proposition A → sub-claim 1 ┐
fresh artifacts B → result proposition B → sub-claim 2 ├→ core claim
fresh artifacts C → result proposition C → sub-claim 3 ┘
```

Here the core claim references sub-claims 1–3 in its evidence slot. Each sub-claim references the result propositions it depends on, and each result proposition carries the fresh artifacts that establish it. Every proposition states its own warrant for the inference from its immediate evidence; the core claim's warrant explains why the combination of sub-claims is sufficient for the broader conclusion. Branches may also share a result proposition by reference when the same result genuinely bears on more than one sub-claim.

Add an intermediate proposition only when it is independently judgeable, can be reused as evidence, can receive its own rebuttal, or needs a qualifier distinct from its parent. Do not create layers merely to mirror paper sections or workflow steps. The result should be a DAG whose depth follows the inference chain.

Create:

1. **Core-claim propositions** for the conclusions the user wants reproduced.
2. **Experimental-result propositions when needed** for measurements, comparisons, ablations, or observations that require a judgment separate from the core claim.
3. **Warrants** expressing why the experimental results support the corresponding core claim.
4. **Rebuttal propositions** for acknowledged exceptions, failed conditions, or later independently observed contradictions.

Do not create an experimental-result proposition by default. Attach fresh execution artifacts directly to the core claim when those artifacts test it without an independently meaningful intermediate assertion. Create a separate result proposition when the result can fail independently, is reused by several claims, needs its own rebuttal or qualifier, or separates distinct datasets, populations, metrics, baselines, conditions, or ablations.

Reference each proposition from the next conclusion it supports, whether that is the core claim or another intermediate proposition. Reuse one result under several claims by reference; never duplicate it.

### Preserve the paper's meaning

- Keep each extracted claim faithful to the paper and attach a precise source anchor in the working record.
- Split compound claims into independently judgeable propositions when needed.
- Do not soften, broaden, or rewrite a paper claim to fit what the reproduction happens to achieve.
- If the paper is ambiguous, record the competing interpretations or state the chosen interpretation before running experiments.
- If only a narrower claim is reproduced, create that narrower proposition separately; do not replace the paper's original claim.

All extracted claims and reported-result propositions begin at `unestablished`. Build this initial graph as an argument skeleton: write the propositions, connect each one to the next proposition it is meant to support, and state the intended warrants. Their evidence slots may be empty because the reproduction evidence does not exist yet.

The paper's text determines node content, intended relationships, target values, and experimental requirements. It does not fill the evidence slots and does not earn a positive qualifier. Never add the paper or placeholder material merely to make the initial graph look complete.

The graph develops in three stages:

1. **Before execution:** propositions and intended inference structure exist; reproduction evidence is absent; qualifiers remain `unestablished`.
2. **During reproduction:** add fresh code, logs, outputs, metric calculations, reports, and result propositions as each obligation is completed. Unfinished branches remain `unestablished`.
3. **After evidence review:** judge result propositions first, then propagate their force through warrants to the core claims and set the qualifiers they have earned.

Do not wait until all experiments finish to update the graph. Return each completed, reviewed evidence package to its proposition while preserving still-open obligations elsewhere.

## 2. Define What Must Be Reproduced

Before delegating experiments, turn every proposition that fresh execution must directly establish—whether a core claim or an intermediate result—into a concrete evidence obligation. Record:

- the exact metric or observation to reproduce;
- dataset, split, population, inputs, and preprocessing;
- model, algorithm, baseline, and parameter settings;
- number of runs, random seeds, and aggregation method;
- the paper's reported value and uncertainty;
- the acceptance range or comparison rule;
- what outcome counts as support, contradiction, or inconclusive evidence;
- required code, logs, raw outputs, processed results, and environment record.

Set the acceptance rule before seeing the reproduction result. For stochastic work, use uncertainty, repeated runs, or a justified tolerance rather than demanding accidental numerical identity. For qualitative claims, specify the observable pattern that must recur. Do not lower the criterion after a disappointing run.

The graph defines the work queue: every `unestablished` leaf proposition that requires fresh execution is an outstanding reproduction obligation.

## 3. Enforce Independent Evidence

The paper and its previously produced results cannot verify their own claims. Author code is allowed when it has been checked against the paper's method description and is then executed afresh; independence is required of the verification result, not necessarily of the code's authorship.

Do **not** use any of the following as evidence for a proposition under direct experimental test:

- the reference paper or its supplementary result tables;
- author-produced plots, processed outputs, predictions, or evaluation files;
- pretrained or fitted weights whose performance is the result under test;
- cached outputs, generated datasets, or intermediate results produced by the authors for that experiment;
- values copied or transcribed from the paper.

These materials may define the target value, explain the method, or help debug a discrepancy. They must not enter the proposition's evidence as proof that the result holds.

Evidence for a directly tested proposition should come from a fresh, controlled execution and normally include:

- either an independently implemented pipeline or verified author code that conforms to the described method;
- the exact execution commands and environment;
- input-data provenance and preprocessing records;
- logs and raw outputs from the new run;
- the metric-computation code and resulting tables or figures;
- a reproduction report linking those artifacts to the proposition.

Code alone is not evidence that a metric was achieved. A final number alone is not auditable evidence either. The useful evidence package combines implementation, execution trace, raw result, metric calculation, and explanation.

Before using author code, inspect whether its data flow, preprocessing, model or algorithm, parameters, evaluation procedure, and metric match the paper's description. Record every material discrepancy. If the code conforms, a fresh run with independently preserved logs and outputs may support the directly tested proposition. State that the result was reproduced with verified author code; do not call it an independent reimplementation. If the code does not conform, either repair and document it, implement the described method independently, or treat the difference as an unresolved methodological discrepancy.

## 4. Execute from the Leaves Upward

Delegate each substantial experimental obligation to `code-experimenter`. Give it:

- the proposition the experiment must directly establish, whether a core claim or an intermediate result;
- the relevant paper method and reported value;
- the predeclared acceptance rule;
- allowed inputs and code, the checks required for author code, and forbidden pre-existing result evidence;
- compute and time budget;
- required artifact paths and report format.

Run cheap sanity checks before full execution, but do not confuse them with completion evidence. Unit tests, toy inputs, and small runs establish implementation behavior; only the declared experiment can establish the target proposition.

When a run returns:

1. Inspect its implementation, deviations, logs, raw outputs, and metric calculation.
2. Attach the freshly produced evidence package to the proposition directly tested by the run.
3. Write the methodological warrant explaining why a conforming fresh run supports that result proposition.
4. Assign the qualifier earned by the evidence.
5. If it is an intermediate result, only then use it to judge the next proposition upstream; if it is the core claim, the direct judgment completes that branch.

Do not set a core claim positive while any proposition required by its warrant remains `unestablished`. This restriction does not apply when the core claim itself is the leaf directly established by fresh artifacts.

## 5. Audit Mismatches and Blockers

An unexpected result is not automatically a rebuttal. It may come from an implementation, data, environment, scope, or metric error.

If a run disagrees with the paper, send the expected result, observed result, code, artifacts, method, data details, and metric definition to `discrepancy-auditor`. Then follow the supported outcome:

- **setup or implementation issue:** fix it and rerun; do not change the graph claim to fit the bad run;
- **insufficient test:** strengthen the experiment and keep the proposition `unestablished`;
- **scope mismatch:** create the narrower result actually tested and keep the coverage gap visible;
- **credible contradiction:** create an independently evidenced rebuttal against the affected result, core content, or warrant, then judge the rebuttal before re-judging its target;
- **inconclusive:** keep the obligation open and state what evidence is still missing.

Audit a claimed blocker before accepting that an obligation cannot be executed. Use `code-optimizer` when a correct full-scope implementation is blocked by runtime or memory and semantics-preserving optimization is feasible. If only a narrower experiment is feasible, record exactly that experiment; never present it as full-scope reproduction.

## 6. Judge Completion from the Graph

Settle the graph bottom-up:

1. judge leaf propositions established by fresh execution, including directly tested core claims;
2. judge rebuttals and affected warrants;
3. judge the paper's core claims from those settled results;
4. re-judge downstream claims whenever an upstream qualifier changes.

Before execution, identify the propositions required for success and the minimum acceptable positive qualifier for each. Do not invent this threshold after seeing results.

**Successful reproduction** means:

- every required leaf proposition has reached its predeclared positive threshold;
- every required core claim has reached its predeclared positive threshold through those results;
- no unresolved material rebuttal, review finding, or structural warning undermines that judgment;
- every positive result rests on fresh execution artifacts rather than the paper's pre-existing outputs or reported values.

The reproduction task may still be **completed with a negative conclusion** when audited independent evidence refutes a required result or core claim. Call it a failed reproduction, not unfinished work. It remains unfinished when required propositions are merely `unestablished` without an audited reason that no defensible test can currently be performed.

## 7. Require a Reproduction Report

For every proposition tested by execution, require a report containing:

- proposition id and the paper's reported result;
- source section, figure, or table;
- implementation origin, author-code conformance audit when applicable, and code paths;
- data, preprocessing, parameters, seeds, commands, and environment;
- raw and processed artifact paths;
- reproduced metric with uncertainty and direct comparison to the paper;
- deviations, sanity checks, and mismatch or blocker audit;
- recommended qualifier and graph consequence.

Attach this report with the code, logs, and outputs to the proposition directly tested by that execution. The report explains the evidence; it does not replace the underlying artifacts.
