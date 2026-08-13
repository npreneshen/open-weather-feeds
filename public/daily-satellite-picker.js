/* Picker for the daily true-colour GIBS composite: MODIS Terra, MODIS Aqua,
   or VIIRS on any of Suomi-NPP/NOAA-20/NOAA-21. These used to be separate
   layer-grid checkboxes that all shared one day-offset stepper (same
   imagery date across all of them); this collapses them into the one
   "Satellite" toggle plus a single-select modal, matching the pattern
   geo-satellite-picker.js uses for the geostationary family. Unlike that
   picker, only one of these can be shown at once -- they're alternate
   sources for the same kind of image, not complementary regional coverage
   -- so this is radio buttons, not checkboxes. NOAA-20/NOAA-21 confirmed
   live via GIBS' own GetCapabilities (VIIRS_NOAA20_CorrectedReflectance_
   TrueColor since 2018-01-05, VIIRS_NOAA21_CorrectedReflectance_TrueColor
   since 2023-02-10), same GoogleMapsCompatible_Level9 pattern as SNPP. */
window.MetisDailySat = (() => {
  "use strict";

  const OPTIONS = [
    { id: "satellite", name: "Terra", region: "MODIS · morning overpass · archive back to 2000" },
    { id: "satelliteAqua", name: "Aqua", region: "MODIS · afternoon overpass" },
    { id: "satelliteViirs", name: "VIIRS SNPP", region: "sharper daily composite" },
    { id: "satelliteNoaa20", name: "VIIRS NOAA-20", region: "sharper daily composite · since 2018" },
    { id: "satelliteNoaa21", name: "VIIRS NOAA-21", region: "sharper daily composite · since 2023" },
  ];
  const KEY = "metis-dailysat-active";
  const DEFAULT = "satelliteViirs";

  function active() {
    try {
      const stored = localStorage.getItem(KEY);
      return OPTIONS.some((opt) => opt.id === stored) ? stored : DEFAULT;
    } catch {
      return DEFAULT;
    }
  }

  function saveActive(id) {
    const valid = OPTIONS.some((opt) => opt.id === id) ? id : DEFAULT;
    try { localStorage.setItem(KEY, valid); } catch { /* ignore */ }
  }

  function activeOption() {
    return OPTIONS.find((opt) => opt.id === active()) || OPTIONS[0];
  }

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
      .metis-dailysat-dialog{width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 48px);
        overflow-y:auto;overflow-x:hidden;background:#081d25;border:1px solid #304b52;
        box-shadow:6px 6px 0 rgba(0,0,0,.45);font-family:"IBM Plex Mono",Consolas,monospace;color:#d8d1bc}
      .metis-dailysat-head{padding:10px 12px;border-bottom:1px solid #304b52}
      .metis-dailysat-kicker{font-size:.6rem;letter-spacing:.09em;text-transform:uppercase;color:#77949a}
      .metis-dailysat-title{font-size:.85rem;color:#68cf91;margin-top:2px}
      .metis-dailysat-body{padding:10px 12px;overflow-x:hidden}
      .metis-dailysat-row{display:flex;align-items:flex-start;gap:9px;border:1px solid #304b52;
        padding:9px;margin-bottom:8px;cursor:pointer;max-width:100%;box-sizing:border-box}
      .metis-dailysat-row:last-child{margin-bottom:0}
      .metis-dailysat-row:has(input:checked){border-color:#68cf91}
      .metis-dailysat-row input{flex:none;width:16px;height:16px;min-width:16px;margin:3px 0 0}
      .metis-dailysat-copy{min-width:0}
      .metis-dailysat-name{font-size:.74rem;color:#d8d1bc;overflow-wrap:anywhere}
      .metis-dailysat-region{margin-top:2px;font-size:.6rem;color:#77949a;
        text-transform:uppercase;letter-spacing:.04em;overflow-wrap:anywhere}
      .metis-dailysat-hint{font-size:.6rem;color:#77949a;margin:8px 0 0;line-height:1.5}
      .metis-dailysat-actions{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid #304b52}
      .metis-dailysat-actions button{border:1px solid #304b52;background:transparent;
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
          <div class="metis-dailysat-kicker">Daily true-colour satellite</div>
          <div class="metis-dailysat-title" id="metis-dailysat-title">Which source</div>
        </header>
        <div class="metis-dailysat-body">
          ${OPTIONS.map((opt) => `
            <label class="metis-dailysat-row" data-opt="${opt.id}">
              <input type="radio" name="metis-dailysat-choice" value="${opt.id}" />
              <div class="metis-dailysat-copy">
                <div class="metis-dailysat-name">${opt.name}</div>
                <div class="metis-dailysat-region">${opt.region}</div>
              </div>
            </label>`).join("")}
          <p class="metis-dailysat-hint">Same imagery date across all three -- switching source keeps the date stepper where it was. Free, no account needed.</p>
        </div>
        <div class="metis-dailysat-actions">
          <button type="button" data-action="cancel">Cancel</button>
          <button type="button" data-action="save">Save</button>
        </div>
      </section>`;
    document.body.appendChild(root);
    root.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(false));
    root.querySelector('[data-action="save"]').addEventListener("click", () => {
      const checked = root.querySelector('input[name="metis-dailysat-choice"]:checked');
      saveActive(checked ? checked.value : DEFAULT);
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
    return new Promise((resolve) => {
      pending = { resolve, root: dlg };
      dlg.classList.add("show");
      requestAnimationFrame(() => dlg.querySelector(`input[value="${current}"]`)?.focus());
    });
  }

  return { OPTIONS, active, saveActive, activeOption, prompt };
})();
