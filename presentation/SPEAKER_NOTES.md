# NutriGuard Egypt: Speaker Notes

## Presentation setup

- Open `presentation/index.html` in a browser and use full screen.
- Use the arrow keys or Space to move between slides.
- Press `P` to print or save a PDF version.
- Recommended timing: 8 to 12 minutes, then live demo and questions.
- The demo UI is intentionally labelled as graduation/demo data. Do not call it production-approved.

## Core message

NutriGuard is not a generic chatbot. It is a deterministic nutrition agent for Egyptian food. Hybrid RAG is used to find recipe and guideline context, while an independent application pipeline resolves ingredients, normalizes quantities, calculates nutrition, and returns provenance. Optional model calls can classify or rephrase, but they cannot calculate, approve, or invent facts.

## Slide-by-slide notes

### 1. Title

Introduce the project as a graduation implementation focused on trustworthy nutrition answers. The phrase “traceable” is important: every result should be explainable by data, rules, and a calculation trace.

### 2. NutriGuard in one sentence

Mention the graduation corpus numbers carefully: 215 recipes are candidate demo records, not 215 human-approved production recipes. The demo also contains 169 ingredient references and 219 indexed documents. The four tools are recipe search, guideline search, deterministic nutrition calculation, and structured guideline comparison.

### 3. Problem

Explain that Egyptian food creates real normalization problems: Arabic and English aliases, local household measures, and food states such as raw, cooked, boiled, fried, and baked. A language model can be fluent while still returning a wrong number, so the system needs a calculation authority outside the model.

### 4. Product thesis

Walk through the four principles. The strongest point for the committee is the difference between `0` and `null`: zero is a measured value, while null means unknown. Also explain that automation creates candidates and review queues; it never self-verifies culturally or nutritionally.

### 5. User experience flow

Use the sodium question as the simple example. The safety screen is before tools. Retrieval identifies the recipe or guideline. The calculator produces the numeric value. The final answer exposes its basis and provenance instead of only showing fluent prose.

### 6. Architecture

Describe the layers from top to bottom. PostgreSQL is the structured authority in the production design. Qdrant is for approved retrieval documents. The local graduation runtime uses a deterministic demo corpus and local retrieval so the presentation works without external credentials.

### 7. Data pipeline

Explain the review lifecycle: raw data stays preserved, audit and staging produce reports and queues, ingredient resolution is staged and deterministic, units require sourced factors, and only an approved snapshot should serve production. Mention that the current production status is intentionally blocked because human-approved mappings and an approved nutrient snapshot are not yet loaded.

### 8. Nutrition engine

Emphasize that the calculator works ingredient by ingredient. It applies mass, nutrient profile, and only sourced edible-portion, yield, and retention factors. It produces full-recipe, per-serving, and per-100-g bases, with coverage and reasons for unavailable values. Internal arithmetic is not rounded until the output boundary.

### 9. RAG and tools

Answer the likely question “Why use RAG?”: recipes and guidelines need updating and must show their source. RAG retrieves context, but it is not allowed to turn arbitrary text into numeric rules. Numeric comparison uses one exact structured guideline rule.

### 10. Safety and integrity

Say that medical and emergency requests are screened before any optional provider call. Prompt injection and user-supplied number overrides are blocked before planning. The grounded formatter extracts numbers and entities from generated wording; any mismatch causes a deterministic template fallback.

### 11. Conversational capabilities

Mention recipe lookup, nutrition, same-basis comparison, lighter alternatives, general guidance, short-term follow-up memory, and multi-option meal selection. Be transparent about dashboard integration: the local mock flow is implemented and tested, but there is no real HTTP dashboard client yet because authentication, privacy, and backend contracts are unresolved.

### 12. UI

Point out the responsive RTL chat, quick prompts, nutrition cards, comparison table, expandable sources, and visible demo disclosure. The UI is designed to make the answer readable first and the evidence available without overwhelming the user.

### 13. Evaluation

Explain the local synthetic retrieval benchmark: Recall@1 is 57.41%, Recall@3 is 85.19%, and MRR@5 is 70.68% over 80 questions, with 54 clear expected links. This proves the evaluation machinery and gives an honest baseline; it is not a production accuracy claim. The latest live-layer verification recorded 553 tests, with 552 passing, one pre-existing skip, and no failures. The optional model layer had 69.7% agreement over 66 comparable cases and made zero calls for medical safety.

### 14. Engineering readiness

Mention the concrete operational work: migrations, schema validation, Qdrant filters, health and readiness routes, metrics, request IDs, rate limiting, security headers, Docker packaging, backup and recovery tooling, threat model, privacy flow, incident response, and release checklists.

### 15. Honest scope

This is a strength, not an apology. Separate “engineering implementation ready for review” from “operationally released to real users.” Remaining blockers are human data approval, real-user questions and wording review, a real staging pilot, approved infrastructure, and owner-authorized deployment.

### 16. Demo plan

Run the four questions in this order. After each answer, open “Sources and details” and point to the basis, document evidence, and status. If the demo data is labelled estimated or needs review, explain that this is deliberate because the candidate dataset is not being presented as health-approved production data.

### 17. Closing

Use the closing sentence: “NutriGuard finds the right context, calculates outside the language model, and shows the evidence and the limits.” Then invite questions.

## Expected committee questions

### Why RAG instead of fine-tuning?

RAG is better for knowledge that changes and must expose a source. Fine-tuning may improve style later, but it should not be treated as the storage location for nutrition facts.

### How do you prevent hallucination?

Numbers come from deterministic tools, not generated text. Retrieval is approval-filtered. The formatter is grounded against structured facts and falls back to a fixed template. Missing or ambiguous data produces `null`, `no_result`, or clarification.

### Is it medically accurate?

The graduation demo is an engineering prototype and informational assistant, not a medical device. Production health claims require reviewed data, domain experts, real-user evidence, and release approvals.

### What happens when an ingredient is missing?

It remains unknown. The system does not coerce it to zero. The result becomes partial or unavailable depending on whether a valid basis remains, and the response contains the reason.

### Why does the demo work without Qdrant?

The demo uses a local deterministic retrieval index for portability. The production adapter is Qdrant because it supports vector persistence, filters, and operational scaling. Both sit behind the same retrieval boundary.

### What was the most important engineering decision?

Separating the language layer from the numeric authority. This makes the system more testable and prevents a fluent model response from becoming an unverified nutrition claim.

## Demo commands

```powershell
npm run demo:prepare
npm run dev:web
```

Then open `http://127.0.0.1:3000`.

## Final wording to remember

“We claim deterministic, traceable, graduation-ready engineering. We do not claim 100% accuracy, human clinical validation, or official production deployment.”
