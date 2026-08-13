const SOURCES = Object.freeze({
  waterservices: { base: "https://waterservices.usgs.gov", ttl: 60, name: "USGS Water Services" },
  earthquake: {
    base: "https://earthquake.usgs.gov", ttl: 60, name: "USGS Earthquakes",
    userAgent: "Mozilla/5.0 (compatible; MetisWeatherFeeds/3.4; +https://metiscore.space)",
  },
  volcanoes: { base: "https://volcanoes.usgs.gov", ttl: 300, name: "USGS Volcano Hazards" },
  geomag: { base: "https://geomag.usgs.gov", ttl: 60, name: "USGS Geomagnetism" },
  nhc: { base: "https://www.nhc.noaa.gov", ttl: 120, name: "NOAA National Hurricane Center" },
  ndbc: { base: "https://www.ndbc.noaa.gov", ttl: 120, name: "NOAA NDBC" },
  cneos: { base: "https://ssd-api.jpl.nasa.gov", ttl: 300, name: "NASA/JPL CNEOS" },
  // OpenSky silently hangs connections from Cloudflare Workers' egress IPs
  // (verified live: a direct call from a normal IP completes in ~0.8s, the
  // identical call from this Worker consistently times out around 20s and
  // Cloudflare gives up with a 522) -- the same shape of problem as Google
  // News' block, just manifesting as a hang instead of an explicit reject.
  // A short explicit timeout turns that into a fast, clear error instead of
  // making the browser wait ~20s+ for Cloudflare's own timeout to fire.
  opensky: { base: "https://opensky-network.org", ttl: 15, name: "OpenSky Network", timeoutMs: 8000 },
  swpc: { base: "https://services.swpc.noaa.gov", ttl: 60, name: "NOAA SWPC" },
  ncei: { base: "https://gis.ngdc.noaa.gov", ttl: 3600, name: "NOAA NCEI GIS" },
  // api.weather.gov sits behind Akamai, whose bot manager flat-out 403s our
  // usual "AppName/version (+url)" identifying UA for this specific host
  // (verified live: identical request with a plain browser-style UA gets
  // 200, every custom domain-styled UA we tried -- including Mozilla-
  // prefixed variants -- gets Akamai's block page, not a real NWS response).
  // A browser-style UA is the only thing that reliably gets through.
  nws: {
    base: "https://api.weather.gov", ttl: 60, name: "US National Weather Service", timeoutMs: 10000,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  },
  aviation: { base: "https://aviationweather.gov", ttl: 60, name: "NOAA Aviation Weather Center" },
  openmeteo: { base: "https://api.open-meteo.com", ttl: 300, name: "Open-Meteo Forecast" },
  openmeteoAq: { base: "https://air-quality-api.open-meteo.com", ttl: 300, name: "Open-Meteo Air Quality" },
  openmeteoMarine: { base: "https://marine-api.open-meteo.com", ttl: 300, name: "Open-Meteo Marine" },
  openmeteoArchive: { base: "https://archive-api.open-meteo.com", ttl: 3600, name: "Open-Meteo Historical" },
  openmeteoFlood: { base: "https://flood-api.open-meteo.com", ttl: 3600, name: "Open-Meteo Flood" },
  openmeteoEnsemble: { base: "https://ensemble-api.open-meteo.com", ttl: 300, name: "Open-Meteo Ensemble Mean" },
  openmeteoGeocoding: { base: "https://geocoding-api.open-meteo.com", ttl: 86400, name: "Open-Meteo Geocoding" },
  nominatim: {
    base: "https://nominatim.openstreetmap.org", ttl: 86400, name: "OpenStreetMap Nominatim",
    userAgent: "MetisWeatherFeeds/3.4 (+https://metiscore.space)",
  },
  earthsearch: { base: "https://earth-search.aws.element84.com", ttl: 300, name: "Earth Search STAC" },
  eonet: {
    base: "https://eonet.gsfc.nasa.gov",
    ttl: 300,
    name: "NASA EONET",
    userAgent: "Mozilla/5.0 (compatible; EarthDataDashboard/1.0)",
  },
  metno: { base: "https://api.met.no", ttl: 300, name: "MET Norway" },
  nasaPower: { base: "https://power.larc.nasa.gov", ttl: 3600, name: "NASA POWER" },
  coops: { base: "https://api.tidesandcurrents.noaa.gov", ttl: 60, name: "NOAA CO-OPS" },
  gdacs: { base: "https://www.gdacs.org", ttl: 300, name: "GDACS" },
  geomet: { base: "https://api.weather.gc.ca", ttl: 300, name: "ECCC GeoMet" },
  brightsky: { base: "https://api.brightsky.dev", ttl: 300, name: "Bright Sky (DWD)" },
  // Esri Living Atlas' public live feed -- combines NOAA NHC (Atlantic/East
  // Pacific, what the old nhc-only cyclone layer covered) with the Joint
  // Typhoon Warning Center (West Pacific, Indian Ocean, Southern Hemisphere,
  // previously missing entirely). Public, keyless FeatureServer.
  arcgisCyclones: {
    base: "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Active_Hurricanes_v1",
    ttl: 300, name: "Esri Living Atlas — Active Hurricanes",
  },
  // Esri's public World Imagery basemap tiles -- keyless, higher native
  // zoom than the NASA GIBS true-color layer already in the app.
  arcgisImagery: { base: "https://server.arcgisonline.com", ttl: 3600, name: "Esri World Imagery" },
  // World Imagery Wayback's release list (195+ dated snapshots back to
  // 2014) is a plain public JSON file, but the S3 bucket serving it sends
  // no CORS headers, so it can't be fetched directly from the browser --
  // proxied here same as everything else. Actual Wayback *tiles* are plain
  // <img> loads (no CORS needed) so those still go direct, unproxied.
  waybackConfig: { base: "https://s3-us-west-2.amazonaws.com", ttl: 86400, name: "Esri World Imagery Wayback" },
});

// OpenSky's /api/states/all is a plain passthrough (no per-service bbox
// cap like the dedicated FIRMS/AirNow keyed feeds below), so a client
// requesting a wide-open view can pull thousands of live aircraft in one
// call -- enough to freeze the map when each one is rendered as a marker.
const OPENSKY_MAX_BBOX = { width: 25, height: 18 };
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const KEYED_FEEDS = Object.freeze({
  firms: { secret: "FIRMS_MAP_KEY", name: "NASA FIRMS", ttl: 300 },
  airnow: { secret: "AIRNOW_API_KEY", name: "EPA AirNow", ttl: 300 },
});

const NEWS_TTL = 600;

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}

function error(message, status = 400) {
  return json({ error: { message } }, status, { "Cache-Control": "no-store" });
}

// Reads a Response body up to maxBytes, aborting mid-stream rather than
// buffering an unbounded/chunked upstream body before checking its size.
async function readCappedText(response, maxBytes) {
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw new Error("Upstream response is too large");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("Upstream response is too large");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Upstream response is too large");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(buffer);
}

function jsonBodyError(cause) {
  if (cause.message === "Method not allowed") return error(cause.message, 405);
  if (cause.message === "Request body is too large") return error(cause.message, 413);
  return error("Invalid JSON", 400);
}

function parseBbox(value, maxWidth, maxHeight) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("bbox must be [west, south, east, north]");
  }
  const [west, south, east, north] = value.map(Number);
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 || east > 180 || south < -90 || north > 90 ||
    west >= east || south >= north
  ) {
    throw new Error("bbox contains invalid coordinates");
  }
  if (east - west > maxWidth || north - south > maxHeight) {
    throw new Error(`Zoom in: this feed accepts at most ${maxWidth}° × ${maxHeight}° per request`);
  }
  return { west, south, east, north };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift()?.map((value) => value.trim()) || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function firmsItems(text) {
  return parseCsv(text).map((row, index) => {
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const hhmm = String(row.acq_time || "").padStart(4, "0");
    const time = row.acq_date
      ? Date.parse(`${row.acq_date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`)
      : null;
    const frp = Number(row.frp);
    const brightness = Number(row.bright_ti4 || row.brightness);
    return {
      kind: "firms",
      id: `firms-${row.acq_date || "date"}-${row.acq_time || "time"}-${lat}-${lon}-${index}`,
      name: `${row.instrument || row.satellite || "Satellite"} active fire`,
      lat, lon,
      time: Number.isFinite(time) ? time : null,
      satellite: row.satellite || "",
      instrument: row.instrument || "",
      confidence: row.confidence || "",
      frp: Number.isFinite(frp) ? frp : null,
      brightness: Number.isFinite(brightness) ? brightness : null,
      daynight: row.daynight || "",
      scan: Number(row.scan) || null,
      track: Number(row.track) || null,
    };
  }).filter(Boolean);
}

// VIIRS 375m detections can number in the thousands over a wide/active bbox
// -- rendering that many individual DOM markers on the client (especially
// alongside satellite tile layers) is what was freezing the page. Grid-snap
// to ~0.05deg (~5km) cells and keep only the hottest detection per cell,
// then hard-cap the remainder, so the client never has to render more than
// a UI-manageable number of points.
function thinFirmsItems(items, { cellDeg = 0.05, maxItems = 800 } = {}) {
  const byCell = new Map();
  for (const item of items) {
    const key = `${Math.round(item.lat / cellDeg)}:${Math.round(item.lon / cellDeg)}`;
    const existing = byCell.get(key);
    if (!existing || (item.frp || 0) > (existing.frp || 0)) byCell.set(key, item);
  }
  const thinned = [...byCell.values()];
  if (thinned.length <= maxItems) return thinned;
  return thinned.sort((a, b) => (b.frp || 0) - (a.frp || 0)).slice(0, maxItems);
}

function airNowItems(rows) {
  const sites = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const lat = Number(row.Latitude);
    const lon = Number(row.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const siteCode = row.FullAQSCode || row.IntlAQSCode || `${lat.toFixed(4)}-${lon.toFixed(4)}`;
    const id = `airnow-${siteCode}`;
    const item = sites.get(id) || {
      kind: "airnow", id,
      name: row.SiteName || row.ReportingArea || `AirNow ${siteCode}`,
      lat, lon,
      time: row.UTC ? Date.parse(`${String(row.UTC).replace(" ", "T")}:00Z`) : null,
      agency: row.AgencyName || "",
      siteCode,
      aqi: null,
      readings: {},
    };
    const parameter = String(row.Parameter || "").toUpperCase();
    const aqi = Number(row.AQI);
    const value = Number(row.Value);
    item.readings[parameter] = {
      value: Number.isFinite(value) ? value : null,
      unit: row.Unit || "",
      aqi: Number.isFinite(aqi) && aqi >= 0 ? aqi : null,
      category: row.Category?.Name || row.Category || "",
    };
    if (Number.isFinite(aqi) && aqi >= 0) item.aqi = Math.max(item.aqi ?? 0, aqi);
    sites.set(id, item);
  }
  return [...sites.values()];
}

function gdeltDateToIso(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(value || ""));
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

function gdeltNewsItems(articles, pageSize) {
  return (Array.isArray(articles) ? articles : []).slice(0, pageSize).map((article, index) => ({
    id: article?.url || `gdelt-${index}`,
    title: String(article?.title || "Untitled report").trim(),
    description: "",
    url: /^https?:\/\//i.test(article?.url || "") ? article.url : "",
    published: gdeltDateToIso(article?.seendate),
    source: article?.domain || article?.sourcecountry || "GDELT",
    category: article?.sourcecountry ? [article.sourcecountry] : [],
  }));
}

// Google News RSS search returns 503 to Cloudflare Workers' shared egress
// IPs no matter what -- verified live with a real Chrome User-Agent,
// matching Accept/Accept-Language/Referer headers, and again with the
// account's Bot Fight Mode disabled. It's an IP-reputation block on
// Google's side, not something fixable from the Worker's request shape, so
// this dashboard uses GDELT's DOC 2.0 API instead: free, keyless, and
// documented for exactly this kind of automated querying.
async function gdeltRequestOnce(query, days, pageSize) {
  const params = new URLSearchParams({
    query, mode: "artlist", maxrecords: String(pageSize), format: "json",
    sort: "datedesc", timespan: `${days}d`,
  });
  const upstream = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; MetisWeatherFeeds/3.4; +https://metiscore.space)",
    },
    cf: { cacheEverything: true, cacheTtl: NEWS_TTL },
  });
  const text = await readCappedText(upstream, MAX_RESPONSE_BYTES);
  // GDELT's anonymous rate limit shows up two different ways: a real 429
  // status, or a 200 OK carrying its plain-text throttle notice instead of
  // JSON. Either is worth one short retry -- the limit is a rolling window,
  // not a hard block, so a request that lands ~1.5s later often succeeds.
  if (upstream.status === 429 || /limit requests/i.test(text)) {
    const rateLimitError = new Error(text.trim().slice(0, 200) || `GDELT returned HTTP ${upstream.status}`);
    rateLimitError.rateLimited = true;
    throw rateLimitError;
  }
  if (!upstream.ok) throw new Error(`GDELT returned HTTP ${upstream.status}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text.trim().slice(0, 200) || "GDELT returned an unexpected response");
  }
  return gdeltNewsItems(data.articles, pageSize);
}

async function fetchGdeltNews(query, days, pageSize) {
  const retryDelaysMs = [0, 1500];
  let lastError;
  for (const delay of retryDelaysMs) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const items = await gdeltRequestOnce(query, days, pageSize);
      return { feed: "gdelt", items, sourceHeader: "GDELT Project" };
    } catch (cause) {
      lastError = cause;
      if (!cause.rateLimited) throw cause;
    }
  }
  throw lastError;
}

function currentsTimestamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "+00:00");
}

function currentsDateToIso(value) {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const [, date, time, offH, offM] = match;
  return `${date}T${time}${offH}:${offM}`;
}

function currentsNewsItems(news, pageSize) {
  return (Array.isArray(news) ? news : []).slice(0, pageSize).map((article, index) => ({
    id: article?.id || article?.url || `currents-${index}`,
    title: String(article?.title || "Untitled report").trim(),
    description: String(article?.description || "").trim(),
    url: /^https?:\/\//i.test(article?.url || "") ? article.url : "",
    published: currentsDateToIso(article?.published),
    source: article?.author && article.author !== "None" ? article.author : "Currents",
    category: Array.isArray(article?.category) ? article.category : [],
  }));
}

// Currents' `keywords` is a plain-text search, not a boolean query language
// -- unlike GDELT/Google it can't parse "(a OR b)" or quoted-phrase syntax.
// Verified empirically against the live API: it behaves like an AND-match
// across every word given, not a relevance-ranked OR search -- "weather
// Johannesburg" (2 words) reliably finds real, relevant articles, but
// "weather storm Johannesburg" (3 words, still just one topic + one place)
// already returns zero every time. Stuffing in every checked topic plus
// locality plus country (the GDELT-style approach) reliably returns
// nothing, which read as "no news despite an active key." Every single
// upstream request stays capped to one topic term plus one place term.
//
// A hyper-local place (a small town, not a capital) commonly comes back
// empty for "weather" specifically even when it does have real recent
// coverage under a different checked topic -- flooding, a wildfire, a
// tremor. Only worth the extra upstream calls at the tightest ("locality
// set") search tier -- the country/global fallback tiers already succeed
// reliably on the first try -- and capped at 3 topics so a location with
// every box checked doesn't fire six sequential requests for one tier.
function currentsTopicCandidates(topics, custom, locality) {
  if (custom) return [custom];
  if (locality && topics.length) return topics.slice(0, 3);
  return [topics[0] || "weather"];
}

function currentsKeywords(topic, place) {
  return (place ? `${topic} ${place}` : topic).trim().slice(0, 120) || "weather";
}

async function fetchCurrentsNews(apiKey, topics, custom, locality, country, language, days, pageSize) {
  const place = locality || country || "";
  const candidateTopics = currentsTopicCandidates(topics, custom, locality);
  let lastResult = null;
  for (const topic of candidateTopics) {
    const keywords = currentsKeywords(topic, place);
    const now = Date.now();
    const params = new URLSearchParams({
      apiKey,
      keywords,
      start_date: currentsTimestamp(now - days * 86400000),
      end_date: currentsTimestamp(now),
    });
    if (/^[a-z]{2}$/i.test(language)) params.set("language", language.toLowerCase());
    // eslint-disable-next-line no-await-in-loop
    const upstream = await fetch(`https://api.currentsapi.services/v1/search?${params}`, {
      // Currents API sits behind Cloudflare's own WAF, which blocks requests
      // with no/default User-Agent (verified live: Cloudflare error 1010 with
      // no UA header or Python's default urllib UA, 200 OK with this one).
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; MetisWeatherFeeds/3.4; +https://metiscore.space)" },
      cf: { cacheEverything: true, cacheTtl: NEWS_TTL },
    });
    // eslint-disable-next-line no-await-in-loop
    const text = await readCappedText(upstream, MAX_RESPONSE_BYTES);
    if (!upstream.ok) {
      let message = `Currents API returned HTTP ${upstream.status}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed?.msg || parsed?.message || message;
      } catch { /* keep default message */ }
      throw new Error(message);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Currents API returned an unexpected response");
    }
    const items = currentsNewsItems(data.news, pageSize);
    lastResult = { feed: "currents", items, sourceHeader: "Currents API" };
    if (items.length) return lastResult;
  }
  return lastResult;
}

async function searchNews(request) {
  if (request.method !== "POST") return error("Method not allowed", 405);
  let body;
  try {
    body = await readJsonBody(request);
  } catch (cause) {
    return jsonBodyError(cause);
  }
  const query = String(body?.query || "weather OR disaster").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 420);
  if (!query) return error("A news query is required");
  const days = Math.max(1, Math.min(30, Number(body?.days) || 3));
  const pageSize = Math.max(1, Math.min(40, Number(body?.pageSize) || 24));
  const language = /^[a-z]{2}$/i.test(String(body?.language || "")) ? String(body.language).toLowerCase() : "en";
  const apiKey = /^[A-Za-z0-9._-]{8,128}$/.test(String(body?.apiKey || "")) ? String(body.apiKey) : "";
  const topics = Array.isArray(body?.topics) ? body.topics.map(String).slice(0, 12) : [];
  const custom = String(body?.custom || "").slice(0, 120);
  const locality = String(body?.locality || "").slice(0, 120);
  const country = String(body?.country || "").slice(0, 120);

  // A user-supplied Currents key is opt-in and gets priority (1,000
  // req/day, no rate-limit fragility); GDELT is the free/keyless default
  // and also the fallback if a configured Currents key ever fails.
  let result;
  if (apiKey) {
    try {
      result = await fetchCurrentsNews(apiKey, topics, custom, locality, country, language, days, pageSize);
    } catch { /* fall through to GDELT */ }
  }
  if (!result) {
    try {
      result = await fetchGdeltNews(query, days, pageSize);
    } catch (cause) {
      return error(cause.message || "News request failed", 502);
    }
  }
  return json(
    { feed: result.feed, generatedAt: new Date().toISOString(), count: result.items.length, items: result.items },
    200,
    { "Cache-Control": `public, max-age=${NEWS_TTL}`, "X-Weather-Source": result.sourceHeader },
  );
}

async function readJsonBody(request) {
  if (request.method !== "POST") throw new Error("Method not allowed");
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new Error("Request body is too large");
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    throw new Error("Request body is too large");
  }
  try {
    return JSON.parse(rawBody || "{}");
  } catch {
    throw new Error("Invalid JSON");
  }
}

async function keyedFeed(request, env, feedName) {
  const config = KEYED_FEEDS[feedName];
  if (!config) return error("Unknown keyed feed", 404);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (cause) {
    return jsonBodyError(cause);
  }
  const suppliedKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const apiKey = suppliedKey || env[config.secret];
  if (!apiKey) {
    return error(`${config.name} needs an API key. Enter one in the dashboard or add the ${config.secret} Cloudflare secret.`, 503);
  }
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(apiKey)) {
    return error(`${config.name} API key format is invalid.`);
  }

  let upstreamUrl;
  let upstreamHeaders = {};
  try {
    if (feedName === "firms") {
      const bbox = parseBbox(body?.bbox, 60, 40);
      const source = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT"].includes(body?.source)
        ? body.source : "VIIRS_SNPP_NRT";
      const days = Math.max(1, Math.min(5, Number(body?.days) || 1));
      const area = [bbox.west, bbox.south, bbox.east, bbox.north].map((value) => value.toFixed(4)).join(",");
      upstreamUrl = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(apiKey)}/${source}/${area}/${days}`;
    } else if (feedName === "airnow") {
      const bbox = parseBbox(body?.bbox, 80, 45);
      const end = new Date();
      end.setUTCMinutes(0, 0, 0);
      const start = new Date(end.getTime() - 2 * 3600000);
      const stamp = (date) => date.toISOString().slice(0, 13);
      const params = new URLSearchParams({
        startDate: stamp(start),
        endDate: stamp(end),
        parameters: "OZONE,PM25,PM10,CO,NO2,SO2",
        BBOX: [bbox.west, bbox.south, bbox.east, bbox.north].map((value) => value.toFixed(4)).join(","),
        dataType: "C",
        format: "application/json",
        verbose: "1",
        monitorType: "0",
        includerawconcentrations: "0",
        API_KEY: apiKey,
      });
      upstreamUrl = `https://www.airnowapi.org/aq/data/?${params}`;
    }
  } catch (cause) {
    return error(cause.message);
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      redirect: "manual",
      headers: {
        Accept: feedName === "firms" ? "text/csv" : "application/json",
        "User-Agent": env.WEATHER_USER_AGENT || "MetisWeatherFeeds/3.4 (+https://metiscore.space)",
        ...upstreamHeaders,
      },
      cf: { cacheEverything: true, cacheTtl: config.ttl },
    });
    if (!upstream.ok) {
      return error(`${config.name} returned HTTP ${upstream.status}`, upstream.status >= 500 || (upstream.status >= 300 && upstream.status < 400) ? 502 : upstream.status);
    }
    let text;
    try {
      text = await readCappedText(upstream, MAX_RESPONSE_BYTES);
    } catch (cause) {
      return error(cause.message, 502);
    }
    const items = feedName === "firms"
      ? (body?.full ? firmsItems(text) : thinFirmsItems(firmsItems(text)))
      : airNowItems(JSON.parse(text));
    return json(
      { feed: feedName, generatedAt: new Date().toISOString(), count: items.length, items },
      200,
      { "Cache-Control": `public, max-age=${config.ttl}`, "X-Weather-Source": config.name },
    );
  } catch (cause) {
    return error(cause.message || `${config.name} request failed`, 502);
  }
}

function buildUpstreamUrl(serviceName, path, params) {
  const source = SOURCES[serviceName];
  if (!source) throw new Error(`Unknown service: ${serviceName}`);
  if (typeof path !== "string") throw new Error("path must be a string");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (
    cleanPath.startsWith("//") ||
    cleanPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(cleanPath)
  ) {
    throw new Error("Invalid path");
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("params must be an object");
  }
  const entries = Object.entries(params);
  if (entries.length > 100) throw new Error("Too many query parameters");
  const query = new URLSearchParams();
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
    } else if (value !== null && value !== undefined) {
      query.append(key, String(value));
    }
  }
  if (query.size > 250 || query.toString().length > 16_384) {
    throw new Error("Query string is too long");
  }
  return {
    url: `${source.base}${cleanPath}${query.size ? `?${query}` : ""}`,
    source,
  };
}

async function proxy(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "POST") return error("Method not allowed", 405);
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return error("Request body is too large", 413);

  let body;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return error("Request body is too large", 413);
    }
    body = JSON.parse(rawBody || "{}");
  } catch {
    return error("Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return error("JSON body must be an object");
  }

  if (String(body.service || "").trim() === "opensky") {
    const params = body.params || {};
    const lamin = Number(params.lamin), lamax = Number(params.lamax);
    const lomin = Number(params.lomin), lomax = Number(params.lomax);
    if (
      ![lamin, lamax, lomin, lomax].every(Number.isFinite) ||
      lamax - lamin > OPENSKY_MAX_BBOX.height || lomax - lomin > OPENSKY_MAX_BBOX.width
    ) {
      return error(`Zoom in: aircraft tracking accepts at most ${OPENSKY_MAX_BBOX.width}° × ${OPENSKY_MAX_BBOX.height}° per request`);
    }
  }

  let target;
  try {
    target = buildUpstreamUrl(
      String(body.service || "waterservices").trim(),
      body.path || "",
      body.params || {},
    );
  } catch (cause) {
    return error(cause.message);
  }

  const userAgent =
    env.WEATHER_USER_AGENT ||
    "MetisWeatherFeeds/3.4 (+https://metiscore.space)";
  let upstream;
  // Same one-short-retry treatment fetchGdeltNews already gives 429s --
  // Open-Meteo in particular throttles in short rolling windows, so a
  // request that lands ~1.5s later after a burst (e.g. a single point click
  // firing several of its sub-services at once) commonly succeeds instead of
  // surfacing a rate-limit error to the user.
  const retryDelaysMs = [0, 1500];
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt]) await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    try {
      // eslint-disable-next-line no-await-in-loop
      upstream = await fetch(target.url, {
        redirect: "manual",
        headers: {
          Accept: "application/json, application/geo+json, text/plain, */*",
          "User-Agent": target.source.userAgent || userAgent,
        },
        cf: {
          cacheEverything: true,
          cacheTtl: target.source.ttl,
        },
        signal: target.source.timeoutMs ? AbortSignal.timeout(target.source.timeoutMs) : undefined,
      });
    } catch (cause) {
      if (cause.name === "TimeoutError" || cause.name === "AbortError") {
        return error(`${target.source.name} did not respond in time (this provider is known to be slow/unreliable from Cloudflare's network)`, 504);
      }
      return error(cause.message || "Upstream request failed", 502);
    }
    if (upstream.status !== 429 || attempt === retryDelaysMs.length - 1) break;
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return error("Upstream redirect blocked", 502);
  }

  let text;
  try {
    text = await readCappedText(upstream, MAX_RESPONSE_BYTES);
  } catch (cause) {
    return error(cause.message, 502);
  }
  let payload;
  if (body.text || !/^\s*[\[{]/.test(text)) {
    payload = upstream.ok
      ? { raw: text }
      : { error: { message: upstream.statusText || `HTTP ${upstream.status}` } };
  } else {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = upstream.ok
        ? { raw: text }
        : { error: { message: upstream.statusText || `HTTP ${upstream.status}` } };
    }
  }
  return json(payload, upstream.status, {
    "Cache-Control": upstream.ok
      ? `public, max-age=${target.source.ttl}`
      : "no-store",
    "X-Weather-Source": target.source.name,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/global-cors" || url.pathname.startsWith("/global-cors/")) {
      return Response.redirect(`${url.origin}/${url.search}`, 308);
    }
    if (
      url.pathname === "/api/proxy" ||
      url.pathname === "/api/data/proxy" ||
      url.pathname === "/api/usgs/proxy"
    ) {
      return proxy(request, env);
    }
    if (url.pathname === "/api/keyed/firms") {
      return keyedFeed(request, env, "firms");
    }
    if (url.pathname === "/api/keyed/airnow") {
      return keyedFeed(request, env, "airnow");
    }
    if (url.pathname === "/api/news") {
      return searchNews(request);
    }
    if (url.pathname === "/api/health") {
      return json({ ok: true, sourceCount: Object.keys(SOURCES).length });
    }
    if (url.pathname === "/api/sources") {
      return json({
        sources: Object.fromEntries(
          Object.entries(SOURCES).map(([key, source]) => [
            key,
            { name: source.name, cacheSeconds: source.ttl },
          ]),
        ),
      });
    }
    const assetResponse = await env.ASSETS.fetch(request);
    const response = new Response(assetResponse.body, assetResponse);
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return response;
  },
};

export {
  airNowItems, currentsTopicCandidates, currentsKeywords, buildUpstreamUrl, currentsNewsItems, firmsItems, gdeltNewsItems, thinFirmsItems,
  keyedFeed, parseBbox, searchNews, SOURCES,
};
