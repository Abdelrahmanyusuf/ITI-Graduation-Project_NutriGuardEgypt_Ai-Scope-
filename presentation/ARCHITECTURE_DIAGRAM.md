# NutriGuard Architecture Diagram

The high-resolution architecture drawing is available as [nutriguard-architecture.svg](nutriguard-architecture.svg). It can be inserted directly into PowerPoint, Google Slides, or the HTML presentation without losing quality.

## Simplified architecture

```mermaid
flowchart TB
  User["User<br/>Arabic · Egyptian Arabic · English"] --> UI["Responsive RTL Chat"]
  UI --> API["Secure HTTP API<br/>Validation · Rate Limit · Timeout · Security Headers"]
  API --> Safety["Safety & Request Integrity<br/>Medical precedence · Injection protection · Data approval rules"]
  Safety --> Router["Authoritative Rule-Based Router<br/>Intent classification · LangGraph · Conversation context"]

  Router --> RecipeSearch["search_recipes"]
  Router --> GuidelineSearch["search_guidelines"]
  Router --> Calculator["calculate_nutrition"]
  Router --> Comparison["compare_with_guideline"]

  RecipeSearch --> Retrieval["Hybrid Retrieval"]
  GuidelineSearch --> Retrieval
  Retrieval --> Qdrant["Production: Qdrant + external embeddings"]
  Retrieval --> LocalIndex["Demo: deterministic local index"]

  Calculator --> StructuredData["Structured Nutrition Data"]
  Comparison --> StructuredData
  StructuredData --> PostgreSQL["Production: PostgreSQL<br/>Provenance · Versions · Review Records"]
  StructuredData --> DemoSnapshot["Demo: versioned local snapshot"]

  Router -. advisory classification .-> LLM["Optional OpenRouter Model"]
  Calculator --> Facts["Structured, computed facts"]
  RecipeSearch --> Facts
  GuidelineSearch --> Facts
  Comparison --> Facts
  Facts -. grounded rephrasing only .-> LLM
  LLM --> Validator["Grounding Validator<br/>Numbers · Entities · Output shape"]
  Facts --> Template["Deterministic Response Template"]
  Validator -->|Pass| Response["Grounded Response<br/>Basis · Status · Provenance"]
  Validator -->|Fail| Template
  Template --> Response
  Response --> UI

  Ops["Operations & Governance<br/>Metrics · Privacy-safe logs · Docker · Recovery · Release gates"] --- API
  Ops --- PostgreSQL
  Ops --- Qdrant

  classDef authority fill:#176b58,color:#fff,stroke:#176b58;
  classDef safety fill:#0f4e42,color:#fff,stroke:#0f4e42;
  classDef optional fill:#fff7f4,color:#18231f,stroke:#d86f5d,stroke-dasharray: 5 5;
  classDef data fill:#eef4ef,color:#18231f,stroke:#c9e4d9;
  class Safety safety;
  class Router,Calculator,Validator authority;
  class LLM optional;
  class PostgreSQL,Qdrant,LocalIndex,DemoSnapshot,StructuredData data;
```

## Main architectural rule

The LLM is not the source of nutrition facts. It may provide advisory classification and grounded response wording, but routing remains rule-based and every nutritional number comes from the deterministic calculation pipeline.
