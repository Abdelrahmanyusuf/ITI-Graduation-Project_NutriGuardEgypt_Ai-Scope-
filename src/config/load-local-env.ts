import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

/** Load a developer-owned, gitignored .env file when present. */
export function loadLocalEnv(path = ".env"): void {
  if (process.env.NODE_ENV === "production" || !existsSync(path)) return;
  loadEnvFile(path);
}
