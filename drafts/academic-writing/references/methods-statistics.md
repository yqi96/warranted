# Methods And Statistical Analysis

Use this reference for Methods, Statistical Analysis, reproducibility, protocol, and analysis-authority prose.

## Graph Role

Methods text usually supports provenance and inference authority. It is not automatically evidence for a result proposition.

Use Methods/Statistics prose to document:

- how result propositions were produced
- what artifacts support those propositions
- what methodology supports warrants
- what assumptions, exclusions, or deviations limit interpretation

## Method Authority Contract

Create or update a method/standard proposition when a warrant depends on:

- statistical test choice
- model assumption
- normalization or preprocessing standard
- validation protocol
- accepted field method
- sample-size or power justification

The method/standard proposition should support the inference principle, not restate the observed result.

## Provenance Contract

For each method that produced a result proposition, make the following attachable or documented:

- input data and source
- inclusion/exclusion criteria
- preprocessing and transformations
- parameter choices
- software, package versions, model versions, or instrument settings
- random seeds when relevant
- commands, scripts, notebooks, logs, and output paths

Methods prose should allow a future evidence reviewer to trace each result proposition to its production process.

## Deviation Discipline

Protocol deviations are not harmless prose details when they affect interpretation.

If a deviation changes what the result can support:

- narrow the result proposition
- revise the warrant or supporting method proposition
- create a rebuttal proposition
- keep the obligation unresolved until checked

Do not bury deviations in Methods if they change a proposition's evidential strength.

## Statistical Reporting

Statistical language should support substantive propositions.

- Report effect size or substantive estimate with uncertainty when available.
- Do not let a p value stand alone as the result.
- Multiple-comparison correction, model assumptions, missing-data handling, and replicate structure should be supporting propositions when they license inference.
- Failed assumptions or insufficient power should become limitations or rebuttal propositions.

## Completion

Methods/Statistics prose is complete when:

- each result proposition has reproducible provenance
- each method-dependent warrant has supporting method authority
- deviations and assumptions are reflected in graph consequences
- statistical text supports, rather than replaces, substantive propositions
