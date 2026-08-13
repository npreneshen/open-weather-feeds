/* Unified picker for every geostationary weather satellite this app can
   reach for free: GOES-East/West and Himawari-9 via NASA GIBS (plain WMTS
   tiles, no key), plus Meteosat-0deg and Meteosat-IODC via EUMETSAT's public
   EUMETView WMS (also no key -- confirmed live: EPSG:3857 works even though
   only EPSG:4326/CRS:84 are advertised in its capabilities, GeoServer
   reprojects on request; omitting TIME falls back to the layer's declared
   default/latest slot). One "Geostationary" layer toggle in the main grid
   turns this whole family on/off; which individual satellites are actually
   shown, and which product each one displays, both live here so
   map-overlays.js and imagery-playback.js read one shared source of truth.

   Every layer id/zoom pair below was confirmed against each provider's own
   GetCapabilities document, not guessed -- GIBS: some ABI/AHI products
   (Air Mass, Clean Infrared) cap at zoom 6, others (GeoColor, Dust,
   FireTemp, Red Visible) at zoom 7; Himawari has no GeoColor-style
   composite, individual bands only. EUMETSAT layers are WMS (Leaflet tiles
   them automatically), not WMTS. */
window.MetisGeoSat = (() => {
  "use strict";

  const GOES_OPTIONS = [
    { id: "GeoColor", label: "GeoColor (true colour day / IR blend night)", maxNativeZoom: 7 },
    { id: "Dust", label: "Dust RGB (volcanic ash, dust storms)", maxNativeZoom: 7 },
    { id: "FireTemp", label: "Fire Temperature", maxNativeZoom: 7 },
    { id: "Air_Mass", label: "Air Mass RGB (jet streams, dry/moist air)", maxNativeZoom: 6 },
    { id: "Band13_Clean_Infrared", label: "Clean Infrared (cloud-top temperature)", maxNativeZoom: 6 },
    { id: "Band2_Red_Visible_1km", label: "Red Visible (daytime only)", maxNativeZoom: 7 },
  ];

  // A curated subset of EUMETView's much longer msg_fes/msg_iodc catalogue --
  // these are the products with a real day-to-day-use case here (imagery +
  // the two things GOES/Himawari don't otherwise cover: a fire product and
  // a convective-storm tracker), not every RGB recipe EUMETSAT publishes.
  const METEOSAT_OPTIONS = [
    { id: "rgb_natural", label: "Natural Colour (true colour equivalent)" },
    { id: "rgb_dust", label: "Dust RGB" },
    { id: "rgb_ash", label: "Volcanic Ash RGB" },
    { id: "rgb_airmass", label: "Air Mass RGB (jet streams, dry/moist air)" },
    { id: "rgb_convection", label: "Convection RGB (severe storm potential)" },
    { id: "rgb_fog", label: "Fog RGB" },
    { id: "rgb_snow", label: "Snow RGB" },
    { id: "ir108", label: "Clean Infrared (cloud-top temperature)" },
    { id: "fire", label: "Active fire detection" },
    { id: "rdt", label: "Rapidly Developing Thunderstorms" },
  ];

  // Meteosat-0deg only -- EUMETSAT's Rapid Scan Service is a 5-minute-cadence
  // product covering just the northern third of the disk (~15-70N, rectified
  // at 9.5E, so Europe/North Africa), on its own `msg_rss` workspace rather
  // than `msg_fes`. wmsLayerPrefix here overrides the satellite's default so
  // this one option can point at a different EUMETSAT workspace.
  const METEOSAT_0_OPTIONS = [
    ...METEOSAT_OPTIONS,
    { id: "rgb_natural_nrt", label: "Rapid Scan Natural Colour (5-min, Europe/N.Africa only)", wmsLayerPrefix: "msg_rss" },
  ];

  // MTG-I1 (Meteosat Third Generation), live at 0 degrees since 2024 on its
  // own `mtg_fd` workspace -- confirmed live and pixel-verified, separate
  // from (not a replacement for) the still-operational MSG satellites above.
  // li_afa is MTG's Lightning Imager (Accumulated Flash Area, 5-min cadence)
  // -- the one genuinely live, free, public geostationary lightning product
  // found in this app's research; GOES' equivalent instrument has no public
  // near-real-time feed.
  const MTG_OPTIONS = [
    { id: "rgb_geocolour", label: "Geo Colour (true colour day / IR blend night)" },
    { id: "rgb_truecolour", label: "True Colour" },
    { id: "rgb_cloudtype", label: "Cloud Type" },
    { id: "rgb_cloudphase", label: "Cloud Phase" },
    { id: "rgb_dust", label: "Dust RGB" },
    { id: "rgb_fog", label: "Fog RGB" },
    { id: "rgb_snow", label: "Snow RGB" },
    { id: "rgb_firetemperature", label: "Fire Temperature" },
    { id: "li_afa", label: "Lightning -- accumulated flash area (5-min)" },
  ];

  const SATELLITES = {
    goesEast: {
      label: "GOES-East (Americas/Atlantic)",
      type: "wmts",
      baseLayer: "GOES-East_ABI",
      attribution: "NOAA GOES-East / NASA GIBS",
      storageKey: "metis-geosat-goesEast-product",
      default: "GeoColor",
      options: GOES_OPTIONS,
    },
    goesWest: {
      label: "GOES-West (Pacific)",
      type: "wmts",
      baseLayer: "GOES-West_ABI",
      attribution: "NOAA GOES-West / NASA GIBS",
      storageKey: "metis-geosat-goesWest-product",
      default: "GeoColor",
      options: GOES_OPTIONS,
    },
    himawari: {
      label: "Himawari (Asia-Pacific)",
      type: "wmts",
      baseLayer: "Himawari_AHI",
      attribution: "JMA Himawari-9 / NASA GIBS",
      storageKey: "metis-geosat-himawari-product",
      // No GeoColor-style composite exists for Himawari on this GIBS
      // endpoint -- Clean Infrared is the default since it (unlike Red
      // Visible) still shows something at night.
      default: "Band13_Clean_Infrared",
      options: [
        { id: "Band13_Clean_Infrared", label: "Clean Infrared (cloud-top temperature, day/night)", maxNativeZoom: 6 },
        { id: "Band3_Red_Visible_1km", label: "Red Visible (daytime only)", maxNativeZoom: 7 },
        { id: "Air_Mass", label: "Air Mass RGB (jet streams, dry/moist air)", maxNativeZoom: 6 },
      ],
    },
    meteosat0: {
      label: "Meteosat (Europe/Africa)",
      type: "wms",
      wmsBase: "https://view.eumetsat.int/geoserver/wms",
      wmsLayerPrefix: "msg_fes",
      attribution: "EUMETSAT Meteosat-0° / EUMETView",
      storageKey: "metis-geosat-meteosat0-product",
      default: "rgb_natural",
      options: METEOSAT_0_OPTIONS,
    },
    meteosatIodc: {
      label: "Meteosat IODC (Indian Ocean)",
      type: "wms",
      wmsBase: "https://view.eumetsat.int/geoserver/wms",
      wmsLayerPrefix: "msg_iodc",
      attribution: "EUMETSAT Meteosat-IODC / EUMETView",
      storageKey: "metis-geosat-meteosatIodc-product",
      default: "rgb_natural",
      options: METEOSAT_OPTIONS,
    },
    mtg0: {
      label: "MTG (Europe/Africa)",
      type: "wms",
      wmsBase: "https://view.eumetsat.int/geoserver/wms",
      wmsLayerPrefix: "mtg_fd",
      attribution: "EUMETSAT MTG-I1 / EUMETView",
      storageKey: "metis-geosat-mtg0-product",
      default: "rgb_geocolour",
      options: MTG_OPTIONS,
    },
  };

  const ORDER = ["goesEast", "goesWest", "himawari", "meteosat0", "meteosatIodc", "mtg0"];
  const ACTIVE_KEY = "metis-geosat-active-list";

  // Groups the modal by provider family so coverage is scannable at a
  // glance, rather than five flat rows with no visual hierarchy.
  const GROUPS = [
    { title: "GOES · NOAA", satIds: ["goesEast", "goesWest"] },
    { title: "Himawari · JMA", satIds: ["himawari"] },
    { title: "Meteosat · EUMETSAT", satIds: ["meteosat0", "meteosatIodc"] },
    { title: "MTG · EUMETSAT", satIds: ["mtg0"] },
  ];

  // Splits "Name (region)" into a short heading + a small region line, and
  // turns "Europe/Africa" into "Europe / Africa" so it has a breakable
  // space -- a bare slash isn't a valid line-break point, so on a narrow
  // screen that one word was overflowing instead of wrapping like
  // "(Indian Ocean)" does.
  function splitLabel(label) {
    const match = label.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (!match) return { name: label, region: "" };
    return { name: match[1], region: match[2].replace(/\//g, " / ") };
  }

  function productFor(satId) {
    const config = SATELLITES[satId];
    if (!config) return null;
    try {
      const stored = localStorage.getItem(config.storageKey);
      return config.options.some((opt) => opt.id === stored) ? stored : config.default;
    } catch {
      return config.default;
    }
  }

  function saveProduct(satId, productId) {
    const config = SATELLITES[satId];
    if (!config) return;
    const valid = config.options.some((opt) => opt.id === productId) ? productId : config.default;
    try { localStorage.setItem(config.storageKey, valid); } catch { /* ignore */ }
  }

  // Which satellites currently render as part of the single "Geostationary"
  // layer toggle -- defaults to GOES-East alone the first time, same as the
  // pre-unification default, rather than turning every satellite on at once.
  function activeSatellites() {
    try {
      const stored = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
      if (Array.isArray(stored) && stored.length) return stored.filter((id) => SATELLITES[id]);
    } catch { /* fall through to default */ }
    return ["goesEast"];
  }

  function saveActiveSatellites(ids) {
    const valid = ORDER.filter((id) => ids.includes(id));
    try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(valid.length ? valid : ["goesEast"])); } catch { /* ignore */ }
  }

  // Everything a caller needs to build/attribute/gap-fill the currently
  // selected product for a satellite, in one place.
  function layerInfo(satId) {
    const config = SATELLITES[satId];
    if (!config) return null;
    const productId = productFor(satId);
    const option = config.options.find((opt) => opt.id === productId) || config.options[0];
    if (config.type === "wmts") {
      return {
        type: "wmts",
        satLabel: config.label,
        productId,
        productLabel: option.label,
        gibsLayer: `${config.baseLayer}_${productId}`,
        maxNativeZoom: option.maxNativeZoom,
        attribution: config.attribution,
      };
    }
    // A product can override which EUMETSAT workspace it lives in (e.g.
    // meteosat0's Rapid Scan option is msg_rss, not the satellite's own
    // default msg_fes) -- fall back to the satellite's prefix otherwise.
    const prefix = option.wmsLayerPrefix || config.wmsLayerPrefix;
    return {
      type: "wms",
      satLabel: config.label,
      productId,
      productLabel: option.label,
      wmsBase: config.wmsBase,
      wmsLayer: `${prefix}:${productId}`,
      attribution: config.attribution,
    };
  }

  // --- Modal: one checkbox + product dropdown per satellite ---
  let root = null;
  let pending = null;

  function ensureStyles() {
    if (document.getElementById("metis-geosat-styles")) return;
    const style = document.createElement("style");
    style.id = "metis-geosat-styles";
    style.textContent = `
      .metis-geosat-backdrop{position:fixed;inset:0;z-index:9200;display:none;
        background:rgba(4,14,18,.6);align-items:center;justify-content:center}
      .metis-geosat-backdrop.show{display:flex}
      .metis-geosat-dialog{width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 48px);
        overflow-y:auto;overflow-x:hidden;background:#081d25;border:1px solid #304b52;
        box-shadow:6px 6px 0 rgba(0,0,0,.45);font-family:"IBM Plex Mono",Consolas,monospace;color:#d8d1bc}
      .metis-geosat-head{padding:10px 12px;border-bottom:1px solid #304b52;position:sticky;top:0;background:#081d25}
      .metis-geosat-kicker{font-size:.6rem;letter-spacing:.09em;text-transform:uppercase;color:#77949a}
      .metis-geosat-title{font-size:.85rem;color:#68cf91;margin-top:2px}
      .metis-geosat-body{padding:10px 12px;overflow-x:hidden}
      .metis-geosat-group{margin-bottom:14px}
      .metis-geosat-group:last-child{margin-bottom:0}
      .metis-geosat-group-title{font-size:.6rem;letter-spacing:.08em;text-transform:uppercase;
        color:#77949a;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #223840}
      .metis-geosat-sat-row{border:1px solid #304b52;margin-bottom:8px;padding:9px;
        max-width:100%;box-sizing:border-box}
      .metis-geosat-sat-row:last-child{margin-bottom:0}
      .metis-geosat-sat-head{display:flex;align-items:flex-start;gap:9px;cursor:pointer;margin-bottom:8px}
      .metis-geosat-sat-head input{flex:none;width:16px;height:16px;min-width:16px;margin:3px 0 0}
      .metis-geosat-sat-copy{min-width:0}
      .metis-geosat-sat-name{font-size:.74rem;color:#d8d1bc;overflow-wrap:anywhere}
      .metis-geosat-sat-region{margin-top:2px;font-size:.6rem;color:#77949a;
        text-transform:uppercase;letter-spacing:.04em;overflow-wrap:anywhere}
      .metis-geosat-sat-row select{display:block;width:100%;max-width:100%;box-sizing:border-box;
        background:#06171e;border:1px solid #304b52;color:#d8d1bc;padding:6px 7px;font:inherit;
        border-radius:0;font-size:.68rem;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
      .metis-geosat-sat-row select:disabled{opacity:.4}
      .metis-geosat-hint{font-size:.6rem;color:#77949a;margin:8px 0 0;line-height:1.5}
      .metis-geosat-actions{display:flex;justify-content:flex-end;gap:8px;
        padding:10px 12px;border-top:1px solid #304b52;position:sticky;bottom:0;background:#081d25}
      .metis-geosat-actions button{border:1px solid #304b52;background:transparent;
        color:#d8d1bc;padding:6px 12px;font:600 .65rem "IBM Plex Mono",monospace;
        text-transform:uppercase;letter-spacing:.05em;cursor:pointer;border-radius:0}
      .metis-geosat-actions [data-action="save"]{border-color:#68cf91;color:#68cf91}
    `;
    document.head.appendChild(style);
  }

  function dialog() {
    if (root) return root;
    ensureStyles();
    root = document.createElement("div");
    root.className = "metis-geosat-backdrop";
    root.innerHTML = `
      <section class="metis-geosat-dialog" role="dialog" aria-modal="true" aria-labelledby="metis-geosat-title">
        <header class="metis-geosat-head">
          <div class="metis-geosat-kicker">Geostationary satellites</div>
          <div class="metis-geosat-title" id="metis-geosat-title">Which satellites, which product</div>
        </header>
        <div class="metis-geosat-body">
          ${GROUPS.map((group) => `
            <div class="metis-geosat-group">
              <div class="metis-geosat-group-title">${group.title}</div>
              ${group.satIds.map((satId) => {
                const config = SATELLITES[satId];
                const { name, region } = splitLabel(config.label);
                return `<div class="metis-geosat-sat-row" data-sat="${satId}">
                  <label class="metis-geosat-sat-head">
                    <input type="checkbox" data-sat-checkbox="${satId}" />
                    <div class="metis-geosat-sat-copy">
                      <div class="metis-geosat-sat-name">${name}</div>
                      ${region ? `<div class="metis-geosat-sat-region">${region}</div>` : ""}
                    </div>
                  </label>
                  <select data-sat-select="${satId}">
                    ${config.options.map((opt) => `<option value="${opt.id}">${opt.label}</option>`).join("")}
                  </select>
                </div>`;
              }).join("")}
            </div>`).join("")}
          <p class="metis-geosat-hint">Multiple satellites can be shown at once -- they tile together for wider coverage. GOES/Himawari update every ~10 min; Meteosat every ~15 min.</p>
        </div>
        <div class="metis-geosat-actions">
          <button type="button" data-action="cancel">Cancel</button>
          <button type="button" data-action="save">Save</button>
        </div>
      </section>`;
    document.body.appendChild(root);
    root.querySelectorAll("[data-sat-checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        root.querySelector(`[data-sat-select="${cb.dataset.satCheckbox}"]`).disabled = !cb.checked;
      });
    });
    root.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(false));
    root.querySelector('[data-action="save"]').addEventListener("click", () => {
      const activeIds = [];
      ORDER.forEach((satId) => {
        const checked = root.querySelector(`[data-sat-checkbox="${satId}"]`).checked;
        if (checked) {
          activeIds.push(satId);
          saveProduct(satId, root.querySelector(`[data-sat-select="${satId}"]`).value);
        }
      });
      saveActiveSatellites(activeIds);
      finish(true);
    });
    root.addEventListener("pointerdown", (event) => {
      if (event.target === root) finish(false);
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish(false);
    });
    return root;
  }

  function finish(result) {
    if (!pending) return;
    const current = pending;
    pending = null;
    current.root.classList.remove("show");
    current.resolve(result);
    if (result) window.dispatchEvent(new CustomEvent("metis-geosat-changed", {}));
  }

  // satId argument kept optional/ignored -- callers used to open the picker
  // scoped to one satellite; the unified modal always shows all of them.
  function prompt() {
    const dlg = dialog();
    if (pending) finish(false);
    const active = new Set(activeSatellites());
    ORDER.forEach((satId) => {
      const cb = dlg.querySelector(`[data-sat-checkbox="${satId}"]`);
      const select = dlg.querySelector(`[data-sat-select="${satId}"]`);
      cb.checked = active.has(satId);
      select.disabled = !cb.checked;
      select.value = productFor(satId);
    });
    return new Promise((resolve) => {
      pending = { resolve, root: dlg };
      dlg.classList.add("show");
      requestAnimationFrame(() => dlg.querySelector('[data-sat-checkbox="goesEast"]').focus());
    });
  }

  return { SATELLITES, ORDER, productFor, saveProduct, activeSatellites, saveActiveSatellites, layerInfo, prompt };
})();
