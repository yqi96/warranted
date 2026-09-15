# Paper experiment branches

This is an experiment-only branch based on the source commit recorded in `experiment.json`.
Production `main` and development `dev` are not changed or merged by this experiment.

## Implementation plan

1. Remove custom subagents, all bundled skills, and the browser server/code/dependency.
2. Keep one shared methodology prefix in `agents/toulmin-researcher.md`; do not override the harness model.
3. Branch guidance-only, record-only, and full-feedback treatments from this common base.
4. Verify the exposed tools, feedback behavior, and prompt consistency before publishing branches.

## Running trials

- Native: run the underlying agent without this plugin.
- Guidance: install only the guidance branch plugin; it supplies the primary prompt and no MCP server or hooks.
- Records: install the records branch plugin; it supplies nine record tools and no generated research feedback.
- Full: install the full branch plugin; it supplies all eleven argument tools, checks and review feedback.
- Load exactly one experiment plugin, never alongside production Warranted. Install outside the participant's task workspace; do not supply this repository or its evaluation fixtures as research inputs.
- Use the same underlying model, effort, task materials, permissions and native research tools for every arm. Built-in delegation and self-directed checking remain available. Disable unrelated user/project custom skills and subagents in the external harness as well.
- Each trial starts with a fresh workspace and database. Do not share `.toulmin` state, sessions, or runtime caches between arms.
- Agents decide when to stop. Record actual tokens, calls, experiments, elapsed time, and reviewer usage; do not equalize these outcomes. Declare any emergency cutoff separately.
- Record the branch commit, prompt hash, effective tool list, model settings and (full arm only) reviewer settings. Configure reviewer credentials locally; never commit `review.json`.
- The full treatment implements existing checks and local semantic review; it does not add a declared investigation execution interface.

The baseline branch is preparation, not an additional treatment. No scientific trial is run by these checks.
