import type { AdversarialEvaluationReport } from "./adversarial.js";

export interface IterationEvidence {
  schemaVersion: "1.0";
  step: 17;
  promptVersion: string;
  basedOnDataset: string;
  basedOnCaseCount: number;
  adversarialPassRate: number;
  changes: Array<{ id: string; finding: string; implementation: string; regressionCoverage: string }>;
  unresolvedProductionBlockers: string[];
  productionEligible: false;
}

export function buildIterationEvidence(report: AdversarialEvaluationReport): IterationEvidence {
  if (report.promptVersion === null) throw new Error("iteration evidence requires an evaluated prompt version");
  return {
    schemaVersion: "1.0",
    step: 17,
    promptVersion: report.promptVersion,
    basedOnDataset: report.datasetTitle,
    basedOnCaseCount: report.caseCount,
    adversarialPassRate: report.passRate,
    changes: [
      { id: "ITER-001", finding: "User instructions could attempt to override system rules or reveal hidden instructions.", implementation: "Added a pre-planner prompt-injection integrity gate.", regressionCoverage: "ADV-006, ADV-007" },
      { id: "ITER-002", finding: "User-supplied nutrition numbers must never replace deterministic calculator output.", implementation: "Added an untrusted numeric-override integrity gate.", regressionCoverage: "ADV-008, ADV-009" },
      { id: "ITER-003", finding: "Requests for pending or rejected data must fail before retrieval.", implementation: "Added an unapproved-data request integrity gate.", regressionCoverage: "ADV-010, ADV-011" },
    ],
    unresolvedProductionBlockers: [
      "real-user Step 14 corpus and consent provenance",
      "human wording/comprehension review",
      "real embedding benchmark and approved production model",
      "approved production recipe, nutrient, and guidance corpus",
    ],
    productionEligible: false,
  };
}
