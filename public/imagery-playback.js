/* Satellite imagery playback + GIF export.
   Composites tiles onto an offscreen canvas per date (using Leaflet's own
   `map.project()` for pixel-accurate placement instead of reimplementing
   Web Mercator tile math), caches the composed frames, and either plays
   them back live over the map or encodes them into a downloadable GIF via
   gif-encoder.js. Zoom always follows whatever is on screen when frames
   are loaded -- there is no separate zoom picker. */
window.MetisImageryPlayback = (() => {
  "use strict";

  const TILE_SIZE = 256;
  // Hard cap regardless of the requested date range/step/release count --
  // without this, a small step over a long range means thousands of frames,
  // each needing dozens of sequential tile fetches, which is what was
  // "breaking the page" (very long, unresponsive-feeling captures rather
  // than a clean failure). Applies uniformly to every layer -- a full year
  // of daily frames is already a real, if slow, request for any of them.
  const MAX_FRAMES = 366;
  const TILE_TIMEOUT_MS = 15000;
  // Browsers cap concurrent connections per host at ~6; keep requests flowing
  // without queueing past TILE_TIMEOUT_MS before they even start.
  const TILE_FETCH_CONCURRENCY = 6;
  // Capture a few independent frames in parallel. Sentinel Hub is kept to
  // one frame at a time below because each WMS tile is rendered on demand;
  // competing frame batches only queue at the provider and cause timeouts.
  const FRAME_CAPTURE_CONCURRENCY = 2;
  const TILE_RETRY_ATTEMPTS = 3;
  const FINGERPRINT_GRID = 16;
  const CELL_DIFF_THRESHOLD = 10;
  const DUPLICATE_CHANGED_FRAC = 0.03;
  // Shared decoded-tile LRU across a load batch (adjacent dates often share
  // label tiles; Wayback redirects also reuse the same underlying imagery).
  const TILE_CACHE_MAX = 256;
  const WAYBACK_PROBE_BATCH = 6;
  // Downsample sizes used to measure how much of a tile (or of the whole
  // frame) actually carries imagery rather than transparency / no-data black.
  const PROBE_SIZE = 16;
  const CANVAS_PROBE_SIZE = 64;
  // A tile below this carries no usable imagery at all.
  const TILE_EMPTY_COVERAGE = 0.02;
  // Alpha-capable providers keep gaining pixels from each fallback request,
  // so they are only considered finished once a tile is essentially full.
  const TILE_FULL_COVERAGE = 0.985;
  const SENTINEL_MAX_WINDOW_DAYS = 60;
  const BACKGROUND_FILL = "#06171e";

  const GIBS_PRODUCTS = {
    satellite: {
      layer: "MODIS_Terra_CorrectedReflectance_TrueColor",
      level: "GoogleMapsCompatible_Level9",
      maxNativeZoom: 9,
      ext: "jpg",
      label: "NASA GIBS Terra true-colour",
    },
    satelliteAqua: {
      layer: "MODIS_Aqua_CorrectedReflectance_TrueColor",
      level: "GoogleMapsCompatible_Level9",
      maxNativeZoom: 9,
      ext: "jpg",
      label: "NASA GIBS Aqua true-colour",
    },
    satelliteViirs: {
      layer: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
      level: "GoogleMapsCompatible_Level9",
      maxNativeZoom: 9,
      ext: "jpg",
      label: "NASA GIBS VIIRS/SNPP true-colour",
    },
    satelliteNoaa20: {
      layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
      level: "GoogleMapsCompatible_Level9",
      maxNativeZoom: 9,
      ext: "jpg",
      label: "NASA GIBS VIIRS/NOAA-20 true-colour",
    },
    satelliteNoaa21: {
      layer: "VIIRS_NOAA21_CorrectedReflectance_TrueColor",
      level: "GoogleMapsCompatible_Level9",
      maxNativeZoom: 9,
      ext: "jpg",
      label: "NASA GIBS VIIRS/NOAA-21 true-colour",
    },
  };

  function isoDay(offsetDays = 0) {
    return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  }

  function dateRange(startStr, endStr, stepDays) {
    const dates = [];
    const start = new Date(`${startStr}T00:00:00Z`);
    const end = new Date(`${endStr}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return dates;
    const step = Math.max(1, stepDays | 0) * 86400000;
    for (let t = start.getTime(); t <= end.getTime(); t += step) {
      dates.push(new Date(t).toISOString().slice(0, 10));
    }
    return dates;
  }

  // Resamples down to at most `max` dates, evenly spaced across the full
  // range (keeps first and last) instead of just truncating the tail.
  function capDates(dates, max) {
    if (dates.length <= max) return dates;
    if (max <= 1) return dates.slice(0, 1);
    const picked = [];
    for (let i = 0; i < max; i++) {
      const idx = Math.round((i * (dates.length - 1)) / (max - 1));
      if (!picked.length || picked[picked.length - 1] !== dates[idx]) picked.push(dates[idx]);
    }
    return picked;
  }

  function loadImage(url, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      const img = new Image();
      img.crossOrigin = "anonymous";
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.src = "";
        reject(new Error("Cancelled"));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        img.src = "";
        reject(new Error("tile load timed out"));
      }, TILE_TIMEOUT_MS);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      img.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        resolve(img);
      };
      img.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        reject(new Error("tile load failed"));
      };
      img.src = url;
    });
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener?.("abort", () => { clearTimeout(t); reject(new Error("Cancelled")); }, { once: true });
    });
  }

  // <img> loading can't see the HTTP status of a cross-origin failure (a 429
  // and a 404 both just fire onerror), so this can't specifically detect
  // rate-limiting -- but retrying instantly on *any* failure is exactly what
  // turns a transient 429 from a provider (Sentinel Hub's free-tier WMS in
  // particular) into a worse one. A short backoff between attempts costs
  // nothing when the failure was something else, and gives a rate limit a
  // moment to clear.
  async function loadImageRetry(url, attempts = TILE_RETRY_ATTEMPTS, signal) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) throw new Error("Cancelled");
      try {
        // eslint-disable-next-line no-await-in-loop
        return await loadImage(url, signal);
      } catch (err) {
        lastErr = err;
        if (err?.message === "Cancelled") throw err;
        if (i < attempts - 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(300 * (i + 1) + Math.random() * 200, signal);
        }
      }
    }
    throw lastErr;
  }

  async function runLimited(tasks, concurrency, signal) {
    let next = 0;
    async function worker() {
      while (next < tasks.length) {
        if (signal?.aborted) throw new Error("Cancelled");
        const i = next++;
        // eslint-disable-next-line no-await-in-loop
        await tasks[i]();
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  }

  // GOES full-disk GeoColor updates on a ~10-min grid (with occasional gaps
  // from eclipse/maintenance periods -- missed slots just 404 and get
  // skipped like any other failed tile). Rounds each step down to the
  // nearest 10 min since that's the native grid GIBS actually publishes on.
  function timeRange(hoursBack, intervalMinutes) {
    const times = [];
    const stepMs = Math.max(10, intervalMinutes | 0) * 60000;
    // GIBS' newest GOES slot commonly trails wall-clock time by 10–20 min.
    // Starting two slots behind avoids requesting an HTTP-200 white
    // placeholder while the latest image is still being published.
    const nowRounded = Math.floor((Date.now() - 20 * 60000) / 600000) * 600000;
    const start = nowRounded - Math.max(1, hoursBack | 0) * 3600000;
    for (let t = start; t <= nowRounded; t += stepMs) {
      const rounded = Math.floor(t / 600000) * 600000;
      times.push(`${new Date(rounded).toISOString().slice(0, 16)}:00Z`);
    }
    return times;
  }

  function sampleCanvasStats(canvas) {
    const w = canvas.width, h = canvas.height;
    if (w <= 0 || h <= 0) return { blank: true, coverage: 0 };
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, w, h);
    let dark = 0, white = 0, n = 0, sum = 0, sumSq = 0;
    for (let i = 0; i < data.length; i += 4 * 16) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      const gray = r * 0.299 + g * 0.587 + b * 0.114;
      n++;
      if (a < 10 || (r < 35 && g < 35 && b < 35)) dark++;
      if (a > 245 && r > 246 && g > 246 && b > 246) white++;
      sum += gray;
      sumSq += gray * gray;
    }
    const coverage = n > 0 ? 1 - dark / n : 0;
    const mean = n ? sum / n : 0;
    const variance = n ? Math.max(0, sumSq / n - mean * mean) : 0;
    // GIBS occasionally returns a rendered white/error PNG with HTTP 200.
    // Treat only an overwhelmingly white, low-detail canvas as invalid;
    // snow, cloud decks and bright desert retain real spatial variation.
    const renderedError = n > 0 && white / n > 0.965 && variance < 90;
    return { blank: n > 0 && (dark / n > 0.98 || renderedError), coverage, renderedError };
  }

  function frameFingerprint(canvas) {
    const probe = document.createElement("canvas");
    probe.width = FINGERPRINT_GRID;
    probe.height = FINGERPRINT_GRID;
    const pctx = probe.getContext("2d");
    pctx.drawImage(canvas, 0, 0, FINGERPRINT_GRID, FINGERPRINT_GRID);
    const { data } = pctx.getImageData(0, 0, FINGERPRINT_GRID, FINGERPRINT_GRID);
    const gray = new Float64Array(FINGERPRINT_GRID * FINGERPRINT_GRID);
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4;
      gray[i] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
    }
    return gray;
  }

  // Providers that publish transparent PNGs mark missing data with alpha 0, so
  // a partially covered tile can be completed pixel-by-pixel from a second
  // request. JPEG products (GIBS true colour, EOX, Esri) bake no-data in as
  // pure black, so for those only a whole tile can be substituted.
  function providerUsesAlpha(layerId) {
    return layerId === "sentinelhub" || !!window.MetisGeoSat?.SATELLITES[layerId];
  }

  // Fraction of sampled pixels carrying real imagery. Thresholds are
  // deliberately strict: dark ocean, night-side GeoColor and deep shadow are
  // all still data; only transparency and pure no-data black are not.
  function coverageFromImageData(data, sampleCount) {
    let filled = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 12) continue;
      if (data[i] < 8 && data[i + 1] < 8 && data[i + 2] < 8) continue;
      filled++;
    }
    return sampleCount > 0 ? filled / sampleCount : 0;
  }

  let sharedProbe = null;
  function probeContext(size) {
    if (!sharedProbe) sharedProbe = document.createElement("canvas");
    if (sharedProbe.width !== size || sharedProbe.height !== size) {
      sharedProbe.width = size;
      sharedProbe.height = size;
    }
    const ctx = sharedProbe.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, size, size);
    return ctx;
  }

  function imageCoverage(img) {
    const ctx = probeContext(PROBE_SIZE);
    ctx.drawImage(img, 0, 0, PROBE_SIZE, PROBE_SIZE);
    const { data } = ctx.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE);
    return coverageFromImageData(data, PROBE_SIZE * PROBE_SIZE);
  }

  function regionCoverage(canvas, x, y, w, h) {
    const sx = Math.max(0, Math.round(x));
    const sy = Math.max(0, Math.round(y));
    const sw = Math.min(canvas.width - sx, Math.round(w + Math.min(0, x)));
    const sh = Math.min(canvas.height - sy, Math.round(h + Math.min(0, y)));
    // A cell entirely outside the crop can never be improved; report it full.
    if (sw <= 0 || sh <= 0) return 1;
    const ctx = probeContext(PROBE_SIZE);
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, PROBE_SIZE, PROBE_SIZE);
    const { data } = ctx.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE);
    return coverageFromImageData(data, PROBE_SIZE * PROBE_SIZE);
  }

  function canvasDataCoverage(canvas) {
    const ctx = probeContext(CANVAS_PROBE_SIZE);
    ctx.drawImage(canvas, 0, 0, CANVAS_PROBE_SIZE, CANVAS_PROBE_SIZE);
    const { data } = ctx.getImageData(0, 0, CANVAS_PROBE_SIZE, CANVAS_PROBE_SIZE);
    return coverageFromImageData(data, CANVAS_PROBE_SIZE * CANVAS_PROBE_SIZE);
  }

  // Opaque JPEG products bake no-data in as pure black, which blocks any
  // attempt to composite a second source underneath. Keying that black out to
  // alpha makes them behave like the transparent PNG products, so an inter-
  // orbit wedge cutting *through* a tile can be filled pixel by pixel rather
  // than only when a whole tile happens to be empty.
  let keyScratch = null;
  function keyTileNoData(img) {
    const w = img.naturalWidth || TILE_SIZE;
    const h = img.naturalHeight || TILE_SIZE;
    if (!keyScratch) keyScratch = document.createElement("canvas");
    if (keyScratch.width !== w || keyScratch.height !== h) {
      keyScratch.width = w;
      keyScratch.height = h;
    }
    const kctx = keyScratch.getContext("2d", { willReadFrequently: true });
    kctx.clearRect(0, 0, w, h);
    kctx.drawImage(img, 0, 0);
    const image = kctx.getImageData(0, 0, w, h);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 8 && d[i + 1] < 8 && d[i + 2] < 8) d[i + 3] = 0;
    }
    kctx.putImageData(image, 0, 0);
    return keyScratch;
  }

  function shiftGoesSlot(iso, minutesBack) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const rounded = Math.floor((t - minutesBack * 60000) / 600000) * 600000;
    return `${new Date(rounded).toISOString().slice(0, 16)}:00Z`;
  }

  // Ordered extra requests to try for tiles the primary request left empty.
  // Each provider degrades along its own natural axis: Sentinel widens the
  // scene-search window and then drops the cloud cap, GIBS true colour falls
  // back to the other daily sensors, GOES steps back through 10-minute slots,
  // and EOX steps back a yearly composite.
  function gapFillPlan(layerId, windowDays) {
    if (layerId === "sentinelhub") {
      const base = Math.max(1, windowDays | 0);
      const plan = [];
      const seen = new Set([base]);
      // Cheapest attempt first: some WMS layers (confirmed live: an official
      // Landsat template) don't resolve a start/end TIME range the way
      // Sentinel-2 does -- a range collapses to almost nothing regardless
      // of how wide it is, while a bare single date returns the real scene.
      // Try that before spending requests widening a window that testing
      // showed makes no difference for layers with this behavior.
      plan.push({ singleDate: true, label: "exact date, no search window" });
      for (const days of [base * 2, base * 4, SENTINEL_MAX_WINDOW_DAYS]) {
        const w = Math.min(SENTINEL_MAX_WINDOW_DAYS, Math.round(days));
        if (w > base && !seen.has(w)) {
          seen.add(w);
          plan.push({ windowDays: w, label: `${w}-day search window` });
        }
      }
      plan.push({
        windowDays: SENTINEL_MAX_WINDOW_DAYS,
        maxcc: 100,
        label: `${SENTINEL_MAX_WINDOW_DAYS}-day window, cloud cap lifted`,
      });
      return plan;
    }
    if (GIBS_PRODUCTS[layerId]) {
      return Object.keys(GIBS_PRODUCTS)
        .filter((id) => id !== layerId)
        .map((id) => ({ siblingLayer: id, label: GIBS_PRODUCTS[id].label }));
    }
    if (window.MetisGeoSat?.SATELLITES[layerId]) {
      // EUMETSAT's WMS snaps any requested time to its nearest real slot
      // (capabilities declare nearestValue="1"), so an imprecise 10-min-grid
      // shift still resolves to a real scene even on Meteosat's 15-min
      // cadence -- no separate step size needed per provider.
      return [10, 20, 30, 60].map((minutes) => ({ shiftMinutes: minutes, label: `${minutes} min earlier` }));
    }
    if (layerId === "s2cloudless") {
      return [1, 2].map((yearsBack) => ({ yearsBack, label: `${yearsBack}y earlier composite` }));
    }
    return [];
  }

  function create({ map, rasterOverlays }) {
    const frameCache = new Map(); // date -> { canvas, meta }
    let playTimer = null;
    let playIndex = 0;
    let playDirection = 1;
    let loopMode = "forward"; // forward | reverse | bounce
    let currentDates = [];
    let overlayCanvas = null;
    let capturedBounds = null;
    let overlayOpacity = 1;
    let loadController = null;
    const tileCache = new Map(); // url -> HTMLImageElement

    function throwIfAborted(signal) {
      if (signal?.aborted) throw new Error("Cancelled");
    }

    function rememberTile(url, img) {
      tileCache.set(url, img);
      if (tileCache.size > TILE_CACHE_MAX) {
        const oldest = tileCache.keys().next().value;
        tileCache.delete(oldest);
      }
    }

    async function loadTileCached(url, signal) {
      if (tileCache.has(url)) return tileCache.get(url);
      const img = await loadImageRetry(url, TILE_RETRY_ATTEMPTS, signal);
      rememberTile(url, img);
      return img;
    }

    function cancelLoad() {
      if (loadController) {
        loadController.abort();
        loadController = null;
      }
    }

    function sentinelTileUrl(date, z, x, y, windowDays, maxccOverride, singleDate) {
      const instanceId = window.MetisApiKeys?.keyFor("sentinelhub");
      if (!instanceId) return null;
      const nw = map.unproject([x * TILE_SIZE, y * TILE_SIZE], z);
      const se = map.unproject([(x + 1) * TILE_SIZE, (y + 1) * TILE_SIZE], z);
      const nwM = L.CRS.EPSG3857.project(nw);
      const seM = L.CRS.EPSG3857.project(se);
      return window.MetisSentinelHub.tileUrl({
        instanceId,
        layer: window.MetisApiKeys?.layerFor("sentinelhub") || "TRUE_COLOR",
        endDate: date,
        maxcc: maxccOverride != null ? maxccOverride : window.MetisApiKeys?.ccFor("sentinelhub"),
        resample: window.MetisApiKeys?.resampleFor("sentinelhub"),
        priority: window.MetisApiKeys?.priorityFor("sentinelhub"),
        bboxMeters: `${nwM.x},${seM.y},${seM.x},${nwM.y}`,
        size: TILE_SIZE,
        windowDays,
        singleDate,
      });
    }

    function tileUrlFor(layerId, date, releases, z, x, y) {
      const gibs = GIBS_PRODUCTS[layerId];
      if (gibs) {
        return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${gibs.layer}/default/${date}/${gibs.level}/${z}/${y}/${x}.${gibs.ext}`;
      }
      if (window.MetisGeoSat?.SATELLITES[layerId]) {
        const info = window.MetisGeoSat.layerInfo(layerId);
        if (!info) return null;
        if (info.type === "wmts") {
          return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${info.gibsLayer}/default/${date}/GoogleMapsCompatible_Level${info.maxNativeZoom}/${z}/${y}/${x}.png`;
        }
        // EUMETSAT is WMS, not WMTS -- no {z}/{y}/{x} template, build a
        // per-tile GetMap request the same way sentinelTileUrl() does
        // (project the tile's pixel corners to EPSG:3857 meters for bbox).
        // `date` here is already the exact "YYYY-MM-DDTHH:MM:00Z" shape
        // timeRange()/shiftGoesSlot() produce, which matches EUMETSAT's own
        // TIME dimension format directly -- no reformatting needed.
        const nw = map.unproject([x * TILE_SIZE, y * TILE_SIZE], z);
        const se = map.unproject([(x + 1) * TILE_SIZE, (y + 1) * TILE_SIZE], z);
        const nwM = L.CRS.EPSG3857.project(nw);
        const seM = L.CRS.EPSG3857.project(se);
        const params = new URLSearchParams({
          service: "WMS", request: "GetMap", layers: info.wmsLayer, styles: "",
          format: "image/png", transparent: "true", version: "1.3.0",
          width: String(TILE_SIZE), height: String(TILE_SIZE), crs: "EPSG:3857",
          bbox: `${nwM.x},${seM.y},${seM.x},${nwM.y}`, time: date,
        });
        return `${info.wmsBase}?${params.toString()}`;
      }
      if (layerId === "s2cloudless") {
        return `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${date}_3857/default/GoogleMapsCompatible/${z}/${y}/${x}.jpg`;
      }
      let release = releases[0];
      for (const r of releases) { if (r.date <= date) release = r; }
      if (!release) return null;
      return release.url.replace("{level}", z).replace("{row}", y).replace("{col}", x);
    }

    function labelsTileUrl(z, x, y) {
      return `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;
    }

    // Composites every tile touching the given pixel-space rect at zoom z.
    // Labels are drawn only after imagery tiles for that cell succeed, so a
    // failed imagery tile doesn't leave orphan place-name text over a hole.
    async function captureFrame(layerId, date, releases, {
      nw, se, z, renderScale = 1, withLabels, windowDays, gapFill = false, signal,
    }) {
      // Keep the exact projected viewport at the provider's native zoom.
      // Leaflet scales this same native crop on screen when the map is zoomed
      // past maxNativeZoom; expanding it to a whole tile changed the extent.
      const width = Math.max(1, Math.ceil((se.x - nw.x) * renderScale));
      const height = Math.max(1, Math.ceil((se.y - nw.y) * renderScale));
      // A personal Sentinel Hub free-tier instance rate-limits far more
      // readily than the public tile providers below -- 6 tiles fired at
      // once from a single frame was enough to trip a 429 on it. Every
      // WMS tile in a frame goes to that same account/instance, so this
      // (unlike frame-level concurrency, already 1 for Sentinel) is what
      // actually controls how many requests land on it per second.
      const tileConcurrency = layerId === "sentinelhub" ? 3 : TILE_FETCH_CONCURRENCY;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      // The canvas is left transparent until the very end so gap-fill passes
      // can composite *underneath* the imagery already drawn. The dark
      // background is applied last, with the same destination-over trick.
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const drawSize = TILE_SIZE * renderScale;

      const plan = gapFill ? gapFillPlan(layerId, windowDays) : [];
      const nativeAlpha = providerUsesAlpha(layerId);
      // Only pay the per-tile keying cost when there is actually a fallback
      // source that could be composited underneath.
      const keyNoData = plan.length > 0 && !nativeAlpha;
      const perPixelFill = nativeAlpha || keyNoData;

      // Must stay synchronous between keying and drawing: keyTileNoData reuses
      // one scratch canvas across all cells.
      function drawTile(img, cell) {
        ctx.drawImage(keyNoData ? keyTileNoData(img) : img, cell.drawX, cell.drawY, drawSize, drawSize);
      }

      const maxTile = 2 ** z - 1;
      const tileXStart = Math.max(0, Math.floor(nw.x / TILE_SIZE));
      const tileXEnd = Math.min(maxTile, Math.floor((se.x - 1) / TILE_SIZE));
      const tileYStart = Math.max(0, Math.floor(nw.y / TILE_SIZE));
      const tileYEnd = Math.min(maxTile, Math.floor((se.y - 1) / TILE_SIZE));

      let tileOk = 0, tileFail = 0;
      const cells = [];
      for (let tx = tileXStart; tx <= tileXEnd; tx++) {
        for (let ty = tileYStart; ty <= tileYEnd; ty++) {
          cells.push({
            tx,
            ty,
            drawX: (tx * TILE_SIZE - nw.x) * renderScale,
            drawY: (ty * TILE_SIZE - nw.y) * renderScale,
            coverage: 0,
            loaded: false,
          });
        }
      }

      function primaryUrl(tx, ty) {
        return layerId === "sentinelhub"
          ? sentinelTileUrl(date, z, tx, ty, windowDays)
          : tileUrlFor(layerId, date, releases, z, tx, ty);
      }

      async function drawLabels(cell) {
        if (!withLabels) return;
        try {
          const label = await loadTileCached(labelsTileUrl(z, cell.tx, cell.ty), signal);
          ctx.drawImage(label, cell.drawX, cell.drawY, drawSize, drawSize);
        } catch {
          /* labels are optional */
        }
      }

      const imageryTasks = cells.map((cell) => async () => {
        const url = primaryUrl(cell.tx, cell.ty);
        if (!url) { tileFail++; return; }
        try {
          const img = await loadTileCached(url, signal);
          drawTile(img, cell);
          cell.loaded = true;
          cell.coverage = imageCoverage(img);
          tileOk++;
          await drawLabels(cell);
        } catch (err) {
          if (err?.message === "Cancelled") throw err;
          tileFail++;
        }
      });

      await runLimited(imageryTasks, tileConcurrency, signal);

      // A retry pass runs after the first batch has drained. The normal
      // Leaflet view gets this behavior naturally as tiles are revisited;
      // playback must explicitly give transient WMS failures the same chance.
      if (tileFail > 0 && tileOk > 0) {
        const retryTasks = [];
        for (const cell of cells) {
          if (cell.loaded) continue;
          const url = primaryUrl(cell.tx, cell.ty);
          if (!url) continue;
          retryTasks.push(async () => {
            try {
              const img = await loadTileCached(url, signal);
              drawTile(img, cell);
              cell.loaded = true;
              cell.coverage = imageCoverage(img);
              tileOk++;
              tileFail = Math.max(0, tileFail - 1);
              await drawLabels(cell);
            } catch (err) {
              if (err?.message === "Cancelled") throw err;
            }
          });
        }
        if (retryTasks.length) await runLimited(retryTasks, tileConcurrency, signal);
      }

      // Gap fill: anywhere the provider had nothing for this date, ask it
      // again along the axis it can actually degrade on (older scene window,
      // sibling sensor, earlier slot) and composite the result underneath what
      // is already drawn, so real data is never overwritten.
      const fillLabels = new Set();
      let gapFilledTiles = 0;
      if (plan.length) {
        const needsMore = (cell) => (
          perPixelFill ? cell.coverage < TILE_FULL_COVERAGE : cell.coverage < TILE_EMPTY_COVERAGE
        );
        let pending = cells.filter(needsMore);
        for (const source of plan) {
          if (!pending.length) break;
          throwIfAborted(signal);
          // Open ocean and permanent no-data areas will never fill no matter
          // how far back we look, so stop spending requests on a cell after
          // two fruitless widenings. The final cloud-cap-lifted attempt is
          // qualitatively different and always gets a turn.
          const batch = source.maxcc != null
            ? pending
            : pending.filter((cell) => (cell.fillMisses || 0) < 2);
          if (!batch.length) continue;
          const tasks = batch.map((cell) => async () => {
            let url = null;
            if (source.singleDate) {
              url = sentinelTileUrl(date, z, cell.tx, cell.ty, windowDays, source.maxcc, true);
            } else if (source.windowDays != null) {
              url = sentinelTileUrl(date, z, cell.tx, cell.ty, source.windowDays, source.maxcc);
            } else if (source.siblingLayer) {
              url = tileUrlFor(source.siblingLayer, date, releases, z, cell.tx, cell.ty);
            } else if (source.shiftMinutes) {
              url = tileUrlFor(layerId, shiftGoesSlot(date, source.shiftMinutes), releases, z, cell.tx, cell.ty);
            } else if (source.yearsBack) {
              url = tileUrlFor(layerId, String(Number(date) - source.yearsBack), releases, z, cell.tx, cell.ty);
            }
            if (!url) {
              cell.fillMisses = (cell.fillMisses || 0) + 1;
              return;
            }
            try {
              const img = await loadTileCached(url, signal);
              const incoming = imageCoverage(img);
              if (incoming <= TILE_EMPTY_COVERAGE) {
                cell.fillMisses = (cell.fillMisses || 0) + 1;
                return;
              }
              // Compare the composited region before and after, not the raw
              // tile against it: place-name labels already burned into the
              // cell would otherwise read as data this source contributed.
              const before = regionCoverage(canvas, cell.drawX, cell.drawY, drawSize, drawSize);
              if (perPixelFill) {
                ctx.save();
                ctx.globalCompositeOperation = "destination-over";
                drawTile(img, cell);
                ctx.restore();
                if (!cell.loaded) await drawLabels(cell);
              } else {
                if (incoming <= before) {
                  cell.fillMisses = (cell.fillMisses || 0) + 1;
                  return;
                }
                drawTile(img, cell);
                await drawLabels(cell);
              }
              const after = regionCoverage(canvas, cell.drawX, cell.drawY, drawSize, drawSize);
              if (after > before + 0.01) {
                cell.coverage = after;
                cell.filled = true;
                fillLabels.add(source.label);
              } else {
                cell.coverage = Math.max(cell.coverage, after);
                cell.fillMisses = (cell.fillMisses || 0) + 1;
              }
              if (!cell.loaded) {
                cell.loaded = true;
                tileOk++;
                tileFail = Math.max(0, tileFail - 1);
              }
            } catch (err) {
              if (err?.message === "Cancelled") throw err;
              cell.fillMisses = (cell.fillMisses || 0) + 1;
            }
          });
          // eslint-disable-next-line no-await-in-loop
          await runLimited(tasks, tileConcurrency, signal);
          pending = pending.filter(needsMore);
        }
        gapFilledTiles = cells.filter((c) => c.filled).length;
      }

      // Measure real data coverage while no-data is still transparent/black,
      // then lay the dark background underneath everything drawn so far.
      const dataCoverage = canvasDataCoverage(canvas);
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = BACKGROUND_FILL;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();

      const total = tileOk + tileFail;
      const stats = sampleCanvasStats(canvas);
      return {
        canvas,
        tileOk,
        tileFail,
        tileCoverage: total ? tileOk / total : 0,
        pixelCoverage: dataCoverage,
        gapFilledTiles,
        gapFillSources: Array.from(fillLabels),
        // A successfully loaded transparent/dark tile is valid provider data
        // (ocean, night, or no-data swath) and must remain in the timeline.
        // Only a total transport failure or rendered white error is invalid.
        blank: tileOk === 0 || stats.renderedError,
      };
    }

    function annotate(canvas, { date, layerLabel, bounds, zoom, extra }) {
      const ctx = canvas.getContext("2d");
      const barHeight = 26;
      ctx.fillStyle = "rgba(6,23,30,.78)";
      ctx.fillRect(0, canvas.height - barHeight, canvas.width, barHeight);
      ctx.fillStyle = "#d8d1bc";
      ctx.font = "13px 'IBM Plex Mono', Consolas, monospace";
      ctx.textBaseline = "middle";
      const coordText = `${bounds.getSouth().toFixed(2)},${bounds.getWest().toFixed(2)} → ${bounds.getNorth().toFixed(2)},${bounds.getEast().toFixed(2)}`;
      const extraText = extra ? `  ·  ${extra}` : "";
      ctx.fillText(`${date}  ·  ${layerLabel}${extraText}  ·  z${zoom}  ·  ${coordText}`, 8, canvas.height - barHeight / 2);
      return canvas;
    }

    function viewportProbePoints(bounds) {
      return [
        bounds.getCenter(),
        bounds.getNorthWest(),
        bounds.getNorthEast(),
        bounds.getSouthWest(),
        bounds.getSouthEast(),
      ];
    }

    // Walk Wayback releases newest→oldest until we have N *distinct* resolved
    // imagery fingerprints for this viewport (not merely the last N global
    // release titles, which often redirect to identical tiles here).
    async function selectDistinctWaybackFrames(releases, targetCount, z, bounds, onProgress, signal) {
      const points = viewportProbePoints(bounds);
      const newestFirst = [];
      for (let i = releases.length - 1; i >= 0; i--) newestFirst.push(i);
      // Do not stop at a multiplier boundary: sparse areas can redirect over
      // many global releases before their next local imagery update.
      const searchLimit = newestFirst.length;
      const candidates = newestFirst.slice(0, searchLimit);
      const seen = new Set();
      const distinct = [];
      const skipped = [];
      let scanned = 0;

      for (let offset = 0; offset < candidates.length && distinct.length < targetCount; offset += WAYBACK_PROBE_BATCH) {
        throwIfAborted(signal);
        const batchIdx = candidates.slice(offset, offset + WAYBACK_PROBE_BATCH);
        const fps = await Promise.all(batchIdx.map((idx) => (
          rasterOverlays.probeWorldImageryFingerprint
            ? rasterOverlays.probeWorldImageryFingerprint(idx, z, points)
            : rasterOverlays.probeWorldImageryItemId(idx, z, points[0]).then((id) => id || "")
        )));
        for (let j = 0; j < batchIdx.length; j++) {
          scanned++;
          const idx = batchIdx[j];
          const release = releases[idx];
          const fp = fps[j];
          // A transient redirect-probe failure must not make a real release
          // disappear. Keep it as a unique fallback candidate and let the
          // actual tile capture decide whether data is available.
          const usableFp = (!fp || fp === "||||" || /^\|+$/.test(fp))
            ? `release:${release.itemId || release.date}`
            : fp;
          if (seen.has(usableFp)) {
            skipped.push({ date: release.date, reason: "same imagery for this view" });
            continue;
          }
          seen.add(usableFp);
          // Record the oldest resolved component only as metadata. Capture
          // using the requested release URL itself: Esri then redirects every
          // tile independently, reproducing the mixed-age mosaic seen live.
          const ids = fp.split("|").filter(Boolean);
          let resolvedDate = release.date;
          for (const id of ids) {
            const match = releases.find((r) => r.itemId === id);
            if (match && match.date <= resolvedDate) {
              resolvedDate = match.date;
            }
          }
          distinct.push({
            date: release.date,
            requestDate: release.date,
            resolvedDate,
            releaseIndex: idx,
            release,
            fingerprint: usableFp,
          });
          if (distinct.length >= targetCount) break;
        }
        onProgress?.(
          distinct.length,
          targetCount,
          `Probing Wayback… ${distinct.length}/${targetCount} distinct (${scanned} scanned)`,
        );
      }

      // Playback oldest → newest
      distinct.reverse();
      return { frames: distinct, skipped, scanned };
    }

    async function loadFrames({
      layerId, startDate, endDate, stepDays, hoursBack, intervalMinutes,
      releaseCount, yearsCount, withLabels, gapFill = false,
      onProgress,
    }) {
      cancelLoad();
      loadController = new AbortController();
      const signal = loadController.signal;
      clearFrames({ keepController: true });
      tileCache.clear();

      // "isGoes" now covers all five geostationary satellites (GOES-East/
      // West, Himawari, Meteosat-0/IODC) -- all share the same hours-back +
      // interval-minutes playback UI and slot-shifting gap fill, kept the
      // shorter name since it's used throughout this function already.
      const isGoes = !!window.MetisGeoSat?.SATELLITES[layerId];
      const isWayback = layerId === "worldimagery";
      const isS2 = layerId === "s2cloudless";
      const isSH = layerId === "sentinelhub";
      const gibs = GIBS_PRODUCTS[layerId];
      // Playback must request exactly what the normal layer would show for
      // the same selected day. Both paths therefore use the shared live
      // window; there is no playback-only widening or coverage preflight.
      const shWindow = window.MetisSentinelHub?.WINDOW_DAYS ?? 10;
      // Not every GOES/Himawari product shares GeoColor's zoom-7 ceiling --
      // Air Mass and Clean Infrared cap at 6, confirmed against GIBS' own
      // capabilities (see geo-satellite-picker.js). Read the real ceiling
      // for whichever product is currently selected instead of assuming 7.
      const geoInfo = isGoes ? window.MetisGeoSat?.layerInfo(layerId) : null;

      const maxNativeZoom = gibs ? gibs.maxNativeZoom
        : isGoes ? (geoInfo?.maxNativeZoom ?? 7)
        : isS2 ? 14
        : isSH ? 18
        : 19;
      const z = Math.min(maxNativeZoom, Math.round(map.getZoom()));
      // Same CSS upscale Leaflet applies beyond maxNativeZoom, but baked into
      // the capture canvas so export and playback preserve the screen extent
      // without substituting a larger one-tile area.
      const renderScale = 2 ** Math.max(0, map.getZoom() - z);
      if (isSH && z < 10) {
        throw new Error("Zoom in further (at least city level, z10+) before loading Sentinel Hub frames -- the provider rejects lower-resolution requests.");
      }
      if (isSH && !window.MetisApiKeys?.keyFor("sentinelhub")) {
        throw new Error("Add a Sentinel Hub instance ID first (toggle the layer on in the Satellite rail).");
      }

      let bounds = map.getBounds();
      let nw = map.project(bounds.getNorthWest(), z);
      let se = map.project(bounds.getSouthEast(), z);
      if (!Number.isFinite(nw.x) || !Number.isFinite(se.x) || se.x - nw.x <= 0 || se.y - nw.y <= 0) {
        map.invalidateSize();
        await new Promise((resolve) => setTimeout(resolve, 80));
        throwIfAborted(signal);
        bounds = map.getBounds();
        nw = map.project(bounds.getNorthWest(), z);
        se = map.project(bounds.getSouthEast(), z);
        if (!Number.isFinite(nw.x) || !Number.isFinite(se.x) || se.x - nw.x <= 0 || se.y - nw.y <= 0) {
          throw new Error("Map view isn't ready yet -- pan/zoom the map and try again.");
        }
      }
      let releases = [];
      let waybackFrames = null;
      let dates;
      let targetCount = null;
      const skipped = [];

      if (isWayback) {
        releases = await rasterOverlays.ensureReleasesLoaded();
        throwIfAborted(signal);
        if (!releases.length) throw new Error("Wayback release list unavailable");
        targetCount = Math.min(Math.max(1, releaseCount | 0) || 12, MAX_FRAMES);
        onProgress?.(0, targetCount, "Finding distinct Wayback releases for this view…");
        const selected = await selectDistinctWaybackFrames(
          releases, targetCount, z, bounds, onProgress, signal,
        );
        skipped.push(...selected.skipped);
        waybackFrames = selected.frames;
        dates = waybackFrames.map((f) => f.date);
        if (!dates.length) throw new Error("No distinct releases found for this view — try zooming in or picking a different area.");
      } else if (isS2) {
        const yearBounds = rasterOverlays.s2YearBounds;
        const endYear = rasterOverlays.getS2Year();
        const n = Math.min(Math.max(1, yearsCount | 0) || 5, yearBounds.max - yearBounds.min + 1);
        dates = [];
        for (let y = endYear - n + 1; y <= endYear; y++) {
          if (y >= yearBounds.min) dates.push(String(y));
        }
      } else {
        dates = capDates(
          isGoes ? timeRange(hoursBack, intervalMinutes) : dateRange(startDate, endDate, stepDays),
          MAX_FRAMES,
        );
      }
      if (!dates.length) {
        throw new Error(isGoes ? "Invalid time range" : isWayback ? "No distinct releases found for this view" : isS2 ? "No years in range" : "Invalid date range");
      }

      const shLayerName = isSH ? (window.MetisApiKeys?.layerFor("sentinelhub") || "TRUE_COLOR") : "";
      const layerLabel = gibs ? gibs.label
        : isGoes ? `${geoInfo?.satLabel ?? "Geostationary"} (${geoInfo?.productLabel ?? "GeoColor"})`
        : isS2 ? "EOX Sentinel-2 cloud-free"
        : isSH ? `Sentinel (${shLayerName})`
        : "Esri World Imagery (Wayback)";

      // Build work list (candidate → optional preflight metadata)
      const work = [];
      if (isWayback) {
        for (const frame of waybackFrames) {
          work.push({
            date: frame.date,
            releasesForCapture: [frame.release],
            meta: { requestDate: frame.requestDate, resolvedDate: frame.resolvedDate },
          });
        }
      } else {
        for (const date of dates) work.push({ date });
      }

      if (!work.length) {
        throw new Error("No frames had visible data for this view -- try a wider date range, a different area, or a higher cloud-coverage cap.");
      }

      const keptDates = [];
      let done = 0;

      async function processOne(item, indexHint) {
        throwIfAborted(signal);
        const date = item.date;
        const captureReleases = item.releasesForCapture || releases;
        const captureDate = isWayback ? item.releasesForCapture[0].date : date;
        const captured = await captureFrame(layerId, captureDate, captureReleases, {
          nw, se, z, renderScale, withLabels, windowDays: shWindow, gapFill, signal,
        });
        done++;
        if (captured.blank) {
          skipped.push({ date, reason: "no data" });
          onProgress?.(done, work.length, `${date} (no data -- skipped)`);
          return null;
        }
        // Fingerprint *before* the date bar is burned in — the bar is nearly
        // identical across frames and would otherwise inflate "same as previous"
        // false positives in the ordered dedup pass below.
        const fp = frameFingerprint(captured.canvas);

        let frameLabel = layerLabel;
        let labelDate = date;
        let extra = "";
        if (isSH) {
          frameLabel += ` · ${shWindow}-day live window`;
        } else if (isWayback && item.meta?.resolvedDate && item.meta.resolvedDate !== date) {
          extra = `mosaic contains imagery back to ${item.meta.resolvedDate}`;
        }
        if (captured.tileFail > 0) {
          extra = `${extra ? `${extra} · ` : ""}${captured.tileOk}/${captured.tileOk + captured.tileFail} tiles`;
        }
        const coveragePct = Math.round(captured.pixelCoverage * 100);
        extra = `${extra ? `${extra} · ` : ""}${coveragePct}% imagery`;
        if (captured.gapFilledTiles > 0) {
          extra += ` (${captured.gapFilledTiles} tiles gap-filled: ${captured.gapFillSources.join(", ")})`;
        }

        annotate(captured.canvas, {
          date: labelDate,
          layerLabel: frameLabel,
          bounds,
          zoom: z,
          extra,
        });
        onProgress?.(done, work.length, `${labelDate} (${coveragePct}%)`);
        return {
          key: labelDate + (isWayback ? `@${item.meta?.requestDate || date}` : ""),
          date: labelDate,
          canvas: captured.canvas,
          fingerprint: fp,
          coverage: captured.pixelCoverage,
          gapFilledTiles: captured.gapFilledTiles,
          order: indexHint,
        };
      }

      // Parallel capture for independent candidates; keep order afterwards.
      const results = new Array(work.length);
      let nextWork = 0;
      async function captureWorker() {
        while (nextWork < work.length) {
          throwIfAborted(signal);
          const idx = nextWork++;
          // eslint-disable-next-line no-await-in-loop
          results[idx] = await processOne(work[idx], idx);
        }
      }
      const frameConcurrency = isSH ? 1 : FRAME_CAPTURE_CONCURRENCY;
      await Promise.all(
        Array.from({ length: Math.min(frameConcurrency, work.length) }, () => captureWorker()),
      );

      // Preserve every requested date. Wayback candidates were already
      // redirect-deduplicated before capture; other providers may legitimately
      // show the same pixels on adjacent dates and must not lose timeline slots.
      const seenKeys = new Set();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r) continue;
        if (seenKeys.has(r.key)) {
          skipped.push({ date: r.date, reason: "duplicate scene" });
          continue;
        }
        seenKeys.add(r.key);
        const cacheKey = r.key;
        frameCache.set(cacheKey, {
          canvas: r.canvas,
          meta: { date: r.date, coverage: r.coverage, gapFilledTiles: r.gapFilledTiles },
        });
        keptDates.push(cacheKey);
        if (targetCount != null && keptDates.length >= targetCount) break;
      }

      if (!keptDates.length) {
        throw new Error("No frames had visible data for this view -- try a wider date range, a different area, zoom in, or a higher cloud-coverage cap.");
      }

      currentDates = keptDates;
      capturedBounds = bounds;
      loadController = null;
      const coverages = keptDates.map((k) => frameCache.get(k)?.meta?.coverage ?? 0);
      const gapFilled = keptDates.reduce((sum, k) => sum + (frameCache.get(k)?.meta?.gapFilledTiles || 0), 0);
      return {
        dates: keptDates.map((k) => frameCache.get(k)?.meta?.date || k),
        keys: keptDates.slice(),
        skipped,
        targetCount,
        gapFilledTiles: gapFilled,
        meanCoverage: coverages.length
          ? coverages.reduce((a, b) => a + b, 0) / coverages.length
          : 0,
        minCoverage: coverages.length ? Math.min(...coverages) : 0,
        sparseFrames: keptDates
          .map((k) => frameCache.get(k)?.meta)
          .filter((m) => m && m.coverage < 0.5)
          .map((m) => m.date),
      };
    }

    function clearFrames({ keepController = false } = {}) {
      stopPlayback();
      if (!keepController) cancelLoad();
      frameCache.clear();
      currentDates = [];
      capturedBounds = null;
      hideOverlay();
    }

    function ensureOverlay() {
      if (overlayCanvas) return overlayCanvas;
      overlayCanvas = document.createElement("canvas");
      overlayCanvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:650";
      overlayCanvas.style.opacity = String(overlayOpacity);
      map.getContainer().appendChild(overlayCanvas);
      return overlayCanvas;
    }

    function hideOverlay() {
      if (overlayCanvas) { overlayCanvas.remove(); overlayCanvas = null; }
    }

    function setOverlayOpacity(value) {
      overlayOpacity = Math.max(0.15, Math.min(1, Number(value) || 1));
      if (overlayCanvas) overlayCanvas.style.opacity = String(overlayOpacity);
    }

    // Frames are pinned to the geographic bounds they were captured over, so
    // any pan/zoom has to re-place the overlay or it slides off the ground it
    // belongs to.
    function positionOverlay() {
      if (!overlayCanvas || !capturedBounds) return;
      const topLeft = map.latLngToContainerPoint(capturedBounds.getNorthWest());
      const bottomRight = map.latLngToContainerPoint(capturedBounds.getSouthEast());
      overlayCanvas.style.left = `${topLeft.x}px`;
      overlayCanvas.style.top = `${topLeft.y}px`;
      overlayCanvas.style.width = `${bottomRight.x - topLeft.x}px`;
      overlayCanvas.style.height = `${bottomRight.y - topLeft.y}px`;
    }
    map.on("move zoomend viewreset resize", positionOverlay);

    function showFrame(index) {
      if (!currentDates.length || !capturedBounds) return;
      const date = currentDates[Math.max(0, Math.min(currentDates.length - 1, index))];
      const entry = frameCache.get(date);
      if (!entry) return;
      const canvas = ensureOverlay();
      canvas.width = entry.canvas.width;
      canvas.height = entry.canvas.height;
      positionOverlay();
      canvas.style.opacity = String(overlayOpacity);
      canvas.getContext("2d").drawImage(entry.canvas, 0, 0);
      playIndex = currentDates.indexOf(date);
    }

    function setLoopMode(mode) {
      loopMode = mode === "reverse" || mode === "bounce" ? mode : "forward";
      playDirection = loopMode === "reverse" ? -1 : 1;
    }

    function advanceIndex() {
      if (loopMode === "bounce") {
        let next = playIndex + playDirection;
        if (next >= currentDates.length || next < 0) {
          playDirection *= -1;
          next = playIndex + playDirection;
        }
        playIndex = Math.max(0, Math.min(currentDates.length - 1, next));
        return playIndex;
      }
      if (loopMode === "reverse") {
        playIndex = (playIndex - 1 + currentDates.length) % currentDates.length;
        return playIndex;
      }
      playIndex = (playIndex + 1) % currentDates.length;
      return playIndex;
    }

    function play(intervalMs, onFrame) {
      stopPlayback();
      playTimer = setInterval(() => {
        const index = advanceIndex();
        showFrame(index);
        onFrame?.(index, frameCache.get(currentDates[index])?.meta?.date || currentDates[index]);
      }, intervalMs);
    }

    function stopPlayback() {
      if (playTimer) { clearInterval(playTimer); playTimer = null; }
    }

    function stepFrame(delta) {
      if (!currentDates.length) return 0;
      playIndex = (playIndex + delta + currentDates.length) % currentDates.length;
      showFrame(playIndex);
      return playIndex;
    }

    async function exportGif({ delayMs = 400, maxDimension = 1280 } = {}) {
      if (!window.MetisGifEncoder) throw new Error("GIF encoder not loaded");
      const frames = [];
      for (const date of currentDates) {
        const entry = frameCache.get(date);
        if (!entry) continue;
        let source = entry.canvas;
        // Downscale very large captures so GIF encode stays responsive.
        if (Math.max(source.width, source.height) > maxDimension) {
          const scale = maxDimension / Math.max(source.width, source.height);
          const w = Math.max(1, Math.round(source.width * scale));
          const h = Math.max(1, Math.round(source.height * scale));
          const scaled = document.createElement("canvas");
          scaled.width = w;
          scaled.height = h;
          scaled.getContext("2d").drawImage(source, 0, 0, w, h);
          source = scaled;
        }
        const ctx = source.getContext("2d");
        frames.push({ imageData: ctx.getImageData(0, 0, source.width, source.height), delayMs });
      }
      if (!frames.length) throw new Error("No frames loaded");
      const { width, height } = frames[0].imageData;
      return window.MetisGifEncoder.encode(frames, { width, height, loop: 0 });
    }

    // Full-resolution PNG of the frame currently on screen -- the GIF export
    // is palette-quantised and downscaled, which is the wrong format when the
    // point is to keep a single high-fidelity still.
    function exportFramePng(index = playIndex) {
      const key = currentDates[Math.max(0, Math.min(currentDates.length - 1, index))];
      const entry = key != null ? frameCache.get(key) : null;
      if (!entry) throw new Error("No frame loaded");
      return new Promise((resolve, reject) => {
        entry.canvas.toBlob((blob) => {
          if (blob) resolve({ blob, date: entry.meta?.date || key });
          else reject(new Error("Could not encode PNG"));
        }, "image/png");
      });
    }

    function frameInfo(index = playIndex) {
      const key = currentDates[Math.max(0, Math.min(currentDates.length - 1, index))];
      const meta = key != null ? frameCache.get(key)?.meta : null;
      return meta ? { ...meta } : null;
    }

    return {
      dateRange, timeRange, isoDay, loadFrames, clearFrames, cancelLoad,
      showFrame, play, stopPlayback, stepFrame, setLoopMode, setOverlayOpacity,
      exportGif, exportFramePng, frameInfo,
      currentIndex: () => playIndex,
      isPlaying: () => playTimer != null,
      frameCount: () => currentDates.length,
      dates: () => currentDates.map((k) => frameCache.get(k)?.meta?.date || k),
      maxFrames: MAX_FRAMES,
      maxFramesFor: () => MAX_FRAMES,
      gibsProducts: GIBS_PRODUCTS,
    };
  }

  return { create };
})();
