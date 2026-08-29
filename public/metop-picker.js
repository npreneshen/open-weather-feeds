/* Picker for Metop AVHRR (EUMETSAT Polar System), separate from
   geo-satellite-picker.js's "Geostationary live" family on purpose: Metop
   is polar-orbiting, not geostationary -- these are rolling 6-orbit
   composites (~100 min refresh, not a continuous full-disk feed), so
   folding it into the geostationary toggle/picker would be architecturally
   easy (identical WMS build path) but label it wrong. Same EUMETSAT
   EUMETView WMS host as Meteosat/MTG (confirmed live against its own
   GetCapabilities, `eps:` workspace), so map-overlays.js's build() and the
   shared GetCapabilities-pinned TIME cache (refreshMtgTimeDefaults, which
   already parses every layer on the host, not just mtg_fd/msg_*) both work
   here with no new fetching. */
window.MetisMetop = (() => {
  "use strict";

  // Confirmed live against eps:*'s own GetCapabilities -- ir108/rgb_natural_fog/
  // rgb_124 all exist per satellite with a proper time Dimension; osisaf_avhrr_l3_sst
  // is a shared (not per-satellite) gridded product, handled separately below.
  // NOTE (tried, measured, removed): these carried an `accumOrbits` hint
  // (6 for the rolling composite, etc.) that playback used to thin its frame
  // list to one slot per accumulation window, on the theory that the
  // in-between slots were near-duplicates. Measured over 2026-08-20..23:
  // the range holds 52 real published slots, the thinning kept 9, and
  // fetching all 52 returned 0 errors and 39 DISTINCT images with only 10
  // adjacent duplicate pairs. It was discarding 30 genuinely different
  // images to tidy up 10 repeats. Playback now requests every published
  // slot; do not reintroduce a cadence heuristic here.
  const AVHRR_OPTIONS = [
    { id: "rgb_natural_fog", label: "Natural Colour + Fog (6 orbits accumulated)" },
    { id: "rgb_124", label: "Cloud RGB, bands 1/2/4 (daily accumulated)" },
    { id: "ir108", label: "Clean Infrared (cloud-top temperature)" },
  ];

  const SATELLITES = {
    metopB: { label: "Metop-B", wmsPrefix: "m01" },
    metopA: { label: "Metop-A", wmsPrefix: "m02" },
    metopC: { label: "Metop-C", wmsPrefix: "m03" },
  };
  const WMS_BASE = "https://view.eumetsat.int/geoserver/wms";
  const WMS_WORKSPACE = "eps";
  const ORDER = ["metopB", "metopA", "metopC"];
  const ACTIVE_KEY = "metis-metop-active-list";
  const PRODUCT_KEY_PREFIX = "metis-metop-product-";
  const DEFAULT_PRODUCT = "rgb_natural_fog";
  const SST_STORAGE_KEY = "metis-metop-sst";
  // Same "Single image" option as geo-satellite-picker.js, same trade --
  // Metop's own coverage is already global (its GetCapabilities
  // BoundingBox is -180..180/-90..90), so map-overlays.js composites every
  // active satellite (+ SST) into ONE combined GetMap via WMS's comma-list
  // `layers` param rather than one image per satellite.
  const REQUEST_MODE_KEY = "metis-metop-request-mode";

  function requestMode() {
    try { return localStorage.getItem(REQUEST_MODE_KEY) === "single" ? "single" : "tiles"; } catch { return "tiles"; }
  }

  function saveRequestMode(mode) {
    try { localStorage.setItem(REQUEST_MODE_KEY, mode === "single" ? "single" : "tiles"); } catch { /* ignore */ }
  }

  function productFor(satId) {
    try {
      const stored = localStorage.getItem(PRODUCT_KEY_PREFIX + satId);
      return AVHRR_OPTIONS.some((opt) => opt.id === stored) ? stored : DEFAULT_PRODUCT;
    } catch {
      return DEFAULT_PRODUCT;
    }
  }

  function saveProduct(satId, productId) {
    const valid = AVHRR_OPTIONS.some((opt) => opt.id === productId) ? productId : DEFAULT_PRODUCT;
    try { localStorage.setItem(PRODUCT_KEY_PREFIX + satId, valid); } catch { /* ignore */ }
  }

  function activeSatellites() {
    try {
      const stored = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
      // Distinguish "never saved" (no key yet -- stored is null, use the
      // sane first-open default below) from "saved as explicitly empty"
      // (stored is []). Coercing the latter back to ["metopB"] was the bug
      // behind "can't switch SST on on its own" -- unchecking every AVHRR
      // satellite to leave just SST got silently overridden back to
      // Metop-B on save, so the SST-only choice could never stick.
      if (Array.isArray(stored)) return stored.filter((id) => SATELLITES[id]);
    } catch { /* fall through */ }
    return ["metopB"];
  }

  function saveActiveSatellites(ids) {
    const valid = ORDER.filter((id) => ids.includes(id));
    try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(valid)); } catch { /* ignore */ }
  }

  function sstEnabled() {
    try { return localStorage.getItem(SST_STORAGE_KEY) === "1"; } catch { return false; }
  }

  function saveSstEnabled(on) {
    try { localStorage.setItem(SST_STORAGE_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  }

  function layerInfo(satId) {
    const config = SATELLITES[satId];
    if (!config) return null;
    const productId = productFor(satId);
    const option = AVHRR_OPTIONS.find((opt) => opt.id === productId) || AVHRR_OPTIONS[0];
    return {
      satLabel: config.label,
      productId,
      productLabel: option.label,
      wmsBase: WMS_BASE,
      wmsLayer: `${WMS_WORKSPACE}:${config.wmsPrefix}_${productId}`,
      attribution: `EUMETSAT ${config.label} / EUMETView`,
    };
  }

  function sstLayerInfo() {
    return {
      wmsBase: WMS_BASE,
      wmsLayer: `${WMS_WORKSPACE}:osisaf_avhrr_l3_sst`,
      attribution: "EUMETSAT OSI SAF Metop AVHRR SST",
    };
  }

  // --- Modal: one checkbox + product dropdown per satellite, plus an SST toggle ---
  let root = null;
  let pending = null;
  let lastToggledOnSatId = null;

  function ensureStyles() {
    if (document.getElementById("metis-metop-styles")) return;
    const style = document.createElement("style");
    style.id = "metis-metop-styles";
    style.textContent = `
      .metis-metop-backdrop{position:fixed;inset:0;z-index:9200;display:none;
        background:rgba(4,14,18,.6);align-items:center;justify-content:center}
      .metis-metop-backdrop.show{display:flex}
      .metis-metop-dialog{width:min(400px,calc(100vw - 32px));max-height:calc(100vh - 48px);
        overflow-y:auto;overflow-x:hidden;
        background:linear-gradient(135deg,var(--glass-panel-a,rgba(16,39,45,.9)),var(--glass-panel-b,rgba(7,25,31,.85)));
        backdrop-filter:var(--glass-blur,blur(18px));-webkit-backdrop-filter:var(--glass-blur,blur(18px));
        border:1px solid var(--glass-line,#304b52);border-radius:8px;background-clip:padding-box;
        box-shadow:var(--glass-inner,inset 0 1px 0 rgba(255,255,255,.05)),var(--glass-drop,0 8px 24px rgba(0,8,12,.22)),0 20px 60px rgba(0,0,0,.45);
        font-family:"IBM Plex Mono",Consolas,monospace;color:#d8d1bc}
      .metis-metop-head{padding:10px 12px;border-bottom:1px solid var(--glass-line,#304b52);position:sticky;top:0;background:transparent}
      .metis-metop-kicker{font-size:.6rem;letter-spacing:.09em;text-transform:uppercase;color:#77949a}
      .metis-metop-title{font-size:.85rem;color:#68cf91;margin-top:2px}
      .metis-metop-body{padding:10px 12px;overflow-x:hidden}
      .metis-metop-sat-row{border:1px solid #304b52;margin-bottom:8px;padding:9px;
        max-width:100%;box-sizing:border-box}
      .metis-metop-sat-row:last-child{margin-bottom:0}
      .metis-metop-sat-head{display:flex;align-items:flex-start;gap:9px;cursor:pointer;margin-bottom:8px}
      .metis-metop-sat-head input{flex:none;width:16px;height:16px;min-width:16px;margin:3px 0 0}
      .metis-metop-sat-name{font-size:.74rem;color:#d8d1bc}
      .metis-metop-sat-row select{display:block;width:100%;max-width:100%;box-sizing:border-box;
        background:#06171e;border:1px solid #304b52;color:#d8d1bc;padding:6px 7px;font:inherit;
        border-radius:0;font-size:.68rem}
      .metis-metop-sat-row select:disabled{opacity:.4}
      .metis-metop-sst-row{border:1px solid #304b52;padding:9px;display:flex;align-items:flex-start;gap:9px;cursor:pointer;margin-top:4px}
      .metis-metop-sst-row input{flex:none;width:16px;height:16px;min-width:16px;margin:3px 0 0}
      .metis-metop-hint{font-size:.6rem;color:#77949a;margin:8px 0 0;line-height:1.5}
      .metis-metop-mode-select{width:auto;margin-top:4px;background:#06171e;border:1px solid #304b52;
        color:#d8d1bc;padding:4px 6px;font:inherit;font-size:.65rem;border-radius:0}
      .metis-metop-actions{display:flex;justify-content:flex-end;gap:8px;
        padding:10px 12px;border-top:1px solid var(--glass-line,#304b52);position:sticky;bottom:0;background:transparent}
      .metis-metop-actions button{border:1px solid var(--glass-line,#304b52);background:transparent;
        color:#d8d1bc;padding:6px 12px;font:600 .65rem "IBM Plex Mono",monospace;
        text-transform:uppercase;letter-spacing:.05em;cursor:pointer;border-radius:0}
      .metis-metop-actions [data-action="save"]{border-color:#68cf91;color:#68cf91}
    `;
    document.head.appendChild(style);
  }

  function dialog() {
    if (root) return root;
    ensureStyles();
    root = document.createElement("div");
    root.className = "metis-metop-backdrop";
    root.innerHTML = `
      <section class="metis-metop-dialog" role="dialog" aria-modal="true" aria-label="Metop AVHRR">
        <header class="metis-metop-head">
          <div class="metis-metop-kicker">Metop AVHRR</div>
          <select class="metis-metop-mode-select" data-metop-mode title="Request method -- Tiles: sharper at high zoom, one failed request only blanks that tile. Single image: one request for every active satellite combined, capped resolution, a failed request blanks the whole layer.">
            <option value="tiles">Tiles</option>
            <option value="single">Single image</option>
          </select>
        </header>
        <div class="metis-metop-body">
          ${ORDER.map((satId) => `
            <div class="metis-metop-sat-row" data-sat="${satId}">
              <label class="metis-metop-sat-head">
                <input type="checkbox" data-sat-checkbox="${satId}" />
                <div class="metis-metop-sat-name">${SATELLITES[satId].label}</div>
              </label>
              <select data-sat-select="${satId}">
                ${AVHRR_OPTIONS.map((opt) => `<option value="${opt.id}">${opt.label}</option>`).join("")}
              </select>
            </div>`).join("")}
          <label class="metis-metop-sst-row">
            <input type="checkbox" data-sst-checkbox />
            <div>
              <div class="metis-metop-sat-name">Sea Surface Temperature</div>
              <div class="metis-metop-hint" style="margin:2px 0 0">Global gridded composite (OSI SAF), not per-satellite -- updates roughly every 12h.</div>
            </div>
          </label>
          <p class="metis-metop-hint">Rolling 6-orbit composites, not a continuous feed -- expect ~100 min between real updates. Multiple satellites tile together for wider coverage.</p>
        </div>
        <div class="metis-metop-actions">
          <button type="button" data-action="cancel">Cancel</button>
          <button type="button" data-action="save">Save</button>
        </div>
      </section>`;
    document.body.appendChild(root);
    root.querySelectorAll("[data-sat-checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        root.querySelector(`[data-sat-select="${cb.dataset.satCheckbox}"]`).disabled = !cb.checked;
        // Remembered so Playback can switch to whichever satellite the user
        // actually just turned on here -- see the metis-metop-changed
        // listener in index.html.
        if (cb.checked) lastToggledOnSatId = cb.dataset.satCheckbox;
      });
    });
    root.querySelector("[data-sst-checkbox]").addEventListener("change", (event) => {
      if (event.target.checked) lastToggledOnSatId = "metopSst";
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
      saveSstEnabled(root.querySelector("[data-sst-checkbox]").checked);
      saveRequestMode(root.querySelector('[data-metop-mode]').value);
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
    if (result) window.dispatchEvent(new CustomEvent("metis-metop-changed", { detail: { lastToggledOnSatId } }));
  }

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
    dlg.querySelector("[data-sst-checkbox]").checked = sstEnabled();
    dlg.querySelector('[data-metop-mode]').value = requestMode();
    return new Promise((resolve) => {
      pending = { resolve, root: dlg };
      dlg.classList.add("show");
      requestAnimationFrame(() => dlg.querySelector('[data-sat-checkbox="metopB"]').focus());
    });
  }

  return {
    SATELLITES, ORDER, productFor, saveProduct, activeSatellites, saveActiveSatellites,
    layerInfo, sstEnabled, sstLayerInfo, prompt, requestMode, saveRequestMode,
  };
})();
