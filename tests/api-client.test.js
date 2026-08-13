import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadApiClient(mockFetch) {
  const window = { dispatchEvent() {} };
  const context = vm.createContext({
    window, fetch: mockFetch, CustomEvent, performance, URLSearchParams, Object, Array, JSON, Error, AbortSignal,
  });
  vm.runInContext(fs.readFileSync("public/api-client.js", "utf8"), context, { filename: "public/api-client.js" });
  return window.WeatherDataApi;
}

test("direct client throws on a non-JSON 200 response instead of returning it silently", async () => {
  const mockFetch = async () => new Response("<html>error page</html>", { status: 200 });
  const api = loadApiClient(mockFetch);
  const dataApi = api.create({ mode: "direct" });
  await assert.rejects(() => dataApi("eonet", "/api/v3/events", {}), /non-JSON/);
});

test("a raw-text request is not treated as an error", async () => {
  const mockFetch = async () => new Response("plain text body", { status: 200 });
  const api = loadApiClient(mockFetch);
  const dataApi = api.create({ mode: "direct" });
  const result = await dataApi("eonet", "/api/v3/events", {}, { text: true });
  assert.equal(result.raw, "plain text body");
});

test("a well-formed JSON response still parses normally", async () => {
  const mockFetch = async () => new Response(JSON.stringify({ features: [1, 2, 3] }), { status: 200 });
  const api = loadApiClient(mockFetch);
  const dataApi = api.create({ mode: "direct" });
  const result = await dataApi("eonet", "/api/v3/events", {});
  assert.deepEqual(result.features, [1, 2, 3]);
});

test("proxy client throws when the worker's raw-fallback envelope wraps an unexpected non-JSON upstream body", async () => {
  const mockFetch = async () => new Response(JSON.stringify({ raw: "<html>gateway error</html>" }), { status: 200 });
  const api = loadApiClient(mockFetch);
  const dataApi = api.create({ mode: "proxy" });
  await assert.rejects(() => dataApi("earthquake", "/fdsnws/event/1/query", {}), /non-JSON/);
});

test("a direct empty 204 body is treated as a valid empty result, not an error", async () => {
  // aviationweather.gov's METAR endpoint returns 204 with an empty body
  // when a bbox query matches zero stations — a real "no results", not a
  // malformed response.
  const mockFetch = async () => new Response(null, { status: 204 });
  const api = loadApiClient(mockFetch);
  const dataApi = api.create({ mode: "direct" });
  const result = await dataApi("eonet", "/api/v3/events", {});
  assert.equal(result.raw, "");
});

test("a proxied empty raw-fallback envelope is treated as a valid empty result, not an error", async () => {
  const mockFetch = async () => new Response(JSON.stringify({ raw: "" }), { status: 200 });
  const api = loadApiClient(mockFetch);
  const dataApi = api.create({ mode: "proxy" });
  const result = await dataApi("aviation", "/api/data/metar", {});
  assert.equal(result.raw, "");
});
