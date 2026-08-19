import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeClientFromEnv,
  OpenRouterClaudeClient,
  type ClaudeToolDefinition,
} from "../src/llm/claude-client.js";

const tool: ClaudeToolDefinition = {
  name: "classify_request",
  description: "Classify the request",
  inputSchema: {
    type: "object",
    properties: { intent: { type: "string" } },
    required: ["intent"],
  },
};

test("OpenRouter client sends Chat Completions auth, attribution and forced function tool", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify({ intent: "find_recipe" }) },
          }],
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new OpenRouterClaudeClient({
    apiKey: "openrouter-test-key",
    model: "anthropic/claude-sonnet-4",
    siteUrl: "https://nutriguard.example",
    appName: "NutriGuard",
    fetchImpl,
  });

  const result = await client.callStructured({ system: "system prompt", userContent: "user prompt", tool });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, { intent: "find_recipe" });
  assert.equal(capturedUrl, "https://openrouter.ai/api/v1/chat/completions");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer openrouter-test-key");
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("anthropic-version"), null);
  assert.equal(headers.get("http-referer"), "https://nutriguard.example");
  assert.equal(headers.get("x-title"), "NutriGuard");
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, "anthropic/claude-sonnet-4");
  assert.deepEqual(body.messages, [
    { role: "system", content: "system prompt" },
    { role: "user", content: "user prompt" },
  ]);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: tool.name } });
  assert.deepEqual(body.tools, [{
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }]);
});

test("OpenRouter client extracts text from a Chat Completions response", async () => {
  const client = new OpenRouterClaudeClient({
    apiKey: "key",
    model: "anthropic/claude-sonnet-4",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: "  صياغة مؤكدة  " } }],
    }), { status: 200 }),
  });

  const result = await client.callText({ system: "system", userContent: "user" });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, "صياغة مؤكدة");
});

test("OpenRouter client rejects malformed function arguments", async () => {
  const client = new OpenRouterClaudeClient({
    apiKey: "key",
    model: "anthropic/claude-sonnet-4",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ type: "function", function: { name: tool.name, arguments: "not-json" } }] } }],
    }), { status: 200 }),
  });

  const result = await client.callStructured({ system: "system", userContent: "user", tool });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "malformed_response");
  assert.equal(result.ok === false && result.detail, "tool_arguments_are_not_json");
});

test("claudeClientFromEnv requires OpenRouter credentials", () => {
  assert.equal(claudeClientFromEnv("model", 1_000, {}), null);
  assert.equal(claudeClientFromEnv(null, 1_000, { OPENROUTER_API_KEY: "key" }), null);
  const client = claudeClientFromEnv("anthropic/claude-sonnet-4", 1_000, {
    OPENROUTER_API_KEY: "key",
    OPENROUTER_BASE_URL: "https://router.example/v1/",
    OPENROUTER_SITE_URL: "https://nutriguard.example",
    OPENROUTER_APP_NAME: "NutriGuard",
  });
  assert.ok(client instanceof OpenRouterClaudeClient);
  assert.equal(client.model, "anthropic/claude-sonnet-4");
});
