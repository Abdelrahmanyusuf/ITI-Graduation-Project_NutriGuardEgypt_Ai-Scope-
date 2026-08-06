import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "./config/env.js";

/**
 * Application entry point (Step 0).
 * It only loads and validates environment configuration; no business
 * features are implemented yet. Console output is intentionally minimal
 * and kept free of secrets.
 */
export function main(): void {
  const config = loadConfig();
  console.log(
    `[NutriGuard] Initialized (NODE_ENV=${config.nodeEnv}); serving port reserved as ${config.port}.`
  );
  console.log("[NutriGuard] No business features are implemented in this foundation step.");
}

const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
const moduleFile = resolve(fileURLToPath(import.meta.url));
if (invokedFile === moduleFile) {
  main();
}