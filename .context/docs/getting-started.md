---
type: doc
name: getting-started
description: Local setup, installation and onboarding path
generated: 2026-06-09
status: generated
---

# Getting Started

## Setup

Package manager: **npm**

```bash
npm install
```

## Local Pi Loading

- Load locally with `pi -e .` to test package extensions from `package.json`.
- Extension entrypoints: `extensions/workflow.ts`.

## Useful Commands

- `test`: `npm run check && npm run build && npm run test:unit`
- `test:unit`: `tsx --test tests/**/*.test.ts`
- `check`: `biome check .`
- `format`: `biome format --write .`
- `lint`: `biome lint .`
- `build`: `tsc`
- `dev`: `tsx src/index.ts`
- `prepublishOnly`: `npm run build`

## First Files To Read

- `. (import) -> ./dist/index.js`
- `. (types) -> ./dist/index.d.ts`
- `./dist/index.d.ts`
- `./dist/index.js`
- `README.md`
- `extensions/workflow.ts`
- `package.json`
- `src/index.ts`
