# Writing a Paper

> [English](write-a-paper.md) | [简体中文](../zh-CN/write-a-paper.md)

## Goal

Produce a research paper — or a literature survey — where every claim is traceable to evidence in the argument graph. **Done** means:

- Every Statement used as evidence is `verified` (source paper attached, content confirmed). **Deferred verification:** for a literature survey, verification happens in two stages — the Grounds the argument rests on are verified in phase 5; the remaining citation surface is verified by `/literature-writing` as it decides what to cite.
- Every Claim has passed `compile_arguments`
- Every Claim has a verdict: `supported`, `disputed`, or `refuted`
- The `.tex` is coherent: each citation's surrounding text faithfully represents its Statement

Two skills drive this: run `/overleaf-setup` once to wire up auto-push and citation enforcement (below), then `/literature-writing` to draft — it grounds each external finding in the graph before it's cited and maintains the `.bib` file as you go.

**For scale:** a literature survey of dozens of papers or more should run `/literature-survey` first (collect, classify, synthesize) and hand off to `/literature-writing` for the prose. For a dozen or so papers, go straight to `/literature-writing`.

---

## Setup (once): `overleaf-setup`

Run `/overleaf-setup` before writing. This is infrastructure, not a recurring step:

1. Installs the `leaf` CLI and links your local LaTeX directory to an Overleaf project
2. Writes a hook that pushes to Overleaf automatically at the end of each conversation turn (skips turns where no files changed)
3. Enforces the `\cite{statement_N}` citation standard (see below)

After setup, restart Claude Code. You won't need to run it again.

---

## The graph in this scenario

The fundamental distinction: **evidence and premises go in Statements, your conclusions go in Claims.**

| Node | What it represents |
|------|--------------------|
| **Claim** | Your independent synthesis conclusion — something you are arguing, not reporting |
| **Statement (Ground role)** | A piece of evidence or premise: a finding from a published paper (PDF attached), your own experimental result (data file attached), or a supported Claim used as a stepping stone |
| **Warrant** | The inference principle connecting this body of evidence to your Claim |
| **Statement (Backing role)** | Methodological consensus or meta-analysis that legitimizes the Warrant |
| **Statement (Rebuttal role)** | A paper with contradicting findings, or a documented boundary condition of your Claim |

One way to check: if the sentence starts with "Smith et al. found that..." or "The paper reports...", it belongs in a Statement (Ground role). If it starts with "We argue..." or "The evidence suggests...", it may be a Claim.

**Claim revision discipline.** Revising a Claim is legitimate when evidence genuinely doesn't support the original formulation. It is not legitimate as a way to avoid acknowledging contradictions — conflicting Statements become Rebuttals, and the Claim status reflects the actual state of the evidence.

---

## The `\cite{statement_N}` standard

Write citations by Statement ID: `\cite{statement_42}`. Don't look up bib keys while drafting.

At the end of each turn, the hook pushes to Overleaf and automatically replaces each `\cite{statement_N}` with the real bib key derived from the Statement's attached filename. This only works if the filename is already the bib key:

| Element | Value |
|---------|-------|
| `.bib` entry key | `vaswani2017attention` |
| Paper filename | `vaswani2017attention.pdf` |
| Statement attachment | `vaswani2017attention.pdf` |

Name papers by their bib key when you download them — e.g. `vaswani2017attention.pdf`. The agent handles `.bib` maintenance.

⭐ **The chain matters:** `\cite{statement_N}` → a verified Statement → an attached paper. A Statement is only marked `verified` once its source paper is attached and confirmed to support the stated finding, so every citation traces back to a document that was actually examined — not a plausible-sounding reference generated from training data.

**The attachment is required at the moment you record the Statement, not at verification time.** A `source="literature"` Statement with an empty `attachments` list is rejected outright, so you cannot record the proposition now, cite it while drafting, and attach the PDF before delivery. This is not deferred verification pulled forward — archiving a file triggers no review — but it does mean the source has to be on disk when the node comes into existence.

**For a paper you cannot get the PDF for yet — paywalled, embargoed, print-only — attach whatever you do have**: an abstract snapshot, a publisher-page capture, your reading notes. The creation check only tests that the attachment list is non-empty and that each path resolves; whether the material is *sufficient* is judged by the review checklist when the Statement is verified, which is the step that was always supposed to make that call. So a snapshot lets the node exist and stay citable-in-progress, and the sufficiency question stays where it belongs.

---

## Graph states to watch

| State | What it means |
|-------|--------------|
| A `Statement` (Ground role) from a published paper has no attached PDF | Provenance is missing; the PDF is the evidence record |
| A `Statement` (Ground role) has no Warrant path to any `Claim` | Isolated evidence — not yet connected to any argument |
| A `Claim` has no `Warrant` | `compile_arguments` will fail the structure check |
| A `Warrant` content restates the support relationship | Circular — not an inference principle; chain reviewer will flag it |
| A `Claim` was revised and has conflicting `Statement`s with no Rebuttal | Contradiction is being suppressed rather than recorded |
| `.tex` contains `\cite{authorname}` instead of `\cite{statement_N}` | The push is blocked — every citation key must be `statement_N` |

---

## When the agent goes off track

**The agent wrote a citation as `\cite{smith2023}` instead of `\cite{statement_N}`.** The push to Overleaf is blocked — the enforcement hook only accepts `statement_N` keys, precisely so every citation has to trace back to a Statement that was actually grounded. Tell it: *"Cite by Statement ID — `\cite{statement_N}` — not by author key."*

**The agent softened or rewrote a Claim to make a contradiction disappear.** A conflicting finding turned up, and instead of recording it the agent adjusted the Claim so nothing clashes. Say: *"Don't revise the Claim to dodge this — record the conflicting finding as a Rebuttal and let the Claim's status reflect the real state of the evidence."* Revising a Claim is legitimate only when the evidence genuinely doesn't support the original wording, not as a way to bury a conflict.

**A Statement (Ground role) has no attached paper.** It's citing a source that was never examined — the exact hallucination risk the graph exists to prevent. Select the Statement in the visualizer and ask: *"There's no paper attached to this Statement — what is it based on?"* Until a source is attached and confirmed to support the stated finding, the Statement can't be `verified`, and nothing resting on it should be cited.

**The Warrant just restates that the Statements support the Claim.** "These three papers support the argument" names the connection instead of explaining it. Say: *"This Warrant is circular. State the inference principle — why does this body of evidence imply your synthesis?"*

**A Claim is `supported`, but its compile is `stale`.** You edited a Statement or the Warrant after it last passed, which reverts the Claim to `proposed`. Say: *"The compile is stale — re-run `compile_arguments` before treating this Claim as settled."*
