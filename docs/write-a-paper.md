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

## When something seems off

---

**You feel:** "The agent is summarizing papers rather than making arguments."

If Claim nodes read like "X et al. showed...", the attribution boundary has been crossed.

**Say:** "Claim #N describes what a paper found — that belongs in a Ground with `source='literature'`. A Claim is your synthesis conclusion. What is the independent judgment you're making across these findings?"

---

**You feel:** "I added a new paper but the graph doesn't feel connected."

A Ground with no Warrant path to any Claim is isolated evidence.

**Say:** "Ground #N has no Warrant connecting it to a Claim. Either connect it to an existing Claim via a Warrant, or identify what Claim this finding contributes to."

---

**You feel:** "The citation in the text doesn't match what I'd expect from the paper."

The Ground content is the source of truth for what a citation claims.

**Say:** "What is the content of Ground #N? Does the surrounding text in the `.tex` accurately represent what that Ground says? If not, revise the text — not the Ground."

---

**You feel:** "A Claim was changed and I'm not sure it reflects the evidence."

**Say:** "Why was Claim #N revised? Are there Grounds that conflict with the new formulation? If so, they should be Rebuttals, not suppressed. The Claim status should reflect the actual state of the evidence."

---

**You feel:** "A Claim is supported but I'm not sure the reasoning holds."

**Say:** "Run `compile_arguments` on Claim #N and show me the result. A `supported` status requires compile to have passed."

---

**You feel:** "The `.tex` still has regular `\cite{authorname}` keys instead of `\cite{ground_N}`."

The auto-replace on push only works with the `\cite{ground_N}` format.

**Say:** "This citation uses a bib key directly. Use `\cite{ground_N}` where N is the Ground ID. The hook replaces it with the bib key automatically when pushing to Overleaf."
