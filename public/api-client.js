/* Shared direct-first / Cloudflare-proxy API client. */
window.WeatherDataApi = (() => {
  "use strict";

  // Without this, a stalled request on a slow/flaky mobile connection leaves
  // the UI stuck on "Fetching…" indefinitely with no way to recover.
  const DEFAULT_TIMEOUT_MS = 20000;

  const DIRECT_BASES = Object.freeze({
    earthquake: "https://earthquake.usgs.gov",
    volcanoes: "https://volcanoes.usgs.gov",
    swpc: "https://services.swpc.noaa.gov",
    ncei: "https://gis.ngdc.noaa.gov",
    nws: "https://api.weather.gov",
    openmeteo: "https://api.open-meteo.com",
    openmeteoAq: "https://air-quality-api.open-meteo.com",
    openmeteoMarine: "https://marine-api.open-meteo.com",
    openmeteoArchive: "https://archive-api.open-meteo.com",
    openmeteoFlood: "https://flood-api.open-meteo.com",
    openmeteoEnsemble: "https://ensemble-api.open-meteo.com",
    openmeteoGeocoding: "https://geocoding-api.open-meteo.com",
    earthsearch: "https://earth-search.aws.element84.com",
    eonet: "https://eonet.gsfc.nasa.gov",
    gdacs: "https://www.gdacs.org",
    geomet: "https://api.weather.gc.ca",
    brightsky: "https://api.brightsky.dev",
  });

  function queryString(params) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (Array.isArray(value)) value.forEach((item) => qs.append(key, String(item)));
      else if (value !== null && value !== undefined) qs.append(key, String(value));
    }
    return qs.toString();
  }

  // wantText=true means the caller explicitly asked for a raw-text payload
  // (e.g. NDBC's plain-text feeds) — that's not a failure. Otherwise, a 200
  // response whose body isn't parseable JSON means the provider (or an
  // intermediary) returned something unexpected — that must surface as an
  // error rather than silently degrading to an empty {raw:...} payload that
  // callers expecting `.features`/`.value` etc. would misread as "0 results".
  // A genuinely EMPTY body (e.g. a 204 No Content some providers — like
  // aviationweather.gov's METAR endpoint — use to mean "zero matches") is
  // different from unexpected content and must NOT be treated as an error.
  async function parseResponse(response, wantText) {
    const text = await response.text();
    const looksJson = /^\s*[\[{]/.test(text);
    let payload;
    let unexpectedRaw = false;
    if (wantText) {
      payload = { raw: text };
    } else if (looksJson) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
        unexpectedRaw = true;
      }
    } else {
      payload = { raw: text };
      unexpectedRaw = text.trim() !== "";
    }
    if (!response.ok) {
      throw new Error(payload?.error?.message || response.statusText || `HTTP ${response.status}`);
    }
    if (unexpectedRaw) {
      throw new Error("Upstream returned a non-JSON response");
    }
    return payload;
  }

  async function direct(service, path, params, opts) {
    const base = DIRECT_BASES[service];
    if (!base) throw new Error(`Direct access unavailable for ${service}`);
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const qs = queryString(params);
    const response = await fetch(`${base}${cleanPath}${qs ? `?${qs}` : ""}`, {
      headers: { Accept: "application/json, application/geo+json, text/plain, */*" },
      signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
    return parseResponse(response, !!opts.text);
  }

  async function proxy(service, path, params, opts) {
    const response = await fetch(opts.proxyEndpoint || "/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service, path, params, text: !!opts.text }),
      signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
    const payload = await parseResponse(response, false);
    // The worker wraps an upstream's non-JSON body as {raw:text} inside its
    // own (valid-JSON) envelope, so the check above can't see it. Detect
    // that fallback shape here when the caller actually wanted JSON.
    const isRawFallback = payload && typeof payload === "object" && !Array.isArray(payload)
      && Object.prototype.hasOwnProperty.call(payload, "raw") && Object.keys(payload).length === 1
      && String(payload.raw).trim() !== "";
    if (!opts.text && isRawFallback) {
      throw new Error("Upstream returned a non-JSON response");
    }
    return payload;
  }

  function create(defaults = {}) {
    return async function dataApi(service, path, params = {}, options = {}) {
      const opts = { mode: "proxy", ...defaults, ...options };
      const started = performance.now();
      let transport = opts.mode === "direct" ? "direct" : "proxy";
      const report = (ok) => window.dispatchEvent(new CustomEvent("weather-api-status", {
        detail: { service, transport, ok, latencyMs: Math.round(performance.now() - started), at: Date.now() },
      }));
      if (opts.mode === "direct" || opts.mode === "direct-first") {
        try {
          transport = "direct";
          const result = await direct(service, path, params, opts);
          report(true);
          return result;
        } catch (directError) {
          if (opts.mode === "direct") {
            report(false);
            throw directError;
          }
          try {
            transport = "proxy";
            const result = await proxy(service, path, params, opts);
            report(true);
            return result;
          } catch (proxyError) {
            report(false);
            throw new Error(`${directError.message}; proxy fallback: ${proxyError.message}`);
          }
        }
      }
      try {
        const result = await proxy(service, path, params, opts);
        report(true);
        return result;
      } catch (cause) {
        report(false);
        throw cause;
      }
    };
  }

  return { create, DIRECT_BASES };
})();
