import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Non-blocking smoke test for the development entry point.
 *
 * It spawns the actual development command (`tsx watch src/index.ts`) through
 * the tsx CLI, waits until the boot message appears on stdout, then terminates
 * the process. This proves the dev command boots without ever blocking the
 * test run (the watch loop is killed as soon as startup is confirmed).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = resolve(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function bootDevProcess(timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [TSX_CLI, "watch", "src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "test", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        rejectPromise(
          new Error(`dev process did not boot within ${timeoutMs}ms. Output:\n${output}`)
        );
      }
    }, timeoutMs);

    const finish = (err: Error | null, value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) rejectPromise(err);
      else resolvePromise(value);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("[NutriGuard] Initialized")) {
        finish(null, output);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(err, output));
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`dev process exited before boot (code=${code}). Output:\n${output}`), output);
      }
    });
  });
}

test("dev command boots and prints the startup line (watch is terminated after boot)", async () => {
  const output = await bootDevProcess(30_000);
  assert.match(output, /\[NutriGuard\] Initialized \(NODE_ENV=test\)/);
  assert.ok(!output.includes("ERR_MODULE_NOT_FOUND"), `dev command failed to resolve modules:\n${output}`);
});