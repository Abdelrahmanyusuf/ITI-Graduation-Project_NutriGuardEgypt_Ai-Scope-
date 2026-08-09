import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evaluateReleaseReadiness } from "../src/release/readiness.js";

const sha = "a".repeat(64);
const evidence = (id: string) => ({ id, sha256: sha });
const approval = (id: string) => ({ status: "approved" as const, reviewerId: id, reviewedAt: "2026-08-09", evidence: evidence(`${id}-evidence`) });
function completeManifest() {
  return {
    schemaVersion: "1.0", releaseId: "release-test-1", commitSha: "b".repeat(40), createdAt: "2026-08-09T10:00:00+03:00",
    approvedData: { recipes: 1, nutrientProfiles: 1, guidelineChunks: 1, evidence: evidence("approved-data") },
    realEvaluation: { datasetOrigin: "real_user", consentReference: "CONSENT-REAL-001", caseCount: 60, failures: 0, humanReviewComplete: true, retrievalRecall: 0.95, numericAccuracy: 1, wordingSafetyPassRate: 1, evidence: evidence("real-evaluation") },
    approvals: { dataOwner: approval("data-owner"), safetyQa: approval("safety-reviewer"), privacySecurity: approval("privacy-reviewer"), releaseOwner: approval("release-owner") },
    staging: { consentDocument: evidence("consent-document"), privacyNotice: evidence("privacy-notice"), retentionPolicy: evidence("retention-policy"), incidentRunbook: evidence("incident-runbook") },
    pilot: null,
    production: null,
  };
}

test("Step 19 staging gate requires complete real evidence and rejects synthetic/incomplete input", () => {
  assert.equal(evaluateReleaseReadiness({}, "staging").ready, false);
  const bad = completeManifest() as Record<string, unknown>;
  bad.realEvaluation = { datasetOrigin: "synthetic" };
  assert.equal(evaluateReleaseReadiness(bad, "staging").ready, false);
  assert.equal(evaluateReleaseReadiness(completeManifest(), "staging").ready, true);
});

test("Step 20 production gate additionally requires completed pilot and operations evidence", () => {
  const manifest = completeManifest();
  const blocked = evaluateReleaseReadiness(manifest, "production");
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, ["a completed real-user staging pilot is required", "production operations evidence is required"]);
  manifest.pilot = { status: "completed", participantCount: 5, feedbackCount: 5, criticalIncidentsOpen: 0, rollbackDrillPassed: true, report: evidence("pilot-report") } as never;
  manifest.production = { backupRestoreDrillPassed: true, monitoringConfigured: true, deploymentEvidence: evidence("deployment-evidence") } as never;
  assert.equal(evaluateReleaseReadiness(manifest, "production").ready, true);
});
