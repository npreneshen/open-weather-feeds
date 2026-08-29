/* Picker for the daily GIBS composites: MODIS Terra, MODIS Aqua, or VIIRS on
   any of Suomi-NPP/NOAA-20/NOAA-21. Radio semantics (not geo-satellite-
   picker.js's checkboxes): only one of these can be shown at once -- they're
   alternate sources for the same kind of image, not complementary regional
   coverage.

   VIIRS satellites now also carry a real product list, mirroring geo-
   satellite-picker.js's satellite+product pattern -- confirmed live against
   GIBS' own WMTSCapabilities.xml (VIIRS SNPP/NOAA-20 publish 72/65 layers
   total; NOAA-21 only 15). Most of the rest are science/index products
   (chlorophyll-a, vegetation index, aerosol optical depth, land surface
   temperature composites) that don't belong in an imagery browser, not held
   back arbitrarily -- this is the genuinely visual subset. Active-fire
   detection (Thermal_Anomalies) deliberately excluded: GIBS serves it as
   Mapbox Vector Tile, not a raster image, which this app's plain <img>-tile
   layers can't render -- FIRMS already covers VIIRS active-fire detections
   as point markers elsewhere in the app, so nothing is actually lost.
   Terra/Aqua stay true-colour-only (MODIS' much larger GIBS catalogue is a
   separate research pass, out of scope here). */
window.MetisDailySat = (() => {
  "use strict";

  const TRUECOLOR_ONLY = [{ id: "CorrectedReflectance_TrueColor", label: "True Colour", maxNativeZoom: 9, ext: "jpg" }];

  // Confirmed live against GIBS' WMTSCapabilities.xml for VIIRS_SNPP/VIIRS_
  // NOAA20 (both have all seven); zoom levels and jpg/png format read from
  // each layer's own <TileMatrixSet>/<Format>, not assumed.
  const VIIRS_FULL_OPTIONS = [
    { id: "CorrectedReflectance_TrueColor", label: "True Colour", maxNativeZoom: 9, ext: "jpg" },
    { id: "CorrectedReflectance_BandsM3-I3-M11", label: "Day Land Cloud (false colour)", maxNativeZoom: 9, ext: "jpg" },
    { id: "CorrectedReflectance_BandsM11-I2-I1", label: "Fire/Burn Scar (shortwave IR false colour)", maxNativeZoom: 9, ext: "jpg" },
    { id: "DayNightBand", label: "Night Lights / Low-Light Imagery", maxNativeZoom: 7, ext: "png" },
    { id: "Brightness_Temp_BandI5_Day", label: "Brightness Temperature (thermal IR, daytime)", maxNativeZoom: 9, ext: "png" },
    { id: "Cloud_Top_Height_Day", label: "Cloud Top Height (daytime)", maxNativeZoom: 7, ext: "png" },
    { id: "Cirrus_Reflectance_VIS_NIR", label: "Cirrus Cloud Detection", maxNativeZoom: 7, ext: "png" },
  ];
  // NOAA-21 confirmed live to lack Cloud_Top_Height and Cirrus_Reflectance
  // entirely (its own GIBS catalogue is 15 layers total vs SNPP/NOAA-20's
  // 72/65) -- not a filtering choice, those products don't exist for it.
  const VIIRS_NOAA21_OPTIONS = VIIRS_FULL_OPTIONS.filter((o) =>
    o.id !== "Cloud_Top_Height_Day" && o.id !== "Cirrus_Reflectance_VIS_NIR");

  const SATELLITES = {
    satellite: {
      name: "Terra", region: "MODIS · morning overpass · archive back to 2000",
      baseLayer: "MODIS_Terra", attribution: "NASA EOSDIS GIBS (MODIS Terra)",
      storageKey: "metis-dailysat-product-terra", default: "CorrectedReflectance_TrueColor", options: TRUECOLOR_ONLY,
    },
    satelliteAqua: {
      name: "Aqua", region: "MODIS · afternoon overpass",
      baseLayer: "MODIS_Aqua", attribution: "NASA EOSDIS GIBS (MODIS Aqua)",
      storageKey: "metis-dailysat-product-aqua", default: "CorrectedReflectance_TrueColor", options: TRUECOLOR_ONLY,
    },
    satelliteViirs: {
      name: "VIIRS SNPP", region: "sharper daily composite",
      baseLayer: "VIIRS_SNPP", attribution: "NASA EOSDIS GIBS (VIIRS SNPP)",
      storageKey: "metis-dailysat-product-snpp", default: "CorrectedReflectance_TrueColor", options: VIIRS_FULL_OPTIONS,
    },
    satelliteNoaa20: {
      name: "VIIRS NOAA-20", region: "sharper daily composite · since 2018",
      baseLayer: "VIIRS_NOAA20", attribution: "NASA EOSDIS GIBS (VIIRS NOAA-20)",
      storageKey: "metis-dailysat-product-noaa20", default: "CorrectedReflectance_TrueColor", options: VIIRS_FULL_OPTIONS,
    },
    satelliteNoaa21: {
      name: "VIIRS NOAA-21", region: "sharper daily composite · since 2023",
      baseLayer: "VIIRS_NOAA21", attribution: "NASA EOSDIS GIBS (VIIRS NOAA-21)",
      storageKey: "metis-dailysat-product-noaa21", default: "CorrectedReflectance_TrueColor", options: VIIRS_NOAA21_OPTIONS,
    },
  };
  const ORDER = ["satellite", "satelliteAqua", "satelliteViirs", "satelliteNoaa20", "satelliteNoaa21"];
  const KEY = "metis-dailysat-active";
  const DEFAULT = "satelliteViirs";

  function active() {
    try {
      const stored = localStorage.getItem(KEY);
      return SATELLITES[stored] ? stored : DEFAULT;
    } catch {
      return DEFAULT;
    }
  }

  function saveActive(id) {
    const valid = SATELLITES[id] ? id : DEFAULT;
    try { localStorage.setItem(KEY, valid); } catch { /* ignore */ }
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

  // Everything a caller needs to build/attribute the currently selected
  // product for the active satellite, in one place -- same shape as geo-
  // satellite-picker.js's layerInfo() so map-overlays.js/imagery-
  // playback.js can consume both the same way.
  function layerInfo(satId) {
    const config = SATELLITES[satId];
    if (!config) return null;
    const productId = productFor(satId);
    const option = config.options.find((opt) => opt.id === productId) || config.options[0];
    return {
      satLabel: config.name,
      productId,
      productLabel: option.label,
      gibsLayer: `${config.baseLayer}_${productId}`,
      maxNativeZoom: option.maxNativeZoom,
      ext: option.ext,
      attribution: config.attribution,
    };
  }

  function activeOption() {
    const satId = active();
    return { id: satId, ...SATELLITES[satId] };
  }

  // --- modal: radio rows (one satellite active at a time) + a product
  // select for whichever row is currently checked ---
  let root = null;
  let pending = null;

  function ensureStyles() {
    if (document.getElementById("metis-dailysat-styles")) return;
    const style = document.createElement("style");
    style.id = "metis-dailysat-styles";
    style.textContent = `
      .metis-dailysat-backdrop{position:fixed;inset:0;z-index:9200;display:none;
        background:rgba(4,14,18,.6);align-items:center;justify-content:center}
      .metis-dailysat-backdrop.show{display:flex}
      .metis-dailysat-dialog{width:min(400px,calc(100vw - 32px));max-height:calc(100vh - 48px);
        overflow-y:auto;overflow-x:hidden;
        background:linear-gradient(135deg,var(--glass-panel-a,rgba(16,39,45,.9)),var(--glass-panel-b,rgba(7,25,31,.85)));
        backdrop-filter:var(--glass-blur,blur(18px));-webkit-backdrop-filter:var(--glass-blur,blur(18px));
        border:1px solid var(--glass-line,#304b52);border-radius:8px;background-clip:padding-box;
        box-shadow:var(--glass-inner,inset 0 1px 0 rgba(255,255,255,.05)),var(--glass-drop,0 8px 24px rgba(0,8,12,.22)),0 20px 60px rgba(0,0,0,.45);
        font-family:"IBM Plex Mono",Consolas,monospace;color:#d8d1bc}
      .metis-dailysat-head{padding:10px 12px;border-bottom:1px solid var(--glass-line,#304b52)}
      .metis-dailysat-kicker{font-size:.6rem;letter-spacing:.09em;text-transform:uppercase;color:#77949a}
      .metis-dailysat-title{font-size:.85rem;color:#68cf91;margin-top:2px}
      .metis-dailysat-body{padding:10px 12px;overflow-x:hidden}
      .metis-dailysat-row{display:flex;align-items:flex-start;gap:9px;border:1px solid #304b52;
        padding:9px;margin-bottom:8px;cursor:pointer;max-width:100%;box-sizing:border-box}
      .metis-dailysat-row:last-child{margin-bottom:0}
      .metis-dailysat-row:has(input:checked){border-color:#68cf91}
      .metis-dailysat-row input{flex:none;width:16px;height:16px;min-width:16px;margin:3px 0 0}
      .metis-dailysat-copy{min-width:0;flex:1}
      .metis-dailysat-name{font-size:.74rem;color:#d8d1bc;overflow-wrap:anywhere}
      .metis-dailysat-region{margin-top:2px;font-size:.6rem;color:#77949a;
        text-transform:uppercase;letter-spacing:.04em;overflow-wrap:anywhere}
      .metis-dailysat-row select{display:block;width:100%;max-width:100%;box-sizing:border-box;
        margin-top:7px;background:#06171e;border:1px solid #304b52;color:#d8d1bc;padding:6px 7px;
        font:inherit;border-radius:0;font-size:.68rem}
      .metis-dailysat-row select:disabled{opacity:.4}
      .metis-dailysat-hint{font-size:.6rem;color:#77949a;margin:8px 0 0;line-height:1.5}
      .metis-dailysat-actions{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--glass-line,#304b52)}
      .metis-dailysat-actions button{border:1px solid var(--glass-line,#304b52);background:transparent;
        color:#d8d1bc;padding:6px 12px;font:600 .65rem "IBM Plex Mono",monospace;
        text-transform:uppercase;letter-spacing:.05em;cursor:pointer;border-radius:0}
      .metis-dailysat-actions [data-action="save"]{border-color:#68cf91;color:#68cf91}
    `;
    document.head.appendChild(style);
  }

  function dialog() {
    if (root) return root;
    ensureStyles();
    root = document.createElement("div");
    root.className = "metis-dailysat-backdrop";
    root.innerHTML = `
      <section class="metis-dailysat-dialog" role="dialog" aria-modal="true" aria-labelledby="metis-dailysat-title">
        <header class="metis-dailysat-head">
          <div class="metis-dailysat-kicker">Daily satellite composite</div>
          <div class="metis-dailysat-title" id="metis-dailysat-title">Which source</div>
        </header>
        <div class="metis-dailysat-body">
          ${ORDER.map((satId) => {
            const config = SATELLITES[satId];
            return `
            <label class="metis-dailysat-row" data-opt="${satId}">
              <input type="radio" name="metis-dailysat-choice" value="${satId}" />
              <div class="metis-dailysat-copy">
                <div class="metis-dailysat-name">${config.name}</div>
                <div class="metis-dailysat-region">${config.region}</div>
                ${config.options.length > 1 ? `
                <select data-product-select="${satId}" disabled>
                  ${config.options.map((opt) => `<option value="${opt.id}">${opt.label}</option>`).join("")}
                </select>` : ""}
              </div>
            </label>`;
          }).join("")}
          <p class="metis-dailysat-hint">Same imagery date across all five -- switching source or product keeps the date stepper where it was. Free, no account needed.</p>
        </div>
        <div class="metis-dailysat-actions">
          <button type="button" data-action="cancel">Cancel</button>
          <button type="button" data-action="save">Save</button>
        </div>
      </section>`;
    document.body.appendChild(root);
    root.querySelectorAll('input[name="metis-dailysat-choice"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        root.querySelectorAll("[data-product-select]").forEach((sel) => {
          sel.disabled = sel.dataset.productSelect !== radio.value;
        });
      });
    });
    root.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(false));
    root.querySelector('[data-action="save"]').addEventListener("click", () => {
      const checked = root.querySelector('input[name="metis-dailysat-choice"]:checked');
      const satId = checked ? checked.value : DEFAULT;
      saveActive(satId);
      ORDER.forEach((id) => {
        const sel = root.querySelector(`[data-product-select="${id}"]`);
        if (sel) saveProduct(id, sel.value);
      });
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
    if (result) window.dispatchEvent(new CustomEvent("metis-dailysat-changed", {}));
  }

  function prompt() {
    const dlg = dialog();
    if (pending) finish(false);
    const current = active();
    dlg.querySelectorAll('input[name="metis-dailysat-choice"]').forEach((radio) => {
      radio.checked = radio.value === current;
    });
    ORDER.forEach((satId) => {
      const sel = dlg.querySelector(`[data-product-select="${satId}"]`);
      if (sel) {
        sel.value = productFor(satId);
        sel.disabled = satId !== current;
      }
    });
    return new Promise((resolve) => {
      pending = { resolve, root: dlg };
      dlg.classList.add("show");
      requestAnimationFrame(() => dlg.querySelector(`input[value="${current}"]`)?.focus());
    });
  }

  return { SATELLITES, ORDER, active, saveActive, productFor, saveProduct, layerInfo, activeOption, prompt };
})();
