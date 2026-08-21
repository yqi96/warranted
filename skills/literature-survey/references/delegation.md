# Delegation and Parallelism

## Required contract

Every delegated task must state:

```yaml
obligation: "The current uncertainty or proposition creating this task"
question: "One answerable question"
decision_use: "How each plausible result would change the inquiry"
scope:
  sources: "Allowed sources or named artifacts"
  limits: "Dates, disciplines, papers, or query bounds"
do_not:
  - "Forbidden synthesis or graph decisions"
output:
  artifact: "Path for durable detail"
  return: "Small report schema"
stop_when: "Evidence or saturation condition"
```

If `decision_use` is vague, the task is probably busywork. If the question changes while working, the subagent should report the discovered issue rather than silently expanding scope.

## Return envelope

Keep raw candidates, long quotations, and per-paper detail in the artifact. Return only:

```yaml
status: OK | PARTIAL | BLOCKED
answer: "Current answer to the delegated question"
material_findings: []
counterevidence: []
artifacts: []
suggested_graph_consequences: []
unresolved: []
```

Suggested graph consequences are recommendations. The main agent verifies their meaning and controls synthesis changes and qualifiers.

## Parallel dispatch

Parallelize tasks when their briefs remain valid regardless of the other workers' results. Useful role separation includes:

- strongest direct support;
- adversarial counterevidence;
- concept and terminology trace;
- method or population comparison.

Do not parallelize tightly dependent interpretations. In particular, integrate before deciding how an apparent conflict changes the claim, what warrant should replace an old one, or which new search question follows.

Avoid concurrent writes to the same artifact or synthesis proposition. Give each worker a distinct output path. Reconcile counts and files after workers return.

## Main-agent integration

For each returned report:

1. inspect the exact evidence needed for the consequential claim;
2. compare it with current propositions and rebuttals;
3. decide whether the result changes content, scope, warrant, evidence, or qualifier;
4. preserve contrary results and rejected interpretations;
5. update compact state only after the graph and artifacts agree.
