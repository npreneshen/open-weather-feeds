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
  // Captured frames are kept TRANSPARENT wherever the provider returned no
  // data, so the on-screen playback overlay lets the basemap (coastlines,
  // borders, place names) show through exactly like the live map does --
  // painting this behind every frame instead made the uncovered part of a
  // satellite disc a flat dark-teal slab that hid the map, which is the
  // "why does the empty area turn blue in playback" report. The fill is
  // still applied, but only when flattening a frame for export (GIF has no
  // useful alpha, and a transparent PNG of a satellite frame reads as
  // broken), via flattenForExport below.
  const BACKGROUND_FILL = "#06171e";
  // Long edge of the single big GetMap fetched for a geoWmsInfo-family
  // layer (Meteosat/MTG/Metop) when that satellite's "Single image" request
  // method is on -- see captureSingleImageWmsFrame below and the matching
  // live-map path in map-overlays.js's buildSingleImageWmsLayer. Routed
  // through the worker's /api/tiles/eumetsat proxy (this pipeline needs
  // real pixel access, unlike the live map's plain <img> tiles), whose
  // width/height cap was raised alongside this to fit it.
  const SINGLE_IMAGE_SIZE = 1536;
  // Largest side captureViewWmsFrame will ask the proxy for -- must stay at or
  // under server.py/_handle_eumetsat_tile's own 1600 limit. A view bigger than
  // this falls back to the tile grid rather than being fetched downscaled.
  const SINGLE_VIEW_MAX_PX = 1600;

  // "family" scopes gapFillPlan()'s sibling substitution below -- without it,
  // adding nightlights here would let a gap in it get filled from a daytime
  // true-colour sibling (or vice versa), compositing two unrelated kinds of
  // imagery together. Only same-family entries are ever offered as a
  // gap-fill source for each other.
  const GIBS_PRODUCTS = {
    // satellite/satelliteAqua/satelliteViirs/satelliteNoaa20/satelliteNoaa21
    // used to be fixed true-colour-only entries here; the satellite AND
    // product both now live in MetisDailySat (daily-satellite-picker.js),
    // resolved dynamically below in tileUrlFor/maxNativeZoom lookup, the
    // same way geoWmsInfo() already does for the GOES/Meteosat/MTG family --
    // so a product change there (e.g. VIIRS SNPP -> Night Lights) is picked
    // up here too instead of silently staying on true-colour.
    // NOAA-20's Day/Night Band, not SNPP's -- confirmed live against GIBS'
    // own GetCapabilities that SNPP's DayNightBand_ENCC stopped updating in
    // mid-2023 (its `default` still resolves to 2023, a current date 404s),
    // while NOAA-20's `default` resolves to today. Grayscale radiance data,
    // not a colourized composite (pixel-verified: every PLTE palette entry
    // has R=G=B) -- NASA's colourized "Black Marble" is a separate, only-
    // annually-updated product, not usable for daily playback.
    nightlights: {
      layer: "VIIRS_NOAA20_DayNightBand",
      level: "GoogleMapsCompatible_Level7",
      maxNativeZoom: 7,
      ext: "png",
      label: "NASA GIBS VIIRS/NOAA-20 nighttime lights",
      family: "nightlights",
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
  // latestSlotMs, if given, overrides the blind "-20min" guess below with an
  // actually-confirmed real slot (see resolveLatestGoesSlot) so the last
  // frame in a playback sequence matches what the live map's literal
  // "default" URL resolves to, instead of trailing it by however far off the
  // blind guess happened to land.
  // periodMinutes is the provider's REAL publish cadence for this layer, not
  // a display preference. It defaults to GIBS' 10-minute GOES grid, but
  // EUMETSAT's layers each declare their own in GetCapabilities and they are
  // wildly different -- measured live: Metop PT1H40M (a ~100-min polar
  // orbit), Meteosat PT15M, MTG PT10M, OSI SAF SST PT12H. Since those
  // Dimensions also declare nearestValue="1", every request inside one
  // period snaps onto the SAME scene, so stepping a 100-minute feed by the
  // UI's 10-minute interval returns the identical image repeatedly (measured:
  // 7 frames at 10-min steps = 1 distinct image; at 100-min steps = 3). Two
  // consequences, both handled below: the step is rounded UP to a whole
  // period, and a confirmed real slot is used EXACTLY rather than being
  // re-rounded onto a 10-minute wall-clock grid it was never on (Metop's
  // slots are orbit phase -- 12:07Z, not 12:00Z).
  function timeRange(hoursBack, intervalMinutes, latestSlotMs, periodMinutes) {
    const period = Math.max(1, Math.round(periodMinutes || 10));
    const periodMs = period * 60000;
    // Never step finer than the provider actually publishes, and always land
    // on a whole multiple of it so every frame is a genuinely distinct scene.
    const requestedMs = Math.max(period, intervalMinutes | 0) * 60000;
    const stepMs = Math.max(1, Math.round(requestedMs / periodMs)) * periodMs;
    // A confirmed slot (GetCapabilities' `default`, or resolveLatestGoesSlot's
    // pixel-verified probe) is a real published timestamp -- use it as-is.
    // Only the blind fallback needs snapping to the grid, and GIBS' newest
    // GOES slot commonly trails wall-clock by 10-20 min, so it starts two
    // slots behind to avoid an HTTP-200 white placeholder. Requesting ahead
    // of the real latest is not harmless: EUMETSAT answers a future TIME with
    // a slow HTTP 502, not a quick 404, so a wrong anchor costs minutes of
    // gateway timeouts across every tile of every frame.
    const anchor = latestSlotMs != null
      ? latestSlotMs
      : Math.floor((Date.now() - 20 * 60000) / periodMs) * periodMs;
    const span = Math.max(1, hoursBack | 0) * 3600000;
    const count = Math.max(1, Math.floor(span / stepMs) + 1);
    const times = [];
    for (let i = count - 1; i >= 0; i--) {
      times.push(`${new Date(anchor - i * stepMs).toISOString().slice(0, 16)}:00Z`);
    }
    return times;
  }

  // Probes backward from the true latest possible 10-min slot (no blind
  // buffer) and checks *actual pixel content* -- reusing sampleCanvasStats,
  // the same blank check the frame-capture pipeline already does -- because
  // a not-yet-published GIBS slot returns a real HTTP 200 with a blank
  // placeholder image, not a 404, so a status-code probe can't tell them
  // apart. Stops at the first confirmed-real slot; gives up after 5 tries
  // (50 minutes) and falls back to the old conservative guess rather than
  // returning an unconfirmed "now".
  async function resolveLatestGoesSlot(gibsLayer, maxNativeZoom, signal) {
    for (let back = 0; back < 5; back++) {
      if (signal?.aborted) throw new Error("Cancelled");
      const roundedMs = Math.floor((Date.now() - back * 600000) / 600000) * 600000;
      const iso = `${new Date(roundedMs).toISOString().slice(0, 16)}:00Z`;
      const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${gibsLayer}/default/${iso}/GoogleMapsCompatible_Level${maxNativeZoom}/2/1/1.png`;
      try {
        const img = await loadImage(url, signal);
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || 256;
        canvas.height = img.naturalHeight || 256;
        canvas.getContext("2d").drawImage(img, 0, 0);
        if (!sampleCanvasStats(canvas).blank) return roundedMs;
      } catch { /* try an earlier slot */ }
    }
    return Math.floor((Date.now() - 20 * 60000) / 600000) * 600000;
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

  // Leaflet's own tile layers wrap tile columns around the world, so a view
  // panned across the antimeridian (worldCopyJump leaves the map showing
  // longitudes outside -180..180) still renders imagery everywhere on
  // screen. The capture loops used to clamp tile X into [0, 2^z-1] instead,
  // which silently DROPPED every column outside that range and left that
  // slice of the frame transparent -- the reported "only part of the screen
  // gets fetched, the left side is unchanged". Columns wrap; rows do not,
  // since there is no world above the pole.
  function wrapTileX(tx, z) {
    const n = 2 ** z;
    return ((tx % n) + n) % n;
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

  // Cell-by-cell comparison of two frameFingerprint() grids: a cell counts
  // as "changed" only past CELL_DIFF_THRESHOLD of grayscale difference (so
  // ordinary compression noise between two identical-looking PNGs doesn't
  // register as a difference), and the two frames count as the same real
  // scene only when fewer than DUPLICATE_CHANGED_FRAC of all cells changed.
  // Used by loadFrames' Metop dedup pass below -- see enumStepDivisor.
  function framesLookIdentical(fpA, fpB) {
    if (!fpA || !fpB || fpA.length !== fpB.length) return false;
    let changed = 0;
    for (let i = 0; i < fpA.length; i++) {
      if (Math.abs(fpA[i] - fpB[i]) > CELL_DIFF_THRESHOLD) changed++;
    }
    return changed / fpA.length < DUPLICATE_CHANGED_FRAC;
  }

  // Metop shares the same EUMETSAT WMS host/mechanism as Meteosat/MTG above
  // (transparent PNG, time-dimension with nearestValue snapping) -- just a
  // different picker module (metop-picker.js, keyed by satellite id rather
  // than the geostationary family's per-disk ids), so every place below that
  // asks "is this a geostationary-style WMS/WMTS satellite" also has to ask
  // MetisMetop, not just MetisGeoSat. Centralised here so that only needs
  // saying once.
  function geoWmsInfo(layerId) {
    if (window.MetisGeoSat?.SATELLITES[layerId]) {
      return { ...window.MetisGeoSat.layerInfo(layerId), family: "geosat" };
    }
    if (window.MetisMetop?.SATELLITES[layerId]) {
      const info = window.MetisMetop.layerInfo(layerId);
      return info ? { ...info, type: "wms", maxNativeZoom: 12, family: "metop" } : null;
    }
    // SST (OSI SAF) is a global gridded composite, not tied to any one
    // satellite -- metop-picker.js's sstLayerInfo() has no satLabel/
    // productLabel the way layerInfo(satId) does, so those are filled in
    // here for the layerLabel/gap-fill-note plumbing that expects them.
    if (layerId === "metopSst" && window.MetisMetop?.sstLayerInfo) {
      const info = window.MetisMetop.sstLayerInfo();
      return info
        ? { ...info, type: "wms", maxNativeZoom: 12, family: "metopSst", satLabel: "Metop OSI SAF", productLabel: "Sea Surface Temperature" }
        : null;
    }
    return null;
  }

  // Whether captureFrame should fetch one big WMS image instead of tiling
  // this layer, and if so what geographic extent that image should cover --
  // shares the same "Single image" toggle (and, for geostationary, the same
  // per-satellite viewing bbox) as the live map's build() in map-overlays.js,
  // via requestMode()/viewBbox() on the same picker modules. Metop's own
  // coverage is already global (its GetCapabilities BoundingBox is a plain
  // -180..180/-90..90), so it always gets the whole-globe bbox regardless of
  // which one satellite/product the playback dropdown has selected.
  function singleImageBboxFor(layerId) {
    const info = geoWmsInfo(layerId);
    if (!info || info.type !== "wms") return null;
    if (info.family === "geosat") {
      if (window.MetisGeoSat?.requestMode?.() !== "single") return null;
      return window.MetisGeoSat.viewBbox(layerId);
    }
    if (info.family === "metop" || info.family === "metopSst") {
      if (window.MetisMetop?.requestMode?.() !== "single") return null;
      return { west: -180, south: -90, east: 180, north: 90 };
    }
    return null;
  }

  function singleImageWmsUrl(wmsLayer, bbox, time) {
    const height = Math.round(SINGLE_IMAGE_SIZE * ((bbox.north - bbox.south) / (bbox.east - bbox.west)));
    const params = new URLSearchParams({
      layers: wmsLayer, width: String(SINGLE_IMAGE_SIZE), height: String(height),
      crs: "EPSG:4326",
      // WMS 1.3.0 + EPSG:4326 mandates lat,lon (south,west,north,east) axis
      // order, not the lon,lat order used everywhere else in this app --
      // see the matching comment on buildSingleImageWmsLayer in
      // map-overlays.js for how this was confirmed (the wrong order still
      // returns a real 200, just visibly wrong/stretched content).
      bbox: `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`, time,
    });
    return `/api/tiles/eumetsat?${params.toString()}`;
  }

  // Providers that publish transparent PNGs mark missing data with alpha 0, so
  // a partially covered tile can be completed pixel-by-pixel from a second
  // request. JPEG products (GIBS true colour, EOX, Esri) bake no-data in as
  // pure black, so for those only a whole tile can be substituted.
  function providerUsesAlpha(layerId) {
    return layerId === "sentinelhub" || !!geoWmsInfo(layerId);
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

  // GEOS_IRX (NSMC's global geostationary IR mosaic) is hourly, not the
  // 10-min grid GOES/Himawari/Meteosat publish on -- its own time-range and
  // slot-shift both work in whole hours instead.
  function geosmosaicTimeRange(hoursBack, intervalMinutes) {
    const times = [];
    const stepMs = Math.max(60, intervalMinutes | 0) * 60000;
    // Mirrors the live layer's own freshness fix (see map-overlays.js): the
    // current UTC hour's composite is regularly still assembling (confirmed
    // live -- a ~1KB near-empty PNG well into the hour, vs ~170KB+ for a
    // finished one), so the newest hour ever requested is always the one
    // before "now", never the current one.
    const latestHour = Math.floor(Date.now() / 3600000) * 3600000 - 3600000;
    const start = latestHour - Math.max(1, hoursBack | 0) * 3600000;
    for (let t = start; t <= latestHour; t += stepMs) {
      const hour = Math.floor(t / 3600000) * 3600000;
      times.push(`${new Date(hour).toISOString().slice(0, 13)}:00:00Z`);
    }
    return times;
  }

  function shiftGeosmosaicHour(iso, hoursBack) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const shifted = Math.floor((t - hoursBack * 3600000) / 3600000) * 3600000;
    return `${new Date(shifted).toISOString().slice(0, 13)}:00:00Z`;
  }

  function geosmosaicImageUrl(iso) {
    const datetime = `${iso.slice(0, 13).replace(/[-T]/g, "")}00`;
    return `https://data.nsmc.org.cn/NSMCAPI/v1/nsmc/image/wms/compose?layers=GEOS_IRX&datetime=${datetime}&request=GetMap&bbox=-180,-90,180,90&width=1440&height=720&version=1.1.0&srs=EPSG:4326&format=png`;
  }

  // Ordered extra requests to try for tiles the primary request left empty.
  // Each provider degrades along its own natural axis: Sentinel widens the
  // scene-search window and then drops the cloud cap, GIBS true colour falls
  // back to the other daily sensors, GOES steps back through 10-minute slots,
  // and EOX steps back a yearly composite.
  function gapFillPlan(layerId, windowDays) {
    // Single source of truth lives in sentinel-hub.js now, shared with the
    // live map layer's own gap-fill (SentinelGapFillTileLayer in
    // map-overlays.js) so the two never drift apart again.
    if (layerId === "sentinelhub") {
      return window.MetisSentinelHub.gapFillPlan(windowDays, {
        priority: window.MetisApiKeys?.priorityFor("sentinelhub"),
      });
    }
    if (GIBS_PRODUCTS[layerId]) {
      const family = GIBS_PRODUCTS[layerId].family;
      return Object.keys(GIBS_PRODUCTS)
        .filter((id) => id !== layerId && GIBS_PRODUCTS[id].family === family)
        .map((id) => ({ siblingLayer: id, label: GIBS_PRODUCTS[id].label }));
    }
    if (window.MetisGeoSat?.SATELLITES[layerId]) {
      // EUMETSAT's WMS snaps any requested time to its nearest real slot
      // (capabilities declare nearestValue="1"), so an imprecise 10-min-grid
      // shift still resolves to a real scene even on Meteosat's 15-min
      // cadence -- no separate step size needed per provider.
      return [10, 20, 30, 60].map((minutes) => ({ shiftMinutes: minutes, label: `${minutes} min earlier` }));
    }
    if (window.MetisMetop?.SATELLITES[layerId]) {
      // Same nearestValue-snapping WMS, but Metop is polar-orbiting with a
      // ~100 min repeat cadence (its own Dimension declares PT1H40M) -- the
      // geostationary family's 10/20/30/60-minute shifts would almost always
      // resolve back to the exact same orbit pass, finding nothing. Step in
      // whole-orbit multiples instead (1, 2, 3, 6 orbits back) so each
      // attempt actually lands on a different real pass.
      return [100, 200, 300, 600].map((minutes) => ({ shiftMinutes: minutes, label: `${Math.round(minutes / 100)} orbit${minutes > 100 ? "s" : ""} earlier` }));
    }
    if (layerId === "metopSst") {
      // Global gridded composite updating roughly every 12h (per metop-
      // picker.js) -- shift in half/full/multi-day steps instead of
      // Metop's own orbit-scale ones.
      return [12, 24, 36, 72].map((hours) => ({ shiftMinutes: hours * 60, label: `${hours}h earlier` }));
    }
    if (layerId === "s2cloudless") {
      return [1, 2].map((yearsBack) => ({ yearsBack, label: `${yearsBack}y earlier composite` }));
    }
    return [];
  }

  function create({ map, rasterOverlays }) {
    // Capture the FULL map container, not just the strip between the panels.
    // The map spans the whole window with the header and both side panels
    // floating on top of it, and every one of those surfaces is translucent
    // glass -- the map really is visible through them. An earlier version
    // inset the capture by each panel's width to avoid fetching tiles for
    // "hidden" area, but nothing there is actually hidden: the panels then
    // showed LIVE map through the glass while the middle of the screen
    // showed the playback frame, so the seam sat right at each panel edge.
    // Framing the whole container keeps the frame continuous under all the
    // chrome, and makes GIF/PNG exports full-screen instead of carrying a
    // panel-shaped notch. It costs roughly double the tiles per frame; that
    // is the deliberate price of the glass panels showing real imagery.
    const captureBounds = () => map.getBounds();

    const frameCache = new Map(); // date -> { canvas, meta }
    let playTimer = null;
    let playIndex = 0;
    let playDirection = 1;
    let loopMode = "forward"; // forward | reverse | bounce
    let currentDates = [];
    let overlayCanvas = null;
    let capturedBounds = null;
    // Exact projected geometry of the current capture, so exports can build a
    // matching basemap underlay (see ensureBasemapCanvas).
    let captureGeometry = null;
    let basemapCanvas = null;
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
      if (window.MetisDailySat?.SATELLITES[layerId]) {
        const info = window.MetisDailySat.layerInfo(layerId);
        if (!info) return null;
        return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${info.gibsLayer}/default/${date}/GoogleMapsCompatible_Level${info.maxNativeZoom}/${z}/${y}/${x}.${info.ext}`;
      }
      const geoInfoForTile = geoWmsInfo(layerId);
      if (geoInfoForTile) {
        const info = geoInfoForTile;
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
          layers: info.wmsLayer, width: String(TILE_SIZE), height: String(TILE_SIZE),
          crs: "EPSG:3857", bbox: `${nwM.x},${seM.y},${seM.x},${nwM.y}`, time: date,
        });
        // Routed through the app's own worker (/api/tiles/eumetsat), not
        // EUMETSAT directly like the live map's tiles (map-overlays.js) --
        // EUMETSAT's GetMap never sends CORS headers (confirmed live,
        // repeatedly), which this canvas-based capture pipeline needs and
        // the live map doesn't. The worker adds the header and re-serves
        // the same bytes; see its own comment for the full story.
        return `/api/tiles/eumetsat?${params.toString()}`;
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

    // GEOS_IRX is one whole-globe equirectangular image per hour, not a
    // per-tile WMS/WMTS grid -- captureFrame's usual per-cell fetch/draw loop
    // doesn't apply. This fetches the single source image for `date` (falling
    // back to earlier hours if gap fill is on and the requested hour is still
    // blank/compositing) and reprojects it across the *whole* captured rect
    // in one pass: the same row-by-row remap map-overlays.js's
    // EquirectangularTileLayer does per-tile for the live map (longitude is
    // linear so one column scale/offset covers the whole width; only
    // latitude needs per-row unprojection), just scaled up to cover
    // everything captureFrame asked for instead of one 256x256 tile.
    async function captureGeosmosaicFrame(date, { nw, se, z, width, height, withLabels, gapFill, signal }) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      const attempts = [date];
      if (gapFill) {
        for (const hoursBack of [1, 2, 3, 6]) attempts.push(shiftGeosmosaicHour(date, hoursBack));
      }
      let usedDate = null;
      let filledFromEarlier = false;
      for (let i = 0; i < attempts.length; i++) {
        throwIfAborted(signal);
        const attemptDate = attempts[i];
        try {
          // eslint-disable-next-line no-await-in-loop
          const img = await loadTileCached(geosmosaicImageUrl(attemptDate), signal);
          const srcW = img.naturalWidth;
          const srcH = img.naturalHeight;
          if (!srcW || !srcH) throw new Error("empty image");
          const worldSize = TILE_SIZE * (2 ** z);
          // Wrap the source column the same way the tile grid wraps tile X.
          // A view panned across the antimeridian projects to a negative
          // nw.x, and drawImage silently CLIPS a source rect starting left
          // of the image -- blanking exactly that slice of the frame. This
          // is a whole-globe equirectangular image, so the column wraps: the
          // part left of the seam is drawn from the right end of the source.
          const srcColWidth = Math.min(srcW, ((se.x - nw.x) / worldSize) * srcW);
          const colStart = ((((nw.x / worldSize) * srcW) % srcW) + srcW) % srcW;
          const headW = Math.min(srcColWidth, srcW - colStart);
          const headDestW = width * (headW / srcColWidth);
          for (let py = 0; py < height; py++) {
            const worldY = nw.y + ((se.y - nw.y) * py) / height;
            const latLng = map.unproject([nw.x, worldY], z);
            const srcRow = Math.max(0, Math.min(srcH - 1, Math.round(((90 - latLng.lat) / 180) * srcH)));
            ctx.drawImage(img, colStart, srcRow, headW, 1, 0, py, headDestW, 1);
            if (srcColWidth > headW) {
              ctx.drawImage(img, 0, srcRow, srcColWidth - headW, 1, headDestW, py, width - headDestW, 1);
            }
          }
          const coverage = canvasDataCoverage(canvas);
          if (coverage > TILE_EMPTY_COVERAGE || i === attempts.length - 1) {
            usedDate = attemptDate;
            filledFromEarlier = i > 0 && coverage > TILE_EMPTY_COVERAGE;
            break;
          }
          // Still essentially blank -- the requested hour's composite is
          // probably still assembling on NSMC's side. Clear and fall
          // through to the next, older attempt rather than keep it.
          ctx.clearRect(0, 0, width, height);
        } catch (err) {
          if (err?.message === "Cancelled") throw err;
          // Network/decode failure -- fall through to the next attempt.
        }
      }

      if (withLabels && usedDate) {
        const maxTile = 2 ** z - 1;
        const tileXStart = Math.floor(nw.x / TILE_SIZE);
        const tileXEnd = Math.floor((se.x - 1) / TILE_SIZE);
        const tileYStart = Math.max(0, Math.floor(nw.y / TILE_SIZE));
        const tileYEnd = Math.min(maxTile, Math.floor((se.y - 1) / TILE_SIZE));
        const labelTasks = [];
        for (let tx = tileXStart; tx <= tileXEnd; tx++) {
          for (let ty = tileYStart; ty <= tileYEnd; ty++) {
            const sx = wrapTileX(tx, z);
            const drawX = (tx * TILE_SIZE - nw.x);
            const drawY = (ty * TILE_SIZE - nw.y);
            labelTasks.push(async () => {
              try {
                const label = await loadTileCached(labelsTileUrl(z, sx, ty), signal);
                ctx.drawImage(label, drawX, drawY, TILE_SIZE, TILE_SIZE);
              } catch { /* labels are optional */ }
            });
          }
        }
        await runLimited(labelTasks, TILE_FETCH_CONCURRENCY, signal);
      }

      const dataCoverage = canvasDataCoverage(canvas);
      const stats = sampleCanvasStats(canvas);
      return {
        canvas,
        tileOk: usedDate ? 1 : 0,
        tileFail: usedDate ? 0 : 1,
        tileCoverage: usedDate ? 1 : 0,
        pixelCoverage: dataCoverage,
        gapFilledTiles: filledFromEarlier ? 1 : 0,
        gapFillSources: filledFromEarlier ? [`resolved to ${usedDate}`] : [],
        blank: !usedDate || stats.renderedError,
      };
    }

    // Same "one big image instead of many small tiles" idea as
    // captureGeosmosaicFrame above, for whichever single EUMETSAT
    // satellite/product the playback dropdown currently has selected --
    // only used when that satellite's family is toggled to "Single image"
    // (see singleImageBboxFor above). Unlike geosmosaic's fixed whole-globe
    // source, `bbox` here can be a regional geostationary disc, so the
    // column mapping (longitude is still linear either way) uses that
    // narrower span instead of a hardcoded 360.
    async function captureSingleImageWmsFrame(wmsLayer, bbox, date, { nw, se, z, width, height, withLabels, signal }) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let usedOk = false;
      try {
        const img = await loadTileCached(singleImageWmsUrl(wmsLayer, bbox, date), signal);
        const srcW = img.naturalWidth;
        const srcH = img.naturalHeight;
        if (!srcW || !srcH) throw new Error("empty image");
        const lonSpan = bbox.east - bbox.west;
        const latSpan = bbox.north - bbox.south;
        const worldSize = TILE_SIZE * (2 ** z);
        const lonLeft = -180 + (nw.x / worldSize) * 360;
        const lonRight = -180 + (se.x / worldSize) * 360;
        // A view panned across the antimeridian spans longitudes outside
        // -180..180. Unlike a whole-globe image, a regional disc does not
        // wrap -- it repeats once per visible world copy -- so collect every
        // copy the capture actually overlaps. A normal in-range view yields
        // exactly [0], i.e. the single pass this did before.
        const srcColWidth = ((lonRight - lonLeft) / lonSpan) * srcW;
        const shifts = [];
        for (let k = -2; k <= 2; k++) {
          if (lonRight + k * 360 > bbox.west && lonLeft + k * 360 < bbox.east) shifts.push(k);
        }
        if (shifts.length) {
          for (let py = 0; py < height; py++) {
            const worldY = nw.y + ((se.y - nw.y) * py) / height;
            const latLng = map.unproject([nw.x, worldY], z);
            if (latLng.lat < bbox.south || latLng.lat > bbox.north) continue;
            const srcRow = Math.max(0, Math.min(srcH - 1, ((bbox.north - latLng.lat) / latSpan) * srcH));
            for (const k of shifts) {
              // drawImage clips a source rect that overhangs the image and
              // scales the destination to match, so each copy lands in the
              // right slice of the canvas without extra bookkeeping.
              const srcColStart = ((lonLeft + k * 360 - bbox.west) / lonSpan) * srcW;
              ctx.drawImage(img, srcColStart, srcRow, srcColWidth, 1, 0, py, width, 1);
            }
          }
          usedOk = true;
        }
      } catch (err) {
        if (err?.message === "Cancelled") throw err;
        // Network/decode failure, or the capture rect fell entirely outside
        // this disc's coverage -- leave the canvas blank, same as a failed
        // tile batch would.
      }

      if (withLabels && usedOk) {
        const maxTile = 2 ** z - 1;
        const tileXStart = Math.floor(nw.x / TILE_SIZE);
        const tileXEnd = Math.floor((se.x - 1) / TILE_SIZE);
        const tileYStart = Math.max(0, Math.floor(nw.y / TILE_SIZE));
        const tileYEnd = Math.min(maxTile, Math.floor((se.y - 1) / TILE_SIZE));
        const labelTasks = [];
        for (let tx = tileXStart; tx <= tileXEnd; tx++) {
          for (let ty = tileYStart; ty <= tileYEnd; ty++) {
            const sx = wrapTileX(tx, z);
            const drawX = (tx * TILE_SIZE - nw.x);
            const drawY = (ty * TILE_SIZE - nw.y);
            labelTasks.push(async () => {
              try {
                const label = await loadTileCached(labelsTileUrl(z, sx, ty), signal);
                ctx.drawImage(label, drawX, drawY, TILE_SIZE, TILE_SIZE);
              } catch { /* labels are optional */ }
            });
          }
        }
        await runLimited(labelTasks, TILE_FETCH_CONCURRENCY, signal);
      }

      const dataCoverage = canvasDataCoverage(canvas);
      const stats = sampleCanvasStats(canvas);
      return {
        canvas,
        tileOk: usedOk ? 1 : 0,
        tileFail: usedOk ? 0 : 1,
        tileCoverage: usedOk ? 1 : 0,
        pixelCoverage: dataCoverage,
        gapFilledTiles: 0,
        gapFillSources: [],
        blank: !usedOk || stats.renderedError,
      };
    }

    // One EPSG:3857 GetMap covering exactly the captured viewport. Because
    // the request is in the same projection the canvas is in, the response
    // maps 1:1 onto it -- no per-row reprojection like the equirectangular
    // whole-globe path above needs. Returns null (not a blank frame) if the
    // request fails, so the caller can fall back to the tile grid.
    async function captureViewWmsFrame(wmsLayer, date, { nw, se, z, width, height, withLabels, signal }) {
      const nwLL = map.unproject([nw.x, nw.y], z);
      const seLL = map.unproject([se.x, se.y], z);
      const nwM = L.CRS.EPSG3857.project(nwLL);
      const seM = L.CRS.EPSG3857.project(seLL);
      const params = new URLSearchParams({
        layers: wmsLayer, width: String(width), height: String(height),
        crs: "EPSG:3857", bbox: `${nwM.x},${seM.y},${seM.x},${nwM.y}`, time: date,
      });
      let img = null;
      try {
        img = await loadTileCached(`/api/tiles/eumetsat?${params.toString()}`, signal);
      } catch (err) {
        if (err?.message === "Cancelled") throw err;
      }
      if (img && (!img.naturalWidth || !img.naturalHeight)) img = null;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (img) ctx.drawImage(img, 0, 0, width, height);
      if (img && withLabels) {
        // Labels stay tiled -- they come from a different, fast provider and
        // there is no GetMap equivalent for them.
        const maxTile = 2 ** z - 1;
        const tasks = [];
        for (let tx = Math.floor(nw.x / TILE_SIZE); tx <= Math.floor((se.x - 1) / TILE_SIZE); tx++) {
          for (let ty = Math.max(0, Math.floor(nw.y / TILE_SIZE)); ty <= Math.min(maxTile, Math.floor((se.y - 1) / TILE_SIZE)); ty++) {
            const drawX = tx * TILE_SIZE - nw.x;
            const drawY = ty * TILE_SIZE - nw.y;
            const wrapped = wrapTileX(tx, z);
            tasks.push(async () => {
              try {
                const label = await loadTileCached(labelsTileUrl(z, wrapped, ty), signal);
                ctx.drawImage(label, drawX, drawY, TILE_SIZE, TILE_SIZE);
              } catch { /* labels are optional */ }
            });
          }
        }
        await runLimited(tasks, TILE_FETCH_CONCURRENCY, signal);
      }
      // Same flat shape every other capture path returns -- callers read
      // pixelCoverage/tileOk/blank off the top level, so nesting them under a
      // `meta` key silently produced "NaN%" in the progress line.
      const dataCoverage = canvasDataCoverage(canvas);
      const stats = sampleCanvasStats(canvas);
      return {
        canvas,
        tileOk: img ? 1 : 0,
        tileFail: img ? 0 : 1,
        tileCoverage: img ? 1 : 0,
        pixelCoverage: dataCoverage,
        gapFilledTiles: 0,
        gapFillSources: [],
        blank: !img || stats.renderedError,
      };
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
      if (layerId === "geosmosaic") {
        return captureGeosmosaicFrame(date, { nw, se, z, width, height, withLabels, gapFill, signal });
      }
      const singleImageBbox = singleImageBboxFor(layerId);
      if (singleImageBbox) {
        const info = geoWmsInfo(layerId);
        return captureSingleImageWmsFrame(info.wmsLayer, singleImageBbox, date, { nw, se, z, width, height, withLabels, signal });
      }
      // One GetMap covering exactly the captured view, instead of a grid of
      // 256px tiles of the same area. Same pixels, ~1/25th the requests.
      //
      // Measured against this proxy: 25 tiles at 6-way concurrency took 10.9s,
      // the equivalent single 1280x1280 GetMap took 3.1s -- 3.5x, and 22
      // frames drops from ~4 min to ~1.2 min. Raising tile concurrency does
      // NOT help: the browser already reaches 24 in flight, but EUMETSAT
      // saturates at ~2.9 responses/sec, so per-request latency just rises to
      // match. Only cutting the request COUNT moves the wall clock.
      //
      // There is no resolution trade: a 1280x1280 GetMap over a 5x5 tile view
      // is the same 1280x1280 pixels the tiles would have produced. The proxy
      // caps a side at 1600 (server.py/_handle_eumetsat_tile), so anything
      // larger falls through to the tile grid below rather than being scaled
      // down.
      const viewWmsInfo = geoWmsInfo(layerId);
      if (viewWmsInfo?.type === "wms" && viewWmsInfo.wmsLayer
          && width <= SINGLE_VIEW_MAX_PX && height <= SINGLE_VIEW_MAX_PX) {
        // Deliberately NO fall-through to the tile grid when this fails.
        // Measured: when EUMETSAT 502s a given time/area it does so for a
        // 256x256 tile exactly as for a 1599x1599 GetMap, so retrying the
        // same frame as 25 tiles just spends 25 more requests to fail again
        // -- one such frame accounted for 75 of the 105 requests in a
        // 15-frame load. loadTileCached already retries this request 3x with
        // backoff; past that the frame is genuinely unavailable and the
        // existing skipped/sparse-frame reporting says so.
        return captureViewWmsFrame(viewWmsInfo.wmsLayer, date, {
          nw, se, z, width, height, withLabels, signal,
        });
      }
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
      const tileXStart = Math.floor(nw.x / TILE_SIZE);
      const tileXEnd = Math.floor((se.x - 1) / TILE_SIZE);
      const tileYStart = Math.max(0, Math.floor(nw.y / TILE_SIZE));
      const tileYEnd = Math.min(maxTile, Math.floor((se.y - 1) / TILE_SIZE));

      let tileOk = 0, tileFail = 0;
      const cells = [];
      for (let tx = tileXStart; tx <= tileXEnd; tx++) {
        for (let ty = tileYStart; ty <= tileYEnd; ty++) {
          cells.push({
            // Wrapped: what the provider is actually asked for. Every URL
            // builder below reads cell.tx, so wrapping once here covers the
            // primary fetch, the gap-fill sources and the label overlay.
            tx: wrapTileX(tx, z),
            ty,
            // Unwrapped: where the tile lands on the capture canvas.
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

      const dataCoverage = canvasDataCoverage(canvas);
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
      // Explicit instants (epoch ms) for the near-real-time satellites. When
      // both are given and the provider publishes an extent, every real slot
      // between them is requested and hoursBack/intervalMinutes are unused --
      // see the enumeration block below. They stay as the fallback for
      // providers with no published extent (e.g. the CMA IR mosaic).
      rangeStartMs, rangeEndMs,
      releaseCount, yearsCount, withLabels, gapFill = false,
      onProgress,
    }) {
      cancelLoad();
      loadController = new AbortController();
      const signal = loadController.signal;
      clearFrames({ keepController: true });
      tileCache.clear();

      // "isGoes" now covers every geostationary-style WMS/WMTS satellite --
      // GOES-East/West, Himawari, Meteosat-0/IODC, MTG, and Metop-A/B/C
      // (metop-picker.js, same EUMETSAT WMS mechanism, just a different
      // picker module -- see geoWmsInfo above) -- all share the same
      // hours-back + interval-minutes playback UI and slot-shifting gap
      // fill, kept the shorter name since it's used throughout this
      // function already. The mosaic is its own flag: same hours-back UI,
      // but an hourly grid and a single whole-globe image per frame rather
      // than a per-tile WMS/WMTS request (see captureGeosmosaicFrame).
      const isGoes = !!geoWmsInfo(layerId);
      const isGeosmosaic = layerId === "geosmosaic";
      const isWayback = layerId === "worldimagery";
      const isS2 = layerId === "s2cloudless";
      const isSH = layerId === "sentinelhub";
      const gibs = GIBS_PRODUCTS[layerId];
      const dailySatInfo = window.MetisDailySat?.SATELLITES[layerId] ? window.MetisDailySat.layerInfo(layerId) : null;
      // Playback must request exactly what the normal layer would show for
      // the same selected day. Both paths therefore use the shared live
      // window; there is no playback-only widening or coverage preflight.
      const shWindow = window.MetisSentinelHub?.WINDOW_DAYS ?? 10;
      // Not every GOES/Himawari product shares GeoColor's zoom-7 ceiling --
      // Air Mass and Clean Infrared cap at 6, confirmed against GIBS' own
      // capabilities (see geo-satellite-picker.js). Read the real ceiling
      // for whichever product is currently selected instead of assuming 7.
      const geoInfo = isGoes ? geoWmsInfo(layerId) : null;

      // Same story for VIIRS's product family -- True Colour caps at 9,
      // but Cloud Top Height/Cirrus/DayNightBand cap at 7 (confirmed live
      // against GIBS' own capabilities, see daily-satellite-picker.js).
      // Falling through to the 19 default here (as it did before
      // MetisDailySat carried a real product/zoom per option) would ask
      // for tiles several zoom levels past what actually exists.
      const maxNativeZoom = gibs ? gibs.maxNativeZoom
        : dailySatInfo ? dailySatInfo.maxNativeZoom
        : isGoes ? (geoInfo?.maxNativeZoom ?? 7)
        : isGeosmosaic ? 12
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

      let bounds = captureBounds();
      let nw = map.project(bounds.getNorthWest(), z);
      let se = map.project(bounds.getSouthEast(), z);
      if (!Number.isFinite(nw.x) || !Number.isFinite(se.x) || se.x - nw.x <= 0 || se.y - nw.y <= 0) {
        map.invalidateSize();
        await new Promise((resolve) => setTimeout(resolve, 80));
        throwIfAborted(signal);
        bounds = captureBounds();
        nw = map.project(bounds.getNorthWest(), z);
        se = map.project(bounds.getSouthEast(), z);
        if (!Number.isFinite(nw.x) || !Number.isFinite(se.x) || se.x - nw.x <= 0 || se.y - nw.y <= 0) {
          throw new Error("Map view isn't ready yet -- pan/zoom the map and try again.");
        }
      }
      // Record the geometry this sequence is captured at, and drop any
      // basemap built for a previous view -- a new load may be at a different
      // zoom/extent, and reusing the old underlay would misregister it.
      captureGeometry = { nw, se, z, renderScale };
      basemapCanvas = null;
      let releases = [];
      let waybackFrames = null;
      let dates;
      let targetCount = null;
      const skipped = [];
      // Declared at this scope (not inside the branch below that actually
      // sets it) because the dedup pass that reads it, much further down,
      // runs for every layer family, not just the EUMETSAT one that sets
      // it -- a block-scoped declaration there would throw a
      // ReferenceError for Wayback/S2 loads, which never reach that branch.
      let enumStepDivisor = 1;

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
        // Anchor the newest frame to imagery that actually exists, per
        // provider, instead of to wall-clock. Every one of these feeds
        // publishes behind real time, and by wildly different amounts, so a
        // fixed "now minus a bit" guess is wrong for all of them:
        //
        //   GIBS/WMTS (GOES, Himawari): ~10-20 min behind -- probe backward
        //   for the newest slot with real pixels (a pending slot answers 200
        //   with a blank placeholder, so only pixels can tell).
        //
        //   EUMETSAT/WMS (Meteosat, MTG, Metop): can be HOURS behind --
        //   measured Metop-B at 10:28Z against a 15:39Z wall clock, a 5h11m
        //   lag, because it is a polar orbiter on a ~100-min orbit plus
        //   processing time. Anchoring those to wall-clock put every single
        //   requested slot in the future, so every frame came back empty and
        //   the whole sequence was skipped as "no data" -- reported as Metop
        //   not loading history at all. Their GetCapabilities advertises the
        //   real newest scene per layer; refreshMtgTimeDefaults already
        //   parses and caches exactly that (it is what the live map view
        //   uses), so reuse it rather than guessing.
        //
        // The same GetCapabilities Dimension also declares each layer's real
        // publish PERIOD, which is not 10 minutes for any of the EUMETSAT
        // feeds (Metop PT1H40M, Meteosat PT15M, SST PT12H). Passing it to
        // timeRange is what stops a short span collapsing every frame onto
        // one scene -- see that function for the measurements.
        let goesLatestSlotMs;
        let goesPeriodMinutes;
        if (isGoes && geoInfo?.type === "wmts" && geoInfo.gibsLayer) {
          goesLatestSlotMs = await resolveLatestGoesSlot(geoInfo.gibsLayer, geoInfo.maxNativeZoom ?? 7, signal);
        } else if (isGoes && geoInfo?.wmsLayer) {
          const timeDefaults = await rasterOverlays.refreshMtgTimeDefaults();
          const parsed = Date.parse(timeDefaults?.[geoInfo.wmsLayer] || "");
          if (Number.isFinite(parsed)) goesLatestSlotMs = parsed;
          goesPeriodMinutes = rasterOverlays.mtgTimePeriodFor?.(geoInfo.wmsLayer) || undefined;
        }
        // Preferred path for EUMETSAT layers: ask the provider's own
        // GetCapabilities which timestamps it actually holds between the two
        // instants the user picked, and request exactly those. Nothing is
        // guessed, so nothing is missed and nothing lands between slots.
        // Verified live: a 12-hour window enumerated 8 real Metop-B slots and
        // 73 real MTG slots, and every single one returned real imagery --
        // 0 errors, versus the cadence-guessing path below which produced 61
        // frames for 10 hours of Metop where only ~6 real scenes exist.
        //
        // EVERY slot in the range is requested -- deliberately not thinned.
        // An earlier version kept only one slot per "accumulation window"
        // (6 orbits for Metop's rolling composites) on the theory that the
        // intermediate ones were near-duplicates. Measured over the 20th to
        // the 23rd: the range holds 52 real slots, that filter kept 9, and
        // fetching all 52 returned 0 errors and 39 DISTINCT images with only
        // 10 adjacent duplicate pairs. It was discarding 30 genuinely
        // different images to avoid 10 repeats. Repeats are the provider's
        // real content and the frame list already reports them; dropping
        // real imagery to tidy them up is the wrong trade.
        // Metop's declared period is nominal, not exact -- it's a polar
        // orbiter, and its real orbit-to-orbit gap jitters by a few minutes
        // rather than landing on a clean grid (measured live: 6 hand-checked
        // real slots had gaps of 99/99/100/100 min, not a flat 100). Probing
        // only at the nominal step demonstrably missed real slots sitting a
        // few minutes off the guessed grid. Probing at half that step is a
        // >>10x margin against the observed jitter. Confirmed this is
        // Metop-specific: the same check against MTG (PT10M) and Meteosat
        // (PT15M) found 8/8 images exactly on their declared grid, zero
        // jitter -- a fixed geostationary scan schedule, unlike an orbit --
        // so only the Metop family pays the extra request cost.
        enumStepDivisor = (geoInfo?.family === "metop" || geoInfo?.family === "metopSst") ? 2 : 1;
        let enumerated = null;
        if (isGoes && geoInfo?.wmsLayer && rangeStartMs != null && rangeEndMs != null) {
          enumerated = rasterOverlays.mtgTimeSlotsBetween?.(geoInfo.wmsLayer, rangeStartMs, rangeEndMs, enumStepDivisor) || null;
        }
        dates = capDates(
          enumerated ? enumerated.map((ms) => `${new Date(ms).toISOString().slice(0, 16)}:00Z`)
            : isGoes ? timeRange(hoursBack, intervalMinutes, goesLatestSlotMs, goesPeriodMinutes)
            : isGeosmosaic ? geosmosaicTimeRange(hoursBack, intervalMinutes)
            : dateRange(startDate, endDate, stepDays),
          MAX_FRAMES,
        );
      }
      if (!dates.length) {
        throw new Error((isGoes || isGeosmosaic) ? "Invalid time range" : isWayback ? "No distinct releases found for this view" : isS2 ? "No years in range" : "Invalid date range");
      }

      const shLayerName = isSH ? (window.MetisApiKeys?.layerFor("sentinelhub") || "TRUE_COLOR") : "";
      const layerLabel = gibs ? gibs.label
        : isGoes ? `${geoInfo?.satLabel ?? "Geostationary"} (${geoInfo?.productLabel ?? "GeoColor"})`
        : isGeosmosaic ? "CMA/NSMC global geostationary IR mosaic"
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
      //
      // Metop is the one exception, and only when the finer probing grid
      // above (enumStepDivisor > 1) is actually in play: that grid
      // deliberately asks for MORE candidate times than there are real
      // slots, specifically so a real slot sitting off the naive nominal
      // grid still gets found -- which means two adjacent candidates can
      // legitimately land on the exact same real scene via EUMETSAT's own
      // nearestValue snapping. That's not "losing a timeline slot" the way
      // the policy above guards against; it's the same real slot answering
      // twice under two different guessed labels. Collapsing an adjacent
      // pair whose actual pixels match (not just their date/label) is safe
      // specifically because it's gated on the divisor -- every other
      // path here (MTG, Meteosat, date-range, Wayback) never sets it above
      // 1, so this loop is a no-op for them and the tested guarantee above
      // still holds exactly as before.
      const seenKeys = new Set();
      let prevKeptFingerprint = null;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r) continue;
        if (seenKeys.has(r.key)) {
          skipped.push({ date: r.date, reason: "duplicate scene" });
          continue;
        }
        if (enumStepDivisor > 1 && prevKeptFingerprint && framesLookIdentical(r.fingerprint, prevKeptFingerprint)) {
          skipped.push({ date: r.date, reason: "same real scene as the previous frame (finer probing grid)" });
          continue;
        }
        seenKeys.add(r.key);
        prevKeptFingerprint = r.fingerprint;
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
      const overlayCtx = canvas.getContext("2d");
      // Frames carry transparent no-data now (see BACKGROUND_FILL), so the
      // previous frame has to be cleared first -- without this, stepping
      // between frames would leave the older frame showing through wherever
      // the newer one has a gap. (Setting canvas.width above already clears
      // it when the size changes; this covers the same-size case.)
      overlayCtx.clearRect(0, 0, canvas.width, canvas.height);
      overlayCtx.drawImage(entry.canvas, 0, 0);
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

    // Clamps at the ends rather than wrapping. Reproduced live: with 15
    // real Metop frames loaded, clicking Next 15 times from frame 1 reaches
    // "Frame 15 / 15" correctly, but a 16th click silently wrapped back to
    // "Frame 1 / 15" with no visual cue besides the small text label --
    // someone stepping through by eye rather than reading the label counts
    // that as a 16th distinct frame. Play/loop mode is unaffected: it uses
    // its own advanceIndex() above, which still wraps/bounces per loopMode
    // (that repeating is the point of a loop). This is only for the
    // Prev/Next buttons and arrow keys, where a human is manually reviewing
    // frames one at a time and "past the end" should mean stop, not repeat.
    function stepFrame(delta) {
      if (!currentDates.length) return 0;
      playIndex = Math.max(0, Math.min(currentDates.length - 1, playIndex + delta));
      showFrame(playIndex);
      return playIndex;
    }

    // Exports need the no-data gaps opaque, and the honest thing to put there
    // is the same basemap the user is looking at -- a flat navy fill made
    // every export of a partial-disc satellite (a Himawari or Meteosat frame
    // covers well under half the screen) look broken, with coastline labels
    // floating over an empty blue field. The basemap does not change between
    // frames, so it is fetched ONCE per loaded sequence and composited under
    // every frame, adding a single tile grid to an export rather than one per
    // frame. Built lazily: a session that never exports never fetches it.
    async function ensureBasemapCanvas(signal) {
      if (basemapCanvas || !captureGeometry) return basemapCanvas;
      const { nw, se, z, renderScale } = captureGeometry;
      const width = Math.max(1, Math.ceil((se.x - nw.x) * renderScale));
      const height = Math.max(1, Math.ceil((se.y - nw.y) * renderScale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = BACKGROUND_FILL;
      ctx.fillRect(0, 0, width, height);

      const maxTile = 2 ** z - 1;
      const drawSize = TILE_SIZE * renderScale;
      const tasks = [];
      for (let tx = Math.floor(nw.x / TILE_SIZE); tx <= Math.floor((se.x - 1) / TILE_SIZE); tx++) {
        for (let ty = Math.max(0, Math.floor(nw.y / TILE_SIZE)); ty <= Math.min(maxTile, Math.floor((se.y - 1) / TILE_SIZE)); ty++) {
          const sx = wrapTileX(tx, z);
          const drawX = (tx * TILE_SIZE - nw.x) * renderScale;
          const drawY = (ty * TILE_SIZE - nw.y) * renderScale;
          // Matches the on-screen basemap (see index.html's map init):
          // CARTO's anonymous dark_all tiles started serving an "API KEY
          // REQUIRED" watermark, so the live map moved to Esri's keyless
          // Dark Gray Canvas -- split across a Base (fill/roads) service and
          // a separate Reference (place-name labels) service on a second
          // hostname. This export path was still pointed at the old,
          // watermarked CARTO URL until now; draw base then labels, in that
          // order, so labels land on top for this cell same as on screen.
          const baseUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${ty}/${sx}`;
          const refUrl = `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/${z}/${ty}/${sx}`;
          tasks.push(async () => {
            try {
              const img = await loadTileCached(baseUrl, signal);
              ctx.drawImage(img, drawX, drawY, drawSize, drawSize);
            } catch { /* a missing base tile just leaves the dark fill */ }
            try {
              const labels = await loadTileCached(refUrl, signal);
              ctx.drawImage(labels, drawX, drawY, drawSize, drawSize);
            } catch { /* missing labels just leaves the unlabeled base */ }
          });
        }
      }
      await runLimited(tasks, TILE_FETCH_CONCURRENCY, signal);
      basemapCanvas = canvas;
      return basemapCanvas;
    }

    // Frames are stored with transparent no-data (see BACKGROUND_FILL's
    // comment) so the live overlay shows the basemap through the gaps.
    // Exports flatten a copy onto the basemap (or the dark fill, if the
    // basemap could not be built) rather than mutating the cached frame.
    function flattenForExport(source, targetWidth, targetHeight) {
      const out = document.createElement("canvas");
      out.width = targetWidth || source.width;
      out.height = targetHeight || source.height;
      const outCtx = out.getContext("2d", { willReadFrequently: true });
      outCtx.fillStyle = BACKGROUND_FILL;
      outCtx.fillRect(0, 0, out.width, out.height);
      if (basemapCanvas) outCtx.drawImage(basemapCanvas, 0, 0, out.width, out.height);
      outCtx.drawImage(source, 0, 0, out.width, out.height);
      return out;
    }

    async function exportGif({ delayMs = 400, maxDimension = 1280 } = {}) {
      if (!window.MetisGifEncoder) throw new Error("GIF encoder not loaded");
      await ensureBasemapCanvas();
      const frames = [];
      for (const date of currentDates) {
        const entry = frameCache.get(date);
        if (!entry) continue;
        // Downscale very large captures so GIF encode stays responsive --
        // flattenForExport doubles as the scaler since it redraws anyway.
        let w = entry.canvas.width;
        let h = entry.canvas.height;
        if (Math.max(w, h) > maxDimension) {
          const scale = maxDimension / Math.max(w, h);
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
        }
        const source = flattenForExport(entry.canvas, w, h);
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
    async function exportFramePng(index = playIndex) {
      const key = currentDates[Math.max(0, Math.min(currentDates.length - 1, index))];
      const entry = key != null ? frameCache.get(key) : null;
      if (!entry) throw new Error("No frame loaded");
      await ensureBasemapCanvas();
      return new Promise((resolve, reject) => {
        flattenForExport(entry.canvas).toBlob((blob) => {
          if (blob) resolve({ blob, date: entry.meta?.date || key });
          else reject(new Error("Could not encode PNG"));
        }, "image/png");
      });
    }

    // Every loaded frame at full capture resolution, as individual PNGs --
    // for when the GIF's palette quantisation and downscaling (see
    // exportGif above) throws away more than you want, and stepping
    // through "Save frame PNG" one at a time isn't practical for a whole
    // loaded sequence.
    async function exportAllFramesPng() {
      await ensureBasemapCanvas();
      const results = [];
      for (const date of currentDates) {
        const entry = frameCache.get(date);
        if (!entry) continue;
        const blob = await new Promise((resolve, reject) => {
          flattenForExport(entry.canvas).toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode PNG"))), "image/png");
        });
        results.push({ date: entry.meta?.date || date, blob });
      }
      if (!results.length) throw new Error("No frames loaded");
      return results;
    }

    function frameInfo(index = playIndex) {
      const key = currentDates[Math.max(0, Math.min(currentDates.length - 1, index))];
      const meta = key != null ? frameCache.get(key)?.meta : null;
      return meta ? { ...meta } : null;
    }

    // How many real frames a start/end range actually contains for this
    // layer, WITHOUT fetching any imagery -- so the UI can say "this range
    // holds N frames (~M tile requests)" and let the user confirm before a
    // wide range on a 10-minute feed turns into thousands of requests.
    // Returns null when the layer has no published extent to enumerate, so
    // callers can tell "nothing in range" (0) from "can't know yet" (null).
    // The layer's full published extent, for seeding a sensible default range
    // without guessing how far back to look. Metop-A ended in 2021, MTG is
    // minutes old -- any fixed "probe the last N days" window is wrong for
    // one of them.
    async function layerExtent(layerId) {
      const info = geoWmsInfo(layerId);
      if (!info?.wmsLayer) return null;
      await rasterOverlays.refreshMtgTimeDefaults();
      return rasterOverlays.mtgTimeExtentFor?.(info.wmsLayer) || null;
    }

    async function previewRange(layerId, rangeStartMs, rangeEndMs) {
      const info = geoWmsInfo(layerId);
      if (!info?.wmsLayer || rangeStartMs == null || rangeEndMs == null) return null;
      await rasterOverlays.refreshMtgTimeDefaults();
      // Same finer probing grid the actual fetch uses for Metop (see the
      // enumStepDivisor comment at the fetch call site) -- otherwise this
      // preview undercounts exactly the way the naive nominal-grid fetch
      // used to. It's still an upper bound for Metop specifically: some of
      // these candidates can resolve to the same real scene and get
      // collapsed after fetching, so the eventual "Loaded N of M" can come
      // in a little under this estimate -- never over it.
      const stepDivisor = (info.family === "metop" || info.family === "metopSst") ? 2 : 1;
      const slots = rasterOverlays.mtgTimeSlotsBetween?.(info.wmsLayer, rangeStartMs, rangeEndMs, stepDivisor);
      if (!slots) return null;
      const frames = Math.min(slots.length, MAX_FRAMES);
      return {
        frames,
        cappedBy: slots.length > MAX_FRAMES ? MAX_FRAMES : null,
        periodMinutes: rasterOverlays.mtgTimePeriodFor?.(info.wmsLayer) || null,
        firstMs: slots.length ? slots[0] : null,
        lastMs: slots.length ? slots[slots.length - 1] : null,
      };
    }

    return {
      dateRange, timeRange, geosmosaicTimeRange, isoDay, loadFrames, clearFrames, cancelLoad,
      previewRange, layerExtent,
      showFrame, play, stopPlayback, stepFrame, setLoopMode, setOverlayOpacity,
      exportGif, exportFramePng, exportAllFramesPng, frameInfo,
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
