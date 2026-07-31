# Dynamic registry ownership

Model routes and agent types are dynamic references. Their shape and owner are documented, but available names depend on active user/project configuration and are intentionally absent from static skill files.

## Model routes

The model-tier configuration owns route names. Standard routes are `small`, `medium`, and `big`; use another route only when its name and purpose are supplied in context. A route is selected with `tier`. An exact user-requested model is selected with `model`.

## Agent types

The agent registry owns agent-type names and their bound instructions, tools, model, and isolation policy. Use `agentType` only when context supplies both its name and purpose. Do not infer an agent type from a role-like label.

## Priority

Routing priority is explicit `model` > `agentType` model > `tier` > phase model > metadata model > implicit `medium` > session default. Higher priority means selection, not "try this then fall back to the next selector." Avoid specifying competing selectors unless deliberately overriding a lower-priority default.

Unavailability is asymmetric by design. An explicit `model`, `agentType` model, `tier`, or phase model that resolves to a model the registry doesn't have throws — it never silently runs a different model instead. A tier failure names its source (for example: `tier "big" from model-tiers.json resolves to "deadprov/x", which is not available`), so the mistake is traceable back to the config that caused it. Only the implicit default `medium` tier — the route an UNTAGGED agent gets routed through when the script requested no `model`, `tier`, `agentType`, or phase model — degrades to the session default when it is unavailable, since that agent never asked for that specific model; the degrade still logs a one-time warning into the run so it stays discoverable instead of silent.
