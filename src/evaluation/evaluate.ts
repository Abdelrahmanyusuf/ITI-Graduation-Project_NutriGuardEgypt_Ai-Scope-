import type { ExpandedAgentResponse } from "../agent/expanded-agent.js";
import type { AgentEvaluationCase, AgentEvaluationDataset } from "./dataset.js";

export interface HumanWordingReview {
  caseId: string;
  reviewerId: string;
  reviewedAt: string;
  clarity: 1 | 2 | 3 | 4 | 5;
  comprehensionCorrect: boolean;
}
export interface EvaluationRunner {
  invoke(input: { message: string; language: "ar-EG" }): Promise<ExpandedAgentResponse>;
}

export interface AgentEvaluationReport {
  schemaVersion: "1.0";
  datasetTitle: string;
  datasetOrigin: "synthetic" | "real_user";
  caseCount: number;
  retrieval: { caseCount: number; recall: number | null; intentStatusAccuracy: number | null };
  numeric: { caseCount: number; factCount: number; exactAccuracy: number | null; intentStatusAccuracy: number | null };
  wording: {
    caseCount: number;
    automatedSafetyAndDialectPassRate: number | null;
    humanReviewStatus: "complete" | "pending";
    humanMeanClarity: number | null;
    humanComprehensionAccuracy: number | null;
  };
  failures: Array<{ caseId: string; reasons: string[] }>;
  productionEligible: boolean;
}

function pathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function intentAndStatusMatch(testCase: AgentEvaluationCase, response: ExpandedAgentResponse): boolean {
  return testCase.expectedIntent === response.primaryIntent && testCase.expectedStatus === response.status;
}

function wordingPass(testCase: Extract<AgentEvaluationCase, { category: "wording" }>, response: ExpandedAgentResponse): boolean {
  const message = response.message;
  const dialectPresent = testCase.expectedDialectMarkers.some((marker) => message.includes(marker));
  const encodingClean = !message.includes("\uFFFD") && !/[طظ][§©]/u.test(message);
  const noUnsafeClaim = !/(?:شخصتك|عالجتك|اضمن لك|مضمون 100%)/iu.test(message);
  return intentAndStatusMatch(testCase, response) && dialectPresent && encodingClean && noUnsafeClaim;
}

function validReview(review: HumanWordingReview): boolean {
  return Boolean(review.reviewerId.trim()) && /^\d{4}-\d{2}-\d{2}$/.test(review.reviewedAt);
}

export async function evaluateAgentDataset(
  dataset: AgentEvaluationDataset,
  runner: EvaluationRunner,
  reviews: readonly HumanWordingReview[] = []
): Promise<AgentEvaluationReport> {
  const failures: AgentEvaluationReport["failures"] = [];
  let retrievalRecallTotal = 0;
  let retrievalIntentStatus = 0;
  let retrievalCases = 0;
  let numericCorrect = 0;
  let numericFacts = 0;
  let numericIntentStatus = 0;
  let numericCases = 0;
  let wordingAutomated = 0;
  let wordingCases = 0;

  for (const testCase of dataset.cases) {
    const response = await runner.invoke({ message: testCase.question, language: "ar-EG" });
    const reasons: string[] = [];
    if (testCase.category === "retrieval") {
      retrievalCases += 1;
      if (intentAndStatusMatch(testCase, response)) retrievalIntentStatus += 1;
      else reasons.push("intent_or_status_mismatch");
      const actual = new Set(response.evidenceDocumentIds);
      const recalled = testCase.expectedEvidenceDocumentIds.filter((id) => actual.has(id)).length / testCase.expectedEvidenceDocumentIds.length;
      retrievalRecallTotal += recalled;
      if (recalled !== 1) reasons.push("retrieval_miss");
    } else if (testCase.category === "numeric") {
      numericCases += 1;
      if (intentAndStatusMatch(testCase, response)) numericIntentStatus += 1;
      else reasons.push("intent_or_status_mismatch");
      for (const [path, expected] of Object.entries(testCase.expectedNumericFacts)) {
        numericFacts += 1;
        if (Object.is(pathValue(response.data, path), expected)) numericCorrect += 1;
        else reasons.push(`numeric_mismatch:${path}`);
      }
    } else {
      wordingCases += 1;
      if (wordingPass(testCase, response)) wordingAutomated += 1;
      else reasons.push("automated_wording_or_safety_check_failed");
    }
    if (reasons.length > 0) failures.push({ caseId: testCase.id, reasons });
  }

  const wordingIds = new Set(dataset.cases.filter((entry) => entry.category === "wording").map((entry) => entry.id));
  const validReviews = reviews.filter((review) => wordingIds.has(review.caseId) && validReview(review));
  const reviewedIds = new Set(validReviews.map((review) => review.caseId));
  const humanComplete = wordingCases > 0 && reviewedIds.size === wordingCases;
  const meanClarity = humanComplete ? validReviews.reduce((sum, review) => sum + review.clarity, 0) / validReviews.length : null;
  const comprehension = humanComplete ? validReviews.filter((review) => review.comprehensionCorrect).length / validReviews.length : null;

  return {
    schemaVersion: "1.0",
    datasetTitle: dataset.title,
    datasetOrigin: dataset.origin,
    caseCount: dataset.cases.length,
    retrieval: { caseCount: retrievalCases, recall: retrievalCases ? retrievalRecallTotal / retrievalCases : null, intentStatusAccuracy: retrievalCases ? retrievalIntentStatus / retrievalCases : null },
    numeric: { caseCount: numericCases, factCount: numericFacts, exactAccuracy: numericFacts ? numericCorrect / numericFacts : null, intentStatusAccuracy: numericCases ? numericIntentStatus / numericCases : null },
    wording: { caseCount: wordingCases, automatedSafetyAndDialectPassRate: wordingCases ? wordingAutomated / wordingCases : null, humanReviewStatus: humanComplete ? "complete" : "pending", humanMeanClarity: meanClarity, humanComprehensionAccuracy: comprehension },
    failures,
    productionEligible: dataset.origin === "real_user" && humanComplete && failures.length === 0,
  };
}
