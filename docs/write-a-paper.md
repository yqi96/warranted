# Writing a Paper

## Goal

Produce a research paper — or a literature survey — where every claim is traceable to evidence in the argument graph. **Done** means:

- Every Ground is `verified` (PDF attached, content confirmed)
- Every Claim has passed `compile_arguments`
- Every Claim has a verdict: `supported`, `disputed`, or `refuted`
- The `.tex` is coherent: each citation's surrounding text faithfully represents its Ground

---

## Setup (once): `overleaf-setup`

Run `/overleaf-setup` before writing. This is infrastructure, not a recurring step:

1. Installs the `leaf` CLI and links your local LaTeX directory to an Overleaf project
2. Writes a hook that pushes to Overleaf automatically at the end of each conversation turn (skips turns where no files changed)
3. Enforces the `\cite{ground_N}` citation standard (see below)

After setup, restart Claude Code. You won't need to run it again.

---

## The graph in this scenario

The fundamental distinction: **papers' findings go in Grounds, your conclusions go in Claims.**

| Node | What it represents |
|------|--------------------|
| **Claim** | Your independent synthesis conclusion — something you are arguing, not reporting |
| **Ground** | A specific finding, result, or argument from a published paper; the PDF is attached as provenance |
| **Warrant** | The inference principle connecting this body of evidence to your Claim |
| **Backing** | Methodological consensus or meta-analysis that legitimizes the Warrant |
| **Rebuttal** | A paper with contradicting findings, or a documented boundary condition of your Claim |

One way to check: if the sentence starts with "Smith et al. found that..." or "The paper reports...", it belongs in a Ground. If it starts with "We argue..." or "The evidence suggests...", it may be a Claim.

**Claim revision discipline.** Revising a Claim is legitimate when evidence genuinely doesn't support the original formulation. It is not legitimate as a way to avoid acknowledging contradictions — conflicting Grounds become Rebuttals, and the Claim status reflects the actual state of the evidence.

---

## The `\cite{ground_N}` standard

Write citations by Ground ID: `\cite{ground_42}`. Don't look up bib keys while drafting.

When you push to Overleaf, the hook automatically replaces each `\cite{ground_N}` with the real bib key derived from the Ground's attached filename. This only works if the filename is already the bib key:

| Element | Value |
|---------|-------|
| `.bib` entry key | `vaswani2017attention` |
| Paper filename | `vaswani2017attention.pdf` |
| Ground attachment | `vaswani2017attention.pdf` |

Name papers by their bib key when you download them. Add the BibTeX entry to the `.bib` file immediately — not at the end. Required fields: `author`, `title`, `year`, and one venue field (`journal`, `booktitle`, or `url`).

---

## Graph states to watch

| State | What it means |
|-------|--------------|
| A `Claim` content reads "X et al. found that..." | Attribution boundary crossed — that's a Ground, not a Claim |
| A `Ground` has no attached PDF | Provenance is missing; the PDF is the evidence record |
| A `Ground` has no Warrant path to any `Claim` | Isolated evidence — not yet connected to any argument |
| A `Claim` has no `Warrant` | `compile_arguments` will fail the structure check |
| A `Warrant` content restates the support relationship | Circular — not an inference principle; chain reviewer will flag it |
| A `Claim` was revised and has conflicting `Ground`s with no `Rebuttal` | Contradiction is being suppressed rather than recorded |
| `.tex` contains `\cite{authorname}` instead of `\cite{ground_N}` | Auto-replace on push won't work |
