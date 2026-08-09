import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateReleaseReadiness, type ReleaseTarget } from "../release/readiness.js";

const target = process.argv[2] as ReleaseTarget | undefined;
if (target !== "staging" && target !== "production") throw new Error("usage: check-release-readiness.ts staging|production");
const manifestPath = process.env.NUTRIGUARD_RELEASE_EVIDENCE;
if (!manifestPath) {
  console.error("release blocked: NUTRIGUARD_RELEASE_EVIDENCE is not set");
  process.exit(1);
} else {
  try {
    const value = JSON.parse(await readFile(resolve(manifestPath), "utf8")) as unknown;
    const result = evaluateReleaseReadiness(value, target);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ready ? 0 : 1);
  } catch (error) {
    console.error(`release blocked: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
