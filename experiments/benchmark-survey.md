# Benchmark Survey for Evaluating Warranted

This document records the current experimental planning decision: do not start
by building a full custom benchmark. First test Warranted on existing scientific
agent and claim/evidence benchmarks, then build only the small stress sets that
existing benchmarks do not cover.

## Evaluation Stance

The experiments should not assume in advance that Warranted improves one
specific metric such as false completion. The first phase should measure how
Warranted changes observable research-agent behavior:

- final task performance
- completion calibration
- evidence discipline
- unsupported-claim behavior
- contradiction handling
- open-issue reporting
- auditability
- token, time, and tool-call cost

The main claim of the paper should be selected only after a pilot identifies
which effects are real and reproducible.

## Existing Benchmarks to Check First

| Benchmark | What it can test | Fit for Warranted | Initial decision |
|---|---|---:|---|
| AstaBench | Broad scientific-agent tasks: literature, code, data analysis, discovery | High | First framework to survey |
| CORE-Bench | Computational reproducibility from code and data | High | First reproduction benchmark |
| PaperBench | Paper-level AI research reproduction with hierarchical rubrics | High but expensive | Use after pilot, not first |
| DiscoveryBench | Data-driven hypothesis discovery and evidence reasoning | High | Strong candidate for main experiments |
| ScienceAgentBench | Data-driven scientific discovery tasks | Medium-high | Candidate supplement |
| DSBench / DABstep | Data-analysis agents with objective or semi-objective scoring | High | Low-cost batch experiments |
| SciFact / SciVer | Scientific claim verification with evidence labels | Medium | Claim-level mechanism microbenchmark |
| LitQA2 / ResearchQA / LAB-Bench literature tasks | Literature QA and grounded answers | Medium | Use before long-form reviews |
| MLAgentBench | ML experimentation and iterative improvement | Medium | Later extension only |
| DA-Code / DataBench | Data analysis code or table QA | Medium-low | Sanity checks, not main evidence |

## Practical Recommendation

Use existing benchmarks for the main pilot:

1. AstaBench for broad harness compatibility.
2. CORE-Bench for reproducibility.
3. DABstep or DSBench for data analysis.
4. SciFact or SciVer for claim-level calibration.
5. DiscoveryBench for hypothesis/evidence reasoning.

Build a custom test set only for missing Warranted-specific behaviors:

1. contradiction retention
2. insufficient-evidence refusal and open-issue exposure
3. auditability of the produced research artifact

## Benchmark-Specific Playbooks

### AstaBench

Purpose: Determine whether a broad scientific-agent benchmark can host
Warranted without distorting the tasks.

Manual:

1. Install and run the benchmark harness locally.
2. Select three task types:
   - literature understanding
   - code execution or reproducibility
   - data analysis or discovery
3. Sample 20 tasks per type.
4. Run two systems first:
   - markdown-log baseline
   - Warranted
5. Save original benchmark scores and Warranted-specific process metrics.
6. Drop any subtask type where fewer than half of samples naturally form
   claim/evidence obligations.

Expected files:

```text
benchmarks/astabench_pilot/
  selected_tasks.jsonl
  run_manifest.csv
  baseline_outputs/
  warranted_outputs/
  graph_exports/
  score_original.csv
  score_warranted_extra.csv
  notes_task_fit.md
```

Decision rule:

```text
If a task family rarely produces claim/evidence states, keep it as an auxiliary
capability check rather than a main Warranted evaluation task.
```

### CORE-Bench

Purpose: Evaluate reproducibility behavior with clearer engineering cost than
PaperBench.

Manual:

1. Select 10 `CORE-Retrieve` and 10 `CORE-Easy` tasks.
2. Do not start with `CORE-Hard`.
3. Run:
   - baseline agent
   - markdown-log agent
   - Warranted agent
4. Use identical model, tools, wall-clock budget, and turn budget.
5. Record final correctness, claimed completion, infrastructure failure, and
   open-issue reporting.
6. Keep infrastructure failures separate from reasoning failures.

Expected files:

```text
benchmarks/corebench_pilot/
  task_subset.json
  run_outputs/
  core_scores.csv
  completion_calibration.csv
  infra_failures.csv
```

Primary pilot metric:

```text
claimed_done_and_wrong_rate =
count(claimed_done = true AND final_correct = false)
/
count(claimed_done = true)
```

### PaperBench

Purpose: Later-stage realistic paper reproduction with hierarchical rubrics.

Manual:

1. Use only after CORE-Bench pilot succeeds.
2. Select three local papers from:

```text
/Users/yn/workspace/toulmin-paper/preparedness/project/paperbench/data/papers
```

3. Selection criteria:
   - no large GPU requirement
   - enough result-analysis rubric leaves
   - clear runnable environment
   - explicit output artifact such as metric, table, log, or figure
4. Convert each relevant rubric leaf into an obligation.
5. Compare rubric score, claimed completion, and graph-to-rubric alignment.

Expected files:

```text
benchmarks/paperbench_selected/
  selected_papers.md
  rubric_obligations.jsonl
  run_outputs/
  rubric_scores.csv
  claim_rubric_alignment.csv
```

Obligation format:

```json
{
  "paper_id": "pinn",
  "obligation_id": "leaf_013",
  "rubric_text": "...",
  "expected_artifact": "metrics/log/table/figure",
  "agent_claimed_status": null,
  "rubric_score": null
}
```

### DABstep or DSBench

Purpose: Low-cost, objective or semi-objective data-analysis evaluation.

Manual:

1. Prefer DABstep first if its automatic checks are easy to run.
2. Otherwise use the DSBench data-analysis split.
3. Select 30 tasks:
   - 10 easy
   - 10 medium
   - 10 hard
4. Require every system to output:

```json
{
  "answer": "...",
  "confidence": 0.0,
  "evidence_files": ["..."],
  "open_issues": ["..."]
}
```

5. Record original benchmark correctness, confidence calibration, open-issue
   quality, and whether errors came from missing evidence or bad inference.

Expected files:

```text
benchmarks/dabstep_pilot/
  selected_tasks.jsonl
  outputs.jsonl
  original_scores.csv
  confidence_calibration.csv
  error_trace_labels.csv
```

### SciFact or SciVer

Purpose: Low-cost claim-level mechanism test.

Manual:

1. Start with SciFact unless SciVer multimodal evidence is explicitly needed.
2. Sample 200 examples:
   - 80 supports
   - 80 refutes
   - 40 no-information
3. Prompt the agent to decide whether the claim is supported, refuted, or not
   sufficiently supported, and to cite evidence.
4. For Warranted, map:
   - claim text to Claim
   - evidence abstract or passage to Ground
   - inference rule to Warrant
5. Compare final label with gold label and record false-supported cases.

Expected files:

```text
benchmarks/scifact_claim_micro/
  selected_claims.jsonl
  system_outputs.jsonl
  label_scores.csv
  false_supported.csv
```

Use this as a mechanism microbenchmark, not as the headline experiment.

### LitQA2 / ResearchQA / Literature Tasks

Purpose: Test grounded literature answering before attempting long-form
literature reviews.

Manual:

1. Do not start with long-form review generation.
2. Start with citation-grounded QA:
   - input paper or literature-retrieval task
   - answer
   - supporting passage or citation
3. Record answer correctness, passage correctness, unsupported answer rate, and
   grounded refusal behavior.
4. Move to long-form literature review only if Warranted shows a measurable
   difference in grounded QA.

Expected files:

```text
benchmarks/litqa_researchqa_pilot/
  qa_subset.jsonl
  answers.jsonl
  citation_grounding_scores.csv
  refusal_scores.csv
```

### DiscoveryBench

Purpose: Evaluate hypothesis, evidence, and conclusion alignment. This is the
closest existing benchmark to Warranted's argument-artifact mechanism.

Manual:

1. Start with the synthetic split if available, because it is more controlled.
2. Require outputs with:
   - hypothesis
   - evidence
   - analysis code
   - conclusion
   - limitations
3. For Warranted:
   - hypothesis becomes Claim
   - analysis result becomes Ground
   - statistical or semantic inference becomes Warrant
4. Use the original faceted evaluator.
5. Add extra labels for:
   - over-strong hypothesis
   - evidence-conclusion mismatch
   - missing limitation

Expected files:

```text
benchmarks/discoverybench_pilot/
  selected_tasks.jsonl
  hypotheses.jsonl
  original_facet_scores.csv
  claim_evidence_alignment.csv
```

## Benchmarks Not Recommended for the First Pilot

| Benchmark | Why not first | Later use |
|---|---|---|
| MLAgentBench | Signal may mostly reflect ML tuning ability rather than evidence discipline | Extension experiment |
| DA-Code | Too code-generation oriented | Low-cost sanity check |
| DataBench | Often too short and table-QA-like | Microbenchmark only |
| LAB-Bench / LABBench2 | Biology expertise may dominate artifact effects | Domain-specific extension |

## Phase 0: Benchmark Survey

Goal: Determine which existing benchmarks are runnable and compatible with
Warranted.

Manual:

1. For each candidate benchmark, run three samples only.
2. Do not compare systems yet.
3. Fill this matrix:

```csv
benchmark,task_count,auto_score,needs_browser,needs_code_exec,avg_cost,claim_level_labels,process_logs_supported,license,first_run_success
```

Expected files:

```text
experiments/benchmark_survey/
  benchmark_matrix.csv
  setup_notes.md
```

## Phase 1: Cross-Benchmark Pilot

Goal: Identify where Warranted changes measurable behavior.

Manual:

1. Select four benchmarks:
   - CORE-Bench
   - DABstep or DSBench
   - SciFact
   - DiscoveryBench
2. Run 20 tasks from each.
3. Run two systems:
   - markdown-log baseline
   - Warranted
4. Use two seeds per task.
5. Total:

```text
4 benchmarks * 20 tasks * 2 systems * 2 seeds = 320 runs
```

Expected files:

```text
experiments/pilot/
  original_scores.csv
  warranted_process_metrics.csv
  task_fit_report.md
  metric_signal_report.md
```

## Phase 2: Decide Whether to Build a Custom Set

After the pilot, answer four questions:

```text
Q1: Does an existing benchmark provide reliable final scoring?
Q2: Can the task be mapped to claim/evidence obligations?
Q3: Can the run expose Warranted-specific process variables?
Q4: Does the task cover contradiction, insufficient evidence, and uncertainty?
```

Decision rule:

```text
If Q1 and Q2 are mostly yes, but Q3 or Q4 is no, build a small stress set only
for the missing process behavior. Do not build a broad replacement benchmark.
```

## Custom Stress Sets to Build Only If Needed

### Stress Set 1: Contradiction Handling

Purpose: Measure whether a system preserves and exposes counterevidence instead
of silently rewriting conclusions.

Manual:

1. Build 50 tasks.
2. Each task gives initial supporting evidence, then introduces counterevidence.
3. Score whether the agent:
   - preserves the original claim
   - records the counterevidence
   - downgrades or disputes the claim
   - reports the conflict in the final answer

Expected file:

```csv
task_id,system,claim_preserved,rebuttal_recorded,status_downgraded,conflict_reported
```

### Stress Set 2: Insufficient-Evidence Exposure

Purpose: Measure whether the system can stop at "not enough evidence" and state
what is missing.

Manual:

1. Build 50 tasks where the correct behavior is not to conclude.
2. Score whether the agent:
   - refuses to mark the claim supported
   - identifies missing evidence
   - proposes a valid next verification step

Expected file:

```csv
task_id,system,unsupported_refusal,missing_evidence_identified,next_step_valid
```

### Stress Set 3: Auditability

Purpose: Measure whether Warranted's graph helps a third party audit the
research artifact.

Manual:

1. Sample 40 erroneous or partially erroneous runs from existing benchmarks.
2. Give evaluators one of two artifact packages:
   - final answer plus markdown log
   - final answer plus Warranted graph export
3. Ask evaluators to find unsupported claims, unresolved issues, and the next
   best action.
4. Record accuracy and time.

Expected file:

```csv
artifact_type,evaluator_id,time_sec,errors_found,errors_missed,next_step_score
```

## Final Experimental Route

The recommended route is:

1. Run Phase 0 benchmark survey.
2. Run Phase 1 pilot on CORE-Bench, DABstep or DSBench, SciFact, and
   DiscoveryBench.
3. Inspect which metrics show signal.
4. Only then build small custom stress sets for contradiction handling,
   insufficient-evidence exposure, and auditability.
5. Freeze the confirmatory protocol after the pilot, not before.

