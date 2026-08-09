import { createHash } from "node:crypto";
import type { Pool } from "pg";
export interface RetentionRequest { policyVersion:string; retentionDays:number; execute:boolean; authorizedBy?:string; evidenceReference?:string }
export async function enforcePilotFeedbackRetention(pool:Pool, request:RetentionRequest):Promise<{mode:"dry_run"|"approved_execution";affectedRows:number;cutoffAt:string}> {
  if(!request.policyVersion.trim()||!Number.isInteger(request.retentionDays)||request.retentionDays<1) throw new Error("valid retention policy and positive whole retentionDays are required");
  if(request.execute&&(!request.authorizedBy?.trim()||!request.evidenceReference?.trim())) throw new Error("approved execution requires authorization and evidence");
  const cutoff=new Date(Date.now()-request.retentionDays*86_400_000); const client=await pool.connect();
  try { await client.query("BEGIN"); const count=await client.query<{count:string}>("SELECT count(*) FROM pilot_feedback WHERE created_at<$1",[cutoff]); const affected=Number(count.rows[0]?.count??0);
    if(request.execute){ await client.query("SELECT set_config('nutriguard.privacy_erasure','approved',true)"); await client.query("DELETE FROM pilot_feedback WHERE created_at<$1",[cutoff]); }
    const id=`RET-${createHash("sha256").update(`${request.policyVersion}|${cutoff.toISOString()}|${request.execute}|${affected}`).digest("hex").slice(0,16).toUpperCase()}`;
    await client.query("INSERT INTO retention_events(id,policy_version,target_table,cutoff_at,affected_rows,execution_mode,authorized_by,evidence_reference) VALUES($1,$2,'pilot_feedback',$3,$4,$5,$6,$7)",[id,request.policyVersion,cutoff,affected,request.execute?"approved_execution":"dry_run",request.authorizedBy??null,request.evidenceReference??null]); await client.query("COMMIT");
    return {mode:request.execute?"approved_execution":"dry_run",affectedRows:affected,cutoffAt:cutoff.toISOString()};
  } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
}
