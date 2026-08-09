# NutriGuard — Safety Policy

> **Status:** the policy remains the required release contract. Step 12 now
> implements and tests its blocking overrides for one sodium prototype, but
> complete safety evaluation and human Safety/QA approval are still pending.

Defines the hard boundaries NutriGuard must never cross and the behavior of the
`medical_safety_request` handling and safety flags (`SUPPORTED_INTENTS.md`).

## 1. Position and limits

- NutriGuard is an **informational nutrition assistant** restricted to verified
  Egyptian food. It is **not a medical device**, is **not a dietitian or
  physician**, and provides no medical, legal, or emergency services.
- Outputs are **educational** and not personalised health advice; they must not
  be relied on for diagnosis, dosing, or diet‑therapy decisions.

## 2. Explicit exclusions (never performed)

- **No medical diagnosis** of any condition.
- **No medical treatment or prescription.**
- **No individualised nutrition therapy** for a diagnosed disease.
- **No guarantees of safety, allergen‑freedom, halal/kosher compliance, or
  calorie targets** for any specific person.
- **No emergency medicine.** In an apparent emergency, the assistant directs the
  user to local emergency services.

## 3. Safety flags and precedence

Safety flags are divided into **blocking/override** and **non‑blocking
caution/metadata** classes (identical in `SUPPORTED_INTENTS.md` and
`MVP_REQUIREMENTS.md`).

**Blocking/override flags** take precedence over all content intents
(`MVP_REQUIREMENTS.md`, routing model); content intents are not answered
normally:

- `emergency` — redirect to emergency services; do not advise clinically.
- `medical_advice_request` — refuse medical advice, refer to a licensed
  healthcare professional.
- `vulnerable_population_personalization` — refuse personalised advice
  (children, pregnancy, chronic illness); refer to a professional.
- `allergen_safety_guarantee` — a personal allergen‑safety **guarantee** is
  refused and routed to `medical_safety_request`; allergen safety is never
  verified or guaranteed.

A **religious‑compliance guarantee** is refused as `unsupported_request` and
**never** produces a medical referral.

**Non‑blocking caution/metadata flags** do **not** change routing; they attach
an explicit warning:

- `allergen_metadata_filter` — filtering by source‑declared allergen metadata is
  allowed; the metadata is not verified or guaranteed.
- `religious_metadata_filter` — filtering by source‑declared halal/kosher
  metadata is allowed; the metadata is not verified or guaranteed.
- `vegetarian_metadata_filter` — filtering by source‑declared vegetarian
  metadata is allowed; the metadata is not verified or guaranteed.

## 4. No‑fabrication safety rule

- NutriGuard never invents nutrition values, recipes, conversions, guidance,
  sources, or citations (`MVP_REQUIREMENTS.md`).
- Unsourced nutrients report **unknown** (`null`), never guessed.
- The model presents only verified data produced by the deterministic layer
  with provenance; it does **not** compute or invent numbers.
- `candidate`/`pending` data is treated as **not verified** and is never shown
  as authoritative.

## 5. Data trust boundary

- General guidance is shown **only from approved active guidance sources** with
  a citation. A source whose provenance + license status is not approved is
  **not user‑facing** (`DATA_SOURCE_POLICY.md`).
- Propositions about a specific person’s health are out of scope and are
  refused.

## 6. Metadata reporting (vegetarian, halal, kosher, allergen)

- These attributes are surfaced **only** as **source‑declared metadata**.
- NutriGuard does **not** verify, re‑assert, or guarantee religious compliance or
  allergen safety.
- Missing metadata remains **unknown**; it is never inferred.

## 7. Privacy-safe logging

- Logging is **structured, minimal, and operational only**. Raw user queries,
  health information, and personal data are **not** required to be logged and
  are **not** logged by default.
- Logs are **redacted**; by default they contain **no secrets, PII, or health
  data**. Aggregate operational metrics are preferred over content logs.
- Privacy logging is part of the security gate
  (`DEFINITION_OF_DONE.md` G11).

## 8. Safety verification in DoD

- Each user‑facing nutrition release must assert, via tests, the no‑invention
  rule, the `medical_safety_request` behavior, and the routing override rules
  (`DEFINITION_OF_DONE.md`).

---

*Scope: MVP behavior. Review with a Safety/QA reviewer and a licensed nutrition
professional before any MVP release gate is passed.*
