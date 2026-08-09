import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateAdversarialDataset, parseAdversarialDataset } from "../evaluation/adversarial.js";
import { buildIterationEvidence } from "../evaluation/iteration.js";
import { buildSyntheticDemoAgent } from "../runtime/synthetic-demo-agent.js";

const root = resolve(process.cwd());
const input = resolve(root, "tests/fixtures/evaluation/adversarial.synthetic.json");
const reportPath = resolve(root, "data/reports/step16-adversarial.synthetic.json");
const iterationPath = resolve(root, "data/reports/step17-iteration.synthetic.json");
const dataset = parseAdversarialDataset(JSON.parse(await readFile(input, "utf8")) as unknown);
const agent = await buildSyntheticDemoAgent("test");
const report = await evaluateAdversarialDataset(dataset, agent);
if (report.failed > 0) throw new Error(`adversarial evaluation failed: ${JSON.stringify(report.failures)}`);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(iterationPath, `${JSON.stringify(buildIterationEvidence(report), null, 2)}\n`, "utf8");
console.log(`adversarial evaluation: ${report.passed}/${report.caseCount} passed; productionEligible=false`);
