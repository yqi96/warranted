# Reproducing a Paper

> [English](reproduce-a-paper.md) | [简体中文](../zh-CN/reproduce-a-paper.md)

## Goal

Run `/paper-reproduce` when the goal is to independently test whether a paper's reported results and core conclusions hold. Reproduction rebuilds the paper's evidential chain with fresh implementation and execution artifacts; summarizing the paper is not enough.

A complete reproduction can end positively or negatively. It is unfinished when a required proposition remains `unestablished` merely because the work stopped.

## Build an argument skeleton

Extract only the propositions needed for the reproduction target. The graph may be shallow or a multi-level DAG:

```text
fresh artifacts ──evidence──► result proposition ──evidence──► core proposition
                                      warrant                     warrant
```

Every node is a proposition. A reported result becomes a proposition when it can fail independently, needs its own qualifier or rebuttal, separates a distinct dataset or metric, or is reused by several conclusions. Otherwise, attach the fresh artifacts directly to the proposition they test.

Before execution:

- preserve the paper's intended meaning in each target proposition;
- write the intended warrant for each inference;
- leave reproduction evidence slots empty;
- leave every extracted proposition at `unestablished`.

The paper defines what must be reproduced. It is not evidence that its own results are true. Do not attach the paper, its precomputed outputs, released weights, or supplementary result files as proof of a proposition under direct experimental test.

## Define evidence obligations

For every proposition that fresh execution must establish, record:

- the target quantity and scope;
- the method, data, metric, baseline, and tolerance;
- the artifacts a successful run must produce;
- what outcome would support, limit, refute, or leave the proposition inconclusive;
- the minimum positive qualifier required for the reproduction to count as successful.

Choose thresholds before seeing the result. Each `unestablished` leaf that requires fresh execution is an open work item.

## Execute from the leaves upward

Delegate bounded implementation and experiment work to `code-experimenter`; use `code-optimizer` only to make the same full-scope test feasible. Cheap sanity checks can establish implementation behavior, but only the declared run can establish the target result.

For each completed obligation:

1. inspect the implementation and artifacts;
2. attach code, execution traces, raw outputs, metric calculations, and a short evidence report to the proposition directly tested;
3. state the warrant explaining why this run bears on the proposition;
4. set the qualifier earned by that evidence;
5. re-judge downstream propositions whose evidence now changed.

Do not set a downstream proposition positive while an evidence proposition required by its warrant remains `unestablished`.

## Audit mismatches and blockers

An unexpected result is not automatically a rebuttal. Route one mismatch or claimed blocker to `discrepancy-auditor` before accepting its graph consequence.

- an implementation, data, environment, or metric fault means repair and rerun;
- an insufficient test leaves the obligation `unestablished`;
- a defensible narrower result becomes a separate, narrower proposition while the original coverage gap stays visible;
- a credible contradiction becomes an independently evidenced proposition attacking the affected content or warrant;
- an inconclusive result leaves a precise open evidence requirement.

A scope reduction is work to execute, not permission to stop after naming it.

## Judge completion

Judge leaves first, then rebuttals and promoted warrants, then downstream conclusions. Before reporting completion:

- every required proposition has a defensible qualifier or an audited explanation of why no defensible test can currently be run;
- every positive conclusion is supported by the evidence propositions its warrant requires;
- no material rebuttal remains unjudged;
- structural warnings that could undermine the conclusion are cleared or explicitly dismissed; review findings are replaced by a later review after correction or dismissed with reasons;
- `get_stats` accurately exposes any remaining red items.

`review` is optional and explicit. Use it for a semantic second opinion on source faithfulness or inference validity; it never replaces the primary agent's qualifier judgment.

## Failure modes to challenge

- **The target was rewritten after seeing the result.** Preserve the original proposition; record the differing result as evidence or a rebuttal.
- **Paper-produced artifacts were used as proof.** They may define the target or help debugging, but do not independently reproduce it.
- **A number was reported without an audit trail.** Attach the implementation, execution trace, raw result, calculation, and report.
- **The warrant merely says “the results support the conclusion.”** State the general inference principle that makes this kind of result relevant.
- **A warning was treated as a gate or ignored.** Warnings are non-blocking signals: inspect, repair, or dismiss with a reason.
