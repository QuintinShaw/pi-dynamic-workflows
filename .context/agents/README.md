# Agent Handbook

This directory contains dotcontext-style agent playbooks generated from the repository analysis.

## Project Snapshot

- **Project**: @quintinshaw/pi-dynamic-workflows
- **Type**: pi-extension
- **Primary language**: TypeScript
- **Package manager**: npm
- **Detection**: pi package manifest or pi extension/theme keywords detected

## Available Agents

- [Feature Developer](./feature-developer.md) — Implements new features according to approved specifications
- [Bug Fixer](./bug-fixer.md) — Investigates failures and applies focused fixes with regression checks
- [Code Reviewer](./code-reviewer.md) — Reviews code for correctness, maintainability, safety and conventions
- [Test Writer](./test-writer.md) — Creates and updates tests that prove behavior and prevent regressions
- [Documentation Writer](./documentation-writer.md) — Keeps project docs, guides and handoff notes clear and current
- [Refactoring Specialist](./refactoring-specialist.md) — Improves structure safely without changing external behavior
- [Performance Optimizer](./performance-optimizer.md) — Finds bottlenecks and validates measurable performance improvements
- [Security Auditor](./security-auditor.md) — Audits secrets, auth, permissions, injection risks and safe defaults
- [Architect Specialist](./architect-specialist.md) — Designs system structure, module boundaries and technical decisions
- [Backend Specialist](./backend-specialist.md) — Works on server-side APIs, services, data access and integrations
- [Frontend Specialist](./frontend-specialist.md) — Works on UI, components, state, accessibility and frontend ergonomics
- [Database Specialist](./database-specialist.md) — Designs schemas, migrations, queries and persistence boundaries
- [DevOps Specialist](./devops-specialist.md) — Handles CI/CD, releases, deployment, infrastructure and observability
- [Mobile Specialist](./mobile-specialist.md) — Works on native or cross-platform mobile application concerns

## How The Extension Uses Agents

Before each agent turn, the extension selects playbooks that match the user's task and injects them with relevant docs and skills as feedforward context.
