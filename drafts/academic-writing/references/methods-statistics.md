# Methods And Statistical Analysis

Use this reference for Methods, Statistical Analysis, reproducibility, protocol, and analysis-authority prose.

## Graph Role

Methods text usually supports provenance and Backing. It is not automatically evidence for a Claim.

Use Methods/Statistics prose to document:

- how observed Grounds were produced
- what artifacts support those Grounds
- what methodology supports Warrants
- what assumptions, exclusions, or deviations limit interpretation

## Backing Contract

Create or update Backing when a Warrant depends on:

- statistical test choice
- model assumption
- normalization or preprocessing standard
- validation protocol
- accepted field method
- sample-size or power justification

The Backing should support the inference principle, not restate the observed result.

## Provenance Contract

For each method that produced an observed Ground, make the following attachable or documented:

- input data and source
- inclusion/exclusion criteria
- preprocessing and transformations
- parameter choices
- software, package versions, model versions, or instrument settings
- random seeds when relevant
- commands, scripts, notebooks, logs, and output paths

Methods prose should allow a future evidence reviewer to trace each observed Ground to its production process.

## Deviation Discipline

Protocol deviations are not harmless prose details when they affect interpretation.

If a deviation changes what the result can support:

- narrow the observed Ground
- revise the Warrant or Backing
- create a Rebuttal
- keep the obligation unresolved until checked

Do not bury deviations in Methods if they change a Claim's evidential strength.

## Statistical Reporting

Statistical language should support substantive Grounds.

- Report effect size or substantive estimate with uncertainty when available.
- Do not let a p value stand alone as the result.
- Multiple-comparison correction, model assumptions, missing-data handling, and replicate structure should be Backing when they license inference.
- Failed assumptions or insufficient power should become limitations or Rebuttals.

## Completion

Methods/Statistics prose is complete when:

- each observed Ground has reproducible provenance
- each method-dependent Warrant has Backing
- deviations and assumptions are reflected in graph consequences
- statistical text supports, rather than replaces, substantive Grounds
