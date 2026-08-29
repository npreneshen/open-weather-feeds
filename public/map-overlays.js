/* Direct raster overlays: tiles never pass through the Cloudflare Worker
   (the Wayback historical-release list is the one exception -- see below). */
window.MetisMapOverlays = (() => {
  "use strict";

  const ICONS = {
    home: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h5V14h3v5.5h5V10" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    satellite: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 7 7 4M2 9l3 3M17 20l3-3M20 17l3 3M8.5 8.5 4 4M15.5 15.5 20 20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    globe: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17-3-3-3-14 0-17" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    ruler: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="3" y="8" width="18" height="8" rx="1" transform="rotate(-45 12 12)" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 9.5 10 11M11 8l1.8 1.8M13.5 6.5l1.8 1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };

  function isoDay(offsetDays = 0) {
    const date = new Date(Date.now() + offsetDays * 86400000);
    return date.toISOString().slice(0, 10);
  }

  // 1x1 transparent PNG -- an errorTileUrl fallback so a failed geostationary
  // tile request just shows nothing instead of a broken-image icon.
  const TRANSPARENT_TILE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  // CMA/NSMC's WMS (the global geostationary IR mosaic) only supports
  // EPSG:4326 -- confirmed live, an EPSG:3857 request 500s (unlike
  // EUMETSAT, which advertises the same EPSG:4326-only capability but
  // actually reprojects fine on request). A plain L.tileLayer.wms would
  // still fetch correctly-shaped EPSG:4326 tiles, but Leaflet would then
  // place them as if they *were* Web Mercator tiles -- fine at the
  // equator, visibly wrong (stretched vertically) toward the poles, since
  // the two projections space latitude lines completely differently.
  // Fetches ONE whole-globe equirectangular image per build instead, then
  // reprojects it into Mercator tiles itself: longitude is already linear
  // in both projections (an X column means the same thing in either), only
  // latitude needs remapping, so each tile is built as a stack of 1px-tall
  // horizontal strips, each pulled from the source row its own latitude
  // maps to. This is the same relationship Leaflet's own EPSG:3857 CRS
  // uses internally (map.unproject), just applied here instead of relying
  // on the tile server to have done it.
  // A single big GetMap (geosmosaic, or the geostationary/Metop "single
  // image" request method) can take several seconds -- long enough that,
  // with nothing drawn until it resolves, the layer just looks broken
  // rather than loading. One shared floating badge per map (stacked if more
  // than one such layer is loading at once) instead of a spinner baked into
  // every tile, which would either repeat awkwardly across several visible
  // tiles or (worse) not exist at all when only one tile is in view.
  let singleImageLoadingStyled = false;
  const singleImageLoadingStacks = new WeakMap();
  function ensureSingleImageLoadingStyles() {
    if (singleImageLoadingStyled) return;
    singleImageLoadingStyled = true;
    const style = document.createElement("style");
    style.textContent = `
      .metis-singleimg-stack{position:absolute;top:calc(var(--mobile-header-h,var(--header-h,54px)) + 10px);left:50%;transform:translateX(-50%);
        z-index:650;display:flex;flex-direction:column;gap:4px;pointer-events:none;align-items:center}
      .metis-singleimg-badge{display:flex;align-items:center;gap:7px;background:rgba(6,23,30,.88);
        border:1px solid #304b52;color:#d8d1bc;padding:5px 10px;border-radius:4px;
        font:12px "IBM Plex Mono",Consolas,monospace;box-shadow:0 2px 8px rgba(0,0,0,.4)}
      .metis-singleimg-spinner{width:11px;height:11px;border-radius:50%;flex:none;
        border:2px solid rgba(216,209,188,.25);border-top-color:#68cf91;animation:metis-singleimg-spin .8s linear infinite}
      @keyframes metis-singleimg-spin{to{transform:rotate(360deg)}}
    `;
    document.head.appendChild(style);
  }
  function singleImageLoadingBadge(map, label) {
    ensureSingleImageLoadingStyles();
    let stack = singleImageLoadingStacks.get(map);
    if (!stack) {
      stack = L.DomUtil.create("div", "metis-singleimg-stack");
      map.getContainer().appendChild(stack);
      singleImageLoadingStacks.set(map, stack);
    }
    const badge = L.DomUtil.create("div", "metis-singleimg-badge", stack);
    badge.innerHTML = `<span class="metis-singleimg-spinner"></span><span>Loading ${label}…</span>`;
    return () => badge.remove();
  }

  const EquirectangularTileLayer = L.GridLayer.extend({
    initialize(imageUrl, options) {
      L.GridLayer.prototype.initialize.call(this, options);
      this._imageUrl = imageUrl;
      this._imagePromise = null;
      // The source image's own geographic extent -- defaults to the whole
      // globe (geosmosaic's case, a plate-carrée GetMap of -180..180/
      // -90..90), but a regional single-image request (see
      // buildSingleImageWmsLayer below, used for the geostationary/Metop
      // "single image" request-method option) passes its own narrower bbox
      // here instead. Longitude is still linear in both this image's X axis
      // and Web Mercator's world-X, so the per-tile column mapping stays a
      // single division per tile either way -- only the divisor (this
      // bbox's span instead of the full 360/180) changes.
      this._bbox = options.bbox || { west: -180, south: -90, east: 180, north: 90 };
    },
    onAdd(map) {
      // Must claim _loadImage() (and check whether it was already resolved)
      // *before* calling the parent's onAdd -- GridLayer.onAdd synchronously
      // creates every initially-visible tile, and createTile() below calls
      // _loadImage() itself, so checking `!this._imagePromise` afterward
      // would always see it already set and never show the badge.
      const alreadyLoading = !this._imagePromise;
      const imagePromise = this._loadImage();
      L.GridLayer.prototype.onAdd.call(this, map);
      if (this.options.loadingLabel && alreadyLoading) {
        const dismiss = singleImageLoadingBadge(map, this.options.loadingLabel);
        imagePromise.then(dismiss, dismiss);
      }
    },
    _loadImage() {
      if (!this._imagePromise) {
        this._imagePromise = new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("image load failed"));
          img.src = this._imageUrl;
        });
      }
      return this._imagePromise;
    },
    createTile(coords, done) {
      const size = this.getTileSize();
      const canvas = L.DomUtil.create("canvas", "leaflet-tile");
      canvas.width = size.x;
      canvas.height = size.y;
      const ctx = canvas.getContext("2d");
      const { west, south, east, north } = this._bbox;
      const lonSpan = east - west;
      const latSpan = north - south;
      this._loadImage().then((img) => {
        const srcW = img.naturalWidth;
        const srcH = img.naturalHeight;
        const worldSize = size.x * (2 ** coords.z);
        const worldX = coords.x * size.x;
        const lonLeft = -180 + (worldX / worldSize) * 360;
        const lonRight = -180 + ((worldX + size.x) / worldSize) * 360;
        // This tile's whole longitude span falls outside the source image's
        // coverage (normal for a regional disc once you pan away from it) --
        // leave it blank rather than sampling garbage columns.
        if (lonRight <= west || lonLeft >= east) { done(null, canvas); return; }
        const srcColStart = ((lonLeft - west) / lonSpan) * srcW;
        const srcColWidth = ((lonRight - lonLeft) / lonSpan) * srcW;
        for (let py = 0; py < size.y; py++) {
          const worldY = coords.y * size.y + py;
          const latLng = this._map.unproject(L.point(worldX, worldY), coords.z);
          if (latLng.lat < south || latLng.lat > north) continue;
          const srcRow = Math.max(0, Math.min(srcH - 1, ((north - latLng.lat) / latSpan) * srcH));
          ctx.drawImage(img, srcColStart, srcRow, srcColWidth, 1, 0, py, size.x, 1);
        }
        done(null, canvas);
      }).catch((err) => done(err, canvas));
      return canvas;
    },
  });

  // NOTE (tried, measured, reverted -- do not reinstate without solving all
  // four of these): a custom canvas GridLayer, SentinelGapFillTileLayer, used
  // to sit here. It ran the playback tool's gap-fill escalation
  // (sentinel-hub.js's gapFillPlan) against the LIVE Sentinel layer, so a
  // tile that came back blank because every in-window scene exceeded the
  // cloud cap would retry with a wider window / lifted cap. The intent was
  // right; the live map is the wrong place for it, for reasons that only
  // showed up under real use, not in a functional test:
  //
  //   1. Leaflet holds a tile at opacity:0 until createTile's done()
  //      callback fires. Deferring done() until the escalation finished
  //      meant a gap-filled tile stayed INVISIBLE across up to five
  //      sequential round-trips -- even though its primary image was
  //      already drawn on the canvas. That is what "almost nothing
  //      resolved until I zoom in and out several times" actually was.
  //   2. No bounded concurrency. Leaflet creates every visible tile at
  //      once (25-100 of them), and each escalated independently: up to
  //      ~125 extra requests from one view. The playback pipeline caps
  //      this at 6 in flight (runLimited) precisely because Sentinel Hub's
  //      free tier rate-limits; unbounded, the rate limit produces more
  //      blank tiles, which trigger more escalation, which is a storm that
  //      feeds itself.
  //   3. It set crossOrigin so it could read tile pixels back to measure
  //      coverage -- which means any response that omits CORS headers (an
  //      error page, a rate-limit body) is refused by the browser and
  //      renders blank instead of just displaying. That is the same
  //      failure mode documented for EUMETSAT below, and it converts a
  //      soft provider hiccup into a hard hole.
  //   4. Blank-vs-legitimately-empty is still ambiguous per tile, the same
  //      trap that sank the general blank-tile check (see
  //      attachTileFeedback's note below).
  //
  // Playback keeps its gap fill: it already has bounded concurrency,
  // backoff, and no incremental-paint requirement, and it is confirmed
  // working. A live-view version needs to paint the primary tile
  // immediately (done() first, repaint later), cap in-flight escalation
  // globally across tiles rather than per tile, and avoid crossOrigin.

  // Builds a single-image raster layer from a WMS GetMap URL instead of
  // Leaflet's usual many-small-tiles WMS layer -- see the "Request method"
  // toggle in geo-satellite-picker.js/metop-picker.js for why this exists:
  // one bigger request pays a WMS server's per-request overhead once
  // instead of once per visible tile, trading that for a fixed resolution
  // ceiling and an all-or-nothing fetch (one failed request blanks the
  // whole layer, not just one tile -- same tradeoff geosmosaic already
  // accepted for the same reason).
  function buildSingleImageWmsLayer({ wmsBase, wmsLayer, bbox, time, opacity, attribution, width = 2048, maxNativeZoom = 6, loadingLabel }) {
    const height = Math.round(width * ((bbox.north - bbox.south) / (bbox.east - bbox.west)));
    const params = new URLSearchParams({
      service: "WMS", request: "GetMap", layers: wmsLayer, styles: "",
      format: "image/png", transparent: "true", version: "1.3.0",
      width: String(width), height: String(height),
      crs: "EPSG:4326",
      // WMS 1.3.0 + EPSG:4326 mandates lat,lon (south,west,north,east) axis
      // order per the spec, not the lon,lat order every other bbox in this
      // codebase uses -- GeoServer (which EUMETSAT runs) enforces this
      // strictly. Confirmed live: west,south,east,north here silently
      // returns a real 200 with a *different*, visibly stretched/wrong
      // image (half the true longitude range stretched to fill the whole
      // requested width) rather than an error, which is what made this
      // look like a squashed/distorted image bug instead of an obviously
      // wrong request. EPSG:3857 (every other WMS call in this app) has no
      // such flip -- it's a projected CRS, always x,y regardless of version.
      bbox: `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`,
    });
    if (time) params.set("time", time);
    return new EquirectangularTileLayer(`${wmsBase}?${params.toString()}`, {
      attribution, opacity, maxNativeZoom, bbox, errorTileUrl: TRANSPARENT_TILE, loadingLabel,
    });
  }

  // Terra MODIS true-colour imagery in GIBS starts 2000-02-24 -- stepping
  // or typing a date before that can never resolve to anything real.
  const SATELLITE_MISSION_START = "2000-02-24";
  const SATELLITE_PROBE_MAX_SEARCH = 12;

  // GIBS' "best available" composite has near-complete daily coverage, but
  // real gaps do happen (instrument maintenance, processing lag on very
  // recent days -- including "today," which GIBS often does have published
  // by the time someone checks, confirmed live: Terra and VIIRS SNPP both
  // had same-day imagery available on a same-day check, not just
  // yesterday's). A cheap HEAD probe on one coarse global tile confirms the
  // day actually has data before the UI claims to be showing it -- direction
  // says which way to keep searching if the requested day comes back empty.
  async function probeSatelliteDay(day) {
    if (day < SATELLITE_MISSION_START || day > isoDay(0)) return false;
    const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/2/1/1.jpg`;
    try {
      const response = await fetch(url, { method: "HEAD" });
      return response.ok;
    } catch {
      return true; // network hiccup, not a real "no data" -- don't block on it
    }
  }

  async function resolveSatelliteOffset(offsetDays, direction) {
    let candidate = Math.max(0, Math.min(365 * 10, offsetDays));
    const step = direction >= 0 ? -1 : 1; // "Newer" search decreases offset, "Older" increases it
    for (let i = 0; i <= SATELLITE_PROBE_MAX_SEARCH; i++) {
      const day = isoDay(-candidate);
      if (day < SATELLITE_MISSION_START) break;
      // eslint-disable-next-line no-await-in-loop
      if (await probeSatelliteDay(day)) return candidate;
      const next = candidate + step;
      if (next < 0) break;
      candidate = next;
    }
    return offsetDays; // give up and fall back to the nominal request
  }

  function ensureStyles() {
    if (document.getElementById("metis-overlay-toggle-styles")) return;
    const style = document.createElement("style");
    style.id = "metis-overlay-toggle-styles";
    style.textContent = `
      .metis-overlay-toggle{background:#fff!important;box-shadow:0 1px 5px rgba(0,0,0,.4);border-radius:4px!important;
        margin-top:8px!important;width:30px!important;overflow:hidden}
      .metis-overlay-toggle button{display:flex!important;align-items:center;justify-content:center;
        width:30px!important;height:30px!important;min-width:30px!important;max-width:30px!important;
        background:#fff!important;border:0!important;border-bottom:1px solid #ccc;color:#333!important;
        cursor:pointer;padding:0!important;margin:0!important;text-transform:none!important;font-size:0!important}
      .metis-overlay-toggle button:last-child{border-bottom:0}
      .metis-overlay-toggle button:hover{background:#f4f4f4!important}
      .metis-overlay-toggle button.active{background:#2c7a7b!important;color:#fff!important}
      .metis-overlay-toggle button svg{display:block;stroke:#333}
      .metis-overlay-toggle button.active svg{stroke:#fff}
      .metis-overlay-history{display:none;align-items:center;justify-content:space-between;gap:2px;
        margin-top:4px;padding:2px 3px;background:rgba(6,23,30,.9);color:#d8d1bc;border-radius:3px}
      .metis-overlay-history.show{display:flex}
      .metis-overlay-history button{width:auto!important;margin:0!important;padding:0 4px!important;
        border:0!important;background:transparent!important;color:#68cf91!important;font:700 12px/1 sans-serif!important;
        cursor:pointer}
      .metis-overlay-history button:disabled{color:#4a5a5c!important;cursor:default}
      .metis-overlay-history input[type=date],.metis-overlay-history input[type=text]{font:9px "IBM Plex Mono",Consolas,monospace;white-space:nowrap;
        padding:0 2px;background:transparent;border:0;color:#d8d1bc;width:78px;color-scheme:dark}
      .metis-overlay-history input[type=date]::-webkit-calendar-picker-indicator{filter:invert(.8);cursor:pointer}
      .metis-overlay-history input[type=text]{cursor:default}
      @media(max-width:960px){
        /* The mobile off-canvas sidebar overlays the map at z-index:3800,
           which otherwise buries this whole control underneath it since it
           sits in the same top-left corner. Float above the sidebar instead
           of being hidden behind it. */
        .metis-imagery-control{position:relative;z-index:4300}
      }
    `;
    document.head.appendChild(style);
  }

  function create(map, { onToggle, dataApi, baseLayers } = {}) {
    ensureStyles();
    const overlays = new Map();
    // A shared opacity for the raster layers with their own "Imagery date"
    // row (satellite, worldimagery, geostationary, s2cloudless, sentinelhub,
    // nightlights) -- lets a bright basemap or a stacked layer underneath
    // still show through without needing to fiddle with each layer's own
    // toggle.
    // Persisted so it doesn't reset to full opacity on every reload.
    const OPACITY_KEY = "metis-imagery-opacity";
    let userOpacity = 0.85;
    try {
      // localStorage.getItem returns null when nothing's been saved yet --
      // Number(null) is 0, not NaN, so that has to be checked explicitly or
      // "never saved" silently becomes "saved as fully transparent."
      const raw = localStorage.getItem(OPACITY_KEY);
      const stored = raw === null ? null : Number(raw);
      if (stored !== null && Number.isFinite(stored) && stored >= 0 && stored <= 1) userOpacity = stored;
    } catch { /* ignore */ }
    const OPACITY_LAYER_IDS = ["satellite", "worldimagery", "geostationary", "s2cloudless", "sentinelhub", "nightlights", "metop", "geosmosaic"];
    // EUMETSAT's WMS "latest" (an omitted TIME) isn't atomic across
    // concurrent requests -- confirmed directly: 16 simultaneous identical
    // GetMap requests with no TIME came back 15-1 (one resolved to a
    // different scene). Leaflet fires exactly this kind of burst on every
    // zoom, which is what actually produced tiles from two different
    // instants mixed on screen. An explicit TIME sidesteps it entirely
    // (the same burst test with a pinned time came back 16/16 identical),
    // but different EUMETSAT products publish on wildly different
    // real-world delays (confirmed: some resolve fine 20 min back, others
    // only past 2+ hours), so a guessed fixed margin isn't safe across all
    // of them. GetCapabilities publishes the true answer directly, though
    // -- every layer's time Dimension carries a `default` attribute that
    // IS that exact layer's actual current latest scene -- so there's no
    // margin to guess: fetch it and pin every tile to that.
    let mtgTimeDefaults = null;
    let mtgTimeDefaultsPromise = null;
    // Each layer's own publish cadence, parsed from the same Dimension the
    // `default` above comes from (its value is "start/end/period"). These
    // are NOT all the same and nothing may assume they are -- measured live
    // against this exact GetCapabilities: Metop eps:m01_* is PT1H40M (a
    // ~100-minute polar orbit), Meteosat msg_* is PT15M, MTG is PT10M, and
    // the OSI SAF SST composite is PT12H. Playback needs this: EUMETSAT
    // declares nearestValue="1", so every request inside one period snaps
    // onto the same scene, and stepping a 100-minute feed by 10 minutes
    // returns the identical image over and over (measured: 7 frames at
    // 10-minute steps produced 1 distinct image; at 100-minute steps, 3).
    let mtgTimePeriods = {};
    // Full published extent per layer: { startMs, endMs, periodMin }. The
    // Dimension's text is "start/end/period", which enumerates every real
    // slot the provider actually holds -- so playback can request exactly
    // those instead of inventing timestamps on an assumed cadence.
    // Confirmed live for every layer the app uses: a single range each, no
    // comma-separated gap segments.
    let mtgTimeExtents = {};

    // ISO 8601 duration -> minutes. Only the H/M (and D, for safety) forms
    // these Dimensions actually use; anything unparseable returns null so
    // callers fall back rather than stepping by a bogus interval.
    function parseIsoPeriodMinutes(text) {
      const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(String(text || "").trim());
      if (!m) return null;
      const minutes = (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
      return minutes > 0 ? minutes : null;
    }
    // Last resolved-time strings for the two new satellite layers -- set
    // inside build() each time that layer's tiles/image are (re)requested,
    // read back by the UI's resolved-date hints (see getMetopTimestamp /
    // getGeosmosaicHour below).
    let lastMetopTime = null;
    let lastGeosmosaicHour = null;
    function refreshMtgTimeDefaults() {
      if (mtgTimeDefaultsPromise) return mtgTimeDefaultsPromise;
      mtgTimeDefaultsPromise = fetch("https://view.eumetsat.int/geoserver/wms?service=WMS&request=GetCapabilities&version=1.3.0")
        .then((res) => res.text())
        .then((text) => {
          const doc = new DOMParser().parseFromString(text, "text/xml");
          const result = {};
          const periods = {};
          const extents = {};
          for (const layer of doc.getElementsByTagName("Layer")) {
            const nameEl = layer.querySelector(":scope > Name");
            const dimEl = layer.querySelector(':scope > Dimension[name="time"]');
            const def = dimEl?.getAttribute("default");
            if (!nameEl || !def) continue;
            const name = nameEl.textContent;
            result[name] = def;
            // Dimension text is "start/end/period" -- the third field is this
            // layer's real publish cadence (see mtgTimePeriods above), and
            // the first two bound everything it actually holds.
            const [rawStart, rawEnd, rawPeriod] = (dimEl.textContent || "").trim().split("/");
            const period = parseIsoPeriodMinutes(rawPeriod);
            if (period) periods[name] = period;
            const startMs = Date.parse(rawStart);
            const endMs = Date.parse(rawEnd);
            if (period && Number.isFinite(startMs) && Number.isFinite(endMs)) {
              extents[name] = { startMs, endMs, periodMin: period };
            }
          }
          mtgTimeDefaults = result;
          mtgTimePeriods = periods;
          mtgTimeExtents = extents;
          return result;
        })
        .catch(() => null) // leaves mtgTimeDefaults as whatever it was (or null) -- build() falls back to omitted TIME
        .finally(() => { mtgTimeDefaultsPromise = null; });
      return mtgTimeDefaultsPromise;
    }
    // satellite: offset in days-ago from today, 0 = today (GIBS usually has
    // it, verified live -- see probeSatelliteDay/resolveSatelliteOffset,
    // which confirm and step back a day at a time if it doesn't).
    // worldimagery: index into the Wayback release list, sorted
    // oldest-to-newest -- null/undefined means "latest" until history is
    // opened, so a plain toggle never has to wait on the release-list fetch.
    // satellite defaults to 1 ("yesterday"), not 0 ("today") -- MODIS/VIIRS
    // scan progressively through the day, so "today" is usually only
    // partially captured (not blank/404, just an incomplete globe), which
    // reads as broken rather than "hasn't fully come in yet." Yesterday is
    // reliably a complete day. Still steppable forward to today from here
    // (see resetSatelliteHistory below for the same default on toggle-on).
    const historyState = {
      satellite: 1, worldimagery: null, s2cloudless: 0, sentinelhub: isoDay(0), geostationary: 0,
      metop: 0, geosmosaic: 0,
    };
    // GOES/Himawari/Meteosat/MTG are all near-real-time feeds with a
    // short rolling window (matches the "last 3 days" already documented for
    // their playback options) -- minutes-ago offset, 0 = live, without the
    // daily satellite offset's probe-for-available-date logic, since these
    // providers don't have real archive gaps to route around the way
    // Terra's 25-year history does. Minute (not day) granularity because
    // GOES/Himawari/MTG all actually publish a new scene every 10-15
    // minutes -- confirmed live against GIBS (Layer-Time-Actual snapped to
    // the nearest real 10-min scene for an arbitrary requested minute) and
    // EUMETSAT (an arbitrary past minute timestamp returned a real PNG, not
    // an exception) -- so a whole-day-only stepper was throwing away
    // essentially all of the imagery these feeds actually have.
    const GEO_HISTORY_MAX_DAYS = 3;
    const GEO_HISTORY_MAX_MINUTES = GEO_HISTORY_MAX_DAYS * 24 * 60;
    const GEO_STEP_MINUTES = 15;
    // Same "quick live-view stepper, deep archive lives in the Imagery Lab
    // playback tool instead" split as geostationary above. Metop steps in
    // whole orbits (~100 min, matching its own Dimension) rather than
    // GEO_STEP_MINUTES -- a 15-min nudge would almost always resolve to the
    // exact same orbit pass via nearestValue snapping and look like nothing
    // happened.
    const METOP_HISTORY_MAX_MINUTES = 3 * 24 * 60;
    const METOP_STEP_MINUTES = 100;
    // Mosaic only has hour-granularity data at all (see build()'s geosmosaic
    // branch), so its stepper works in whole hours.
    const GEOSMOSAIC_HISTORY_MAX_HOURS = 3 * 24;
    const GEOSMOSAIC_STEP_HOURS = 1;

    // Mirrors isoDay() above but at minute precision, seconds zeroed --
    // used to pin geostationary tiles to a specific past instant instead of
    // only a specific day.
    function isoMinutesAgo(minutes) {
      const date = new Date(Date.now() - minutes * 60000);
      date.setUTCSeconds(0, 0);
      return `${date.toISOString().slice(0, 16)}:00Z`;
    }
    // Sentinel-2's own catalog resolves a start/end TIME range into "the best
    // scene in that span" -- some other WMS layers on the same protocol
    // (confirmed live: an official Landsat template) don't do that
    // resolution at all and need a bare single date instead, see sentinel-
    // hub.js's buildTime() comment. Defaults to the range (right for
    // Sentinel-2 and the common case); sentinelHubResolvedInfo() flips this
    // to "single" the first time it detects the range coming back empty
    // where a single date doesn't, and flips back if a later layer/instance
    // change makes the range work again.
    let sentinelhubTimeMode = "range";
    const S2CLOUDLESS_LATEST_YEAR = 2025;
    const S2CLOUDLESS_OLDEST_YEAR = 2017;
    const SENTINELHUB_WINDOW_DAYS = 10; // trailing search window; server returns the most recent scene within it
    let waybackReleases = null; // [{date, url, itemId}] sorted ascending, lazy-loaded
    // Wayback only stores a new tile where that spot was actually re-flown;
    // everything else 301-redirects to whichever earlier release last had
    // real imagery there. So the release the user picked and the release
    // actually serving the pixels can differ -- resolve it by following the
    // redirect for a representative tile and reporting THAT release's date,
    // keyed by requested index so a stale resolution never displays.
    let resolvedWorldImagery = { index: undefined, date: null, itemId: null };

    function extractItemId(url) {
      return String(url || "").match(/\/tile\/(\d+)\//i)?.[1] || null;
    }

    async function loadWaybackReleases() {
      if (waybackReleases) return waybackReleases;
      if (!dataApi) return (waybackReleases = []);
      try {
        const config = await dataApi("waybackConfig", "/config.maptiles.arcgis.com/waybackconfig.json", {});
        waybackReleases = Object.values(config || {})
          .map((entry) => ({
            date: String(entry.itemTitle || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "",
            url: entry.itemURL,
            itemId: extractItemId(entry.itemURL),
          }))
          .filter((r) => r.date && r.url)
          .sort((a, b) => a.date.localeCompare(b.date));
      } catch {
        waybackReleases = [];
      }
      return waybackReleases;
    }

    // Probes one representative tile (map center, at the *live displayed*
    // zoom -- not a floor) for the requested release and follows its
    // redirect (if any) to find which release's itemId the pixels actually
    // come from. Deliberately NOT using a probe-zoom floor here (unlike the
    // playback tool's multi-frame dedup): a floor would confirm a release
    // is "distinct" at some higher detail level that isn't what's actually
    // on screen, so stepping could report a resolved-date change with the
    // visible tile staying identical at the live, zoomed-out view --
    // exactly the "date changes, image doesn't" bug. Probing at the real
    // displayed zoom means whatever gets picked is guaranteed to look
    // different right now, at the cost of sometimes needing to step further
    // back to find it when zoomed way out.
    async function probeWorldImageryItemId(index, zOpt, latLngOpt) {
      const url = worldImageryUrl(index);
      const z = zOpt != null ? zOpt : Math.min(19, Math.round(map.getZoom()));
      const latLng = latLngOpt || map.getCenter();
      const centerPx = map.project(latLng, z);
      // Wrap the column: a view panned across the antimeridian projects to
      // tile X outside [0, 2^z-1], and Esri answers those with an error
      // rather than a redirect -- which silently blanked that probe point
      // and weakened the release fingerprint it feeds.
      const n = 2 ** z;
      const tx = ((Math.floor(centerPx.x / 256) % n) + n) % n;
      const ty = Math.floor(centerPx.y / 256);
      const probeUrl = url.replace("{z}", z).replace("{y}", ty).replace("{x}", tx);
      try {
        const response = await fetch(probeUrl, { method: "GET" });
        return extractItemId(response.url);
      } catch {
        return null;
      }
    }

    // Multi-point fingerprint for a Wayback release across the current
    // viewport -- catches partial re-flights where only some tiles change.
    // Used by imagery playback so "last N frames" means N visually distinct
    // composites for *this view*, not the last N global release titles.
    async function probeWorldImageryFingerprint(index, z, points) {
      const ids = await Promise.all(points.map((ll) => probeWorldImageryItemId(index, z, ll)));
      return ids.map((id) => id || "").join("|");
    }

    async function resolveWorldImageryDate(index) {
      const releases = await loadWaybackReleases();
      if (!releases.length) return;
      const resolvedId = await probeWorldImageryItemId(index);
      const match = releases.find((r) => r.itemId === resolvedId);
      resolvedWorldImagery = {
        index,
        date: match?.date || releases[index == null ? releases.length - 1 : index]?.date || null,
        itemId: resolvedId,
      };
      notifyChange("worldimagery");
      const row = historyRows?.worldimagery;
      if (row && lastEnabled.has("worldimagery")) updateHistoryRow("worldimagery", true);
    }

    function worldImageryUrl(index) {
      const releases = waybackReleases || [];
      if (!releases.length || index == null) {
        return "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
      }
      const clamped = Math.max(0, Math.min(releases.length - 1, index));
      return releases[clamped].url.replace("{level}", "{z}").replace("{row}", "{y}").replace("{col}", "{x}");
    }

    function buildGibsDaily(id) {
      // Satellite AND product both live in MetisDailySat now (was a fixed
      // true-colour-only table here) -- VIIRS satellites carry a real
      // product list (Night Lights, Cloud Top Height, etc.), each with its
      // own native zoom ceiling and jpg/png format, confirmed live against
      // GIBS' own WMTSCapabilities.xml rather than assumed like the old
      // hardcoded Level9/.jpg here was.
      const info = window.MetisDailySat?.layerInfo(id);
      if (!info) return null;
      // Terra / Aqua / VIIRS share one day-offset so the imagery date
      // stepper stays a single control for all daily true-colour products.
      const day = isoDay(-historyState.satellite);
      return L.tileLayer(
        `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${info.gibsLayer}/default/${day}/GoogleMapsCompatible_Level${info.maxNativeZoom}/{z}/{y}/{x}.${info.ext}`,
        {
          attribution: info.attribution,
          opacity: userOpacity,
          maxNativeZoom: info.maxNativeZoom,
          maxZoom: 12,
          crossOrigin: true,
        },
      );
    }

    function build(id) {
      // "satellite" is the one grid toggle for all three daily true-colour
      // GIBS sources (Terra/Aqua/VIIRS) -- daily-satellite-picker.js tracks
      // which one is actually selected; they still share one date offset.
      if (id === "satellite") return buildGibsDaily(window.MetisDailySat?.active() || "satellite");
      if (id === "worldimagery") {
        // Esri's public World Imagery basemap tiles -- keyless, native zoom
        // up to 23 vs. GIBS' 9 (upsampled to 12 here), so this is the option
        // for closer-in detail; GIBS is a same-day true-color composite.
        // historyState.worldimagery selects a specific dated Wayback
        // release instead of the live tiles when history is in use.
        return L.tileLayer(worldImageryUrl(historyState.worldimagery), {
          attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
          opacity: userOpacity,
          maxZoom: 19,
        });
      }
      if (id === "imagerylabels") {
        // Country/state borders + place names, purpose-built by Esri for
        // overlaying on dark imagery basemaps like World Imagery -- this is
        // what makes satellite view actually legible/"premium" instead of
        // an unlabeled photo. Auto-paired with satellite/worldimagery below
        // rather than being its own toggle.
        return L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
          { attribution: "Esri", maxZoom: 19, zIndex: 5 },
        );
      }
      if (id === "radar") {
        return L.tileLayer.wms("https://opengeo.ncep.noaa.gov/geoserver/conus/conus_pcpn_typ/ows", {
          layers: "conus_pcpn_typ",
          format: "image/png",
          transparent: true,
          opacity: 0.68,
          attribution: "NOAA/NCEP MRMS",
          version: "1.3.0",
        });
      }
      if (id === "globalprecip") {
        // The radar layer above is NOAA MRMS, CONUS-only. NASA's GPM IMERG
        // "best available" near-real-time composite is the global
        // equivalent -- same GIBS WMTS pattern as the satellite layer,
        // updated roughly every 30 minutes, TIME=default picks the latest.
        return L.tileLayer(
          "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png",
          {
            attribution: "NASA GPM IMERG",
            opacity: 0.75,
            maxNativeZoom: 6,
            maxZoom: 12,
            crossOrigin: true,
          },
        );
      }
      if (id === "geostationary") {
        // One toggle, up to six geostationary sources (GOES-East/West +
        // Himawari via NASA GIBS WMTS, Meteosat-0deg/IODC + MTG via
        // EUMETSAT's EUMETView WMS) -- which ones are actually on and which
        // product each shows both live in geo-satellite-picker.js, so this
        // just builds
        // whichever sub-layers are currently selected and returns them as
        // one group. historyState.geostationary is a shared minutes-ago
        // offset (0 = live) stepped/picked via the imagery-date row, same
        // as the other raster layers' history controls.
        const pinnedTime = historyState.geostationary === 0 ? null : isoMinutesAgo(historyState.geostationary);
        const active = window.MetisGeoSat?.activeSatellites() || [];
        const sublayers = active.map((satId) => {
          const info = window.MetisGeoSat.layerInfo(satId);
          if (!info) return null;
          if (info.type === "wmts") {
            // "default/default" is GIBS' own "latest" shorthand; a specific
            // instant needs an actual timestamp in that slot instead --
            // confirmed live that GIBS accepts arbitrary minute-precision
            // ISO8601 there and snaps to the nearest real ~10-min scene
            // (Layer-Time-Actual response header), not just whole days.
            // GIBS itself is never a caching problem (see above), so live
            // view just stays "default" -- no cache-busting needed here.
            const timeSlot = pinnedTime || "default";
            return L.tileLayer(
              `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${info.gibsLayer}/default/${timeSlot}/GoogleMapsCompatible_Level${info.maxNativeZoom}/{z}/{y}/{x}.png`,
              {
                attribution: info.attribution,
                opacity: userOpacity,
                maxNativeZoom: info.maxNativeZoom,
                maxZoom: 12,
                crossOrigin: true,
                errorTileUrl: TRANSPARENT_TILE,
              },
            );
          }
          // EUMETSAT's WMS only advertises EPSG:4326/CRS:84 in its
          // capabilities but reprojects to EPSG:3857 fine on request
          // (verified live) -- Leaflet's default WMS CRS is already 3857,
          // so no extra crs option is needed here. Live view pins every
          // tile to this layer's actual current scene, fetched via
          // GetCapabilities (see refreshMtgTimeDefaults above) -- falls
          // back to omitting TIME (the old "ask each tile for its own
          // latest" behaviour) only if that hasn't resolved yet, e.g. the
          // very first build before the capabilities fetch completes.
          //
          // Deliberately NOT setting crossOrigin here (unlike the GIBS
          // branch above) -- confirmed live that EUMETSAT's GetMap tile
          // responses can go through stretches of not sending an
          // Access-Control-Allow-Origin header at all (GetCapabilities on
          // the same host still sends one fine, so it's specific to tile
          // rendering, not the whole service). With crossOrigin set, a
          // browser refuses to even display such a response and falls to
          // errorTileUrl, i.e. every EUMETSAT tile going blank. Without it,
          // an <img> tag never triggers the CORS check in the first place
          // and just displays the image normally -- this map never reads
          // tile pixels back out via canvas (that's the separate playback
          // tool's own Image() objects, unaffected either way), so nothing
          // here actually needs the crossOrigin-gated canvas access it was
          // paying for.
          const liveDefault = mtgTimeDefaults?.[info.wmsLayer];
          const resolvedTime = pinnedTime || liveDefault || null;
          // "Single image" (opt-in per satellite family, see the
          // geo-satellite-picker.js dialog's Request method toggle): one
          // GetMap covering this satellite's whole viewable disc instead of
          // Leaflet's usual many-small-tiles WMS layer. Only applies to the
          // EUMETSAT wms-type satellites here -- GOES/Himawari above are
          // GIBS WMTS, which has no equivalent single-image endpoint.
          if (window.MetisGeoSat?.requestMode?.() === "single") {
            const bbox = window.MetisGeoSat.viewBbox(satId);
            if (bbox) {
              return buildSingleImageWmsLayer({
                wmsBase: info.wmsBase, wmsLayer: info.wmsLayer, bbox,
                time: resolvedTime, opacity: userOpacity, attribution: info.attribution,
                loadingLabel: info.satLabel,
              });
            }
          }
          const wmsOptions = {
            layers: info.wmsLayer,
            format: "image/png",
            transparent: true,
            version: "1.3.0",
            attribution: info.attribution,
            opacity: userOpacity,
            maxZoom: 12,
            errorTileUrl: TRANSPARENT_TILE,
          };
          if (resolvedTime) wmsOptions.time = resolvedTime;
          return L.tileLayer.wms(info.wmsBase, wmsOptions);
        }).filter(Boolean);
        if (!sublayers.length) return null;
        return L.layerGroup(sublayers);
      }
      if (id === "metop") {
        // EUMETSAT's Metop AVHRR (`eps:` workspace), same WMS host as
        // Meteosat/MTG above -- reuses mtgTimeDefaults for the same
        // reason: refreshMtgTimeDefaults() already parses every layer on
        // the whole host, not just mtg_fd/msg_*, so eps:* entries are
        // already sitting in that same cache for free. Deliberately its
        // own toggle/picker (metop-picker.js) rather than folded into
        // "Geostationary live" -- Metop is polar-orbiting, these are
        // rolling 6-orbit composites (~100 min refresh per its own
        // GetCapabilities Dimension), not a continuous full-disk feed, so
        // sharing that toggle would label it wrong even though the build
        // path is otherwise identical.
        const active = window.MetisMetop?.activeSatellites() || [];
        lastMetopTime = null;
        // Shared across every active satellite (and SST below), same as
        // geostationary's pinnedTime above -- one stepper for the whole
        // layer group rather than per-satellite. Note this is only ever the
        // user's OWN explicit "step back to this time" choice; the live
        // (unstepped) case must resolve per layer, see resolveMetopTime.
        const pinnedTime = historyState.metop === 0 ? null : isoMinutesAgo(historyState.metop);
        // Each Metop layer publishes on its own schedule and they are NOT
        // interchangeable -- measured live against GetCapabilities:
        //   eps:m01_* (Metop-B)  latest 2026-08-23T13:49Z
        //   eps:m03_* (Metop-C)  latest 2026-08-23T12:31Z
        //   eps:m02_* (Metop-A)  latest 2021-11-15T07:46Z  <- decommissioned
        //   eps:osisaf_avhrr_l3_sst  latest 00:00Z, period PT12H
        // An earlier version pinned every layer in the combined single-image
        // request to whichever one happened to be FIRST in the list, on the
        // assumption that nearestValue="1" would snap each to its own real
        // scene. Measured, that assumption is false: Metop-A asked for
        // today's time answers HTTP 502, and the SST composite answers a
        // 475-byte empty PNG (both return real imagery at their own time --
        // 149KB and 15.6KB). With Metop-A first in the list, its 2021 time
        // was pinned onto everything and the whole group went blank. So each
        // layer resolves its own time unless the user explicitly stepped.
        const resolveMetopTime = (wmsLayer) => pinnedTime || mtgTimeDefaults?.[wmsLayer] || null;
        // The UI hint has room for one timestamp, and it answers "how current
        // is what I'm looking at" -- so it must be the NEWEST of the active
        // layers, not whichever happens to be first. With Metop-A (archive,
        // 2021) selected alongside Metop-C and SST (both today), showing the
        // first would report 2021 for a view that is mostly current.
        const noteMetopTime = (t) => {
          if (!t) return;
          if (!lastMetopTime || Date.parse(t) > Date.parse(lastMetopTime)) lastMetopTime = t;
        };
        const sstOn = window.MetisMetop?.sstEnabled();
        const sstInfo = sstOn ? window.MetisMetop.sstLayerInfo() : null;
        // Same "Single image" opt-in as geostationary above, same reasoning
        // -- except Metop's own coverage is already global (its
        // GetCapabilities BoundingBox is a plain -180..180/-90..90, unlike a
        // geostationary disc), so each active satellite (+ SST) gets one
        // whole-globe GetMap instead of a tile grid.
        //
        // These deliberately are NOT merged into a single comma-list
        // `layers` request any more. WMS composites a comma list
        // server-side and would indeed make this one request instead of
        // N -- but a GetMap carries exactly ONE `time`, and these layers'
        // real latest scenes are years apart (see resolveMetopTime above).
        // Merging therefore forces every layer onto one wrong timestamp,
        // which measured as a 502 for Metop-A and an empty PNG for SST.
        // N is at most 4 here, so the honest cost of correctness is up to
        // three extra requests -- still far below the tiled path's grid.
        if (window.MetisMetop?.requestMode?.() === "single") {
          const singles = [];
          const entries = active
            .map((satId) => window.MetisMetop.layerInfo(satId))
            .filter(Boolean)
            .map((info) => ({ wmsLayer: info.wmsLayer, label: info.satLabel, attribution: info.attribution }));
          if (sstInfo) entries.push({ wmsLayer: sstInfo.wmsLayer, label: "SST", attribution: sstInfo.attribution });
          if (!entries.length) return null;
          entries.forEach((entry, i) => {
            const resolvedTime = resolveMetopTime(entry.wmsLayer);
            noteMetopTime(resolvedTime);
            singles.push(buildSingleImageWmsLayer({
              wmsBase: "https://view.eumetsat.int/geoserver/wms",
              wmsLayer: entry.wmsLayer,
              bbox: { west: -180, south: -90, east: 180, north: 90 },
              time: resolvedTime, opacity: userOpacity, attribution: entry.attribution,
              // One badge for the whole group, not one per satellite --
              // EquirectangularTileLayer raises its own from onAdd.
              loadingLabel: i === 0 ? `Metop AVHRR (${entries.map((e) => e.label).join(", ")})` : null,
            }));
          });
          return singles.length === 1 ? singles[0] : L.layerGroup(singles);
        }
        const sublayers = active.map((satId) => {
          const info = window.MetisMetop.layerInfo(satId);
          if (!info) return null;
          const wmsOptions = {
            layers: info.wmsLayer,
            format: "image/png",
            transparent: true,
            version: "1.3.0",
            attribution: info.attribution,
            opacity: userOpacity,
            maxZoom: 12,
            errorTileUrl: TRANSPARENT_TILE,
          };
          const resolved = resolveMetopTime(info.wmsLayer);
          if (resolved) wmsOptions.time = resolved;
          noteMetopTime(wmsOptions.time);
          return L.tileLayer.wms(info.wmsBase, wmsOptions);
        }).filter(Boolean);
        if (sstInfo) {
          const sstOptions = {
            layers: sstInfo.wmsLayer,
            format: "image/png",
            transparent: true,
            version: "1.3.0",
            attribution: sstInfo.attribution,
            opacity: userOpacity,
            maxZoom: 12,
            errorTileUrl: TRANSPARENT_TILE,
          };
          const sstResolved = resolveMetopTime(sstInfo.wmsLayer);
          if (sstResolved) sstOptions.time = sstResolved;
          noteMetopTime(sstOptions.time);
          sublayers.push(L.tileLayer.wms(sstInfo.wmsBase, sstOptions));
        }
        if (!sublayers.length) return null;
        return L.layerGroup(sublayers);
      }
      if (id === "geosmosaic") {
        // CMA/NSMC's free public WMS (confirmed live: no auth, "Fees: none"
        // in its own GetCapabilities) blends every operational geostationary
        // satellite's 10.8um channel into one seamless global image,
        // refreshed hourly -- pixel-mapped the actual response to confirm:
        // real data across every longitude, gaps only at the poles (a hard
        // limit for any geostationary constellation, not a data problem).
        // No time Dimension/default published the way EUMETSAT's is
        // (confirmed -- its GetCapabilities has no Dimension element at
        // all) and it always returns HTTP 200 even for an hour that hasn't
        // finished compositing yet -- confirmed live: the current UTC hour
        // regularly comes back as a ~1KB near-empty PNG well into the hour
        // (checked 24 minutes in), while the hour before it is reliably a
        // full ~170KB+ composite. That first attempt pinned to the current
        // hour and leaned on this layer's blank/transparent handling to
        // cover the gap, but unlike the per-tile WMS layers above, this is
        // a single whole-globe image behind EquirectangularTileLayer -- a
        // blank fetch there blanks the entire layer, not just a few tiles,
        // which is exactly what made it look "not working". Pinning one
        // hour behind is the fix: always request the last hour guaranteed
        // to have finished compositing, trading an hour of freshness for a
        // layer that's actually never blank.
        // 0 (live) still means "1 hour behind now" per the freshness fix
        // above -- stepping adds ON TOP of that 1h floor (not max(1, ...),
        // which would make the first step back a no-op: state 0 and state 1
        // would both clamp to the same 1h), so "live" and "1 hour back"
        // are two distinct, visibly different button presses.
        const hoursBack = 1 + historyState.geosmosaic;
        const hour = new Date();
        hour.setUTCMinutes(0, 0, 0);
        hour.setUTCHours(hour.getUTCHours() - hoursBack);
        const datetime = `${hour.toISOString().slice(0, 13).replace(/[-T]/g, "")}00`;
        lastGeosmosaicHour = datetime;
        const imageUrl = `https://data.nsmc.org.cn/NSMCAPI/v1/nsmc/image/wms/compose?layers=GEOS_IRX&datetime=${datetime}&request=GetMap&bbox=-180,-90,180,90&width=1440&height=720&version=1.1.0&srs=EPSG:4326&format=png`;
        return new EquirectangularTileLayer(imageUrl, {
          attribution: "CMA/NSMC global geostationary IR mosaic",
          opacity: userOpacity,
          maxNativeZoom: 6,
          maxZoom: 12,
          loadingLabel: "global IR mosaic",
        });
      }
      if (id === "nightlights") {
      // VIIRS' Day/Night Band nighttime-lights composite, daily cadence --
      // same GIBS "best available" pattern as the Terra/Aqua/VIIRS daily
      // true-colour layers above, so it shares their day-offset stepper
      // instead of needing a separate date control. NOAA-20's version, not
      // the original SNPP one: confirmed live against GetCapabilities that
      // SNPP's DayNightBand_ENCC stopped updating in mid-2023 (its `default`
      // still resolves to 2023, and a current date 404s) while NOAA-20's
      // `default` resolves to today and both today's and yesterday's dates
      // return real tiles.
      const day = isoDay(-historyState.satellite);
      return L.tileLayer(
        `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_DayNightBand/default/${day}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`,
        {
          attribution: "NASA EOSDIS GIBS (VIIRS NOAA-20 Day/Night Band)",
          opacity: userOpacity,
          maxNativeZoom: 7,
          maxZoom: 12,
          crossOrigin: true,
        },
      );
    }
    if (id === "s2cloudless") {
        // EOX's cloud-free Sentinel-2 annual composite -- one full mosaic
        // per year (2017-2025), each a genuinely distinct dataset (unlike
        // Wayback there's no redirect/dedup concern: every year is directly
        // addressable), so a simple year offset is all this needs.
        const year = S2CLOUDLESS_LATEST_YEAR - historyState.s2cloudless;
        return L.tileLayer(
          `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg`,
          { attribution: `EOX s2cloudless ${year}`, opacity: userOpacity, maxNativeZoom: 14, maxZoom: 16, crossOrigin: true },
        );
      }
      if (id === "sentinelhub") {
        // Bring-your-own free Copernicus Data Space instance ID -- the WMS
        // GetMap auth is just that ID in the URL path, no OAuth token needed.
        // Sentinel-2's ~5-day revisit means the exact picked date often has
        // no scene at all, so this asks for the most recent scene in a
        // trailing window ending on that date rather than pretending to
        // know the picked day's imagery exists (the earlier Wayback bug this
        // session was exactly that kind of false-precision timestamp).
        const instanceId = window.MetisApiKeys?.keyFor("sentinelhub");
        if (!instanceId) return null;
        const endDate = historyState.sentinelhub || isoDay(0);
        const shLayer = window.MetisApiKeys?.layerFor("sentinelhub") || "TRUE_COLOR";
        const shMaxCC = window.MetisApiKeys?.ccFor("sentinelhub");
        const shResample = window.MetisApiKeys?.resampleFor("sentinelhub");
        const shPriority = window.MetisApiKeys?.priorityFor("sentinelhub");
        // Shared with the playback tool (sentinel-hub.js) -- one place
        // building these params instead of two hand-rolled copies that can
        // silently drift apart.
        return L.tileLayer.wms(`https://sh.dataspace.copernicus.eu/ogc/wms/${instanceId}`, {
          ...window.MetisSentinelHub.wmsOptions({
            layer: shLayer, endDate, maxcc: shMaxCC, resample: shResample, priority: shPriority,
            singleDate: sentinelhubTimeMode === "single",
          }),
          attribution: `Copernicus Sentinel-2 (${shLayer}) / Sentinel Hub`,
          opacity: userOpacity,
          // Deliberately NOT setting crossOrigin: nothing here reads these
          // pixels back (see the reverted-gap-fill note above, and
          // attachTileFeedback's note on the removed blank-tile check), and
          // setting it means any response that happens to omit CORS headers
          // -- an error page, a rate-limit body -- is refused by the browser
          // and renders blank instead of just displaying, which is the exact
          // failure mode documented for EUMETSAT below. No upside, real
          // downside.
          // Sentinel Hub's S2L1C collection enforces a 200 m/pixel resolution
          // ceiling server-side -- request a tile any more zoomed-out than
          // that and it returns a *rendered error image* as if it were valid
          // tile content ("Your request of N meters per pixel exceeds the
          // limit 200.00...") instead of a clean failure, which then tiles
          // across the whole view. z10 keeps every tile under ~153 m/px even
          // at the equator (the worst case for Web Mercator), with margin.
          minZoom: 10,
          // maxNativeZoom (not maxZoom) for the zoomed-in end: z18 is already
          // far finer than Sentinel-2's native ~10m resolution, and verified
          // live that requesting even deeper zoom doesn't error server-side
          // (Sentinel Hub just upsamples). The bug was purely client-side --
          // a bare maxZoom:18 makes Leaflet stop rendering *this* layer's
          // tiles past z18 while the basemap underneath keeps zooming,
          // which is what showed up as the tile going black. maxNativeZoom
          // keeps fetching real data up to z18 and lets Leaflet CSS-upscale
          // that tile for anything deeper instead of going blank.
          maxNativeZoom: 18,
          maxZoom: 22,
        });
      }
      return null;
    }

    // Human-readable names for the loading badge. Only imagery layers the
    // user explicitly turns on get one -- the labels/reference overlay loads
    // alongside them and a second badge for it would just be noise.
    const LOADING_LABELS = {
      satellite: "satellite imagery", worldimagery: "World Imagery",
      s2cloudless: "cloud-free mosaic", sentinelhub: "Sentinel imagery",
      nightlights: "night lights", geostationary: "geostationary imagery",
      metop: "Metop AVHRR", geosmosaic: "IR mosaic",
      radar: "radar", globalprecip: "precipitation",
    };
    // A tile that errors is currently only recovered by zooming out and back
    // in (which makes Leaflet re-request the whole level), so a transient
    // 5xx/timeout leaves a permanent-looking hole. Retry just that tile, with
    // backoff, a bounded number of times. This costs nothing on the happy
    // path: it only ever runs from the error event, never during normal load.
    const TILE_RETRY_LIMIT = 2;
    // NOTE (deliberately not reinstated): a pixel-sampling "is this tile
    // blank?" check used to run here on every tileload, to catch providers
    // returning a 200 OK but empty image. It was removed after measuring:
    // reading pixels cost ~1.6ms per tile (so 40-160ms of main-thread
    // blocking per pan/zoom at 25-100 tiles), and -- worse -- it cannot tell
    // a failed render from legitimate transparency. Transparency is normal,
    // expected data for several of these layers: IMERG is transparent
    // wherever it isn't raining, geostationary is transparent off-disc,
    // night lights is transparent over the daylit hemisphere. Measured 4
    // false positives out of 25 IMERG tiles, each then re-fetched twice with
    // a cache-busting param -- tripling requests for tiles that were correct
    // the first time. Any future attempt needs a signal that distinguishes
    // "provider failed" from "nothing here", which pixel alpha alone is not.
    function attachTileFeedback(id, layer) {
      if (!layer || layer._metisInstrumented || typeof layer.on !== "function") return layer;
      layer._metisInstrumented = true;

      // EquirectangularTileLayer raises its own badge from onAdd (it fetches
      // one big image rather than a tile grid), so double-badging it would
      // stack two spinners for the same load.
      const label = LOADING_LABELS[id];
      if (label && !(layer instanceof EquirectangularTileLayer)) {
        let dismiss = null;
        const clear = () => { if (dismiss) { dismiss(); dismiss = null; } };
        layer.on("loading", () => { if (!dismiss) dismiss = singleImageLoadingBadge(map, label); });
        // "load" fires when the visible tile set finishes; "remove" covers the
        // user toggling the layer off mid-load, which would otherwise strand
        // the badge on screen forever.
        layer.on("load", clear);
        layer.on("remove", clear);
      }

      layer.on("tileerror", (event) => {
        const tile = event?.tile;
        if (!tile || !tile.src) return;
        const attempt = (tile._metisRetries || 0) + 1;
        if (attempt > TILE_RETRY_LIMIT) return;
        tile._metisRetries = attempt;
        const src = tile.src;
        setTimeout(() => {
          // Re-request the identical URL rather than appending a cache-buster:
          // several of these providers sign or strictly validate their query
          // strings, and an extra param risks turning a retryable blip into a
          // hard 400. Clearing src first is what actually forces the refetch --
          // assigning the same value is a no-op.
          if (!tile.parentNode) return; // tile was pruned by a pan/zoom meanwhile
          tile.src = "";
          tile.src = src;
        }, 400 * attempt);
      });
      return layer;
    }

    function rebuild(id) {
      const existing = overlays.get(id);
      if (existing && map.hasLayer(existing)) map.removeLayer(existing);
      overlays.delete(id);
      const layer = attachTileFeedback(id, build(id));
      if (layer) {
        overlays.set(id, layer);
        layer.addTo(map);
      }
      if (id === "worldimagery" && historyState.worldimagery != null) {
        resolveWorldImageryDate(historyState.worldimagery);
      }
    }

    let lastEnabled = new Set();
    function sync(enabled) {
      lastEnabled = enabled;
      for (const id of ["satellite", "worldimagery", "radar", "globalprecip", "geostationary", "s2cloudless", "sentinelhub", "nightlights", "metop", "geosmosaic"]) {
        const shouldShow = enabled.has(id);
        let layer = overlays.get(id);
        if (shouldShow && !layer) {
          layer = attachTileFeedback(id, build(id));
          if (layer) overlays.set(id, layer);
        }
        if (shouldShow && layer && !map.hasLayer(layer)) layer.addTo(map);
        if (!shouldShow && layer && map.hasLayer(layer)) map.removeLayer(layer);
      }
      const showLabels = enabled.has("satellite") || enabled.has("worldimagery") || enabled.has("geostationary")
        || enabled.has("s2cloudless") || enabled.has("sentinelhub") || enabled.has("nightlights")
        || enabled.has("metop") || enabled.has("geosmosaic");
      let labels = overlays.get("imagerylabels");
      if (showLabels && !labels) {
        // Retry behaviour but no badge (no entry in LOADING_LABELS).
        labels = attachTileFeedback("imagerylabels", build("imagerylabels"));
        overlays.set("imagerylabels", labels);
      }
      if (showLabels && labels && !map.hasLayer(labels)) labels.addTo(map);
      if (!showLabels && labels && map.hasLayer(labels)) map.removeLayer(labels);

      // World Imagery is the one layer in the showLabels set with genuine
      // global gap-free coverage (confirmed live earlier: real tiles
      // worldwide through z23) -- it fully occludes the dark canvas
      // basemap, and Leaflet keeps fetching that basemap's tiles on every
      // pan/zoom regardless, since it has no idea they're covered. That
      // was pure waste competing for the same connection pool as the
      // visible imagery, and it's what actually made panning feel slow
      // with World Imagery on. The other showLabels members (geostationary
      // disks, Metop swaths, Sentinel Hub scenes, etc.) only cover part of
      // the globe -- pulling the basemap out from under those left blank
      // white space wherever the satellite doesn't reach (confirmed live:
      // regressed exactly this way when the condition was showLabels
      // instead of just worldimagery), so they keep the basemap as their
      // fallback background like before. Re-adding on toggle-off is
      // instant since Leaflet keeps its tile cache.
      const hideBase = enabled.has("worldimagery");
      if (baseLayers) {
        for (const base of baseLayers) {
          if (hideBase && map.hasLayer(base)) map.removeLayer(base);
          if (!hideBase && !map.hasLayer(base)) base.addTo(map);
        }
      }

      if (toggleButtons) {
        toggleButtons.satellite?.classList.toggle("active", enabled.has("satellite"));
        toggleButtons.worldimagery?.classList.toggle("active", enabled.has("worldimagery"));
      }
      updateHistoryRow("satellite", enabled.has("satellite"));
      updateHistoryRow("worldimagery", enabled.has("worldimagery"));
      // Kick off the Wayback release list as soon as the layer goes on,
      // instead of waiting for a first prev/next click -- otherwise the
      // date field sits blank until the user interacts with it.
      if (enabled.has("worldimagery") && waybackReleases == null) {
        loadWaybackReleases().then(() => updateHistoryRow("worldimagery", lastEnabled.has("worldimagery")));
      }
    }

    // GOES/Himawari tiles use a literal TIME=default (GIBS resolves that to
    // its latest published slot server-side), so a plain redraw is enough
    // to pick up newer imagery there. EUMETSAT's WMS sublayers carry an
    // explicit TIME baked in at construction from GetCapabilities (see the
    // geostationary branch of build()), so a redraw alone would keep
    // re-requesting that same now-stale instant forever -- refresh the
    // capabilities first, then do a full rebuild to pick up whatever's now
    // current for every active EUMETSAT product. Skipped while a
    // historical instant is selected -- that view doesn't change over time.
    setInterval(() => {
      if (lastEnabled.has("geostationary") && historyState.geostationary === 0) {
        refreshMtgTimeDefaults().finally(() => rebuild("geostationary"));
      }
      // Metop shares the exact same GetCapabilities-pinned TIME cache
      // (refreshMtgTimeDefaults parses every layer on the host, eps:* is
      // already in there) -- needs the same periodic refresh+rebuild for
      // the same reason, but skipped independently in case only one of the
      // two is actually on.
      if (lastEnabled.has("metop")) {
        refreshMtgTimeDefaults().finally(() => rebuild("metop"));
      }
      // No capabilities to refresh here -- geosmosaic just needs a fresh
      // build so its pinned hour (computed at build time) advances.
      if (lastEnabled.has("geosmosaic")) rebuild("geosmosaic");
    }, 10 * 60 * 1000);

    // Lets external UI (the sidebar layer rail) mirror the same date instead
    // of duplicating the floating control's date-stepping logic.
    const changeListeners = new Set();
    function getDate(id) {
      if (id === "satellite") return isoDay(-historyState.satellite);
      if (resolvedWorldImagery.index === historyState.worldimagery && resolvedWorldImagery.date) {
        return resolvedWorldImagery.date;
      }
      const releases = waybackReleases || [];
      const idx = historyState.worldimagery == null ? releases.length - 1 : historyState.worldimagery;
      return releases[idx]?.date || "";
    }
    function notifyChange(id) {
      const date = getDate(id);
      for (const cb of changeListeners) cb(id, date);
    }

    function updateHistoryRow(id, visible) {
      notifyChange(id);
      const row = historyRows?.[id];
      if (!row) return;
      row.wrap.classList.toggle("show", visible);
      if (!visible) return;
      if (id === "satellite") {
        row.label.value = getDate("satellite");
        row.next.disabled = historyState.satellite <= 0;
      } else {
        const releases = waybackReleases || [];
        row.label.value = getDate("worldimagery");
        row.next.disabled = historyState.worldimagery == null;
        // The release list loads lazily on first use (see stepHistory), so
        // it may legitimately be empty here -- prev must stay enabled so
        // that first click can happen at all. Only disable once we've
        // loaded the list and confirmed we're already at the oldest entry.
        row.prev.disabled = waybackReleases != null && historyState.worldimagery === 0;
      }
    }

    function rebuildGibsDaily() {
      if (lastEnabled.has("satellite")) rebuild("satellite");
      // Nightlights shares historyState.satellite's day-offset (see build()'s
      // "nightlights" branch) instead of its own date control, so it has to
      // be rebuilt in lockstep whenever that offset changes.
      if (lastEnabled.has("nightlights")) rebuild("nightlights");
    }

    async function stepHistory(id, direction) {
      if (id === "satellite") {
        const requested = Math.max(0, Math.min(365 * 10, historyState.satellite - direction));
        historyState.satellite = await resolveSatelliteOffset(requested, direction);
        rebuildGibsDaily();
        updateHistoryRow("satellite", lastEnabled.has("satellite"));
        return;
      }
      const releases = await loadWaybackReleases();
      if (!releases.length) return;
      const current = historyState.worldimagery == null ? releases.length - 1 : historyState.worldimagery;
      // Wayback only stores a new tile where a spot was actually re-flown --
      // the immediately adjacent release in the list can easily redirect to
      // the exact same underlying imagery as the current one, making a
      // single step visibly do nothing. Keep stepping in the requested
      // direction until the resolved image genuinely differs (or the list
      // runs out), the same idea as the playback tool's dedup.
      const currentItemId = resolvedWorldImagery.index === current && resolvedWorldImagery.itemId
        ? resolvedWorldImagery.itemId
        : await probeWorldImageryItemId(current);
      // Probing at the live (not floored) zoom means a very zoomed-out view
      // can need many hops before finding a genuinely different overview
      // tile -- probe in parallel batches (same pattern as the playback
      // tool's dedup) so that search stays fast instead of one network
      // round-trip at a time.
      const STEP_PROBE_BATCH = 8;
      let candidate = current;
      let resolved = null;
      outer: while (true) { // eslint-disable-line no-labels
        const batch = [];
        let cursor = candidate;
        for (let i = 0; i < STEP_PROBE_BATCH; i++) {
          const next = Math.max(0, Math.min(releases.length - 1, cursor + direction));
          if (next === cursor) break; // hit the end of the list
          cursor = next;
          batch.push(cursor);
        }
        if (!batch.length) break;
        // eslint-disable-next-line no-await-in-loop
        const batchIds = await Promise.all(batch.map((idx) => probeWorldImageryItemId(idx)));
        for (let i = 0; i < batch.length; i++) {
          if (!currentItemId || !batchIds[i] || batchIds[i] !== currentItemId) {
            resolved = batch[i];
            break outer; // eslint-disable-line no-labels
          }
        }
        candidate = batch[batch.length - 1];
      }
      historyState.worldimagery = resolved != null ? resolved : candidate;
      if (lastEnabled.has("worldimagery")) rebuild("worldimagery");
      updateHistoryRow("worldimagery", lastEnabled.has("worldimagery"));
    }

    // Lets a specific date be typed/picked directly instead of stepping one
    // release at a time -- same underlying historyState, just set in one jump.
    async function setHistoryDate(id, dateStr) {
      if (!dateStr) return;
      if (id === "satellite") {
        const entered = new Date(`${dateStr}T00:00:00Z`);
        if (Number.isNaN(entered.getTime())) return;
        // Anchored to today (offset 0), not yesterday -- today is now a
        // valid, probeable offset (see probeSatelliteDay above), so typing
        // today's own date should resolve to 0 instead of being pushed back
        // a day. Both sides are midnight UTC, so this is an exact whole-day
        // difference with no time-of-day rounding to worry about.
        const today = new Date(`${isoDay(0)}T00:00:00Z`);
        const days = Math.round((today - entered) / 86400000);
        historyState.satellite = await resolveSatelliteOffset(Math.max(0, Math.min(365 * 10, days)), -1);
        rebuildGibsDaily();
        updateHistoryRow("satellite", lastEnabled.has("satellite"));
        return;
      }
      const releases = await loadWaybackReleases();
      if (!releases.length) return;
      // Releases are sorted oldest-to-newest -- pick the latest one at or
      // before the entered date, falling back to the oldest if none qualify.
      let idx = 0;
      for (let i = 0; i < releases.length; i++) {
        if (releases[i].date <= dateStr) idx = i;
      }
      historyState.worldimagery = idx;
      if (lastEnabled.has("worldimagery")) rebuild("worldimagery");
      updateHistoryRow("worldimagery", lastEnabled.has("worldimagery"));
    }

    // A small zoom-adjacent toggle for the two satellite imagery options,
    // plus a reset-view button -- stacks directly under Leaflet's own zoom
    // control since both are topleft controls added in this order, without
    // needing the layer rail. Each imagery button gets its own compact
    // history stepper that only appears once that layer is active.
    let toggleButtons = null;
    let historyRows = null;
    let toolsButton = null;
    const control = L.control({ position: "topleft" });
    control.onAdd = () => {
      const wrap = L.DomUtil.create("div", "metis-imagery-control");
      const bar = L.DomUtil.create("div", "leaflet-bar metis-overlay-toggle", wrap);

      const toolsBtn = L.DomUtil.create("button", "", bar);
      toolsBtn.type = "button";
      toolsBtn.title = "Measure distance and area";
      toolsBtn.innerHTML = ICONS.ruler;

      const homeBtn = L.DomUtil.create("button", "", bar);
      homeBtn.type = "button";
      homeBtn.title = "Reset view";
      homeBtn.innerHTML = ICONS.home;

      const satBtn = L.DomUtil.create("button", "", bar);
      satBtn.type = "button";
      satBtn.title = "NASA GIBS true-color satellite";
      satBtn.innerHTML = ICONS.satellite;
      const satHistory = buildHistoryRow(wrap, "satellite");

      const imgBtn = L.DomUtil.create("button", "", bar);
      imgBtn.type = "button";
      imgBtn.title = "Esri World Imagery (higher zoom, historical archive)";
      imgBtn.innerHTML = ICONS.globe;
      const imgHistory = buildHistoryRow(wrap, "worldimagery");

      L.DomEvent.disableClickPropagation(wrap);
      L.DomEvent.on(homeBtn, "click", () => onToggle?.("__home"));
      L.DomEvent.on(satBtn, "click", () => onToggle?.("satellite"));
      L.DomEvent.on(imgBtn, "click", () => onToggle?.("worldimagery"));
      toggleButtons = { satellite: satBtn, worldimagery: imgBtn };
      historyRows = { satellite: satHistory, worldimagery: imgHistory };
      toolsButton = toolsBtn;
      return wrap;
    };
    function buildHistoryRow(parent, id) {
      const row = L.DomUtil.create("div", "metis-overlay-history", parent);
      const prev = L.DomUtil.create("button", "", row);
      prev.type = "button";
      prev.title = "Older imagery";
      prev.textContent = "‹";
      const label = L.DomUtil.create("input", "", row);
      if (id === "satellite") {
        label.type = "date";
        label.title = "Pick a specific date";
        label.max = isoDay(-1);
        label.min = SATELLITE_MISSION_START;
      } else {
        // Wayback releases are sparse, specific dates -- a free-typed date
        // input invites picking a day with no release at all and getting
        // silently snapped elsewhere. Read-only display of the resolved
        // date instead; prev/next (below) are the only way to move.
        label.type = "text";
        label.readOnly = true;
        label.title = "Resolved release date -- use ‹ / › to step";
      }
      const next = L.DomUtil.create("button", "", row);
      next.type = "button";
      next.title = "Newer imagery";
      next.textContent = "›";
      L.DomEvent.on(prev, "click", () => stepHistory(id, -1));
      L.DomEvent.on(next, "click", () => stepHistory(id, 1));
      L.DomEvent.on(label, "change", () => setHistoryDate(id, label.value));
      L.DomEvent.disableClickPropagation(row);
      return { wrap: row, label, prev, next };
    }
    control.addTo(map);

    // Sentinel Hub mosaics the least-cloudy scene in a trailing window, so
    // the date typed/stepped in the UI is only a request -- the actual scene
    // behind any given pixel can be any day in that window, and a stricter
    // cloud-coverage cap can push it further back (or find nothing at all).
    // WMS GetFeatureInfo on the *same* instance ID (no separate OAuth needed,
    // unlike Sentinel Hub's Catalog/STAC API) returns that real scene's date
    // and cloud % for whatever pixel is queried -- used here at the map
    // center as a representative "what you're actually looking at" readout.
    async function queryFeatureInfoOnce(singleDate) {
      const instanceId = window.MetisApiKeys?.keyFor("sentinelhub");
      if (!instanceId) return null;
      const shLayer = window.MetisApiKeys?.layerFor("sentinelhub") || "TRUE_COLOR";
      const endDate = historyState.sentinelhub || isoDay(0);
      const shMaxCC = window.MetisApiKeys?.ccFor("sentinelhub");
      const shPriority = window.MetisApiKeys?.priorityFor("sentinelhub");
      const z = Math.max(10, Math.round(map.getZoom()));
      const half = 32;
      const centerPx = map.project(map.getCenter(), z);
      const nw = map.unproject([centerPx.x - half, centerPx.y - half], z);
      const se = map.unproject([centerPx.x + half, centerPx.y + half], z);
      const nwM = L.CRS.EPSG3857.project(nw);
      const seM = L.CRS.EPSG3857.project(se);
      const url = window.MetisSentinelHub.featureInfoUrl({
        instanceId, layer: shLayer, endDate, maxcc: shMaxCC, priority: shPriority, singleDate,
        bboxMeters: `${nwM.x},${seM.y},${seM.x},${nwM.y}`, size: half * 2, i: half, j: half,
      });
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const json = await res.json();
        return json?.features?.[0]?.properties || null;
      } catch {
        return null;
      }
    }

    // Confirmed live against an official Landsat template: a start/end TIME
    // range that Sentinel-2 resolves into "the best scene in that span"
    // returns almost nothing on some other WMS layers, while a bare end
    // date on the exact same layer/instance returns the real scene. Try the
    // range first (right for Sentinel-2, the common case, and keeps the
    // "search back and find one" convenience wherever it's supported); if
    // it comes back empty, retry with just the end date before concluding
    // there's genuinely no scene. Whichever mode actually finds something
    // becomes sentinelhubTimeMode, which build()'s live tile layer reads too
    // -- rebuilding here (not just reporting) is what actually fixes what's
    // on screen, not just the resolved-date readout.
    async function sentinelHubResolvedInfo() {
      if (!window.MetisApiKeys?.keyFor("sentinelhub")) return null;
      const endDate = historyState.sentinelhub || isoDay(0);
      const startDate = window.MetisSentinelHub.shiftDay(endDate, -(window.MetisSentinelHub.WINDOW_DAYS - 1));

      const rangeProps = await queryFeatureInfoOnce(false);
      if (rangeProps) {
        if (sentinelhubTimeMode !== "range") {
          sentinelhubTimeMode = "range";
          if (lastEnabled.has("sentinelhub")) rebuild("sentinelhub");
        }
        return { date: rangeProps.date, cloud: rangeProps.cloudCoverPercentage, window: [startDate, endDate] };
      }

      const singleProps = await queryFeatureInfoOnce(true);
      if (singleProps) {
        if (sentinelhubTimeMode !== "single") {
          sentinelhubTimeMode = "single";
          if (lastEnabled.has("sentinelhub")) rebuild("sentinelhub");
        }
        return { date: singleProps.date, cloud: singleProps.cloudCoverPercentage, window: [endDate, endDate] };
      }

      return { date: null, cloud: null, window: [startDate, endDate] };
    }

    return {
      sync,
      // Reset-to-live-on-toggle-on, one per independently-toggleable layer
      // (a single combined resetHistory() would wrongly reset e.g.
      // worldimagery's deliberately-picked historical date just because
      // satellite was toggled) -- same fix as resetGeostationary above,
      // for the same reason: otherwise re-checking the box after having
      // stepped/picked into history leaves it pinned there instead of
      // showing what "on" should mean, the current view.
      resetSatelliteHistory: () => {
        // Offset 1 ("yesterday") is the default (see historyState's own
        // comment above) -- paint that optimistically first so toggling the
        // layer on stays instant, then confirm in the background in case
        // even yesterday's imagery isn't fully published yet (rare, but
        // possible very early in the UTC day): search further back rather
        // than leave a still-incomplete day showing.
        historyState.satellite = 1;
        resolveSatelliteOffset(1, -1).then((resolved) => {
          if (resolved === 1 || historyState.satellite !== 1) return; // yesterday held up, or the user already moved on
          historyState.satellite = resolved;
          rebuildGibsDaily();
          updateHistoryRow("satellite", lastEnabled.has("satellite"));
        }).catch(() => {}); // leave yesterday showing -- a failed probe isn't worth correcting away from
      },
      resetWorldImageryHistory: () => { historyState.worldimagery = null; },
      resetS2History: () => { historyState.s2cloudless = 0; },
      resetSentinelHubHistory: () => {
        historyState.sentinelhub = isoDay(0);
        if (lastEnabled.has("sentinelhub")) rebuild("sentinelhub");
      },
      getDate,
      setDate: setHistoryDate,
      step: stepHistory,
      ensureReleasesLoaded: loadWaybackReleases,
      probeWorldImageryItemId,
      probeWorldImageryFingerprint,
      extractItemId,
      getReleaseBounds: () => {
        const releases = waybackReleases || [];
        return releases.length ? { min: releases[0].date, max: releases[releases.length - 1].date } : null;
      },
      onHistoryChange: (cb) => { changeListeners.add(cb); return () => changeListeners.delete(cb); },
      getS2Year: () => S2CLOUDLESS_LATEST_YEAR - historyState.s2cloudless,
      setS2Year: (year) => {
        const clamped = Math.max(S2CLOUDLESS_OLDEST_YEAR, Math.min(S2CLOUDLESS_LATEST_YEAR, year | 0));
        historyState.s2cloudless = S2CLOUDLESS_LATEST_YEAR - clamped;
        if (lastEnabled.has("s2cloudless")) rebuild("s2cloudless");
      },
      s2YearBounds: { min: S2CLOUDLESS_OLDEST_YEAR, max: S2CLOUDLESS_LATEST_YEAR },
      getSentinelHubDate: () => historyState.sentinelhub || isoDay(0),
      setSentinelHubDate: (dateStr) => {
        if (!dateStr) return;
        historyState.sentinelhub = dateStr;
        if (lastEnabled.has("sentinelhub")) rebuild("sentinelhub");
      },
      sentinelHubWindowDays: SENTINELHUB_WINDOW_DAYS,
      sentinelHubResolvedInfo,
      // Lets an external picker (geo-satellite-picker.js's product change,
      // same idea as the Sentinel Hub key-changed listener) force a redraw
      // with new settings without needing to know about `overlays`/`build`.
      rebuildIfEnabled: (id) => { if (lastEnabled.has(id)) rebuild(id); },
      // sync() only calls build() when nothing is cached yet for that id --
      // cheap reuse for layers whose own build() output never changes
      // between toggles, but wrong for geostationary, whose active-
      // satellites/product selection can change (via the picker) whenever
      // it's toggled off and back on. Without this, re-checking the box
      // just re-adds the SAME stale layer group built from whatever the
      // satellite selection was the last time it was actually constructed
      // -- confirmed live: activeSatellites() correctly reporting the new
      // selection while the rendered tiles kept showing an old, since-
      // removed satellite mixed in. Called right before sync() so the next
      // sync() is forced to build fresh.
      invalidate: (id) => {
        const existing = overlays.get(id);
        if (existing && map.hasLayer(existing)) map.removeLayer(existing);
        overlays.delete(id);
      },
      refreshMtgTimeDefaults,
      // This layer's own publish cadence in minutes, from the same
      // GetCapabilities Dimension refreshMtgTimeDefaults parses (call that
      // first). Playback steps its frames by this instead of assuming
      // everything is on GIBS' 10-minute grid -- see mtgTimePeriods above
      // for why that assumption produced identical frames.
      mtgTimePeriodFor: (wmsLayer) => mtgTimePeriods[wmsLayer] || null,
      mtgTimeExtentFor: (wmsLayer) => mtgTimeExtents[wmsLayer] || null,
      // Every timestamp this layer ACTUALLY publishes between fromMs and toMs,
      // oldest first. Call refreshMtgTimeDefaults() first; returns null if the
      // layer's extent isn't known, so callers can fall back rather than
      // silently producing nothing.
      //
      // Phase-locked to the extent's END, walking backwards -- NOT forward
      // from its start. Measured live: Metop-B's declared extent spans
      // 3,142,875 minutes at a 100-minute period, which is not a whole
      // number of periods (75 minutes over). Enumerating forward from the
      // start would therefore land 75 minutes off every real slot, and
      // EUMETSAT answers a between-slots TIME with a slow HTTP 502 rather
      // than a quick 404. MTG's extent happens to divide evenly, so a
      // forward walk would have looked correct there and hidden the bug.
      //
      // stepDivisor (default 1) steps the grid finer than the declared
      // period -- for Metop specifically. The declared "PT1H40M" is a
      // NOMINAL period; Metop is a polar orbiter, and its real orbit-to-
      // orbit interval jitters by a few minutes rather than landing on an
      // exact grid. Measured live: 6 hand-verified real Metop-B slots had
      // gaps of 99, 99, 100, 100 min -- not a clean 100 -- and probing only
      // at the nominal 100-min step (divisor 1) demonstrably missed real
      // slots that existed a few minutes off the guessed grid. Confirmed
      // this is Metop-specific, not general: the SAME test against MTG
      // (PT10M) and Meteosat (PT15M) found 8/8 distinct images exactly on
      // their declared grid, zero jitter -- geostationary satellites scan
      // on a fixed ground schedule, unlike a polar orbit. Callers pass 2
      // only for the Metop family; every other layer keeps divisor 1, so
      // this doesn't double MTG's already-large 10-minute-cadence request
      // count for no reason. A finer grid can probe the SAME real slot
      // twice from two adjacent candidates; callers dedupe by comparing
      // each frame's actual fetched content, not by trusting the grid.
      mtgTimeSlotsBetween: (wmsLayer, fromMs, toMs, stepDivisor = 1) => {
        const extent = mtgTimeExtents[wmsLayer];
        if (!extent) return null;
        const stepMs = (extent.periodMin * 60000) / Math.max(1, stepDivisor);
        const upper = Math.min(toMs, extent.endMs);
        const lower = Math.max(fromMs, extent.startMs);
        if (!(upper >= lower)) return [];
        // Snap the newest requested instant down onto the real slot grid.
        const newest = extent.endMs - Math.floor((extent.endMs - upper) / stepMs) * stepMs;
        const slots = [];
        for (let t = newest; t >= lower; t -= stepMs) slots.unshift(t);
        return slots;
      },
      // The ruler button lives in this module's own Leaflet control (next
      // to reset-view/satellite/world-imagery), not in the sidebar --
      // map-tools.js needs the actual element to wire its click handler
      // and active-state styling onto.
      getToolsButton: () => toolsButton,
      // null return means "live" -- callers display that as its own state
      // rather than a timestamp string.
      getGeostationaryTimestamp: () => (historyState.geostationary === 0 ? null : isoMinutesAgo(historyState.geostationary)),
      // Whatever build() last resolved -- used both as the read-only "how
      // fresh is this" text and, below, to seed the stepper inputs.
      getMetopTimestamp: () => lastMetopTime,
      getGeosmosaicHour: () => lastGeosmosaicHour,
      geostationaryOffsetMinutes: () => historyState.geostationary,
      geostationaryMaxMinutes: GEO_HISTORY_MAX_MINUTES,
      geostationaryStepMinutes: GEO_STEP_MINUTES,
      stepGeostationary: (direction) => {
        historyState.geostationary = Math.max(0, Math.min(GEO_HISTORY_MAX_MINUTES, historyState.geostationary - direction * GEO_STEP_MINUTES));
        if (lastEnabled.has("geostationary")) rebuild("geostationary");
      },
      // Back to live -- called whenever the geostationary checkbox is
      // (re)checked, so toggling it on always shows the current scene
      // instead of silently staying wherever the history stepper/picker
      // was last left (which can land on a real publish gap and just look
      // blank, see errorTileUrl above).
      resetGeostationary: () => { historyState.geostationary = 0; },
      // Direct jump to a specific minute instead of stepping GEO_STEP_MINUTES
      // at a time -- dateTimeStr is a "YYYY-MM-DDTHH:MM" datetime-local
      // value, interpreted as UTC (matches every other timestamp this
      // module deals in).
      // Returns "future" or "past" when the picked instant fell outside the
      // history window and had to be clamped to that edge, or null when it
      // was used as typed -- callers surface this, because silently
      // clamping with no signal is indistinguishable from "the field
      // rejected what I typed". Confirmed live: a date/time a few minutes
      // past the 3-day edge round-tripped back to the CLAMPED boundary
      // instant, not the typed one, and with no visible difference in the
      // fields' format looked exactly like typing had no effect at all.
      setGeostationaryDate: (dateTimeStr) => {
        if (!dateTimeStr) return null;
        const picked = new Date(`${dateTimeStr}Z`);
        if (Number.isNaN(picked.getTime())) return null;
        const minutesAgo = Math.round((Date.now() - picked.getTime()) / 60000);
        historyState.geostationary = Math.max(0, Math.min(GEO_HISTORY_MAX_MINUTES, minutesAgo));
        if (lastEnabled.has("geostationary")) rebuild("geostationary");
        return minutesAgo < 0 ? "future" : minutesAgo > GEO_HISTORY_MAX_MINUTES ? "past" : null;
      },
      // Metop's quick live-view stepper -- same shape as geostationary's
      // above, just its own step size/cap (whole orbits, 3 days). Deeper
      // history than that is what the Imagery Lab playback tool is for.
      metopOffsetMinutes: () => historyState.metop,
      metopMaxMinutes: METOP_HISTORY_MAX_MINUTES,
      metopStepMinutes: METOP_STEP_MINUTES,
      stepMetop: (direction) => {
        historyState.metop = Math.max(0, Math.min(METOP_HISTORY_MAX_MINUTES, historyState.metop - direction * METOP_STEP_MINUTES));
        if (lastEnabled.has("metop")) rebuild("metop");
      },
      resetMetop: () => { historyState.metop = 0; },
      // See setGeostationaryDate's comment -- same silent-clamp problem,
      // same fix: report which edge (if any) the picked instant landed on.
      setMetopDate: (dateTimeStr) => {
        if (!dateTimeStr) return null;
        const picked = new Date(`${dateTimeStr}Z`);
        if (Number.isNaN(picked.getTime())) return null;
        const minutesAgo = Math.round((Date.now() - picked.getTime()) / 60000);
        historyState.metop = Math.max(0, Math.min(METOP_HISTORY_MAX_MINUTES, minutesAgo));
        if (lastEnabled.has("metop")) rebuild("metop");
        return minutesAgo < 0 ? "future" : minutesAgo > METOP_HISTORY_MAX_MINUTES ? "past" : null;
      },
      // Mosaic's stepper works in whole hours -- 0 still means "1 hour
      // behind now" (the freshness floor from build()'s geosmosaic branch),
      // stepping further back adds on top of that rather than replacing it.
      geosmosaicOffsetHours: () => historyState.geosmosaic,
      geosmosaicMaxHours: GEOSMOSAIC_HISTORY_MAX_HOURS,
      geosmosaicStepHours: GEOSMOSAIC_STEP_HOURS,
      stepGeosmosaic: (direction) => {
        historyState.geosmosaic = Math.max(0, Math.min(GEOSMOSAIC_HISTORY_MAX_HOURS, historyState.geosmosaic - direction * GEOSMOSAIC_STEP_HOURS));
        if (lastEnabled.has("geosmosaic")) rebuild("geosmosaic");
      },
      resetGeosmosaic: () => { historyState.geosmosaic = 0; },
      // Same silent-clamp problem and fix as setGeostationaryDate above,
      // in hours rather than minutes.
      setGeosmosaicDate: (dateTimeStr) => {
        if (!dateTimeStr) return null;
        const picked = new Date(`${dateTimeStr}Z`);
        if (Number.isNaN(picked.getTime())) return null;
        const hoursAgo = Math.round((Date.now() - picked.getTime()) / 3600000);
        historyState.geosmosaic = Math.max(0, Math.min(GEOSMOSAIC_HISTORY_MAX_HOURS, hoursAgo));
        if (lastEnabled.has("geosmosaic")) rebuild("geosmosaic");
        return hoursAgo < 0 ? "future" : hoursAgo > GEOSMOSAIC_HISTORY_MAX_HOURS ? "past" : null;
      },
      getOpacity: () => userOpacity,
      // Applies live to whichever of the five layers are already built,
      // via Leaflet's own setOpacity -- no rebuild/refetch, so dragging the
      // slider is instant instead of re-requesting tiles on every move.
      setOpacity: (value) => {
        const clamped = Math.max(0, Math.min(1, Number(value)));
        if (!Number.isFinite(clamped)) return;
        userOpacity = clamped;
        try { localStorage.setItem(OPACITY_KEY, String(clamped)); } catch { /* ignore */ }
        for (const id of OPACITY_LAYER_IDS) {
          const layer = overlays.get(id);
          if (!layer) continue;
          if (typeof layer.setOpacity === "function") layer.setOpacity(clamped);
          else if (typeof layer.eachLayer === "function") layer.eachLayer((sub) => sub.setOpacity?.(clamped));
        }
      },
    };
  }

  return { create };
})();
