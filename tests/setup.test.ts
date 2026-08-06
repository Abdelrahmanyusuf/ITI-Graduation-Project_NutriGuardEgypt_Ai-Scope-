import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateEnv } from "../src/config/env.js";
import { main } from "../src/index.js";

test("TypeScript module pipeline: config/env.ts compiles and exports", () => {
  assert.equal(typeof validateEnv, "function");
});

test("validateEnv accepts a valid development configuration", () => {
  const result = validateEnv({ NODE_ENV: "development", PORT: "8080" });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.nodeEnv, "development");
  assert.equal(result.value.port, 8080);
});

test("validateEnv accepts production without any OpenRouter key", () => {
  const result = validateEnv({ NODE_ENV: "production", PORT: "443" });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.nodeEnv, "production");
});

test("validateEnv rejects an unknown NODE_ENV", () => {
  const result = validateEnv({ NODE_ENV: "staging", PORT: "3000" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => e.includes("NODE_ENV")),
    `expected a NODE_ENV error, got: ${result.errors.join(" | ")}`
  );
});

test("validateEnv accepts PORT boundary values 1 and 65535", () => {
  for (const port of ["1", "65535"]) {
    const result = validateEnv({ NODE_ENV: "development", PORT: port });
    assert.equal(result.ok, true, `PORT ${port} should pass`);
    if (result.ok) assert.equal(result.value.port, Number(port));
  }
});

const INVALID_PORTS = [
  "0", // below range
  "65536", // above range
  "3000abc", // trailing letters (parseInt would otherwise accept)
  "1.5", // decimal
  "   ", // whitespace only
  "", // empty
  "-80", // negative / signed
  "3e3", // scientific notation
];

for (const bad of INVALID_PORTS) {
  test(`validateEnv rejects invalid PORT '${bad}'`, () => {
    const result = validateEnv({ NODE_ENV: "development", PORT: bad });
    assert.equal(result.ok, false, `PORT '${bad}' must be rejected`);
    if (!result.ok) {
      assert.ok(
        result.errors.some((e) => e.includes("PORT")),
        `expected a PORT error, got: ${result.errors.join(" | ")}`
      );
    }
  });
}

test("application entry point can be imported without side effects", async () => {
  const spy = console.log;
  const calls: unknown[][] = [];
  try {
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    main();
  } finally {
    console.log = spy;
  }
  assert.ok(calls.length >= 1, "main() should print a startup line");
});