import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

const Evidence = z.object({ id: z.string().trim().min(3), file: z.string().trim().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Approval = z.object({ status: z.literal("approved"), reviewerId: z.string().trim().min(3), reviewedAt: z.string().date(), evidence: Evidence }).strict();
const RealEvaluation = z.object({
  datasetOrigin: z.literal("real_user"), consentReference: z.string().trim().min(3), caseCount: z.number().int().min(50).max(100), failures: z.literal(0), humanReviewComplete: z.literal(true), retrievalRecall: z.number().min(0.9).max(1), numericAccuracy: z.number().min(0.99).max(1), wordingSafetyPassRate: z.number().min(0.95).max(1), evidence: Evidence,
}).strict();
const Pilot = z.object({ status: z.literal("completed"), participantCount: z.number().int().min(5), feedbackCount: z.number().int().min(5), criticalIncidentsOpen: z.literal(0), rollbackDrillPassed: z.literal(true), report: Evidence }).strict();

const ManifestSchema = z.object({
  schemaVersion: z.literal("1.0"), releaseId: z.string().trim().min(3), commitSha: z.string().regex(/^[a-f0-9]{40}$/), createdAt: z.string().datetime({ offset: true }),
  approvedData: z.object({ recipes: z.number().int().positive(), nutrientProfiles: z.number().int().positive(), guidelineChunks: z.number().int().positive(),
    ingredientMappings: z.number().int().positive(), unitConversions: z.number().int().positive(), cookingFactors: z.number().int().nonnegative(),
    licensedSources: z.number().int().positive(), culturalEvidenceRecords: z.number().int().positive(), evidence: Evidence }).strict(),
  realEvaluation: RealEvaluation,
  approvals: z.object({ dataOwner: Approval, nutritionReviewer: Approval, egyptianCulturalReviewer: Approval,
    legalLicenseReviewer: Approval, safetyQa: Approval, privacySecurity: Approval, releaseOwner: Approval }).strict(),
  staging: z.object({ consentDocument: Evidence, privacyNotice: Evidence, retentionPolicy: Evidence, incidentRunbook: Evidence }).strict(),
  pilot: Pilot.nullable(),
  production: z.object({ backupRestoreDrillPassed: z.literal(true), qdrantRecoveryDrillPassed: z.literal(true), rollbackDrillPassed: z.literal(true),
    incidentExercisePassed: z.literal(true), monitoringConfigured: z.literal(true), deploymentEvidence: Evidence }).strict().nullable(),
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

/** Verify that every evidence declaration resolves inside the manifest directory and hash-matches real bytes. */
export async function verifyReleaseEvidenceFiles(manifest:ReleaseEvidenceManifest,manifestPath:string):Promise<string[]> {
  const issues:string[]=[]; const root=await realpath(dirname(resolve(manifestPath))); const declarations:Array<{id:string;file:string;sha256:string}>=[];
  const visit=(value:unknown):void=>{if(Array.isArray(value)){value.forEach(visit);return;}if(typeof value!=="object"||value===null)return;const record=value as Record<string,unknown>;
    if(typeof record.id==="string"&&typeof record.file==="string"&&typeof record.sha256==="string")declarations.push(record as {id:string;file:string;sha256:string});Object.values(record).forEach(visit);};
  visit(manifest); const ids=new Set<string>();
  for(const evidence of declarations){if(ids.has(evidence.id)){issues.push(`duplicate evidence id: ${evidence.id}`);continue;}ids.add(evidence.id);
    if(isAbsolute(evidence.file)||evidence.file.split(/[\\/]/u).includes("..")){issues.push(`unsafe evidence path: ${evidence.id}`);continue;}
    try{const file=await realpath(resolve(root,evidence.file));if(file!==root&&!file.startsWith(`${root}${sep}`)){issues.push(`evidence escapes manifest directory: ${evidence.id}`);continue;}
      const actual=createHash("sha256").update(await readFile(file)).digest("hex");if(actual!==evidence.sha256)issues.push(`evidence hash mismatch: ${evidence.id}`);
    }catch{issues.push(`evidence file missing or unreadable: ${evidence.id}`);}
  }
  return issues;
}
