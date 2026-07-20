# Repository guidance

## Workflow documentation

Before changing the workflow runtime, tool API, capability contract, or `workflow-authoring` skill, read [Protected workflow-authoring guidance](CONTRIBUTING.md#protected-workflow-authoring-guidance).

- Keep stable capability facts in the executable capability contract and generated documentation.
- Keep detailed authoring guidance in the on-demand skill, not the always-on prompt.
- Do not copy live model or agent-type catalogues into static guidance.
- Run `npm run context:check` with the other checks listed in the contributor guide.
- If a protected file changes, review it before running `npm run guidance:accept -- <path>`.
