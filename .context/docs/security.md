---
type: doc
name: security
description: Security assumptions, secrets, permissions and threat surfaces
generated: 2026-06-09
status: generated
---

# Security

## Sensitive Areas

- Secrets and environment files must not be read or echoed without explicit user permission.
- Package dependencies and peer dependencies are part of the trusted runtime surface.

## Project-Specific Signals

- No extra security signals inferred from the scan.

## Review Gates

- Review any change that expands filesystem reads/writes, shell execution, package mutation or git operations.
- Review event hooks for fail-open behavior and unintended prompt/session mutation.
