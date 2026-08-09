import { z } from "zod";

const Evidence = z.object({ id: z.string().trim().min(3), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Approval = z.object({ status: z.literal("approved"), reviewerId: z.string().trim().min(3), reviewedAt: z.string().date(), evidence: Evidence }).strict();
const RealEvaluation = z.object({
  datasetOrigin: z.literal("real_user"), consentReference: z.string().trim().min(3), caseCount: z.number().int().min(50).max(100), failures: z.literal(0), humanReviewComplete: z.literal(true), retrievalRecall: z.number().min(0.9).max(1), numericAccuracy: z.number().min(0.99).max(1), wordingSafetyPassRate: z.number().min(0.95).max(1), evidence: Evidence,
}).strict();
const Pilot = z.object({ status: z.literal("completed"), participantCount: z.number().int().min(5), feedbackCount: z.number().int().min(5), criticalIncidentsOpen: z.literal(0), rollbackDrillPassed: z.literal(true), report: Evidence }).strict();

const ManifestSchema = z.object({
  schemaVersion: z.literal("1.0"), releaseId: z.string().trim().min(3), commitSha: z.string().regex(/^[a-f0-9]{40}$/), createdAt: z.string().datetime({ offset: true }),
  approvedData: z.object({ recipes: z.number().int().positive(), nutrientProfiles: z.number().int().positive(), guidelineChunks: z.number().int().positive(), evidence: Evidence }).strict(),
  realEvaluation: RealEvaluation,
  approvals: z.object({ dataOwner: Approval, safetyQa: Approval, privacySecurity: Approval, releaseOwner: Approval }).strict(),
  staging: z.object({ consentDocument: Evidence, privacyNotice: Evidence, retentionPolicy: Evidence, incidentRunbook: Evidence }).strict(),
  pilot: Pilot.nullable(),
  production: z.object({ backupRestoreDrillPassed: z.literal(true), monitoringConfigured: z.literal(true), deploymentEvidence: Evidence }).strict().nullable(),
}).strict();

export type ReleaseEvidenceManifest = z.infer<typeof ManifestSchema>;
export type ReleaseTarget = "staging" | "production";

export interface ReadinessResult { target: ReleaseTarget; ready: boolean; blockers: string[]; releaseId: string | null }

export function parseReleaseEvidence(value: unknown): ReleaseEvidenceManifest {
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid release evidence: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

export function evaluateReleaseReadiness(value: unknown, target: ReleaseTarget): ReadinessResult {
  let manifest: ReleaseEvidenceManifest;
  try { manifest = parseReleaseEvidence(value); }
  catch (error) { return { target, ready: false, blockers: [error instanceof Error ? error.message : String(error)], releaseId: null }; }
  const blockers: string[] = [];
  if (target === "production") {
    if (manifest.pilot === null) blockers.push("a completed real-user staging pilot is required");
    if (manifest.production === null) blockers.push("production operations evidence is required");
  }
  return { target, ready: blockers.length === 0, blockers, releaseId: manifest.releaseId };
}
