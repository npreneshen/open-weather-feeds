/* Direct raster overlays: tiles never pass through the Cloudflare Worker
   (the Wayback historical-release list is the one exception -- see below). */
window.MetisMapOverlays = (() => {
  "use strict";

  const ICONS = {
    home: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h5V14h3v5.5h5V10" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    satellite: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 7 7 4M2 9l3 3M17 20l3-3M20 17l3 3M8.5 8.5 4 4M15.5 15.5 20 20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    globe: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17-3-3-3-14 0-17" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  };

  function isoDay(offsetDays = 0) {
    const date = new Date(Date.now() + offsetDays * 86400000);
    return date.toISOString().slice(0, 10);
  }

  // Terra MODIS true-colour imagery in GIBS starts 2000-02-24 -- stepping
  // or typing a date before that can never resolve to anything real.
  const SATELLITE_MISSION_START = "2000-02-24";
  const SATELLITE_PROBE_MAX_SEARCH = 12;

  // GIBS' "best available" composite has near-complete daily coverage, but
  // real gaps do happen (instrument maintenance, processing lag on very
  // recent days). A cheap HEAD probe on one coarse global tile confirms the
  // day actually has data before the UI claims to be showing it -- direction
  // says which way to keep searching if the requested day comes back empty.
  async function probeSatelliteDay(day) {
    if (day < SATELLITE_MISSION_START || day > isoDay(-1)) return false;
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
      const day = isoDay(-1 - candidate);
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

  function create(map, { onToggle, dataApi } = {}) {
    ensureStyles();
    const overlays = new Map();
    // A shared opacity for the five layers with their own "Imagery date"
    // row (satellite, worldimagery, geostationary, s2cloudless, sentinelhub)
    // -- lets a bright basemap or a stacked layer underneath still show
    // through without needing to fiddle with each layer's own toggle.
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
    const OPACITY_LAYER_IDS = ["satellite", "worldimagery", "geostationary", "s2cloudless", "sentinelhub"];
    // satellite: offset in days-ago from "yesterday" (GIBS' effective
    // "today"). worldimagery: index into the Wayback release list, sorted
    // oldest-to-newest -- null/undefined means "latest" until history is
    // opened, so a plain toggle never has to wait on the release-list fetch.
    const historyState = { satellite: 0, worldimagery: null, s2cloudless: 0, sentinelhub: isoDay(0), geostationary: 0 };
    // GOES/Himawari/Meteosat/MTG are all near-real-time feeds with a
    // short rolling window (matches the "last 3 days" already documented for
    // their playback options) -- days-ago offset, 0 = live, same shape as
    // the satellite offset above but without that one's probe-for-available-
    // date logic, since these providers don't have real archive gaps to
    // route around the way Terra's 25-year history does.
    const GEO_HISTORY_MAX_DAYS = 3;
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
      const tx = Math.floor(centerPx.x / 256);
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

    const GIBS_DAILY = {
      satellite: {
        layer: "MODIS_Terra_CorrectedReflectance_TrueColor",
        attribution: "NASA EOSDIS GIBS (MODIS Terra)",
      },
      satelliteAqua: {
        layer: "MODIS_Aqua_CorrectedReflectance_TrueColor",
        attribution: "NASA EOSDIS GIBS (MODIS Aqua)",
      },
      satelliteViirs: {
        layer: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
        attribution: "NASA EOSDIS GIBS (VIIRS SNPP)",
      },
      satelliteNoaa20: {
        layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
        attribution: "NASA EOSDIS GIBS (VIIRS NOAA-20)",
      },
      satelliteNoaa21: {
        layer: "VIIRS_NOAA21_CorrectedReflectance_TrueColor",
        attribution: "NASA EOSDIS GIBS (VIIRS NOAA-21)",
      },
    };

    function buildGibsDaily(id) {
      const product = GIBS_DAILY[id];
      if (!product) return null;
      // Terra / Aqua / VIIRS share one day-offset so the imagery date
      // stepper stays a single control for all daily true-colour products.
      const day = isoDay(-1 - historyState.satellite);
      return L.tileLayer(
        `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${product.layer}/default/${day}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
        {
          attribution: product.attribution,
          opacity: userOpacity,
          maxNativeZoom: 9,
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
        // one group. historyState.geostationary is a shared days-ago offset
        // (0 = live) stepped via the imagery-date row, same as the other
        // raster layers' history controls.
        const day = historyState.geostationary === 0 ? null : isoDay(-historyState.geostationary);
        const active = window.MetisGeoSat?.activeSatellites() || [];
        const sublayers = active.map((satId) => {
          const info = window.MetisGeoSat.layerInfo(satId);
          if (!info) return null;
          if (info.type === "wmts") {
            // "default/default" is GIBS' own "latest" shorthand; a specific
            // date needs an actual timestamp in that slot instead. Any valid
            // time on the day works -- GIBS resolves to the nearest real
            // scene -- so midday UTC is just a reasonable fixed pick.
            const timeSlot = day ? `${day}T12:00:00Z` : "default";
            return L.tileLayer(
              `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${info.gibsLayer}/default/${timeSlot}/GoogleMapsCompatible_Level${info.maxNativeZoom}/{z}/{y}/{x}.png`,
              {
                attribution: info.attribution,
                opacity: userOpacity,
                maxNativeZoom: info.maxNativeZoom,
                maxZoom: 12,
                crossOrigin: true,
              },
            );
          }
          // EUMETSAT's WMS only advertises EPSG:4326/CRS:84 in its
          // capabilities but reprojects to EPSG:3857 fine on request
          // (verified live) -- Leaflet's default WMS CRS is already 3857,
          // so no extra crs option is needed here. Omitting TIME falls back
          // to the layer's own declared latest slot; a picked date is passed
          // as an extra WMS param the same way -- EUMETSAT's TIME dimension
          // has nearestValue="1" so an approximate timestamp still resolves
          // to a real scene.
          const wmsOptions = {
            layers: info.wmsLayer,
            format: "image/png",
            transparent: true,
            version: "1.3.0",
            attribution: info.attribution,
            opacity: userOpacity,
            maxZoom: 12,
            crossOrigin: true,
          };
          if (day) wmsOptions.time = `${day}T12:00:00Z`;
          return L.tileLayer.wms(info.wmsBase, wmsOptions);
        }).filter(Boolean);
        if (!sublayers.length) return null;
        return L.layerGroup(sublayers);
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

    function rebuild(id) {
      const existing = overlays.get(id);
      if (existing && map.hasLayer(existing)) map.removeLayer(existing);
      overlays.delete(id);
      const layer = build(id);
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
      for (const id of ["satellite", "worldimagery", "radar", "globalprecip", "geostationary", "s2cloudless", "sentinelhub"]) {
        const shouldShow = enabled.has(id);
        let layer = overlays.get(id);
        if (shouldShow && !layer) {
          layer = build(id);
          if (layer) overlays.set(id, layer);
        }
        if (shouldShow && layer && !map.hasLayer(layer)) layer.addTo(map);
        if (!shouldShow && layer && map.hasLayer(layer)) map.removeLayer(layer);
      }
      const showLabels = enabled.has("satellite") || enabled.has("worldimagery") || enabled.has("geostationary")
        || enabled.has("s2cloudless") || enabled.has("sentinelhub");
      let labels = overlays.get("imagerylabels");
      if (showLabels && !labels) {
        labels = build("imagerylabels");
        overlays.set("imagerylabels", labels);
      }
      if (showLabels && labels && !map.hasLayer(labels)) labels.addTo(map);
      if (!showLabels && labels && map.hasLayer(labels)) map.removeLayer(labels);

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

    // GOES tiles are requested with a literal TIME=default (GIBS resolves
    // that to its latest published slot server-side), so simply panning
    // doesn't guarantee a fresh fetch if the browser still has the old
    // response cached -- force a redraw every 10 min while active so the
    // ~10-min-cadence imagery doesn't just sit stale on screen.
    setInterval(() => {
      if (lastEnabled.has("geostationary")) {
        overlays.get("geostationary")?.eachLayer((layer) => layer.redraw());
      }
    }, 10 * 60 * 1000);

    // Lets external UI (the sidebar layer rail) mirror the same date instead
    // of duplicating the floating control's date-stepping logic.
    const changeListeners = new Set();
    function getDate(id) {
      if (id === "satellite") return isoDay(-1 - historyState.satellite);
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
        const yesterday = new Date(Date.now() - 86400000);
        const days = Math.round((yesterday - entered) / 86400000);
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
    const control = L.control({ position: "topleft" });
    control.onAdd = () => {
      const wrap = L.DomUtil.create("div", "metis-imagery-control");
      const bar = L.DomUtil.create("div", "leaflet-bar metis-overlay-toggle", wrap);

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
      resetHistory: () => { historyState.satellite = 0; historyState.worldimagery = null; },
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
      // null return means "live" -- callers display that as its own state
      // rather than a date string.
      getGeostationaryDay: () => (historyState.geostationary === 0 ? null : isoDay(-historyState.geostationary)),
      geostationaryOffset: () => historyState.geostationary,
      geostationaryMaxDays: GEO_HISTORY_MAX_DAYS,
      stepGeostationary: (direction) => {
        historyState.geostationary = Math.max(0, Math.min(GEO_HISTORY_MAX_DAYS, historyState.geostationary - direction));
        if (lastEnabled.has("geostationary")) rebuild("geostationary");
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
