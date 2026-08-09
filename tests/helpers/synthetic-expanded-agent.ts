import { buildSyntheticDemoAgent } from "../../src/runtime/synthetic-demo-agent.js";

export async function buildSyntheticExpandedAgent() {
  return buildSyntheticDemoAgent("test");
}
