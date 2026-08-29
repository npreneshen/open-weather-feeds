import assert from "node:assert/strict";
import test from "node:test";

import {
  airNowItems, currentsTopicCandidates, currentsKeywords, buildUpstreamUrl, currentsNewsItems, eumetsatTile, firmsItems, gdeltNewsItems,
  keyedFeed, parseBbox, searchNews, SOURCES, thinFirmsItems,
} from "../worker/index.js";
import worker from "../worker/index.js";

test("legacy global dashboard routes redirect to the unified dashboard", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/global-cors/?source=bookmark"),
    { ASSETS: { fetch: () => { throw new Error("assets should not be called"); } } },
  );
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://example.test/?source=bookmark");
});

test("worker exposes current and newly integrated services", () => {
  for (const service of [
    "waterservices", "earthquake", "nhc", "ndbc", "aviation",
    "openmeteo", "openmeteoAq", "openmeteoEnsemble", "eonet", "metno",
    "geomet", "gdacs", "coops", "nominatim",
  ]) {
    assert.ok(SOURCES[service], `missing ${service}`);
  }
});

test("reverse geocoding is allow-listed with a long cache and identifying header", () => {
  const { url, source } = buildUpstreamUrl("nominatim", "/reverse", {
    format: "jsonv2", lat: -29.8587, lon: 31.0218,
  });
  assert.match(url, /nominatim\.openstreetmap\.org\/reverse/);
  assert.ok(source.ttl >= 86400);
  assert.match(source.userAgent, /MetisWeatherFeeds/);
});

test("NASA EONET uses its accepted provider-specific User-Agent", () => {
  assert.match(SOURCES.eonet.userAgent, /EarthDataDashboard/);
  assert.doesNotMatch(SOURCES.eonet.userAgent, /MetisWeatherFeeds/);
});

test("worker URL builder encodes repeated parameters", () => {
  const { url } = buildUpstreamUrl("openmeteo", "/v1/forecast", {
    latitude: -26.2,
    hourly: ["temperature_2m", "precipitation"],
  });
  assert.equal(
    url,
    "https://api.open-meteo.com/v1/forecast?latitude=-26.2&hourly=temperature_2m&hourly=precipitation",
  );
});

test("worker rejects unknown services and scheme-relative paths", () => {
  assert.throws(() => buildUpstreamUrl("unknown", "/", {}), /Unknown service/);
  assert.throws(() => buildUpstreamUrl("nws", "//example.com", {}), /Invalid path/);
});

test("worker rejects non-object and excessive query parameters", () => {
  assert.throws(() => buildUpstreamUrl("nws", "/alerts", []), /params must be an object/);
  const excessive = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [`p${index}`, index]),
  );
  assert.throws(
    () => buildUpstreamUrl("nws", "/alerts", excessive),
    /Too many query parameters/,
  );
});

test("eumetsatTile rejects requests before ever reaching EUMETSAT", async () => {
  const base = "https://example.test/api/tiles/eumetsat";
  const good = "layers=eps%3Am01_rgb_natural_fog&time=2026-08-20T13%3A10%3A00Z&bbox=0,0,1,1&crs=EPSG%3A3857&width=256&height=256";

  const badLayers = await eumetsatTile(new Request(`${base}?${good.replace(/layers=[^&]+/, "layers=not_a_real_workspace%3Afoo")}`));
  assert.equal(badLayers.status, 400);
  assert.match((await badLayers.json()).error.message, /Invalid layers/);

  const badTime = await eumetsatTile(new Request(`${base}?${good.replace(/time=[^&]+/, "time=not-a-time")}`));
  assert.equal(badTime.status, 400);
  assert.match((await badTime.json()).error.message, /Invalid time/);

  const badBbox = await eumetsatTile(new Request(`${base}?${good.replace(/bbox=[^&]+/, "bbox=only,two")}`));
  assert.equal(badBbox.status, 400);
  assert.match((await badBbox.json()).error.message, /Invalid bbox/);

  const badSize = await eumetsatTile(new Request(`${base}?${good.replace(/width=[^&]+/, "width=9999")}`));
  assert.equal(badSize.status, 400);
  assert.match((await badSize.json()).error.message, /Invalid width\/height/);

  const wrongMethod = await eumetsatTile(new Request(`${base}?${good}`, { method: "POST" }));
  assert.equal(wrongMethod.status, 405);
});

test("keyed feeds fail safely without exposing or requiring a browser key", async () => {
  const request = new Request("https://example.test/api/keyed/firms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bbox: [18, -35, 33, -22] }),
  });
  const response = await keyedFeed(request, {}, "firms");
  assert.equal(response.status, 503);
  assert.match(await response.text(), /FIRMS_MAP_KEY/);
});

test("a browser-supplied key can power a portable FIRMS deployment", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /portable_key_123/);
    return new Response(
      "latitude,longitude,acq_date,acq_time,instrument,confidence,frp\n-33.9,18.4,2026-07-29,1230,VIIRS,n,8.2\n",
      { status: 200 },
    );
  };
  try {
    const request = new Request("https://example.test/api/keyed/firms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bbox: [18, -35, 20, -32],
        apiKey: "portable_key_123",
      }),
    });
    const response = await keyedFeed(request, {}, "firms");
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.items[0].kind, "firms");
    assert.doesNotMatch(JSON.stringify(payload), /portable_key_123/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FIRMS keyed feed thins dense detections by default but returns everything when full:true is requested", async () => {
  const originalFetch = globalThis.fetch;
  // Two detections sharing the same ~0.05deg grid cell -- thinned to 1 by default.
  const csv = "latitude,longitude,acq_date,acq_time,instrument,confidence,frp\n" +
    "34.001,-118.001,2026-07-29,1230,VIIRS,n,12\n" +
    "34.011,-118.011,2026-07-29,1231,VIIRS,n,40\n";
  globalThis.fetch = async () => new Response(csv, { status: 200 });
  try {
    const thinnedRequest = new Request("https://example.test/api/keyed/firms", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bbox: [18, -35, 20, -32], apiKey: "portable_key_123" }),
    });
    const thinnedPayload = await (await keyedFeed(thinnedRequest, {}, "firms")).json();
    assert.equal(thinnedPayload.items.length, 1);

    const fullRequest = new Request("https://example.test/api/keyed/firms", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bbox: [18, -35, 20, -32], apiKey: "portable_key_123", full: true }),
    });
    const fullPayload = await (await keyedFeed(fullRequest, {}, "firms")).json();
    assert.equal(fullPayload.items.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keyed feeds enforce bounded map requests", () => {
  assert.deepEqual(parseBbox([18, -35, 33, -22], 60, 40), {
    west: 18, south: -35, east: 33, north: -22,
  });
  assert.throws(() => parseBbox([-180, -90, 180, 90], 60, 40), /Zoom in/);
});

test("FIRMS CSV is normalized into fire observations", () => {
  const items = firmsItems(
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,frp,daynight\n" +
    "-33.9,18.4,342.1,0.4,0.4,2026-07-29,1230,N,VIIRS,n,18.5,D\n",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "firms");
  assert.equal(items[0].frp, 18.5);
  assert.equal(items[0].brightness, 342.1);
});

test("thinFirmsItems keeps the hottest detection per grid cell and caps the total", () => {
  // Two detections land in the same ~0.05deg cell -- only the hotter one survives.
  const clustered = [
    { lat: 34.001, lon: -118.001, frp: 12 },
    { lat: 34.011, lon: -118.011, frp: 40 },
  ];
  const thinnedCluster = thinFirmsItems(clustered);
  assert.equal(thinnedCluster.length, 1);
  assert.equal(thinnedCluster[0].frp, 40);

  // A large, geographically-spread set still gets hard-capped so the client
  // never has to render an unbounded number of DOM markers.
  const spread = Array.from({ length: 2000 }, (_, i) => ({
    lat: -60 + (i % 1200) * 0.1, lon: -180 + i * 0.15, frp: i,
  }));
  const thinnedSpread = thinFirmsItems(spread);
  assert.ok(thinnedSpread.length <= 800);
});

test("AirNow pollutant rows aggregate by monitoring site", () => {
  const items = airNowItems([
    { Latitude: 40, Longitude: -75, FullAQSCode: "001", SiteName: "Test", Parameter: "PM25", Value: 12, AQI: 52, Unit: "UG/M3" },
    { Latitude: 40, Longitude: -75, FullAQSCode: "001", SiteName: "Test", Parameter: "OZONE", Value: 0.04, AQI: 38, Unit: "PPM" },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].aqi, 52);
  assert.equal(items[0].readings.PM25.value, 12);
  assert.equal(items[0].readings.OZONE.unit, "PPM");
});

test("GDELT news items are normalized from artlist JSON", () => {
  const items = gdeltNewsItems([
    { url: "https://example.com/story", title: "Flood warning issued", seendate: "20260802T060000Z", domain: "example.com", sourcecountry: "South Africa" },
    { title: "Untitled", seendate: "not-a-date" },
  ], 10);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Flood warning issued");
  assert.equal(items[0].url, "https://example.com/story");
  assert.equal(items[0].published, "2026-08-02T06:00:00Z");
  assert.equal(items[0].source, "example.com");
  assert.deepEqual(items[0].category, ["South Africa"]);
  assert.equal(items[1].published, null);
});

test("News search is keyless, bounded and hits GDELT", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.gdeltproject\.org\/api\/v2\/doc\/doc/);
    assert.match(decodeURIComponent(String(url)), /timespan=3d/);
    assert.match(String(url), /query=cyclone\+Mozambique/);
    return new Response(JSON.stringify({ articles: [{ url: "https://example.com/a", title: "Cyclone update", seendate: "20260802T060000Z", domain: "Test Wire" }] }), { status: 200 });
  };
  try {
    const request = new Request("https://example.test/api/news", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "cyclone Mozambique", region: "ZA", language: "en", days: 3 }),
    });
    const response = await searchNews(request);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.items[0].title, "Cyclone update");
    assert.equal(payload.feed, "gdelt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Currents keyword builder caps each request to one topic term plus one place term", () => {
  assert.equal(currentsKeywords("weather", "Johannesburg"), "weather Johannesburg");
  assert.equal(currentsKeywords("weather", ""), "weather");
  assert.equal(currentsKeywords("storm", "South Africa"), "storm South Africa");
});

test("Currents topic candidates only rotate through multiple topics when a locality narrows the search", () => {
  // Locality set (the tightest search tier) + several topics checked ->
  // try up to 3 in order, since a small town commonly has zero recent
  // articles tagged "weather" specifically but real coverage under a
  // different topic.
  assert.deepEqual(currentsTopicCandidates(["weather", "storm", "flood", "fire"], "", "Johannesburg"), ["weather", "storm", "flood"]);
  // No locality (country/global tier already succeeds reliably) -> a
  // single request, first topic only.
  assert.deepEqual(currentsTopicCandidates(["weather", "storm", "flood"], "", ""), ["weather"]);
  // Nothing checked at all -> falls back to "weather".
  assert.deepEqual(currentsTopicCandidates([], "", "Johannesburg"), ["weather"]);
  // A typed custom keyword always wins and is never combined with or
  // rotated against the checked topic boxes.
  assert.deepEqual(currentsTopicCandidates(["storm"], "hail", "Johannesburg"), ["hail"]);
});

test("Currents news items are normalized from the /search response shape", () => {
  const items = currentsNewsItems([
    { id: "abc", url: "https://example.com/story", title: "Flood warning issued", description: "Rivers rising.", published: "2026-08-02 06:00:00 +0000", author: "Example News", category: ["regional"] },
    { title: "No author", published: "not-a-date", author: "None" },
  ], 10);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Flood warning issued");
  assert.equal(items[0].published, "2026-08-02T06:00:00+00:00");
  assert.equal(items[0].source, "Example News");
  assert.deepEqual(items[0].category, ["regional"]);
  assert.equal(items[1].source, "Currents");
  assert.equal(items[1].published, null);
});

test("News search uses a configured Currents key ahead of GDELT, with a plain-text keyword query", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.currentsapi\.services\/v1\/search/);
    assert.match(String(url), /apiKey=test-currents-key-12345/);
    // Only one topic term plus one place term -- Currents' keyword search
    // behaves like an AND-match, so more terms than that reliably finds
    // nothing (verified against the live API; see fetchCurrentsNews).
    assert.match(String(url), /keywords=weather\+Johannesburg/);
    return new Response(JSON.stringify({ status: "ok", news: [{ id: "1", url: "https://example.com/a", title: "Joburg storm update", published: "2026-08-02 06:00:00 +0000", author: "Local News" }] }), { status: 200 });
  };
  try {
    const request = new Request("https://example.test/api/news", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "(weather OR storm) \"Johannesburg\" \"South Africa\"",
        apiKey: "test-currents-key-12345",
        topics: ["weather", "storm"], locality: "Johannesburg", country: "South Africa", days: 3,
      }),
    });
    const response = await searchNews(request);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.feed, "currents");
    assert.equal(payload.items[0].title, "Joburg storm update");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("News search falls back to GDELT when a configured Currents key fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("currentsapi.services")) return new Response(JSON.stringify({ status: "401", msg: "Invalid token" }), { status: 401 });
    return new Response(JSON.stringify({ articles: [{ url: "https://example.com/a", title: "Cyclone update", seendate: "20260802T060000Z", domain: "Test Wire" }] }), { status: 200 });
  };
  try {
    const request = new Request("https://example.test/api/news", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "weather", apiKey: "bad-key-1234567" }),
    });
    const response = await searchNews(request);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.feed, "gdelt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("News search retries once and recovers from a transient GDELT rate limit", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("Please limit requests to one every 5 seconds.", { status: 200 });
    return new Response(JSON.stringify({ articles: [{ url: "https://example.com/a", title: "Cyclone update", seendate: "20260802T060000Z", domain: "Test Wire" }] }), { status: 200 });
  };
  try {
    const request = new Request("https://example.test/api/news", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "weather" }),
    });
    const response = await searchNews(request);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.items[0].title, "Cyclone update");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("News search surfaces GDELT's plain-text rate-limit response as an error after retrying once", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Please limit requests to one every 5 seconds.", { status: 200 });
  try {
    const request = new Request("https://example.test/api/news", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "weather" }),
    });
    const response = await searchNews(request);
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.match(payload.error.message, /limit requests/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
