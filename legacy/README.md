# legacy/ — Archived JavaScript prototype (reference only)

This directory preserves the original pre-Step-0 prototype **as reference
source only**. It is documented as **non-runnable**:

- It is **not** required by, and **not** wired into, the `src/` foundation.
- It has **no dependencies** declared for it and the prototype runtime
  dependencies were removed from the root `package.json`, so these files
  cannot be executed against the current install.
- If run, file paths such as `../data/raw/...` resolve from the current
  working directory, which makes them unreliable. They are **not** executed
  as part of any install, build, or test.
- Data-path strings in these files are illustrative only and were preserved
  verbatim from the original prototype (with `node:fs` used in place of the
  removed fake `fs` package in `Guidelines_Rag.js`).

No run instructions are provided, because this archive is intentionally
non-runnable. Reintroducing the prototype as runnable code is future work.

## Contents

| File | Original purpose | Status |
| ---- | ---------------- | ------ |
| `NutriGuard_Agent.js` | OpenRouter LLM agent (Egyptian-Arabic system prompt) | Archived, non-runnable |
| `Guidelines_Rag.js` | Embedding-based guideline retrieval prototype | Archived, non-runnable |
| `clean_data.js` | CSV → cleaned JSON for ingredients & recipes | Archived, non-runnable |
| `Clean_WHO Guidelines.js` | WHO PDF → chunk JSON | Archived, non-runnable |
| `merge_guidelines.js` | Merge staging + raw guideline JSON | Archived, non-runnable |

These files are excluded from ESLint and the TypeScript build on purpose. The
Egyptian-Arabic strings they contain remain a valid UTF-8 reference and are
exercised by the Arabic UTF-8 tests in `tests/arabic-utf8.test.ts`.