import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAgentEvaluationDataset } from "../src/evaluation/dataset.js";
import { evaluateAgentDataset } from "../src/evaluation/evaluate.js";
import { buildSyntheticExpandedAgent } from "./helpers/synthetic-expanded-agent.js";

test("Steps 14–15 run the real expanded Agent across all 60 synthetic Egyptian-Arabic questions", async () => {
  const dataset = parseAgentEvaluationDataset(JSON.parse(await readFile("tests/fixtures/evaluation/agent-eval.synthetic.json", "utf8")));
  const agent = await buildSyntheticExpandedAgent();
  const report = await evaluateAgentDataset(dataset, agent);
  assert.equal(report.caseCount, 60);
  assert.equal(report.datasetOrigin, "synthetic");
  assert.equal(report.productionEligible, false);
  assert.equal(report.wording.humanReviewStatus, "pending");
  assert.ok(report.retrieval.recall !== null);
  assert.ok(report.numeric.exactAccuracy !== null);
  assert.ok(report.wording.automatedSafetyAndDialectPassRate !== null);
  assert.equal(report.failures.length, 0, JSON.stringify(report.failures, null, 2));
});
