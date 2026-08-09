# Scenario expansion and evaluation (Steps 13–15)

> **Status:** engineering implementation and a synthetic baseline are complete
> for review. The roadmap's required real-user dataset and human wording review
> are not complete and cannot be replaced by synthetic evidence.

## Step 13 — expanded scenarios

`src/agent/expanded-agent.ts` extends the LangGraph Agent with three scenarios:

1. **Compare two recipes.** Both search results must resolve clearly to
   different human-verified recipes. Both calculations use the same
   `per_100g` or `per_serving` basis. Every supported nutrient reports the two
   amounts and a difference; if either amount is missing, the difference is
   `null`.
2. **Approved healthier alternative.** An alternative is returned only when an
   approved/licensed rule binds the original recipe to a verified candidate and
   deterministic calculations prove the candidate is lower on the rule's
   nutrient and basis. With no rule, the Agent says it will not invent a
   modification. The result is labelled a verified alternative recipe—not a
   fabricated rewrite of the original recipe.
3. **Food-pyramid guidance.** The Agent uses `search_guidelines` and returns
   approved source passages with citations. It does not turn prose into numeric
   guidance or personalised medical advice.

The Step 12 sodium scenario remains available. Blocking safety routing still
runs before planning and tools. Planner output is restricted to a strict schema;
the application executes tools and never executes model-generated SQL.

Recipe resolution uses a deterministic top-score confidence band. A clear best
match proceeds; tied or near-tied recipe IDs require clarification.

## Step 14 — 50–100 question set

The committed set
`tests/fixtures/evaluation/agent-eval.synthetic.json` contains **60 explicit
Egyptian-Arabic questions**:

- 20 retrieval cases;
- 20 numeric cases with expected deterministic facts;
- 20 wording/safety/comprehension cases with reference answers.

It is explicitly marked `origin: synthetic`. `parseAgentEvaluationDataset`
requires 50–100 unique cases and coverage of all three categories.
`assertProductionEvaluationDataset` rejects synthetic data and requires a
consent/provenance reference for a real-user set. Therefore this fixture is
useful for repeatable engineering tests but does **not** satisfy the roadmap's
real-user research requirement.

Run its structural gate with:

```powershell
npm run eval:validate
npm run eval:validate -- --production  # intentionally fails for the synthetic set
```

## Step 15 — separate metrics

`src/evaluation/evaluate.ts` keeps the three requested dimensions separate:

- **Retrieval:** relevant-document recall plus intent/status accuracy.
- **Numbers:** exact fact accuracy against the expected deterministic/manual
  reference plus intent/status accuracy. Retrieval success cannot hide a
  numeric mismatch.
- **Egyptian-Arabic wording/comprehension:** automated encoding, safety, dialect,
  intent, and status checks; human clarity/comprehension scores remain `null`
  and `pending` until every wording case has a valid reviewer record.

The current 60-case **synthetic** run produces:

| Metric | Synthetic result |
| --- | ---: |
| Retrieval cases / recall | 20 / 1.00 |
| Numeric cases / checked facts / exact accuracy | 20 / 37 / 1.00 |
| Wording cases / automated pass rate | 20 / 1.00 |
| Human wording review | Pending |
| Production eligible | **No** |

These figures prove deterministic test-fixture behavior only. They are not a
production quality claim and cannot approve the proposed release thresholds.

## Roadmap status after Step 15

The original roadmap continues through Step 20. Still outstanding:

- Step 16 adversarial edge-case evaluation;
- Step 17 prompt/retrieval iteration based on real evaluation findings;
- Step 18 chat/API or web interface;
- Step 19 limited real-user staging and feedback collection;
- Step 20 production refinement and deployment.
