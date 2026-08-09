import type { Pool } from "pg";
import type { AlternativeRuleRepository, ApprovedAlternativeRule } from "../agent/expanded-agent.js";
import { NUTRIENT_CODES, type NutrientCode, type RecipeNutritionResult, type ServingRequest } from "../domain/nutrition.js";
import type { GuidelineRule, GuidelineRuleRepository } from "../tools/nutriguard-tools.js";

export class PostgresGuidelineRuleRepository implements GuidelineRuleRepository {
  public constructor(private readonly pool: Pool) {}
  public async listByMetric(metric: NutrientCode): Promise<GuidelineRule[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT gr.id, gd.document_key, gc.id AS chunk_id, gr.metric, gr.operator, gr.value,
        gr.unit, gr.population, s.source_key, dv.version_label, s.title, s.url, s.access_date,
        COALESCE(gc.section, gc.page::text, gc.topic) AS locator
      FROM guideline_rules gr JOIN guideline_documents gd ON gd.id=gr.document_id
      JOIN guideline_chunks gc ON gc.id=gr.chunk_id JOIN sources s ON s.id=gr.source_id
      JOIN data_versions dv ON dv.id=gr.data_version_id AND dv.source_id=gr.source_id
      WHERE gr.metric=$1 AND gr.status='active' AND gd.source_status='active'
        AND s.review_status='approved' AND s.license_review_status='approved'
        AND (SELECT decision FROM approval_records WHERE subject_type='guideline' AND subject_key=gd.document_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved'
        AND (SELECT decision FROM approval_records WHERE subject_type='source_license' AND subject_key=s.source_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved'`, [metric]);
    return result.rows.flatMap((row) => {
      const op = row.operator === "<" || row.operator === "<=" ? "maximum" : row.operator === ">" || row.operator === ">=" ? "minimum" : "target";
      const unit = row.unit;
      if (unit !== "kcal" && unit !== "g" && unit !== "mg") return [];
      const value = Number(row.value); if (!Number.isFinite(value) || value < 0) return [];
      return [{ id: String(row.id), documentId: String(row.document_key), chunkId: String(row.chunk_id), metric,
        operator: op, minimum: op === "minimum" ? value : null, maximum: op === "maximum" ? value : null,
        target: op === "target" ? value : null, unit, basis: "per_day", population: String(row.population ?? "general_adult"),
        status: "approved", licenseStatus: "approved", sourceId: String(row.source_key), versionId: String(row.version_label),
        sourceTitle: String(row.title ?? ""), sourceUrl: String(row.url ?? ""), sourceAccessedAt: row.access_date instanceof Date ? row.access_date.toISOString().slice(0,10) : String(row.access_date ?? ""), sourceLocator: String(row.locator ?? "") } satisfies GuidelineRule];
    });
  }
}

export class PostgresAlternativeRuleRepository implements AlternativeRuleRepository {
  public constructor(private readonly pool: Pool) {}
  public async listForRecipe(recipeId: string): Promise<ApprovedAlternativeRule[]> {
    const result = await this.pool.query<Record<string, unknown>>(`SELECT ar.rule_key, fr.recipe_key from_key, cr.recipe_key candidate_key,
      ar.candidate_query, ar.target_nutrient, ar.basis, s.source_key, dv.version_label, s.title, s.url
      FROM recipe_alternative_rules ar JOIN recipes fr ON fr.id=ar.from_recipe_id JOIN recipes cr ON cr.id=ar.candidate_recipe_id
      JOIN sources s ON s.id=ar.source_id JOIN data_versions dv ON dv.id=ar.data_version_id AND dv.source_id=ar.source_id
      WHERE fr.recipe_key=$1 AND ar.status='approved' AND fr.verification_status='verified' AND cr.verification_status='verified'
        AND s.review_status='approved' AND s.license_review_status='approved'
        AND (SELECT decision FROM approval_records WHERE subject_type='recipe' AND subject_key=fr.recipe_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved'
        AND (SELECT decision FROM approval_records WHERE subject_type='recipe' AND subject_key=cr.recipe_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved'
        AND (SELECT decision FROM approval_records WHERE subject_type='source_license' AND subject_key=s.source_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved'`, [recipeId]);
    return result.rows.map((row) => ({ id: String(row.rule_key), fromRecipeId: String(row.from_key), candidateRecipeId: String(row.candidate_key),
      candidateQuery: String(row.candidate_query), targetNutrient: row.target_nutrient as ApprovedAlternativeRule["targetNutrient"],
      basis: row.basis as ApprovedAlternativeRule["basis"], status: "approved", licenseStatus: "approved",
      sourceId: String(row.source_key), versionId: String(row.version_label), sourceTitle: String(row.title ?? ""), sourceUrl: String(row.url ?? "") }));
  }
}

const META: Record<NutrientCode, { unit: "kcal" | "g" | "mg"; decimals: number }> = {
  calories:{unit:"kcal",decimals:0}, protein:{unit:"g",decimals:1}, carbohydrate:{unit:"g",decimals:1}, total_fat:{unit:"g",decimals:1},
  saturated_fat:{unit:"g",decimals:1}, fiber:{unit:"g",decimals:1}, sugar:{unit:"g",decimals:1}, sodium:{unit:"mg",decimals:0},
};

export class PostgresNutritionService {
  public constructor(private readonly pool: Pool) {}
  public async calculate(recipeId: string, request: ServingRequest): Promise<RecipeNutritionResult> {
    const recipe = await this.pool.query<{ servings:string|null; final_cooked_weight_g:string|null }>(`SELECT r.servings, r.final_cooked_weight_g FROM recipes r
      JOIN sources rs ON rs.id=r.source_id JOIN data_versions rdv ON rdv.id=r.data_version_id AND rdv.source_id=r.source_id
      WHERE r.recipe_key=$1 AND r.verification_status='verified' AND rs.review_status='approved' AND rs.license_review_status='approved'
        AND (SELECT decision FROM approval_records WHERE subject_type='recipe' AND subject_key=r.recipe_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved'
        AND (SELECT decision FROM approval_records WHERE subject_type='source_license' AND subject_key=rs.source_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved'
        AND ((r.servings IS NULL AND r.final_cooked_weight_g IS NULL) OR
          (SELECT decision FROM approval_records WHERE subject_type='recipe_serving_yield' AND subject_key='recipe_serving_yield:'||r.recipe_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved')
        AND EXISTS(SELECT 1 FROM recipe_cultural_evidence rce JOIN cultural_evidence_records ce ON ce.id=rce.cultural_evidence_id
          WHERE rce.recipe_id=r.id AND ce.status='approved' AND
            (SELECT decision FROM approval_records WHERE subject_type='cultural_evidence' AND subject_key=ce.evidence_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved')`, [recipeId]);
    const row = recipe.rows[0];
    const requested = [...new Set(["full_recipe", ...(request.bases ?? ["per_serving", "per_100g"])])] as RecipeNutritionResult["requestedBases"];
    const values = Object.fromEntries(NUTRIENT_CODES.map((code) => [code, 0])) as Record<NutrientCode, number>;
    const covered = Object.fromEntries(NUTRIENT_CODES.map((code) => [code, new Set<string>()])) as Record<NutrientCode, Set<string>>;
    const blockers: string[] = [];
    if (!row) blockers.push("recipe_not_verified_or_not_found");
    const ingredients = row ? await this.pool.query<Record<string, unknown>>(`SELECT ri.id, ri.quantity, i.verification_status,
      (SELECT decision FROM approval_records WHERE subject_type='ingredient_mapping' AND subject_key=i.ingredient_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1) AS mapping_decision,
      u.dimension, u.unit_code AS ingredient_unit, u.factor_to_base, iuc.factor AS conversion_factor,
      cs.source_key AS conversion_source_key, cdv.version_label AS conversion_version_label,
      nv.nutrient, nv.amount, nu.unit_code, s.source_key, dv.version_label
      FROM recipe_ingredients ri JOIN ingredients i ON i.id=ri.ingredient_id JOIN units u ON u.id=ri.unit_id
      LEFT JOIN units gu ON gu.unit_code='g'
      LEFT JOIN ingredient_unit_conversions iuc ON iuc.ingredient_id=i.id AND iuc.from_unit_id=ri.unit_id AND iuc.to_unit_id=gu.id AND iuc.food_state IS NOT DISTINCT FROM ri.food_state
        AND (SELECT decision FROM approval_records WHERE subject_type='unit_conversion' AND subject_key='unit_conversion:'||iuc.id::text ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved'
      LEFT JOIN sources cs ON cs.id=iuc.source_id AND cs.review_status='approved' AND cs.license_review_status='approved'
        AND (SELECT decision FROM approval_records WHERE subject_type='source_license' AND subject_key=cs.source_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved'
      LEFT JOIN data_versions cdv ON cdv.id=iuc.data_version_id AND cdv.source_id=iuc.source_id
      LEFT JOIN LATERAL (SELECT DISTINCT ON (candidate.nutrient) candidate.* FROM nutrient_values candidate WHERE candidate.ingredient_id=i.id
        AND candidate.basis IN ('per_100g','per_edible_100g') AND candidate.food_state IS NOT DISTINCT FROM ri.food_state
        AND (SELECT decision FROM approval_records WHERE subject_type='nutrient_profile' AND subject_key='nutrient_profile:'||i.ingredient_key||':'||COALESCE(candidate.food_state,'unspecified') ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved'
        AND EXISTS(SELECT 1 FROM sources ns WHERE ns.id=candidate.source_id AND ns.review_status='approved' AND ns.license_review_status='approved'
          AND (SELECT decision FROM approval_records WHERE subject_type='source_license' AND subject_key=ns.source_key ORDER BY reviewed_at DESC,created_at DESC LIMIT 1)='approved')
        ORDER BY candidate.nutrient, (candidate.basis='per_100g') DESC) nv ON true
      LEFT JOIN units nu ON nu.id=nv.unit_id LEFT JOIN sources s ON s.id=nv.source_id AND s.review_status='approved' AND s.license_review_status='approved'
      LEFT JOIN data_versions dv ON dv.id=nv.data_version_id AND dv.source_id=nv.source_id
      WHERE ri.recipe_id=(SELECT id FROM recipes WHERE recipe_key=$1) ORDER BY ri.id`, [recipeId]) : { rows: [] };
    const ingredientIds = new Set<string>(); const massByIngredient = new Map<string, number>(); const profileIngredients = new Set<string>();
    const provenance = new Map<string, {sourceId:string;versionId:string;roles:string[]}>();
    for (const item of ingredients.rows) {
      const id=String(item.id); ingredientIds.add(id);
      if (item.verification_status !== "approved" || item.mapping_decision !== "approved") { blockers.push(`ingredient_${id}_not_approved`); continue; }
      const quantity=item.quantity === null || item.quantity === undefined ? null : Number(item.quantity);
      let factor: number | null = null;
      if (item.dimension === "mass") factor = item.ingredient_unit === "g" ? 1 : item.factor_to_base === null || item.factor_to_base === undefined ? null : Number(item.factor_to_base);
      else if (item.conversion_source_key && item.conversion_version_label && item.conversion_factor !== null && item.conversion_factor !== undefined) factor=Number(item.conversion_factor);
      if (quantity === null || !Number.isFinite(quantity) || quantity < 0 || factor === null || !Number.isFinite(factor) || factor <= 0) { blockers.push(`ingredient_${id}_mass_unavailable`); continue; }
      const mass=quantity*factor; massByIngredient.set(id,mass);
      if (item.conversion_source_key && item.conversion_version_label) provenance.set(`${item.conversion_source_key}|${item.conversion_version_label}`,{sourceId:String(item.conversion_source_key),versionId:String(item.conversion_version_label),roles:["conversion"]});
      const nutrient = item.nutrient as NutrientCode;
      const amount=item.amount === null || item.amount === undefined ? null : Number(item.amount);
      if (!NUTRIENT_CODES.includes(nutrient) || amount === null || !Number.isFinite(amount) || amount < 0 || !item.source_key || !item.version_label || item.unit_code !== META[nutrient].unit) continue;
      values[nutrient] += amount * mass / 100; covered[nutrient].add(id); profileIngredients.add(id);
      provenance.set(`${item.source_key}|${item.version_label}`, {sourceId:String(item.source_key),versionId:String(item.version_label),roles:["nutrition"]});
    }
    if (row && ingredientIds.size === 0) blockers.push("verified_recipe_has_no_approved_ingredients");
    const servings = request.servingCount ?? (row?.servings ? Number(row.servings) : null);
    const weight = request.finalFoodWeightG ?? (row?.final_cooked_weight_g ? Number(row.final_cooked_weight_g) : null);
    const known = Object.fromEntries(NUTRIENT_CODES.map((code) => [code, ingredientIds.size>0 && covered[code].size===ingredientIds.size])) as Record<NutrientCode, boolean>;
    const output = (divisor:number|null) => Object.fromEntries(NUTRIENT_CODES.map((code) => [code, {amount: known[code] && divisor ? values[code]/divisor : null, knownSubtotal: divisor ? values[code]/divisor : values[code], ...META[code]}])) as RecipeNutritionResult["bases"]["full_recipe"]["nutrients"];
    const basis = (name:"full_recipe"|"per_serving"|"per_100g", divisor:number|null, basisWeight:number|null) => ({basis:name,basisStatus:divisor ? "available" as const:"unavailable" as const,reason:divisor?null:`${name}_basis_unavailable`,divisor,weightG:basisWeight,nutrients:output(divisor)});
    const total = ingredientIds.size, calc=massByIngredient.size;
    return { recipeId, calculationStatus: blockers.length || !NUTRIENT_CODES.every((code)=>known[code]) ? (calc ? "partial" : "unavailable") : "complete", requestedBases:requested,
      servingCount:Number.isFinite(servings) && (servings??0)>0 ? servings:null, finalFoodWeightG:Number.isFinite(weight)&&(weight??0)>0?weight:null,
      servingWeightG: servings&&weight ? weight/servings:null, bases:{full_recipe:basis("full_recipe",row?1:null,weight),per_serving:basis("per_serving",servings&&servings>0?servings:null,servings&&weight?weight/servings:null),per_100g:basis("per_100g",weight&&weight>0?weight/100:null,100)},
      missingIngredients:[], assumptions:[], coverage:{ingredientCount:total,requiredIngredientCount:total,resolvedIngredientCount:total,gramConvertedIngredientCount:calc,nutritionProfileIngredientCount:profileIngredients.size,calculableIngredientCount:profileIngredients.size,resolutionRate:total?1:null,gramConversionRate:total?calc/total:null,nutritionProfileRate:total?profileIngredients.size/total:null,knownFinalWeightG:weight??0,nutritionCoveredWeightG:[...profileIngredients].reduce((sum,id)=>sum+(massByIngredient.get(id)??0),0),weightCoverageRate:weight&&weight>0?Math.min(1,[...profileIngredients].reduce((sum,id)=>sum+(massByIngredient.get(id)??0),0)/weight):null,weightDenominatorComplete:massByIngredient.size===total,byNutrient:Object.fromEntries(NUTRIENT_CODES.map((code)=>[code,{coveredRequiredIngredients:covered[code].size,requiredIngredients:total,rate:total?covered[code].size/total:null}])) as RecipeNutritionResult["coverage"]["byNutrient"]},
      provenance:[...provenance.values()],trace:[],blockers:[...new Set(blockers)],roundingPolicy:Object.fromEntries(NUTRIENT_CODES.map((code)=>[code,{...META[code],stage:"output_only" as const}])) as RecipeNutritionResult["roundingPolicy"] };
  }
}
