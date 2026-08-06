import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "docs-link-check.mjs");

function runCheck(dir: string) {
  return execFileAsync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
}

async function expectFailed(dir: string, snippet: string) {
  await assert.rejects(runCheck(dir), (err) => {
    const e = err as { stdout?: unknown; stderr?: unknown };
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    assert.ok(out.includes(snippet), `expected '${snippet}' in output but got:\n${out}`);
    return true;
  });
}

test("docs:check passes on a valid fixture (files, anchors, external links)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doccheck-ok-"));
  try {
    writeFileSync(
      join(dir, "a.md"),
      "# Title A\n\n## Section One\n\n[good](./b.md)\n[anchor](./a.md#section-one)\n[ext](https://example.com/x)\n"
    );
    writeFileSync(join(dir, "b.md"), "# Title B\n");
    const { stdout } = await runCheck(dir);
    assert.match(stdout, /docs:check OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs:check fails when a referenced local file does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doccheck-missing-file-"));
  try {
    writeFileSync(join(dir, "a.md"), "# A\n\n[missing](./nope.md)\n");
    await expectFailed(dir, "missing target file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs:check fails when a referenced heading anchor does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doccheck-missing-anchor-"));
  try {
    writeFileSync(join(dir, "a.md"), "# A\n\n[bad](./a.md#does-not-exist)\n");
    await expectFailed(dir, "missing heading anchor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs:check fails on malformed double-hash anchors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doccheck-double-hash-"));
  try {
    writeFileSync(join(dir, "a.md"), "# A\n\n[bad](./a.md##-section)\n");
    await expectFailed(dir, "malformed anchor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs:check fails on a broken local link in README.md", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doccheck-readme-"));
  try {
    writeFileSync(join(dir, "README.md"), "# R\n\n[broken](./nope.md)\n");
    await expectFailed(join(dir, "README.md"), "missing target file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs:check default run (docs/ + README.md) passes", async () => {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.match(stdout, /docs:check OK/);
});