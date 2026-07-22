# Writing a Paper

> [English](write-a-paper.md) | [简体中文](../zh-CN/write-a-paper.md)

## Goal

Produce a research paper — or a literature survey — where every claim is traceable to evidence in the argument graph. **Done** means:

- Every Ground is `verified` (source paper attached, content confirmed)
- Every Claim has passed `compile_arguments`
- Every Claim has a verdict: `supported`, `disputed`, or `refuted`
- The `.tex` is coherent: each citation's surrounding text faithfully represents its Ground

Two skills drive this: run `/overleaf-setup` once to wire up auto-push and citation enforcement (below), then `/literature-survey` to draft — it grounds each external finding in the graph before it's cited and maintains the `.bib` file as you go.

---

## Setup (once): `overleaf-setup`

Run `/overleaf-setup` before writing. This is infrastructure, not a recurring step:

1. Installs the `leaf` CLI and links your local LaTeX directory to an Overleaf project
2. Writes a hook that pushes to Overleaf automatically at the end of each conversation turn (skips turns where no files changed)
3. Enforces the `\cite{ground_N}` citation standard (see below)

After setup, restart Claude Code. You won't need to run it again.

---

## The graph in this scenario

The fundamental distinction: **evidence and premises go in Grounds, your conclusions go in Claims.**

| Node | What it represents |
|------|--------------------|
| **Claim** | Your independent synthesis conclusion — something you are arguing, not reporting |
| **Ground** | A piece of evidence or premise: a finding from a published paper (PDF attached), your own experimental result (data file attached), or a supported Claim used as a stepping stone |
| **Warrant** | The inference principle connecting this body of evidence to your Claim |
| **Backing** | Methodological consensus or meta-analysis that legitimizes the Warrant |
| **Rebuttal** | A paper with contradicting findings, or a documented boundary condition of your Claim |

One way to check: if the sentence starts with "Smith et al. found that..." or "The paper reports...", it belongs in a Ground. If it starts with "We argue..." or "The evidence suggests...", it may be a Claim.

**Claim revision discipline.** Revising a Claim is legitimate when evidence genuinely doesn't support the original formulation. It is not legitimate as a way to avoid acknowledging contradictions — conflicting Grounds become Rebuttals, and the Claim status reflects the actual state of the evidence.

---

## The `\cite{ground_N}` standard

Write citations by Ground ID: `\cite{ground_42}`. Don't look up bib keys while drafting.

At the end of each turn, the hook pushes to Overleaf and automatically replaces each `\cite{ground_N}` with the real bib key derived from the Ground's attached filename. This only works if the filename is already the bib key:

| Element | Value |
|---------|-------|
| `.bib` entry key | `vaswani2017attention` |
| Paper filename | `vaswani2017attention.pdf` |
| Ground attachment | `vaswani2017attention.pdf` |

Name papers by their bib key when you download them — e.g. `vaswani2017attention.pdf`. The agent handles `.bib` maintenance.

⭐ **The chain matters:** `\cite{ground_N}` → a verified Ground → an attached paper. A Ground is only marked `verified` once its source paper is attached and confirmed to support the stated finding, so every citation traces back to a document that was actually examined — not a plausible-sounding reference generated from training data.

---

## Graph states to watch

| State | What it means |
|-------|--------------|
| A `Ground` from a published paper has no attached PDF | Provenance is missing; the PDF is the evidence record |
| A `Ground` has no Warrant path to any `Claim` | Isolated evidence — not yet connected to any argument |
| A `Claim` has no `Warrant` | `compile_arguments` will fail the structure check |
| A `Warrant` content restates the support relationship | Circular — not an inference principle; chain reviewer will flag it |
| A `Claim` was revised and has conflicting `Ground`s with no `Rebuttal` | Contradiction is being suppressed rather than recorded |
| `.tex` contains `\cite{authorname}` instead of `\cite{ground_N}` | The push is blocked — every citation key must be `ground_N` |

---

## When the agent goes off track

**The agent wrote a citation as `\cite{smith2023}` instead of `\cite{ground_N}`.** The push to Overleaf is blocked — the enforcement hook only accepts `ground_N` keys, precisely so every citation has to trace back to a Ground that was actually grounded. Tell it: *"Cite by Ground ID — `\cite{ground_N}` — not by author key."*

**The agent softened or rewrote a Claim to make a contradiction disappear.** A conflicting finding turned up, and instead of recording it the agent adjusted the Claim so nothing clashes. Say: *"Don't revise the Claim to dodge this — record the conflicting finding as a Rebuttal and let the Claim's status reflect the real state of the evidence."* Revising a Claim is legitimate only when the evidence genuinely doesn't support the original wording, not as a way to bury a conflict.

**A Ground has no attached paper.** It's citing a source that was never examined — the exact hallucination risk the graph exists to prevent. Select the Ground in the visualizer and ask: *"There's no paper attached to this Ground — what is it based on?"* Until a source is attached and confirmed to support the stated finding, the Ground can't be `verified`, and nothing resting on it should be cited.

**The Warrant just restates that the Grounds support the Claim.** "These three papers support the argument" names the connection instead of explaining it. Say: *"This Warrant is circular. State the inference principle — why does this body of evidence imply your synthesis?"*

**A Claim is `supported`, but its compile is `stale`.** You edited a Ground or the Warrant after it last passed, which reverts the Claim to `proposed`. Say: *"The compile is stale — re-run `compile_arguments` before treating this Claim as settled."*
