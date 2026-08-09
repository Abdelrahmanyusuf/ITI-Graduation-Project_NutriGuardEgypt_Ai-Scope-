import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "./config/env.js";

export {
  calculateRecipeNutrition,
  InMemoryNutritionCalculationRepository,
  JsonNutritionCalculationRepository,
  NutritionCalculator,
  parseNutritionRegistry,
  type RecipeNutritionResult,
  type ServingRequest,
} from "./domain/nutrition.js";

/**
 * Application entry point. It validates environment configuration and exposes
 * deterministic domain operations as module exports. No HTTP server starts in
 * this foundation entry point. Console output stays minimal and secret-free.
 */
export function main(): void {
  const config = loadConfig();
  console.log(
    `[NutriGuard] Initialized (NODE_ENV=${config.nodeEnv}); serving port reserved as ${config.port}.`
  );
  console.log("[NutriGuard] Deterministic domain operations loaded; HTTP serving is not implemented.");
}

const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
const moduleFile = resolve(fileURLToPath(import.meta.url));
if (invokedFile === moduleFile) {
  main();
}
