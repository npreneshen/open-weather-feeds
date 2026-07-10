const API_BASES = {
  waterservices: "https://waterservices.usgs.gov",
  earthquake: "https://earthquake.usgs.gov",
  volcanoes: "https://volcanoes.usgs.gov",
  geomag: "https://geomag.usgs.gov",
  nhc: "https://www.nhc.noaa.gov",
  ndbc: "https://www.ndbc.noaa.gov",
  cneos: "https://ssd-api.jpl.nasa.gov",
  opensky: "https://opensky-network.org",
  swpc: "https://services.swpc.noaa.gov",
  ncei: "https://gis.ngdc.noaa.gov",
  nws: "https://api.weather.gov",
  aviation: "https://aviationweather.gov",
  openmeteo: "https://air-quality-api.open-meteo.com",
  earthsearch: "https://earth-search.aws.element84.com",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(data);
}

async function proxyHandler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { message: "Method not allowed" } });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON" } });
    return;
  }

  const service = String(body.service || "waterservices").trim();
  let path = body.path || "";
  const params = body.params || {};
  const wantText = Boolean(body.text);
  const base = API_BASES[service];

  if (!base) {
    sendJson(res, 400, { error: { message: `Unknown service: ${service}` } });
    return;
  }
  if (!path.startsWith("/")) path = `/${path}`;

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => qs.append(k, String(item)));
    else if (v != null) qs.append(k, String(v));
  }
  const url = qs.toString() ? `${base}${path}?${qs}` : `${base}${path}`;

  try {
    const upstream = await fetch(url, {
      headers: { Accept: "application/json, text/plain, */*", "User-Agent": "HazardsTracker/1.0" },
    });
    const text = await upstream.text();
    let payload;
    if (wantText || !text.trim().startsWith("{") && !text.trim().startsWith("[")) {
      payload = upstream.ok ? { raw: text } : { error: { message: upstream.statusText || `HTTP ${upstream.status}` } };
    } else {
      try {
        payload = JSON.parse(text);
      } catch {
        const m = text.match(/<b>message<\/b>\s*([^<]+)/i);
        payload = !upstream.ok
          ? { error: { message: m ? m[1].trim() : (upstream.statusText || `HTTP ${upstream.status}`) } }
          : { raw: text };
      }
    }
    sendJson(res, upstream.status, payload);
  } catch (err) {
    sendJson(res, 502, { error: { message: err.message || "Upstream error" } });
  }
}

export default proxyHandler;
