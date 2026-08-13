/* Browser-local API key manager for optional bring-your-own-key feeds. */
window.MetisApiKeys = (() => {
  "use strict";

  const FEEDS = {
    firms: {
      label: "NASA FIRMS",
      storage: "metis-api-key-firms",
      hint: "Paste your free FIRMS MAP_KEY.",
      url: "https://firms.modaps.eosdis.nasa.gov/api/map_key/",
    },
    airnow: {
      label: "EPA AirNow",
      storage: "metis-api-key-airnow",
      hint: "Paste the API key shown in your AirNow account.",
      url: "https://docs.airnowapi.org/account/request/",
    },
    currents: {
      label: "Currents API",
      storage: "metis-api-key-currents",
      hint: "Optional — makes Global Feeds use Currents (1,000 free requests/day) instead of the free, more easily rate-limited GDELT search.",
      url: "https://currentsapi.services/en/register",
    },
    sentinelhub: {
      label: "Sentinel",
      storage: "metis-api-key-sentinelhub",
      hint: "Paste a WMS configuration instance ID from your free Copernicus Data Space account (Sentinel Hub Dashboard → Configuration Utility). Registration is free, no card required.",
      url: "https://shapps.dataspace.copernicus.eu/dashboard/#/configurations",
      // Common layer IDs on a Sentinel Hub "Full WMS template" configuration
      // instance (confirmed live via that template's own GetCapabilities) --
      // a different template (e.g. "Simple WMS Instance") may only have
      // TRUE_COLOR, in which case picking anything else here will just fail
      // to render, same as requesting a layer name that doesn't exist.
      layerStorage: "metis-sentinelhub-layer",
      ccStorage: "metis-sentinelhub-maxcc",
      ccDefault: 30,
      // Sentinel Hub's mosaicking PRIORITY picks which scene wins among
      // candidates already inside the cloud-coverage cap above -- maxcc is a
      // hard filter in both modes (a scene cloudier than the cap is excluded
      // outright, never picked even by "most recent"), priority only decides
      // the tie-break among whatever survives that filter.
      priorityStorage: "metis-sentinelhub-priority",
      priorityDefault: "leastCC",
      priorityOptions: [
        { value: "leastCC", label: "Least cloudy (may be a few days old)" },
        { value: "mostRecent", label: "Most recent (may be cloudy)" },
      ],
      // Lets someone keep several Sentinel Hub instance IDs on hand -- e.g.
      // one Configuration Utility instance built from the Sentinel-2 "Full
      // WMS template" and another built for a different collection (Landsat,
      // a CLMS product) -- and switch between them without retyping the
      // instance ID or losing the old one.
      configsStorage: "metis-sentinelhub-configs",
      resampleStorage: "metis-sentinelhub-resample",
      resampleDefault: "BICUBIC",
      resampleOptions: [
        { value: "NEAREST", label: "Nearest (sharp pixel edges, fastest)" },
        { value: "BILINEAR", label: "Bilinear (smoother)" },
        { value: "BICUBIC", label: "Bicubic (smoothest, default)" },
      ],
      layerOptions: [
        { value: "TRUE_COLOR", label: "True colour" },
        { value: "FALSE_COLOR", label: "False colour (vegetation red)" },
        { value: "FALSE_COLOR_URBAN", label: "False colour, urban" },
        { value: "NDVI", label: "NDVI — vegetation health" },
        { value: "NDWI", label: "NDWI — water content" },
        { value: "MOISTURE_INDEX", label: "Moisture index" },
        { value: "SWIR", label: "SWIR (short-wave infrared)" },
        { value: "AGRICULTURE", label: "Agriculture" },
        { value: "BATHYMETRIC", label: "Bathymetric (shallow water)" },
        { value: "GEOLOGY", label: "Geology" },
        { value: "BAI", label: "BAI — burn area index" },
      ],
    },
  };
  // Site-provided defaults so the keyed layers/news work out of the box.
  // These are plain client-side values (visible in page source to anyone,
  // like any bring-your-own-key field) -- fine for free-tier keys the site
  // owner is comfortable sharing, not for anything meant to stay secret.
  // A user's own explicit save/clear (even clearing to empty) always wins
  // over the default; see keyFor()/save() below.
  const DEFAULTS = {
    firms: "3be0825a9cb9c916d592605616d253d4",
    airnow: "F0277EC9-7C71-42E0-A44B-1D3DB5FC86F5",
    currents: "JSpX2e1GLfHcJhDWSClNRa29jhv--8aD5iUeOeOaj7ZJeBM0",
    // Unlike the anonymous demo keys above, this is a personal Copernicus
    // Data Space instance tied to one account's own free-tier quota (50k
    // requests / 10k processing units per month) -- embedded here on
    // explicit request since this app isn't publicly deployed, but if this
    // ever is shared or deployed somewhere else, every visitor would be
    // spending that same quota.
    sentinelhub: "9dd46043-3e7f-427d-898d-3d88e9fdbd7c",
  };
  let pending = null;

  function keyFor(feed) {
    try {
      // localStorage.getItem returns null only if the user has never saved
      // *or cleared* this key -- an explicit clear stores "" and must win
      // over the default, so null (and only null) falls back to it.
      const stored = localStorage.getItem(FEEDS[feed]?.storage);
      return stored !== null ? stored : (DEFAULTS[feed] || "");
    } catch { return DEFAULTS[feed] || ""; }
  }

  function usingDefault(feed) {
    try { return localStorage.getItem(FEEDS[feed]?.storage) === null && !!DEFAULTS[feed]; }
    catch { return !!DEFAULTS[feed]; }
  }

  function save(feed, value) {
    const config = FEEDS[feed];
    if (!config) return;
    try {
      // Always an explicit set, even "" -- that's how a cleared key stays
      // cleared instead of silently falling back to the site default again.
      localStorage.setItem(config.storage, value ? value.trim() : "");
    } catch {
      throw new Error("This browser blocked local key storage.");
    }
  }

  function layerFor(feed) {
    const config = FEEDS[feed];
    if (!config?.layerOptions) return "";
    try {
      const stored = localStorage.getItem(config.layerStorage);
      return stored || config.layerOptions[0].value;
    } catch { return config.layerOptions[0].value; }
  }

  function saveLayer(feed, value) {
    const config = FEEDS[feed];
    if (!config?.layerStorage) return;
    try { localStorage.setItem(config.layerStorage, (value || "").trim()); } catch { /* ignore */ }
  }

  function ccFor(feed) {
    const config = FEEDS[feed];
    if (!config?.ccStorage) return null;
    try {
      const stored = localStorage.getItem(config.ccStorage);
      return stored !== null ? Number(stored) : config.ccDefault;
    } catch { return config.ccDefault; }
  }

  function saveCloudCoverage(feed, value) {
    const config = FEEDS[feed];
    if (!config?.ccStorage) return;
    const num = Math.max(0, Math.min(100, Math.round(Number(value)) || 0));
    try { localStorage.setItem(config.ccStorage, String(num)); } catch { /* ignore */ }
  }

  function priorityFor(feed) {
    const config = FEEDS[feed];
    if (!config?.priorityStorage) return null;
    try {
      const stored = localStorage.getItem(config.priorityStorage);
      return stored || config.priorityDefault;
    } catch { return config.priorityDefault; }
  }

  function savePriority(feed, value) {
    const config = FEEDS[feed];
    if (!config?.priorityStorage) return;
    const valid = (config.priorityOptions || []).some((opt) => opt.value === value);
    try { localStorage.setItem(config.priorityStorage, valid ? value : config.priorityDefault); } catch { /* ignore */ }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function configsFor(feed) {
    const config = FEEDS[feed];
    if (!config?.configsStorage) return [];
    try {
      const stored = JSON.parse(localStorage.getItem(config.configsStorage) || "[]");
      return Array.isArray(stored) ? stored.filter((c) => c && c.id && c.instanceId) : [];
    } catch { return []; }
  }

  function saveConfigsList(feed, list) {
    const config = FEEDS[feed];
    if (!config?.configsStorage) return;
    try { localStorage.setItem(config.configsStorage, JSON.stringify(list)); } catch { /* ignore */ }
  }

  function addConfig(feed, name, instanceId) {
    const trimmedId = (instanceId || "").trim();
    if (!trimmedId) return null;
    const list = configsFor(feed);
    // A re-add of the same instance ID replaces the old entry (keeping its
    // name) rather than piling up duplicates.
    const existing = list.find((c) => c.instanceId === trimmedId);
    const entry = {
      id: existing?.id || `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: (name || "").trim() || existing?.name || `Configuration ${list.length + 1}`,
      instanceId: trimmedId,
    };
    saveConfigsList(feed, [...list.filter((c) => c.instanceId !== trimmedId), entry]);
    return entry;
  }

  function removeConfigEntry(feed, id) {
    saveConfigsList(feed, configsFor(feed).filter((c) => c.id !== id));
  }

  function populateConfigSelect(feed) {
    const root = document.querySelector(".metis-key-backdrop");
    if (!root) return;
    const select = root.querySelector("#metis-key-config-select");
    if (!select) return;
    const list = configsFor(feed);
    const currentKey = keyFor(feed);
    const matched = list.find((c) => c.instanceId === currentKey);
    select.innerHTML = [
      `<option value="">Site default key</option>`,
      ...list.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`),
      `<option value="__add__">+ Add configuration key…</option>`,
    ].join("");
    select.value = matched ? matched.id : "";
    root.querySelector(".metis-key-config-name-row")?.classList.add("hidden");
  }

  function resampleFor(feed) {
    const config = FEEDS[feed];
    if (!config?.resampleStorage) return null;
    try {
      const stored = localStorage.getItem(config.resampleStorage);
      return stored || config.resampleDefault;
    } catch { return config.resampleDefault; }
  }

  function saveResample(feed, value) {
    const config = FEEDS[feed];
    if (!config?.resampleStorage) return;
    try { localStorage.setItem(config.resampleStorage, value || config.resampleDefault); } catch { /* ignore */ }
  }

  function ensureStyles() {
    if (document.getElementById("metis-api-key-styles")) return;
    const style = document.createElement("style");
    style.id = "metis-api-key-styles";
    style.textContent = `
      .api-key-tools{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;
        padding:7px 8px;border:1px solid var(--line,#304b52);background:rgba(6,23,30,.55)}
      .api-key-tools span{color:var(--muted,#77949a);font-size:.59rem;letter-spacing:.05em}
      .api-key-tools button{width:auto!important;margin:0!important;padding:5px 7px!important;border:1px solid var(--line,#304b52)!important;
        border-radius:0!important;background:#102d35!important;color:var(--text,#d8d1bc)!important;font:600 9px "IBM Plex Mono",monospace!important}
      .metis-key-backdrop{position:fixed;z-index:5000;inset:0;display:none;padding:18px;
        background:rgba(1,8,12,.76);backdrop-filter:blur(3px)}
      .metis-key-backdrop.show{display:block}
      .metis-key-dialog{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(460px,calc(100% - 36px));
        min-width:320px;min-height:260px;max-width:calc(100% - 24px);max-height:calc(100% - 24px);resize:both;overflow:auto;
        border:1px solid #587078;background:#06171e;color:#d8d1bc;
        box-shadow:8px 8px 0 rgba(0,0,0,.45);font:11px/1.5 "IBM Plex Mono",Consolas,monospace}
      .metis-key-head{padding:11px 13px;border-bottom:1px solid #304b52;background:#081d25;cursor:grab;user-select:none;touch-action:none}
      .metis-key-head.dragging{cursor:grabbing}
      .metis-key-kicker{color:#68cf91;font-size:9px;letter-spacing:.12em}
      .metis-key-title{margin-top:2px;color:#d9c69e;font:600 20px "Barlow Condensed","Arial Narrow",sans-serif;letter-spacing:.04em}
      .metis-key-body{padding:13px}
      .metis-key-body p{margin:0 0 10px;color:#9bacae}
      .metis-key-body a{color:#68cf91}
      .metis-key-body label{display:block;margin:10px 0 4px;color:#d9c69e;font-size:9px;letter-spacing:.07em}
      .metis-key-body input,.metis-key-body select{box-sizing:border-box;width:100%;padding:9px;border:1px solid #304b52;border-radius:0;
        background:#071820;color:#fff;font:11px "IBM Plex Mono",monospace}
      .metis-key-mask{-webkit-text-security:disc;text-security:disc}
      .metis-key-known{display:none;margin:0 0 10px;padding:7px 8px;border:1px solid #304b52;background:rgba(104,207,145,.08);color:#9bacae}
      .metis-key-known a{color:#68cf91;margin-left:4px}
      .metis-key-dialog.metis-key-simple .metis-key-full{display:none}
      .metis-key-dialog.metis-key-simple .metis-key-known{display:block}
      .metis-key-configs-row .metis-key-config-controls{display:flex;gap:6px;align-items:center}
      .metis-key-configs-row select{flex:1}
      .metis-key-configs-row button{flex:none;width:auto!important;margin:0!important;padding:0 10px!important;
        height:34px;border:1px solid #304b52!important;border-radius:0!important;background:#102d35!important;
        color:#ff8a5f!important;font:600 12px "IBM Plex Mono",monospace!important;cursor:pointer}
      .metis-key-note{margin-top:9px!important;color:#77949a!important;font-size:9px}
      .metis-key-actions{display:flex;justify-content:space-between;gap:7px;margin-top:13px}
      .metis-key-actions div{display:flex;gap:7px;margin-left:auto}
      .metis-key-actions button{width:auto!important;margin:0!important;padding:7px 10px!important;border:1px solid #304b52!important;
        border-radius:0!important;background:#102d35!important;color:#d8d1bc!important;font:600 9px "IBM Plex Mono",monospace!important}
      .metis-key-actions [data-action="save"]{border-color:#68cf91!important;color:#68cf91!important}
      .metis-key-actions [data-action="remove"]{color:#ff8a5f!important}
    `;
    document.head.appendChild(style);
  }

  function dialog() {
    let root = document.querySelector(".metis-key-backdrop");
    if (root) return root;
    ensureStyles();
    root = document.createElement("div");
    root.className = "metis-key-backdrop";
    root.innerHTML = `
      <section class="metis-key-dialog" role="dialog" aria-modal="true" aria-labelledby="metis-key-title">
        <header class="metis-key-head">
          <div class="metis-key-kicker">OPTIONAL PROVIDER CREDENTIAL</div>
          <div class="metis-key-title" id="metis-key-title">API key</div>
        </header>
        <div class="metis-key-body">
          <div class="metis-key-full">
            <p class="metis-key-hint"></p>
            <a class="metis-key-link" target="_blank" rel="noopener noreferrer">Get a free key ↗</a>
            <div class="metis-key-configs-row hidden">
              <label for="metis-key-config-select">SAVED CONFIGURATIONS</label>
              <div class="metis-key-config-controls">
                <select id="metis-key-config-select"></select>
                <button type="button" data-action="delete-config" title="Remove this saved configuration" aria-label="Remove this saved configuration">×</button>
              </div>
              <div class="metis-key-config-name-row hidden">
                <label for="metis-key-config-name">CONFIGURATION NAME</label>
                <input id="metis-key-config-name" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. Landsat thermal, Burnt area" />
              </div>
            </div>
            <label for="metis-key-input">API KEY</label>
            <input id="metis-key-input" type="text" class="metis-key-mask" autocomplete="off" autocapitalize="off" spellcheck="false" autocorrect="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" />
          </div>
          <p class="metis-key-known">Using your saved key.<a href="#" data-action="change-key">Change key</a></p>
          <div class="metis-key-layer-row hidden">
            <label for="metis-key-layer-select">LAYER / BAND</label>
            <select id="metis-key-layer-select"></select>
            <label for="metis-key-layer-custom">OR A CUSTOM LAYER ID FROM YOUR OWN CONFIGURATION</label>
            <input id="metis-key-layer-custom" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="leave blank to use the dropdown above" />
          </div>
          <div class="metis-key-cc-row hidden">
            <label for="metis-key-cc-input">MAX CLOUD COVERAGE % (scenes cloudier than this are always excluded)</label>
            <input id="metis-key-cc-input" type="number" min="0" max="100" step="5" />
          </div>
          <div class="metis-key-priority-row hidden">
            <label for="metis-key-priority-select">WHEN MULTIPLE SCENES QUALIFY</label>
            <select id="metis-key-priority-select"></select>
          </div>
          <div class="metis-key-resample-row hidden">
            <label for="metis-key-resample-select">RESAMPLING (how tiles are sharpened/smoothed when scaled)</label>
            <select id="metis-key-resample-select"></select>
          </div>
          <p class="metis-key-note">Stored only in this browser. It is sent to your same-origin Worker when this layer is fetched and is never added to the project files. “Use site key” selects an optional key configured by the site owner.</p>
          <div class="metis-key-actions">
            <button type="button" data-action="remove">REMOVE SAVED KEY</button>
            <div>
              <button type="button" data-action="site">USE SITE KEY</button>
              <button type="button" data-action="cancel">CANCEL</button>
              <button type="button" data-action="save">SAVE &amp; ENABLE</button>
            </div>
          </div>
        </div>
      </section>`;
    document.body.appendChild(root);
    const panel = root.querySelector(".metis-key-dialog");
    const handle = root.querySelector(".metis-key-head");
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button > 0) return;
      const box = panel.getBoundingClientRect();
      panel.style.transform = "none";
      panel.style.left = `${box.left}px`;
      panel.style.top = `${box.top}px`;
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: box.left, top: box.top };
      handle.classList.add("dragging");
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    window.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const width = panel.offsetWidth, height = panel.offsetHeight;
      panel.style.left = `${Math.max(8, Math.min(drag.left + event.clientX - drag.x, innerWidth - width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(drag.top + event.clientY - drag.y, innerHeight - height - 8))}px`;
    });
    window.addEventListener("pointerup", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      handle.classList.remove("dragging");
    });
    root.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(false));
    root.querySelector('[data-action="site"]').addEventListener("click", () => finish(true));
    root.querySelector('[data-action="change-key"]').addEventListener("click", (event) => {
      event.preventDefault();
      panel.classList.remove("metis-key-simple");
      root.querySelector("#metis-key-input").focus();
    });
    // maxcc still excludes anything cloudier than the cap in "most recent"
    // mode too (see extras() in sentinel-hub.js) -- the default 30% cap
    // would keep it from finding much of anything actually recent, so
    // switching to "most recent" nudges the cap up to give it a real chance
    // of surfacing a newer, cloudier scene instead of quietly falling back
    // to the same clear-but-old one leastCC would have picked anyway.
    root.querySelector("#metis-key-priority-select").addEventListener("change", (event) => {
      if (event.target.value === "mostRecent") {
        root.querySelector("#metis-key-cc-input").value = 70;
      }
    });
    root.querySelector("#metis-key-config-select").addEventListener("change", (event) => {
      const value = event.target.value;
      const nameRow = root.querySelector(".metis-key-config-name-row");
      if (value === "__add__") {
        root.querySelector("#metis-key-input").value = "";
        root.querySelector("#metis-key-config-name").value = "";
        nameRow.classList.remove("hidden");
        root.querySelector("#metis-key-input").focus();
        return;
      }
      nameRow.classList.add("hidden");
      if (!pending) return;
      if (!value) {
        // "Site default key" -- always the embedded default specifically,
        // not "whatever was active when the dialog opened": once a config
        // has actually been saved, that config's instance ID *is* the
        // active stored key, so there's no other "current, unconfigured"
        // value left to fall back to except the real site default.
        root.querySelector("#metis-key-input").value = DEFAULTS[pending.feed] || "";
        return;
      }
      const match = configsFor(pending.feed).find((c) => c.id === value);
      if (match) root.querySelector("#metis-key-input").value = match.instanceId;
    });
    root.querySelector('[data-action="delete-config"]').addEventListener("click", () => {
      if (!pending) return;
      const select = root.querySelector("#metis-key-config-select");
      if (!select.value || select.value === "__add__") return;
      removeConfigEntry(pending.feed, select.value);
      populateConfigSelect(pending.feed);
    });
    root.querySelector('[data-action="save"]').addEventListener("click", () => {
      const simple = panel.classList.contains("metis-key-simple");
      if (!simple) {
        const value = root.querySelector("#metis-key-input").value.trim();
        if (!value || value.length < 8) {
          root.querySelector("#metis-key-input").setCustomValidity("Enter a valid API key.");
          root.querySelector("#metis-key-input").reportValidity();
          return;
        }
        save(pending.feed, value);
        if (FEEDS[pending.feed]?.configsStorage && !root.querySelector(".metis-key-config-name-row").classList.contains("hidden")) {
          addConfig(pending.feed, root.querySelector("#metis-key-config-name").value, value);
        }
      }
      if (FEEDS[pending.feed]?.layerOptions) {
        const custom = root.querySelector("#metis-key-layer-custom").value.trim();
        saveLayer(pending.feed, custom || root.querySelector("#metis-key-layer-select").value);
      }
      if (FEEDS[pending.feed]?.ccStorage) {
        saveCloudCoverage(pending.feed, root.querySelector("#metis-key-cc-input").value);
      }
      if (FEEDS[pending.feed]?.priorityStorage) {
        savePriority(pending.feed, root.querySelector("#metis-key-priority-select").value);
      }
      if (FEEDS[pending.feed]?.resampleStorage) {
        saveResample(pending.feed, root.querySelector("#metis-key-resample-select").value);
      }
      finish(true);
    });
    root.querySelector('[data-action="remove"]').addEventListener("click", () => {
      const removedFeed = pending.feed;
      save(removedFeed, "");
      root.querySelector("#metis-key-input").value = "";
      panel.classList.remove("metis-key-simple");
      // finish(false) skips its own change-event dispatch (result is only
      // "true" on an actual save), but the effective key genuinely just
      // changed -- from a personal key back to the site default (or to
      // nothing, if there's no default) -- so listeners still need to know,
      // the same as any other save.
      finish(false);
      window.dispatchEvent(new CustomEvent("metis-api-key-changed", { detail: { feed: removedFeed } }));
    });
    root.addEventListener("pointerdown", (event) => {
      if (event.target === root) finish(false);
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish(false);
      if (event.key === "Enter") root.querySelector('[data-action="save"]').click();
    });
    return root;
  }

  function finish(result) {
    if (!pending) return;
    const current = pending;
    pending = null;
    current.root.classList.remove("show");
    current.resolve(result);
    // Lets the app react to a saved key/layer change (e.g. rebuild an
    // already-active raster layer) without this module needing to know
    // about map/layer internals -- fires for any successful save, not just
    // the first-toggle-on flow.
    if (result) window.dispatchEvent(new CustomEvent("metis-api-key-changed", { detail: { feed: current.feed } }));
  }

  function prompt(feed, options = {}) {
    const config = FEEDS[feed];
    if (!config) return Promise.resolve(true);
    if (pending) finish(false);
    const root = dialog();
    const panel = root.querySelector(".metis-key-dialog");
    root.querySelector(".metis-key-title").textContent = `${config.label} API key`;
    root.querySelector(".metis-key-hint").textContent = usingDefault(feed)
      ? `${config.hint} (currently using the site's shared key — save your own to replace it, or remove to disable this layer.)`
      : config.hint;
    root.querySelector(".metis-key-link").href = config.url;
    root.querySelector("#metis-key-input").value = keyFor(feed);
    const layerRow = root.querySelector(".metis-key-layer-row");
    const ccRow = root.querySelector(".metis-key-cc-row");
    const priorityRow = root.querySelector(".metis-key-priority-row");
    const resampleRow = root.querySelector(".metis-key-resample-row");
    const configsRow = root.querySelector(".metis-key-configs-row");
    layerRow.classList.toggle("hidden", !config.layerOptions);
    ccRow.classList.toggle("hidden", !config.ccStorage);
    priorityRow.classList.toggle("hidden", !config.priorityStorage);
    resampleRow.classList.toggle("hidden", !config.resampleStorage);
    configsRow.classList.toggle("hidden", !config.configsStorage);
    if (config.configsStorage) populateConfigSelect(feed);
    if (config.layerOptions) {
      const select = root.querySelector("#metis-key-layer-select");
      select.innerHTML = config.layerOptions.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join("");
      const stored = layerFor(feed);
      const isCurated = config.layerOptions.some((opt) => opt.value === stored);
      select.value = isCurated ? stored : config.layerOptions[0].value;
      root.querySelector("#metis-key-layer-custom").value = isCurated ? "" : stored;
    }
    if (config.ccStorage) {
      root.querySelector("#metis-key-cc-input").value = ccFor(feed);
    }
    if (config.priorityStorage) {
      const prioritySelect = root.querySelector("#metis-key-priority-select");
      prioritySelect.innerHTML = config.priorityOptions.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join("");
      prioritySelect.value = priorityFor(feed);
    }
    if (config.resampleStorage) {
      const resampleSelect = root.querySelector("#metis-key-resample-select");
      resampleSelect.innerHTML = config.resampleOptions.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join("");
      resampleSelect.value = resampleFor(feed);
    }
    // Once a key is already known (saved or the site default), toggling the
    // layer back on should surface just the layer/cloud-cover picker instead
    // of re-asking for the key every time -- "change key" or the manage-keys
    // bar (options.manage) still reach the full form when it's genuinely needed.
    const simple = !!config.layerOptions && !!keyFor(feed) && !options.manage;
    panel.classList.toggle("metis-key-simple", simple);
    root.querySelector('[data-action="save"]').textContent = (!simple && options.manage) ? "SAVE KEY" : "SAVE & ENABLE";
    return new Promise((resolve) => {
      pending = { feed, resolve, root };
      root.classList.add("show");
      requestAnimationFrame(() => root.querySelector(simple ? "#metis-key-layer-select" : "#metis-key-input").focus());
    });
  }

  async function ensure(feed) {
    return keyFor(feed) ? true : prompt(feed);
  }

  function mount(host, feeds = Object.keys(FEEDS)) {
    if (!host || host.querySelector(".api-key-tools")) return;
    const available = feeds.filter((feed) => FEEDS[feed]);
    if (!available.length) return;
    const bar = document.createElement("div");
    bar.className = "api-key-tools";
    bar.innerHTML = `<span>${available.length === 1 ? "OPTIONAL API KEY" : "OPTIONAL API KEYS"}</span>${available.map((feed) => `<button type="button" data-feed="${feed}">${FEEDS[feed].label.replace("NASA ", "").replace("EPA ", "")}${usingDefault(feed) ? " ✓" : ""}</button>`).join("")}`;
    bar.querySelectorAll("button[data-feed]").forEach((button) => {
      button.addEventListener("click", () => prompt(button.dataset.feed, { manage: true }));
    });
    host.prepend(bar);
  }

  return { ensure, keyFor, mount, prompt, usingDefault, layerFor, ccFor, priorityFor, resampleFor };
})();
