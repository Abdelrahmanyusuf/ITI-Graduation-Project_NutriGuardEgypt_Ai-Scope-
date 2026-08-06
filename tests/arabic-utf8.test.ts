import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

/**
 * Prove that Arabic in the project's executable sources is valid,
 * readable UTF-8: it decodes strictly with no Unicode replacement
 * characters and the Egyptian-Arabic phrases are intact.
 */

const REPLACEMENT_CHAR = "\uFFFD";

function strictUtf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

test("Arabic literal round-trips through UTF-8 without corruption", () => {
  const arabic = "أنا باكل خضار وفاكهة كتير";
  const encoded = new TextEncoder().encode(JSON.parse(JSON.stringify(arabic)));
  const decoded = strictUtf8Decode(encoded);
  assert.equal(decoded, arabic);
  assert.ok(!decoded.includes(REPLACEMENT_CHAR));
});

test("archived agent holds valid, readable Arabic with no mojibake", () => {
  const text = strictUtf8Decode(
    readFileSync(resolve("legacy/NutriGuard_Agent.js"))
  );

  assert.ok(!text.includes(REPLACEMENT_CHAR), "file must not contain U+FFFD");

  // Core Egyptian-Arabic system prompt and integrity rule must be intact.
  assert.ok(text.includes("مساعد صحي مصري"), "missing system-prompt phrase");
  assert.ok(text.includes("لا تخترع أي أرقام"), "missing number-integrity rule");
  assert.ok(text.includes("أنا باكل خضار وفاكهة كتير"), "missing sample user message");
  assert.ok(text.includes("جاري تحميل أدوات"), "missing loading message");
});

test("all archived .js executable sources decode as valid, readable UTF-8", () => {
  const sources = [
    "legacy/NutriGuard_Agent.js",
    "legacy/Guidelines_Rag.js",
    "legacy/clean_data.js",
    "legacy/Clean_WHO Guidelines.js",
    "legacy/merge_guidelines.js",
  ];
  for (const rel of sources) {
    const text = strictUtf8Decode(readFileSync(resolve(rel)));
    assert.ok(
      !text.includes(REPLACEMENT_CHAR),
      `${rel} contains the Unicode replacement character (corrupted UTF-8)`
    );
  }
});