import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertProductionEvaluationDataset, parseAgentEvaluationDataset } from "../evaluation/dataset.js";

async function main(): Promise<void> {
  const datasetPath = path.resolve(process.env.AGENT_EVALUATION_DATASET?.trim() || "tests/fixtures/evaluation/agent-eval.synthetic.json");
  const dataset = parseAgentEvaluationDataset(JSON.parse(await readFile(datasetPath, "utf8")));
  const production = process.argv.includes("--production");
  if (production) assertProductionEvaluationDataset(dataset);
  console.log(`agent evaluation dataset valid: cases=${dataset.cases.length}; origin=${dataset.origin}; productionEligible=${dataset.origin === "real_user"}`);
}

await main().catch((error: unknown) => {
  console.error(`agent evaluation dataset invalid: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
