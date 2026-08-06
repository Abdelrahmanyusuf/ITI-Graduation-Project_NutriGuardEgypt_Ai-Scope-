# NutriGuard — Architecture & Current State

## Project scope

NutriGuard is a nutrition assistant restricted to **verified Egyptian food**.
It must never invent nutritional numbers: all arithmetic is deterministic
application code, and data carries provenance and versioning.

## Repository layout (after Step 0)

```
src/            TypeScript application source (foundation only)
  config/       environment validation (implemented)
  domain/       future domain models (reserved)
  data/         future data access / schema (reserved)
  services/     future business services (reserved)
  tools/        future agent tools (reserved)
  workflows/    future orchestration (reserved)
  api/          future HTTP/API surface (reserved)
  safety/       future safety guards (reserved)
  observability future telemetry/logging (reserved)
  index.ts      entry point (foundation)
tests/          automated tests (node:test + tsx)
scripts/        reserved for CLI / data-processing scripts
data/
  raw/          immutable source inputs (intended for version control)
  staging/      intermediate generated data (gitignored)
  processed/    generated outputs (gitignored)
docs/           documentation
migrations/     reserved for future DB migrations
legacy/         archived JavaScript prototype (reference only)
```

## What is implemented (verified, Step 0)

- TypeScript + Node ESM foundation (`target ES2022`, `module NodeNext`).
- Environment validation module (`src/config/env.ts`) with strict rules for
  `NODE_ENV` and `PORT`. The foundation reads no API keys.
- Root `package.json` has **no runtime dependencies** — only TypeScript, ESLint,
  tsx, and Node type definitions (development tooling). The archived prototype
  runtime libraries (LangChain v1, @xenova/transformers, csv-parser, pdf-parse)
  are **not** installed for the foundation.
- Scripts: `dev`, `dev:smoke`, `build`, `start`, `type-check`, `lint`, `test`.
- Tests proving the toolchain, config validation, dev-entry boot, and Arabic
  UTF-8 integrity.
- `.gitignore` handling for secrets (`.env`) and generated data
  (`data/processed`, `data/staging`).
- Raw input data separated under `data/raw`; generated outputs under
  `data/processed` / `data/staging`.

## What is still prototype (NOT completed)

The archived JavaScript prototype under `legacy/` is a **non-runnable
reference**. It is preserved, not migrated, not wired into the new foundation,
and its runtime dependencies were removed from the root project:

- OpenRouter agent (`NutriGuard_Agent.js`).
- RAG-style guideline retrieval prototype (`Guidelines_Rag.js`).
- Data-cleaning CSV/PDF scripts.

## Explicitly NOT implemented (future work)

- Database schema (and `migrations/` bindings)
- Deterministic nutrition calculator
- Production RAG / vector store
- Workflows / agent orchestration
- UI / HTTP API
- Import pipelines + manual review queue (missing-data handling)

## Data provenance note (Step 0)

Source values are preserved verbatim in `data/raw`. No nutritional value,
guideline, conversion factor, or recipe was altered during this step. Missing
values remain missing (null / absent); they are **never** silently coerced to 0
or invented. Existing cleaning scripts historically used `0` as a stand-in;
that behaviour is confined to the archived prototype and must be replaced by
explicit missing-state handling in a later step — not silently accepted here.

## Repository state

This workspace is **not a Git repository** (no `.git`), so commit-based
verification ("verified from a clean checkout") cannot be performed here.
Installability is verified from the lockfile with `npm ci` only.