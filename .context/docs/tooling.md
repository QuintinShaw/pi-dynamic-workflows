---
type: doc
name: tooling
description: Scripts, package manager, automation and productivity tools
generated: 2026-06-09
status: generated
---

# Tooling

## Package Manager

Detected: **npm**

## Scripts

- `test`: `npm run check && npm run build && npm run test:unit`
- `test:unit`: `tsx --test tests/**/*.test.ts`
- `check`: `biome check .`
- `format`: `biome format --write .`
- `lint`: `biome lint .`
- `build`: `tsc`
- `dev`: `tsx src/index.ts`
- `prepublishOnly`: `npm run build`

## Pi Manifest

- Extensions: `extensions/workflow.ts`

## Configuration Files

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `package.json`
- `tsconfig.json`

## Dependencies Snapshot

- `@biomejs/biome`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `acorn`
- `tsx`
- `typebox`
- `typescript`
