import assert from "node:assert/strict";
import test from "node:test";
import { apply } from "../lib/index.js";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

function load(config = {}) {
  const tools = new Map(), skills = [];
  apply({ logger() { return { info() {} }; }, tools: { register(tool) { tools.set(tool.name, tool); } }, skills: { register(skill) { skills.push(skill); } } }, config);
  return { tools, skills };
}

test("ask is registered by default and can be disabled", () => {
  assert.ok(load().tools.has("s1_ask"));
  assert.ok(!load({ ask: false }).tools.has("s1_ask"));
  assert.match(load().skills[0].content, /s1_ask/);
});

test("new engines, week, page and result metadata survive the host mapping", async (context) => {
  process.env.S1_KEY = "test-key";
  context.after(() => delete process.env.S1_KEY);
  const { tools } = load();
  const wire = { results: [{ title: "Repo", link: "https://example.com", snippet: "s", published_date: "2026-10-12", metadata: { stars: 0, future: [1, null] } }, { title: "Plain", link: "https://plain.example", snippet: "No extras" }] };
  let body;
  context.mock.method(globalThis, "fetch", async (input, init) => { body = JSON.parse(init.body); return Response.json(wire); });
  for (const searchService of ["bingcn", "yandex", "grokipedia"]) {
    const result = await tools.get("s1_search").execute({ query: "q", searchService, timeRange: "week", page: 2 }, { signal: new AbortController().signal });
    assert.equal(body.search_service, searchService);
    assert.equal(body.time_range, "week");
    assert.equal(body.page, 2);
    assert.deepEqual(result.results[0].metadata, wire.results[0].metadata);
    assert.equal(result.results[0].published_date, "2026-10-12");
    assert.equal(result.results[0].url, wire.results[0].link);
    assert.equal(Object.hasOwn(result.results[0], "stars"), false);
    assert.equal(Object.hasOwn(result.results[1], "metadata"), false);
    assert.deepEqual(validateJsonSchemaValue(tools.get("s1_search").output.schema, result), []);
  }
  await assert.rejects(tools.get("s1_search").execute({ query: "q", searchService: "sogou" }, {}));
});

test("ask only sends query and preserves route, scores, date and errors", async (context) => {
  process.env.S1_KEY = "test-key";
  context.after(() => delete process.env.S1_KEY);
  const { tools } = load();
  const wire = { query: "Bun", intent: { search_query: "Bun", sources: ["github"], time_range: null }, results: [{ title: "Bun", link: "https://example.com", snippet: "s", source: "github", relevance: 0, published_date: "2026-10-12" }], errors: [{ source: "reddit", message: "timeout" }] };
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), "https://api.search1api.com/ask");
    assert.deepEqual(JSON.parse(init.body), { query: "Bun" });
    return Response.json(wire);
  });
  const tool = tools.get("s1_ask");
  const result = await tool.execute({ query: "Bun" }, { signal: new AbortController().signal });
  assert.deepEqual(result.intent, wire.intent);
  assert.equal(result.results[0].source, "github");
  assert.equal(result.results[0].relevance, 0);
  assert.equal(result.results[0].published_date, "2026-10-12");
  assert.deepEqual(result.errors, wire.errors);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result), []);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["query"]);
});
