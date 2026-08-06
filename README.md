# NutriGuard Egypt

A nutrition assistant restricted to **verified Egyptian food**. Nutritional
values and guidelines are deterministic application data — the assistant never
invents numbers, and every value carries provenance and versioning.

> **Status: Step 0 (foundation).** No nutrition features are implemented yet.
> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for what exists and what
> is explicitly future work.

## Requirements

- Node.js **>= 22.6** (developed on v24)
- npm **>= 10**

## Installation

```powershell
npm ci
```

`npm ci` performs a clean, reproducible install from the lockfile. The root
project has **no runtime dependencies**; everything installed is development
tooling (TypeScript, ESLint, tsx, Node types). No secrets are required for
install, build, type-check, lint, or tests.

## Environment configuration

The Step 0 foundation validates `NODE_ENV` and `PORT` from the process
environment (see `src/config/env.ts`). It does **not** read any API key and
does **not** load a `.env` file automatically — defaults apply if neither
variable is set. `.env.example` documents the optional variables only; copying
it to `.env` has no effect on the foundation unless your runtime loads it.

## Scripts

| Command             | Action                                        |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Run `src/index.ts` via `tsx watch`            |
| `npm run dev:smoke` | One-shot run of the dev entry (no watch)      |
| `npm run build`     | TypeScript build → `dist/`                    |
| `npm start`         | Run the built output (`node dist/index.js`)   |
| `npm run type-check`| Type-check without emitting                    |
| `npm run lint`      | ESLint across `src/`, `tests/`, roots          |
| `npm test`          | Run the `node:test` suite via `tsx`           |
| `npm run docs:check`| Verify links/anchors in `docs/` and `README.md`    |

## Testing

Tests live in `tests/` and use the Node built-in test runner:

```powershell
npm test
```

They verify the toolchain compiles, environment validation behaves correctly
(including strict `PORT` rules), the development entry boots via `tsx watch`,
Arabic UTF-8 is preserved in the project's executable sources, and the
documentation link checker catches broken files, anchors, and slugs.

## Project scope (completed vs future)

**Implemented (Step 0):**
- TypeScript + Node ESM foundation; root `package.json` holds only foundation
  tooling (no runtime deps).
- Environment validation with strict rules for `NODE_ENV` and `PORT`.
- `dev` / `build` / `start` / `type-check` / `lint` / `test` scripts, plus a
  one-shot `dev:smoke`.
- Source directory skeleton under `src/` (no future features).
- Raw vs generated data split under `data/`.
- `.gitignore` for secrets and generated data.
- Original prototype archived under `legacy/` as **non-runnable reference**
  (its runtime dependencies were removed from the root project).
- Tests for toolchain, config validation, dev-entry boot, and Arabic UTF-8.

**Future (NOT implemented):**
- Database schema and migrations
- Deterministic nutrition calculator and recipe aggregation
- Import pipelines + validation + manual-review queue
- Production RAG / vector retrieval
- Agent workflows, UI, and HTTP API
- Reintroducing the archived prototype as runnable code

Do not assume any of the above "future" capabilities exist yet.

## Repository-state caveat

This workspace is **not a Git repository** (no `.git`). Nothing has been
committed, and "clean-checkout" behavior can only be verified here by
`npm ci` from the lockfile — not from an actual fresh Git clone.