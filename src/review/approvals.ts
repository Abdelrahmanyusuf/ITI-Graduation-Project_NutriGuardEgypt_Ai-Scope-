import { createHash } from "node:crypto";
import { z } from "zod";

export const SUBJECT_TYPES = ["ingredient_mapping","unit_conversion","cooking_factor","retention_factor","nutrient_profile","recipe_serving_yield","source_license","cultural_evidence","recipe","guideline","safety_qa","privacy_security","release"] as const;
export const ReviewerAuthorizationSchema = z.object({ id:z.string().regex(/^AUT-[A-F0-9]{16}$/), reviewerId:z.string().trim().min(1), reviewerRole:z.string().trim().min(1), qualification:z.string().trim().min(1),
  subjectType:z.enum(SUBJECT_TYPES), subjectKeyPrefix:z.string().min(1).nullable(), validFrom:z.string().date(), validUntil:z.string().date().nullable(), revokedAt:z.string().datetime({offset:true}).nullable(), authorizationEvidenceReference:z.string().trim().min(1), authorizedBy:z.string().trim().min(1) }).strict();
export type ReviewerAuthorization=z.infer<typeof ReviewerAuthorizationSchema>;
export const ApprovalRecordSchema = z.object({ schemaVersion:z.literal("1.0"), id:z.string().regex(/^APR-[A-F0-9]{16}$/), subjectType:z.enum(SUBJECT_TYPES), subjectKey:z.string().trim().min(1),
  contentSha256:z.string().regex(/^[a-f0-9]{64}$/), decision:z.enum(["approved","rejected"]), reviewerId:z.string().trim().min(1), reviewerRole:z.string().trim().min(1),
  authorizationId:z.string().regex(/^AUT-[A-F0-9]{16}$/), reviewedAt:z.string().datetime({offset:true}), evidenceReference:z.string().trim().min(1), rationale:z.string().trim().min(1), supersedesId:z.string().regex(/^APR-[A-F0-9]{16}$/).nullable() }).strict();
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function contentHash(value: unknown): string { return createHash("sha256").update(canonical(value),"utf8").digest("hex"); }
export function verifyApproval(record: ApprovalRecord, subject: unknown, requiredRole: string, authorization?:ReviewerAuthorization): string[] {
  const issues:string[]=[]; const parsed=ApprovalRecordSchema.safeParse(record); if(!parsed.success) return parsed.error.issues.map((i)=>`${i.path.join(".")}: ${i.message}`);
  if(record.reviewerRole!==requiredRole) issues.push("reviewer_role_not_authorized");
  const auth=authorization?ReviewerAuthorizationSchema.safeParse(authorization):null;
  if(!auth?.success || auth.data.id!==record.authorizationId || auth.data.reviewerId!==record.reviewerId || auth.data.reviewerRole!==record.reviewerRole || auth.data.subjectType!==record.subjectType) issues.push("reviewer_authorization_missing_or_mismatched");
  else { const reviewDate=record.reviewedAt.slice(0,10); if(reviewDate<auth.data.validFrom || (auth.data.validUntil!==null&&reviewDate>auth.data.validUntil) || (auth.data.revokedAt!==null&&Date.parse(record.reviewedAt)>=Date.parse(auth.data.revokedAt)) || (auth.data.subjectKeyPrefix!==null&&!record.subjectKey.startsWith(auth.data.subjectKeyPrefix))) issues.push("review_outside_authorized_scope_or_date"); }
  if(record.contentSha256!==contentHash(subject)) issues.push("content_hash_mismatch");
  if(new Date(record.reviewedAt).getTime()>Date.now()+300_000) issues.push("review_time_in_future");
  return issues;
}

export interface ReviewQueueItem { id:string; subjectType:typeof SUBJECT_TYPES[number]; subjectKey:string; contentSha256:string; requiredRole:string; priority:1|2|3|4|5; status:"pending"; blockerCodes:string[] }
export function buildPendingQueue(subjectType:ReviewQueueItem["subjectType"], subjectKey:string, subject:unknown, requiredRole:string, blockerCodes:string[]=[]):ReviewQueueItem {
  const hash=contentHash(subject); const id=`QUE-${createHash("sha256").update(`${subjectType}|${subjectKey}|${hash}|${requiredRole}`).digest("hex").slice(0,16).toUpperCase()}`;
  return {id,subjectType,subjectKey,contentSha256:hash,requiredRole,priority:3,status:"pending",blockerCodes:[...new Set(blockerCodes)].sort()};
}
