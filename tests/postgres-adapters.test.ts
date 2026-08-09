import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { NUTRIENT_CODES } from "../src/domain/nutrition.js";
import { PostgresNutritionService } from "../src/runtime/postgres-adapters.js";

function poolFor(rows:Record<string,unknown>[]):Pool {
  let call=0;
  return {query:async()=>{call+=1;return call===1?{rows:[{servings:"2",final_cooked_weight_g:"150"}]}:{rows};}} as unknown as Pool;
}

test("PostgreSQL nutrition keeps missing distinct from explicit zero and counts ingredient mass once",async()=>{
  const rows:Record<string,unknown>[]=[];
  for(const [id,quantity] of [["1","100"],["2","50"]]) for(const nutrient of NUTRIENT_CODES) rows.push({id,quantity,verification_status:"approved",mapping_decision:"approved",dimension:"mass",ingredient_unit:"g",factor_to_base:null,conversion_factor:null,
    nutrient,amount:nutrient==="calories"?(id==="1"?"100":null):"0",unit_code:nutrient==="calories"?"kcal":nutrient==="sodium"?"mg":"g",source_key:"SRC",version_label:"V1"});
  const result=await new PostgresNutritionService(poolFor(rows)).calculate("R1",{});
  assert.equal(result.coverage.nutritionCoveredWeightG,150,"join rows must not multiply ingredient weight");
  assert.equal(result.bases.full_recipe.nutrients.calories.amount,null,"one missing ingredient value makes the total unknown");
  assert.equal(result.bases.full_recipe.nutrients.calories.knownSubtotal,100,"known subtotal remains disclosed");
  assert.equal(result.bases.full_recipe.nutrients.protein.amount,0,"two explicit measured zeroes remain a known zero");
  assert.equal(result.coverage.byNutrient.calories.coveredRequiredIngredients,1);
  assert.equal(result.calculationStatus,"partial");
});

test("PostgreSQL nutrition fails closed for null quantity and unapproved ingredients",async()=>{
  const rows=[{id:"1",quantity:null,verification_status:"approved",mapping_decision:"approved",dimension:"mass",ingredient_unit:"g",factor_to_base:null,nutrient:"calories",amount:"10",unit_code:"kcal",source_key:"SRC",version_label:"V1"},
    {id:"2",quantity:"10",verification_status:"needs_review",mapping_decision:"approved",dimension:"mass",ingredient_unit:"g",factor_to_base:null,nutrient:"calories",amount:"10",unit_code:"kcal",source_key:"SRC",version_label:"V1"}];
  const result=await new PostgresNutritionService(poolFor(rows)).calculate("R1",{});
  assert.equal(result.calculationStatus,"unavailable");
  assert.ok(result.blockers.includes("ingredient_1_mass_unavailable"));
  assert.ok(result.blockers.includes("ingredient_2_not_approved"));
  assert.equal(result.bases.full_recipe.nutrients.calories.amount,null);
});
