# Dynamic registry ownership

Model routes and agent types are dynamic references. Their shape and owner are documented, but available names depend on active user/project configuration and are intentionally absent from static skill files.

## Model routes

The model-tier configuration owns route names. Standard routes are `small`, `medium`, and `big`; use another route only when its name and purpose are supplied in context. A route is selected with `tier`. An exact user-requested model is selected with `model`.

## Agent types

The agent registry owns agent-type names and their bound instructions, tools, model, and isolation policy. Use `agentType` only when context supplies both its name and purpose. Do not infer an agent type from a role-like label.

## Priority

Routing priority is explicit `model` > `agentType` model > `tier` > phase model > metadata model > implicit `medium` > session default. Higher priority means selection, not "try this then fall back to the next selector." If the selected model or route is unavailable, execution falls directly to the session default; it does not try lower-priority selectors. Avoid specifying competing selectors unless deliberately overriding a lower-priority default.
