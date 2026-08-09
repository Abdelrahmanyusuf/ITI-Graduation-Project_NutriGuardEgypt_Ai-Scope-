import { z } from "zod";

const BaseCase = z.object({
  id: z.string().trim().min(1),
  question: z.string().trim().min(3).max(500),
  language: z.literal("ar-EG"),
  expectedIntent: z.enum(["recipe_nutrition", "compare_recipes", "lighter_recipe", "general_guidance", "medical_safety_request", "unsupported_request"]),
  expectedStatus: z.enum(["ok", "no_result", "clarification", "refused", "unsupported", "emergency"]),
  referenceAnswer: z.string().trim().min(1),
});

const RetrievalCase = BaseCase.extend({
  category: z.literal("retrieval"),
  expectedEvidenceDocumentIds: z.array(z.string().trim().min(1)).min(1),
}).strict();

const NumericCase = BaseCase.extend({
  category: z.literal("numeric"),
  expectedNumericFacts: z.record(z.string().trim().min(1), z.number().finite().nullable()),
}).strict();

const WordingCase = BaseCase.extend({
  category: z.literal("wording"),
  expectedMeaning: z.string().trim().min(1),
  expectedDialectMarkers: z.array(z.string().trim().min(1)).min(1),
}).strict();

const EvaluationCaseSchema = z.discriminatedUnion("category", [RetrievalCase, NumericCase, WordingCase]);

const DatasetSchema = z.object({
  schemaVersion: z.literal("1.0"),
  title: z.string().trim().min(1),
  origin: z.enum(["synthetic", "real_user"]),
  collectionMethod: z.string().trim().min(1),
  consentReference: z.string().trim().min(1).nullable(),
  cases: z.array(EvaluationCaseSchema).min(50).max(100),
}).strict();

export type AgentEvaluationCase = z.infer<typeof EvaluationCaseSchema>;
export type AgentEvaluationDataset = z.infer<typeof DatasetSchema>;

export function parseAgentEvaluationDataset(value: unknown): AgentEvaluationDataset {
  const parsed = DatasetSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid agent evaluation dataset: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const dataset = parsed.data;
  if (new Set(dataset.cases.map((entry) => entry.id)).size !== dataset.cases.length) throw new Error("agent evaluation case IDs must be unique");
  for (const category of ["retrieval", "numeric", "wording"] as const) {
    if (!dataset.cases.some((entry) => entry.category === category)) throw new Error(`agent evaluation dataset needs ${category} cases`);
  }
  if (dataset.origin === "real_user" && dataset.consentReference === null) throw new Error("real-user evaluation data requires a consent/provenance reference");
  if (dataset.origin === "synthetic" && dataset.consentReference !== null) throw new Error("synthetic evaluation data must not claim a consent reference");
  return dataset;
}
export function assertProductionEvaluationDataset(dataset: AgentEvaluationDataset): void {
  if (dataset.origin !== "real_user" || dataset.consentReference === null) {
    throw new Error("production evaluation requires 50–100 consented, provenance-recorded real-user questions");
  }
}
