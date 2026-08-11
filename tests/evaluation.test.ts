import assert from "node:assert/strict";
import test from "node:test";
import type { ExpandedAgentResponse } from "../src/agent/expanded-agent.js";
import { assertProductionEvaluationDataset, parseAgentEvaluationDataset, type AgentEvaluationDataset } from "../src/evaluation/dataset.js";
import { evaluateAgentDataset, type EvaluationRunner, type HumanWordingReview } from "../src/evaluation/evaluate.js";

function datasetValue(origin: "synthetic" | "real_user" = "synthetic"): unknown {
  const retrieval = Array.from({ length: 20 }, (_, index) => ({
    id: `RET-${index}`, question: `استرجاع ${index}`, language: "ar-EG", category: "retrieval",
    expectedIntent: "general_guidance", expectedStatus: "ok", referenceAnswer: "إرشاد موثق", expectedEvidenceDocumentIds: ["DOC-PYRAMID"],
  }));
  const numeric = Array.from({ length: 15 }, (_, index) => ({
    id: `NUM-${index}`, question: `رقم ${index}`, language: "ar-EG", category: "numeric",
    expectedIntent: "recipe_nutrition", expectedStatus: "ok", referenceAnswer: "700 مجم", expectedNumericFacts: { sodiumMg: 700 },
  }));
  const wording = Array.from({ length: 15 }, (_, index) => ({
    id: `WRD-${index}`, question: `صياغة ${index}`, language: "ar-EG", category: "wording",
    expectedIntent: "medical_safety_request", expectedStatus: "refused", referenceAnswer: "رفض آمن", expectedMeaning: "medical refusal", expectedDialectMarkers: ["مقدرش"],
  }));
  return {
    schemaVersion: "1.0", title: "SYNTHETIC EVALUATOR TEST", origin,
    collectionMethod: origin === "synthetic" ? "generated test fixture" : "consented interview collection",
    consentReference: origin === "real_user" ? "CONSENT-REGISTER-TEST" : null,
    cases: [...retrieval, ...numeric, ...wording],
  };
}

function response(overrides: Partial<ExpandedAgentResponse>): ExpandedAgentResponse {
  return {
    status: "ok", primaryIntent: "general_guidance", language: "ar-EG", safetyFlags: [], integrityFlags: [], message: "دي إجابة موثقة",
    data: null, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: "1.3.0", ...overrides,
  };
}

const perfectRunner: EvaluationRunner = {
  invoke: async ({ message }) => message.startsWith("استرجاع")
    ? response({ evidenceDocumentIds: ["DOC-PYRAMID"] })
    : message.startsWith("رقم")
      ? response({ primaryIntent: "recipe_nutrition", data: { sodiumMg: 700 } })
      : response({ status: "refused", primaryIntent: "medical_safety_request", message: "مقدرش أقدم تشخيص أو علاج شخصي" }),
};

test("Step 14 accepts a versioned 50–100 case set and rejects undersized or duplicate sets", () => {
  const parsed = parseAgentEvaluationDataset(datasetValue());
  assert.equal(parsed.cases.length, 50);
  const short = datasetValue() as { cases: unknown[] };
  short.cases = short.cases.slice(0, 49);
  assert.throws(() => parseAgentEvaluationDataset(short), /at least 50|Too small/i);
  const duplicate = datasetValue() as { cases: Array<{ id: string }> };
  duplicate.cases[1]!.id = duplicate.cases[0]!.id;
  assert.throws(() => parseAgentEvaluationDataset(duplicate), /unique/);
});

test("Step 14 production gate rejects synthetic questions and requires real-user consent provenance", () => {
  assert.throws(() => assertProductionEvaluationDataset(parseAgentEvaluationDataset(datasetValue())), /real-user/);
  assert.doesNotThrow(() => assertProductionEvaluationDataset(parseAgentEvaluationDataset(datasetValue("real_user"))));
  const missingConsent = datasetValue("real_user") as { consentReference: string | null };
  missingConsent.consentReference = null;
  assert.throws(() => parseAgentEvaluationDataset(missingConsent), /consent/);
});

test("Step 15 reports retrieval, exact numeric accuracy, and wording quality separately", async () => {
  const dataset = parseAgentEvaluationDataset(datasetValue());
  const report = await evaluateAgentDataset(dataset, perfectRunner);
  assert.equal(report.retrieval.recall, 1);
  assert.equal(report.retrieval.intentStatusAccuracy, 1);
  assert.equal(report.numeric.exactAccuracy, 1);
  assert.equal(report.numeric.factCount, 15);
  assert.equal(report.wording.automatedSafetyAndDialectPassRate, 1);
  assert.equal(report.wording.humanReviewStatus, "pending");
  assert.equal(report.wording.humanMeanClarity, null);
  assert.equal(report.productionEligible, false);
});

test("Step 15 wording remains pending until every wording case has a valid human review", async () => {
  const dataset = parseAgentEvaluationDataset(datasetValue());
  const wordingIds = dataset.cases.filter((entry) => entry.category === "wording").map((entry) => entry.id);
  const reviews: HumanWordingReview[] = wordingIds.map((caseId) => ({ caseId, reviewerId: "SYNTHETIC-REVIEWER", reviewedAt: "2026-08-09", clarity: 4, comprehensionCorrect: true }));
  const report = await evaluateAgentDataset(dataset, perfectRunner, reviews);
  assert.equal(report.wording.humanReviewStatus, "complete");
  assert.equal(report.wording.humanMeanClarity, 4);
  assert.equal(report.wording.humanComprehensionAccuracy, 1);
  assert.equal(report.productionEligible, false, "synthetic origin can never become production evidence");
});

test("Step 15 numeric mismatches cannot be hidden by perfect retrieval or wording", async () => {
  const dataset: AgentEvaluationDataset = parseAgentEvaluationDataset(datasetValue());
  const wrongNumeric: EvaluationRunner = {
    invoke: async (input) => input.message.startsWith("رقم")
      ? response({ primaryIntent: "recipe_nutrition", data: { sodiumMg: 701 } })
      : perfectRunner.invoke(input),
  };
  const report = await evaluateAgentDataset(dataset, wrongNumeric);
  assert.equal(report.retrieval.recall, 1);
  assert.equal(report.numeric.exactAccuracy, 0);
  assert.ok(report.failures.some((failure) => failure.reasons.includes("numeric_mismatch:sodiumMg")));
});
