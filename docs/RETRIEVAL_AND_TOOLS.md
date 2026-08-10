# Retrieval and deterministic tools (Steps 8–10)

> **Status:** implemented for review. Production model selection and production
> vector ingestion remain blocked until an approved, non-synthetic evaluation
> set and an approved corpus are supplied.

## Trust boundary

Retrieval is descriptive only. It may find approved recipe or guideline text,
but it never calculates nutrition and it never turns text into a numeric rule.

- Nutrition arithmetic is delegated to the deterministic Step 7 engine.
- Guideline comparisons use exact, structured, approved `guideline_rules`.
- Search results must carry source and data-version provenance.
- Recipe search returns only human-verified recipes.
- Missing, ambiguous, pending, or unlicensed records fail closed.

No raw or staging directory is imported automatically. Production ingestion
requires an explicit approved corpus file supplied by an operator.

## Step 8 — embedding benchmark

`npm run benchmark:embeddings` evaluates exactly two or three multilingual
embedding models against a versioned Arabic retrieval dataset. It reports:

- Recall@K
- mean reciprocal rank (MRR)
- per-query ranking evidence
- failures and model dimensions

Selection requires one unique winner that meets the configured thresholds.
Ties, model failures, and missed thresholds require review. A dataset marked
`synthetic: true` can exercise the benchmark but **cannot select a production
model**.

Required configuration:

```text
EMBEDDING_BASE_URL=https://provider.example/v1
EMBEDDING_API_KEY=...
EMBEDDING_MODELS=model-a,model-b
EMBEDDING_BENCHMARK_DATASET=path/to/approved-evaluation.json
```

The HTTP adapter uses an OpenAI-compatible `/embeddings` endpoint, but model
and provider names are configuration rather than code constants.

## Step 9 — approved-only vector ingestion

`npm run ingest:retrieval` reads one explicit corpus manifest, embeds it with
the selected model, and synchronizes the configured Qdrant collection.

The ingestion gate requires every document to contain:

- a stable document ID and namespace;
- `approved` review status and an approved license status;
- complete source ID, data-version ID, title, URL, access date, and locator;
- a human-verified status for recipe documents.

Points use deterministic content-bound IDs. The pipeline upserts the complete
new namespace before deleting stale points, and refuses empty corpora. Search
filters are also enforced by Qdrant for namespace, document kind, approval,
license, and recipe verification.

Ingredients remain in normalized PostgreSQL tables; they are not a vector
collection. Numeric nutrient values also remain outside the vector authority.

Required configuration:

```text
RETRIEVAL_CORPUS_PATH=path/to/approved-corpus.json
EMBEDDING_BASE_URL=https://provider.example/v1
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=the-reviewed-model
QDRANT_URL=https://qdrant.example
QDRANT_API_KEY=...
QDRANT_COLLECTION=nutriguard_retrieval
```

The embedding adapter supports bounded batches, deterministic retry/backoff for
transient `429`/`503` responses, and an explicit output dimension. Qdrant
ingestion creates the required keyword payload indexes (`namespace`, `kind`,
approval fields, and Egyptian-verification status) before writing points, so
strict-mode Qdrant Cloud collections can enforce the approved-only filters.
Graduation data must use a collection separate from future production data.

Paths inside `data/raw/` and `data/staging/` are rejected by the CLI.

## Step 10 — application tools

| Tool | Authority and behavior |
| --- | --- |
| `search_recipes` | Semantic search restricted to approved, licensed, human-verified Egyptian recipes. |
| `search_guidelines` | Semantic search restricted to approved, licensed guideline text. |
| `calculate_nutrition` | Calls the Step 7 deterministic calculator; it never derives numbers from retrieved text or an LLM. |
| `compare_with_guideline` | Compares a supplied value with one exact approved structured rule matching nutrient, unit, and basis. |

Tool results are structured and include provenance where applicable. Invalid
inputs, absent trusted data, ambiguous rules, unit/basis mismatches, and
unavailable nutrition return explicit errors. Guideline results are general
information only and are not medical advice.

These tools are application services. Agent prompting, orchestration, HTTP API,
and user interface work begin in later steps and are not part of Step 10.

## Tests and fixtures

`tests/retrieval.test.ts` and `tests/nutriguard-tools.test.ts` cover benchmark
selection and tie behavior, the synthetic-data production block, deterministic
ingestion, approval gates, Qdrant filters, all four tools, unavailable
nutrition, exact structured comparisons, and ambiguous/pending guideline
rules.

`tests/fixtures/retrieval/embedding-eval.synthetic.json` is explicitly
synthetic and test-only. It is not evidence for choosing a production model.
