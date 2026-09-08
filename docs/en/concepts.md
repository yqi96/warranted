# The Argument Graph

> [English](concepts.md) | [简体中文](../zh-CN/concepts.md)

## What Warranted is for

Warranted makes research reasoning auditable. It records what is being asserted, what evidence it rests on, why that evidence carries the assertion, what attacks it, and how much credence the current evidence earns.

The graph is not a task list or activity log. Record a proposition when judging it materially affects the research question, a downstream argument, or a decision.

## One proposition, five slots

The graph has one node type: a **proposition**, a statement that can be judged to hold or not.

| Slot | Meaning |
|---|---|
| `content` | the atomic statement being judged |
| `evidence.attachments` | files that directly support or document it |
| `evidence.nodes` | references to other propositions used as evidence |
| `warrant` | the general reasoning principle connecting evidence to content |
| `rebuttals` | propositions that attack the content or its promoted warrant |
| `qualifier` | current credence: `refuted → unestablished → possibly → probably → certainly` |

The warrant may remain inline. Promote it into its own proposition only when it needs evidence, a rebuttal, a qualifier, or reuse elsewhere.

Terms such as claim, ground, backing, and rebuttal describe a proposition's role from a particular viewpoint:

- a proposition is a **claim** when its own credibility is at issue;
- it is a **ground** when another proposition cites it as evidence;
- it is **backing** when it supports a promoted warrant;
- it is a **rebuttal** when it appears in another proposition's rebuttal slot.

The same proposition can occupy several of these perspectives. No type conversion or copied node is involved.

## Qualifiers are judgments

New propositions always start at `unestablished`. Only `set_qualifier` records a credibility judgment:

| Qualifier | Reading |
|---|---|
| `refuted` | the proposition is rejected on the current evidence |
| `unestablished` | no defensible judgment has yet been recorded |
| `possibly` | plausible, but supported only weakly or provisionally |
| `probably` | the evidence makes it more likely than not |
| `certainly` | the evidence is strong enough for the highest available band |

Changing content and changing credence are separate actions. `update_proposition` changes what is being judged; `set_qualifier` changes the judgment and snapshots the evidence state that informed it.

## Structural warnings

Structural checks run automatically whenever a proposition is read or changed. They can report:

- empty evidence or warrant slots at a positive qualifier;
- missing or non-portable attachments;
- referenced propositions that are still `unestablished`;
- a `refuted` proposition without a positively judged rebuttal;
- content, membership, or referenced qualifiers that changed since the last judgment.

Warnings are **non-blocking**. The system does not change qualifiers or reject a judgment merely because a warning exists. Fix the underlying condition, or call `dismiss` with a reason. Dismissal is retained in the event history, and a material graph change gives recomputed warnings new ids, so previously dismissed warnings can reappear.

Three write-time checks remain hard failures: content must be non-empty, referenced proposition ids must exist, and attachment paths must resolve.

## Explicit semantic review

`review(id)` is an optional, deliberate, potentially expensive second opinion from a separate model. It examines one proposition:

1. **Q1 — faithfulness:** do attached sources actually say what the proposition claims?
2. **Q2 — validity:** even granting the evidence, does the warrant support the content?

Review is not automatic and does not set a qualifier. Its findings remain visible until a later review replaces them or they are explicitly dismissed with a reason. Structural checks continue to work when no review model is configured.

## The 11 tools

| Purpose | Tools |
|---|---|
| Create and change | `create_propositions`, `update_proposition`, `set_qualifier`, `promote_warrant`, `delete_proposition` |
| Read and settle | `get_argument`, `find_propositions`, `get_stats`, `get_history` |
| Independent opinion | `review`, `dismiss` |

`get_stats` is the graph-level settlement view: it lists unresolved findings, structural warnings, missing attachments, and qualifier counts. There is no compile step; structural state is recomputed from the current graph.

## Historical terminology

Released versions through 0.5.0 used separate Claim, Warrant, and Statement node types, plus `status`, `verification`, and `compile_state`. Commit `90c7acb` retired that model. Old `.toulmin/argument.db` files are retained as read-only archives; the current graph lives at `.toulmin/graph.db`.
