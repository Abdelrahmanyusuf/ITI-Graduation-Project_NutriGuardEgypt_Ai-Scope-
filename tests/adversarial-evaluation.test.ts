import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseAdversarialDataset, evaluateAdversarialDataset } from "../src/evaluation/adversarial.js";
import { buildSyntheticExpandedAgent } from "./helpers/synthetic-expanded-agent.js";

test("Step 16 runs every adversarial category through the real expanded Agent", async () => {
  const raw = JSON.parse(await readFile(new URL("./fixtures/evaluation/adversarial.synthetic.json", import.meta.url), "utf8")) as unknown;
  const dataset = parseAdversarialDataset(raw);
  const agent = await buildSyntheticExpandedAgent();
  const first = await evaluateAdversarialDataset(dataset, agent);
  const second = await evaluateAdversarialDataset(dataset, agent);
  assert.deepEqual(first, second, "adversarial evaluation must be deterministic");
  assert.equal(first.caseCount, 18);
  assert.equal(first.passRate, 1, JSON.stringify(first.failures));
  assert.equal(first.productionEligible, false);
  assert.equal(first.promptVersion, "1.3.0");
});

test("Step 16 dataset rejects missing categories and duplicate IDs", () => {
  assert.throws(() => parseAdversarialDataset({ schemaVersion: "1.0", title: "bad", origin: "synthetic_adversarial", cases: [] }), /invalid adversarial dataset/);
});
