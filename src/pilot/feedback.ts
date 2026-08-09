import { randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import { z } from "zod";

const FeedbackInputSchema = z.object({
  sessionId: z.string().uuid(),
  responseRequestId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  understood: z.boolean(),
  comment: z.string().trim().max(500).nullable(),
  consentReference: z.string().trim().min(3).max(200),
  privacyNoticeVersion: z.string().trim().min(1).max(40),
}).strict();

const FeedbackSubmissionSchema = FeedbackInputSchema.omit({ consentReference: true, privacyNoticeVersion: true }).extend({ consentAccepted: z.literal(true) }).strict();

export type PilotFeedbackInput = z.infer<typeof FeedbackInputSchema>;
export type PilotFeedbackSubmission = z.infer<typeof FeedbackSubmissionSchema>;

export interface PilotFeedbackRecord extends PilotFeedbackInput {
  id: string;
  releaseId: string;
  promptVersion: string;
  createdAt: string;
}

export interface PilotFeedbackStore {
  save(input: PilotFeedbackInput, context: { releaseId: string; promptVersion: string }): Promise<PilotFeedbackRecord>;
}

export class DuplicateFeedbackError extends Error {
  public readonly status = 409;
  public constructor() { super("feedback already exists for this response"); }
}

export function parsePilotFeedback(value: unknown): PilotFeedbackInput {
  const result = FeedbackInputSchema.safeParse(value);
  if (!result.success) throw new Error(`invalid pilot feedback: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return result.data;
}

export function parsePilotFeedbackSubmission(value: unknown): PilotFeedbackSubmission {
  const result = FeedbackSubmissionSchema.safeParse(value);
  if (!result.success) throw new Error(`invalid pilot feedback submission: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return result.data;
}

export class InMemoryPilotFeedbackStore implements PilotFeedbackStore {
  private readonly records: PilotFeedbackRecord[] = [];
  public async save(input: PilotFeedbackInput, context: { releaseId: string; promptVersion: string }): Promise<PilotFeedbackRecord> {
    if (this.records.some((entry) => entry.responseRequestId === input.responseRequestId)) throw new DuplicateFeedbackError();
    const record = { ...structuredClone(input), id: randomUUID(), releaseId: context.releaseId, promptVersion: context.promptVersion, createdAt: new Date().toISOString() };
    this.records.push(record);
    return structuredClone(record);
  }
  public list(): PilotFeedbackRecord[] {
    return structuredClone(this.records);
  }
}

export class PostgresPilotFeedbackStore implements PilotFeedbackStore {
  public constructor(private readonly pool: Pool) {}
  public async save(input: PilotFeedbackInput, context: { releaseId: string; promptVersion: string }): Promise<PilotFeedbackRecord> {
    const id = randomUUID();
    let result: QueryResult<{ created_at: Date }>;
    try { result = await this.pool.query<{ created_at: Date }>(
      `INSERT INTO pilot_feedback
       (id, session_id, response_request_id, rating, understood, comment, consent_reference, privacy_notice_version, release_id, prompt_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING created_at`,
      [id, input.sessionId, input.responseRequestId, input.rating, input.understood, input.comment, input.consentReference, input.privacyNoticeVersion, context.releaseId, context.promptVersion]
    ); } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new DuplicateFeedbackError();
      throw error;
    }
    const created = result.rows[0]?.created_at;
    if (!created) throw new Error("feedback insert returned no timestamp");
    return { ...input, id, releaseId: context.releaseId, promptVersion: context.promptVersion, createdAt: new Date(created).toISOString() };
  }
}
