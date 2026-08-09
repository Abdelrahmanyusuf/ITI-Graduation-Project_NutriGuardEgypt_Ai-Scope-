import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPendingQueue } from "../review/approvals.js";
const queues=[
  buildPendingQueue("ingredient_mapping","all-pending",{source:"ingredient-resolution-registry"},"nutrition_data_reviewer",["human_review_required"]),
  buildPendingQueue("unit_conversion","all-pending",{source:"unit-conversion-registry"},"nutrition_data_reviewer",["human_review_required"]),
  buildPendingQueue("cooking_factor","all-pending",{source:"cooking-factors"},"nutrition_data_reviewer",["human_review_required"]),
  buildPendingQueue("retention_factor","all-pending",{source:"nutrient-retention-factors"},"nutrition_data_reviewer",["human_review_required"]),
  buildPendingQueue("nutrient_profile","all-pending",{source:"nutrient-profiles"},"nutrition_reviewer",["human_review_required"]),
  buildPendingQueue("recipe_serving_yield","all-pending",{source:"verified-recipe-registry"},"nutrition_reviewer",["human_review_required"]),
  buildPendingQueue("source_license","all-pending",{source:"source-manifest"},"data_owner",["license_approval_required"]),
  buildPendingQueue("cultural_evidence","all-pending",{scope:"Egyptian food evidence"},"egyptian_cultural_reviewer",["human_review_required"]),
  buildPendingQueue("safety_qa","release-pending",{suite:"adversarial-and-comprehension"},"safety_qa_reviewer",["real_user_evidence_required"]),
];
const packet={schemaVersion:"1.0",status:"pending_human_review",synthetic:false,generatedAt:null,checks:["medical wording","emergency routing","numeric provenance","Arabic comprehension","prompt injection","unknown-data refusal"],requiredEvidence:["named reviewer","review date","content SHA-256","signed decision","test results"],approval:null};
await mkdir(resolve("data/reports"),{recursive:true});
await writeFile(resolve("data/reports/review-work-queues.json"),`${JSON.stringify({schemaVersion:"1.0",status:"pending",items:queues},null,2)}\n`);
const sha=createHash("sha256").update(JSON.stringify(packet)).digest("hex");
await writeFile(resolve("data/reports/safety-qa-packet.pending.json"),`${JSON.stringify({...packet,contentSha256:sha},null,2)}\n`);
console.log(`generated ${queues.length} pending queues and one pending Safety/QA packet`);
