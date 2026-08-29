/* Draggable location inspector: loaded observations, source history and Open-Meteo charts. */
window.PointChartsModal = (() => {
  "use strict";

  function ensureStyles() {
    if (document.getElementById("point-modal-styles")) return;
    const style = document.createElement("style");
    style.id = "point-modal-styles";
    style.textContent = `
      .point-charts-modal{position:absolute;z-index:8000;display:none;min-width:360px;min-height:300px;
        width:620px;max-width:calc(100% - 24px);height:440px;max-height:calc(100% - 24px);overflow:hidden;
        background:linear-gradient(135deg,var(--glass-panel-a,rgba(16,39,45,.9)),var(--glass-panel-b,rgba(7,25,31,.85)));
        backdrop-filter:var(--glass-blur,blur(18px));-webkit-backdrop-filter:var(--glass-blur,blur(18px));
        border:1px solid var(--glass-line,#587078);border-radius:8px;background-clip:padding-box;
        box-shadow:var(--glass-inner,inset 0 1px 0 rgba(255,255,255,.05)),var(--glass-drop,0 8px 24px rgba(0,8,12,.22)),0 14px 44px rgba(0,0,0,.42);
        color:#d8d1bc;font:13px "IBM Plex Mono",Consolas,monospace}
      .point-charts-modal.show{display:flex;flex-direction:column}
      .point-charts-modal.expanded{position:fixed;inset:12px!important;width:auto!important;height:auto;max-width:none;max-height:none}
      .point-modal-head{display:flex!important;justify-content:space-between;align-items:flex-start;min-height:52px!important;
        padding:8px 10px!important;border-bottom:1px solid var(--glass-line,#304b52)!important;background:transparent!important;
        cursor:grab;user-select:none;touch-action:none;gap:8px}
      .point-modal-head.dragging{cursor:grabbing}
      .point-modal-head-left{min-width:0}
      /* Was its own full-width row (.point-modal-shared-controls) below the
         tab bar -- reported live as wasting vertical space for a single
         dropdown. Lives in the header now, next to the export/expand/close
         actions it's least likely to collide with for room. */
      .point-modal-head-right{display:flex;align-items:center;gap:7px;flex:none}
      .point-modal-kicker{color:#68cf91;font-size:9px;letter-spacing:.13em}
      .point-modal-title{display:block;color:#d9c69e;font:600 17px "Barlow Condensed","Arial Narrow",sans-serif;letter-spacing:.05em}
      .point-modal-meta{color:#77949a;font-size:11px}
      .point-modal-head-right select.point-modal-model{width:auto;max-width:150px;margin:0;padding:5px 6px;
        border:1px solid #304b52;border-radius:0;background:#071820;color:#d8d1bc;
        font:10px "IBM Plex Mono",monospace;text-overflow:ellipsis}
      .point-modal-head-right select.point-modal-model.hidden{display:none}
      .point-modal-actions{display:flex;gap:5px}
      .point-modal-actions button{width:auto!important;margin:0!important;padding:5px 7px!important;border:1px solid #304b52!important;
        background:#102d35!important;color:#d8d1bc!important;border-radius:0!important;font:600 9px "IBM Plex Mono",monospace!important}
      .point-modal-tabs{display:flex;border-bottom:1px solid #304b52;background:#071820;
        overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
      .point-modal-tabs button{width:auto!important;min-width:150px;flex:0 0 auto;margin:0!important;padding:8px 12px!important;border:0!important;
        border-right:1px solid #304b52!important;border-radius:0!important;background:#071820!important;color:#77949a!important;
        font:600 9px "IBM Plex Mono",monospace!important;letter-spacing:.07em}
      .point-modal-tabs button.active{background:#102d35!important;color:#68cf91!important;box-shadow:inset 0 -2px #68cf91}
      .point-modal-body{display:flex;min-height:0;flex:1;padding:9px}
      .point-modal-view{display:none;min-width:0;min-height:0;flex:1}.point-modal-view.active{display:flex;flex-direction:column;gap:7px}
      .point-modal-select{width:100%;padding:6px 8px;border:1px solid #304b52;border-radius:0;background:#071820;color:#d8d1bc;
        font:12px "IBM Plex Mono",monospace}
      .point-modal-controls{display:grid;grid-template-columns:minmax(150px,1.4fr) minmax(120px,.8fr);gap:7px}
      .point-modal-controls .point-modal-history-depth{width:100%;padding:6px 8px;border:1px solid #304b52;border-radius:0;
        background:#071820;color:#d8d1bc;font:11px "IBM Plex Mono",monospace}
      .point-modal-advanced{display:flex!important;align-items:center;gap:5px;margin:0!important;color:#77949a;font-size:10px;letter-spacing:.05em;text-transform:uppercase}
      .point-modal-advanced input{width:auto!important;margin:0!important}
      .point-modal-status{color:#ff8a5f;font-size:11px;letter-spacing:.03em}
      .point-modal-status.ready{color:#77949a}.point-modal-status.error{color:#ff7b72}
      .point-modal-canvas{display:none;width:100%;height:100%;min-height:0;background:#06171e;border:1px solid #304b52}
      .point-modal-canvas.show{display:block}.point-charts-modal .hidden{display:none!important}
      .point-loaded-panel{overflow:auto;min-height:0;flex:1;padding-right:3px}
      .point-summary-view{overflow:auto}
      .point-summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:9px}
      .point-summary-card{border:1px solid #304b52;background:#071820}
      .point-summary-card h3{margin:0;padding:6px 9px;border-bottom:1px solid #203b42;color:#68cf91;
        font:600 10px "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase}
      .point-summary-asof{padding:5px 9px 0;color:#5f8a90;font-size:9px;letter-spacing:.03em}
      .point-summary-headline{display:flex;align-items:baseline;gap:9px;padding:9px 9px 2px}
      .point-summary-temp{color:#f0e4c6;font:600 30px "Barlow Condensed","Arial Narrow",sans-serif;letter-spacing:.02em}
      .point-summary-condition{color:#d8d1bc;font-size:12px}
      .point-summary-card dl{display:grid;grid-template-columns:minmax(90px,50%) 1fr;gap:4px 8px;margin:0;padding:8px 9px;font-size:10.5px;line-height:1.4}
      .point-summary-card dt{color:#77949a}.point-summary-card dd{margin:0;color:#d8d1bc;word-break:break-word}
      .point-summary-empty{padding:9px;color:#77949a;font-size:11px;line-height:1.5}
      .point-loaded-summary{display:flex;justify-content:space-between;gap:10px;padding:7px 9px;margin-bottom:7px;border-left:3px solid #68cf91;background:#071820;color:#77949a;font-size:10px}
      .point-observation{margin-bottom:8px;border:1px solid #304b52;background:#071820}
      .point-observation-head{display:flex;justify-content:space-between;gap:10px;padding:7px 9px;border-bottom:1px solid #203b42}
      .point-observation-title{color:#d9c69e;font:600 15px "Barlow Condensed",sans-serif}.point-observation-kind{color:#68cf91;font-size:9px;text-transform:uppercase}
      .point-observation dl{display:grid;grid-template-columns:minmax(90px,34%) 1fr;gap:4px 8px;margin:0;padding:8px 9px;font-size:10.5px;line-height:1.4}
      .point-observation dt{color:#77949a}.point-observation dd{margin:0;color:#d8d1bc;word-break:break-word}
      .point-modal-resize-handle{position:absolute;right:0;bottom:0;width:22px;height:22px;cursor:nwse-resize;
        touch-action:none;background:linear-gradient(135deg,transparent 0 44%,#38575d 45% 51%,transparent 52% 62%,#68cf91 63% 69%,transparent 70%)}
      .point-charts-modal.expanded .point-modal-resize-handle{display:none}
      @media(max-width:720px){.point-charts-modal{left:8px!important;right:8px!important;top:8px!important;width:auto!important;
        min-width:0;height:58vh}
        /* .point-modal-head-right keeps flex:none (its non-mobile rule,
           above) so it never shrinks -- fine on desktop, but on mobile that
           made head-right demand the header's full width while head-left
           was still allowed to shrink (min-width:0, for the desktop case
           where both sides share one row), so flexbox crushed head-left to
           0 width instead of wrapping -- confirmed live: the title/coords
           sat behind the model dropdown. flex-wrap here plus an explicit
           100% basis on head-right forces head-right onto its own
           full-width row below head-left instead of contesting it. */
        .point-modal-head{flex-wrap:wrap}
        .point-modal-head-left{flex:1 1 auto}
        .point-modal-head-right{flex:1 1 100%;flex-wrap:nowrap;justify-content:flex-end;gap:5px}
        /* Within that row, the select used to also claim flex:1 1 100% --
           correct for keeping it off head-left's row, but it also meant the
           select and the PNG/CSV/EXPAND/close actions each forced their own
           line *inside* head-right, spending three rows total on a header
           that only needs two -- reported live as "takes too much space".
           nowrap above plus letting the select shrink (flex:1 1 auto,
           min-width:0) puts both on head-right's one row instead, with the
           select giving up width first since the action buttons have
           actual labels to fit and it's fine to just truncate. */
        .point-modal-head-right select.point-modal-model{max-width:none;flex:1 1 auto;min-width:0;width:0}
        .point-modal-actions{flex:none;flex-wrap:nowrap;gap:3px}
        .point-modal-actions button{padding:5px 5px!important;font-size:8px!important}
        .point-modal-tabs button{min-width:0;flex:1 1 0;padding:8px 6px!important;font-size:8px!important}}
    `;
    document.head.appendChild(style);
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function download(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  function create({ map, host, onModelChange, onAdvancedChange, onHistoryDepthChange } = {}) {
    ensureStyles();
    const mount = host || map?.getContainer()?.parentElement || document.body;
    const root = document.createElement("section");
    root.className = "point-charts-modal";
    root.setAttribute("aria-label", "Location data inspector");
    root.innerHTML = `
      <header class="point-modal-head">
        <div class="point-modal-head-left">
          <div class="point-modal-kicker">LOCATION OBSERVATORY</div>
          <strong class="point-modal-title">Select a point</strong>
          <span class="point-modal-meta"></span>
        </div>
        <div class="point-modal-head-right">
          <select class="point-modal-model" aria-label="Weather model"></select>
          <div class="point-modal-actions">
            <button type="button" data-action="png" title="Export current chart as PNG">PNG</button>
            <button type="button" data-action="csv" title="Export current chart as CSV">CSV</button>
            <button type="button" data-action="expand" title="Expand chart">EXPAND</button>
            <button type="button" data-action="close" title="Close">×</button>
          </div>
        </div>
      </header>
      <nav class="point-modal-tabs" aria-label="Location data views">
        <button type="button" data-view="charts">CHARTS &amp; HISTORY</button>
        <button type="button" data-view="summary">SUMMARY</button>
        <button type="button" data-view="loaded" class="active">LOADED HERE <span data-loaded-count>0</span></button>
      </nav>
      <div class="point-modal-body">
        <section class="point-modal-view point-chart-view">
          <div class="point-modal-controls">
            <select class="point-modal-select" aria-label="Chart variable"></select>
            <select class="point-modal-history-depth" aria-label="History depth" title="How far back historical charts (archive, earthquakes, air quality, water gauges) look">
              <option value="7" selected>History: 7 days</option>
              <option value="30">History: 30 days</option>
              <option value="90">History: 90 days</option>
              <option value="365">History: 1 year</option>
            </select>
          </div>
          <label class="point-modal-advanced"><input type="checkbox" class="point-modal-advanced-input" /> All variables (slower)</label>
          <div class="point-modal-status">Click the map to load point data.</div>
          <canvas class="point-modal-canvas"></canvas>
        </section>
        <section class="point-modal-view point-summary-view">
          <div class="point-summary-panel"><div class="point-summary-empty">Loading weather summary…</div></div>
        </section>
        <section class="point-modal-view point-loaded-view active">
          <div class="point-raster-panel"></div>
          <div class="point-loaded-panel"><div class="point-loaded-summary"><span>CLICK A LOADED FEATURE</span><span>0 MATCHES</span></div></div>
        </section>
      </div>
      <div class="point-modal-resize-handle" role="separator" aria-label="Drag to resize chart window"></div>`;
    mount.appendChild(root);

    const title = root.querySelector(".point-modal-title");
    const meta = root.querySelector(".point-modal-meta");
    const select = root.querySelector(".point-modal-select");
    const modelSelect = root.querySelector(".point-modal-model");
    const historyDepthSelect = root.querySelector(".point-modal-history-depth");
    const advancedCheckbox = root.querySelector(".point-modal-advanced-input");
    const status = root.querySelector(".point-modal-status");
    const canvas = root.querySelector(".point-modal-canvas");
    const header = root.querySelector(".point-modal-head");
    const resizeHandle = root.querySelector(".point-modal-resize-handle");
    const loadedPanel = root.querySelector(".point-loaded-panel");
    const rasterPanel = root.querySelector(".point-raster-panel");
    const loadedCount = root.querySelector("[data-loaded-count]");
    const summaryPanel = root.querySelector(".point-summary-panel");
    const tabButtons = [...root.querySelectorAll("[data-view]")];
    const views = {
      summary: root.querySelector(".point-summary-view"),
      loaded: root.querySelector(".point-loaded-view"),
      charts: root.querySelector(".point-chart-view"),
    };
    let charts = [];
    let context = {};
    let interaction = null;
    let restoreBox = null;
    let activeView = "loaded";

    if (window.L?.DomEvent) {
      window.L.DomEvent.disableClickPropagation(root);
      window.L.DomEvent.disableScrollPropagation(root);
    }

    function currentChart() {
      return charts.find((chart) => chart.id === select.value) || charts[0] || null;
    }

    function activate(view) {
      activeView = views[view] ? view : "loaded";
      tabButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === activeView));
      Object.entries(views).forEach(([key, element]) => element.classList.toggle("active", key === activeView));
      // The model choice only affects the Open-Meteo-driven Charts/Summary
      // views -- "Loaded here" is just each feature's own raw attributes, so
      // the selector doesn't apply there and was just clutter on that tab.
      modelSelect.classList.toggle("hidden", activeView === "loaded");
      root.querySelectorAll('[data-action="png"],[data-action="csv"]').forEach((button) => {
        button.disabled = activeView !== "charts";
      });
      if (activeView === "charts") requestAnimationFrame(draw);
    }

    function draw() {
      const chart = currentChart();
      if (!chart) {
        canvas.classList.remove("show");
        return;
      }
      canvas.classList.add("show");
      window.GlobalCharts.draw(canvas, chart.series, {
        unit: chart.unit,
        emptyText: "No numeric values returned",
      });
    }

    function position(anchor) {
      if (!anchor || root.classList.contains("expanded")) return;
      const bounds = mount.getBoundingClientRect();
      const mapBounds = map?.getContainer()?.getBoundingClientRect();
      const anchorX = anchor.x + (mapBounds ? mapBounds.left - bounds.left : 0);
      const anchorY = anchor.y + (mapBounds ? mapBounds.top - bounds.top : 0);
      const width = Math.min(root.offsetWidth || 620, Math.max(360, bounds.width - 24));
      root.style.width = `${width}px`;
      const left = Math.max(12, Math.min(anchorX + 14, bounds.width - width - 12));
      const estimatedHeight = Math.min(root.offsetHeight || 440, bounds.height - 24);
      const top = Math.max(12, Math.min(anchorY + 14, bounds.height - estimatedHeight - 12));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    }

    function boundedBox(left, top, width = root.offsetWidth, height = root.offsetHeight) {
      const bounds = mount.getBoundingClientRect();
      const nextWidth = Math.max(360, Math.min(width, bounds.width - 24));
      const nextHeight = Math.max(300, Math.min(height, bounds.height - 24));
      return {
        left: Math.max(12, Math.min(left, bounds.width - nextWidth - 12)),
        top: Math.max(12, Math.min(top, bounds.height - nextHeight - 12)),
        width: nextWidth,
        height: nextHeight,
      };
    }

    function beginInteraction(event, type) {
      if (root.classList.contains("expanded") || event.button > 0) return;
      // .point-modal-head-right now also holds the model select (moved out
      // of its own row into the header) -- was just .point-modal-actions,
      // which no longer covers it, so opening the dropdown would have
      // started a drag right along with it.
      if (type === "drag" && event.target.closest(".point-modal-head-right")) return;
      event.preventDefault();
      const bounds = mount.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      interaction = {
        type,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: box.left - bounds.left,
        top: box.top - bounds.top,
        width: box.width,
        height: box.height,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      header.classList.toggle("dragging", type === "drag");
    }

    function moveInteraction(event) {
      if (!interaction || event.pointerId !== interaction.pointerId) return;
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      const next = interaction.type === "drag"
        ? boundedBox(interaction.left + dx, interaction.top + dy, interaction.width, interaction.height)
        : boundedBox(interaction.left, interaction.top, interaction.width + dx, interaction.height + dy);
      root.style.left = `${next.left}px`;
      root.style.top = `${next.top}px`;
      root.style.width = `${next.width}px`;
      root.style.height = `${next.height}px`;
      if (activeView === "charts") requestAnimationFrame(draw);
    }

    function endInteraction(event) {
      if (!interaction || event.pointerId !== interaction.pointerId) return;
      interaction = null;
      header.classList.remove("dragging");
    }

    function showLoading({ lat, lon, model, anchor, label } = {}) {
      context = { lat, lon, model, anchor, label };
      title.textContent = label || `${Number(lat).toFixed(3)}°, ${Number(lon).toFixed(3)}°`;
      meta.textContent = `${Number(lat).toFixed(3)}°, ${Number(lon).toFixed(3)}°${model ? ` · ${model}` : ""}`;
      rasterPanel.innerHTML = "";
      charts = [];
      select.innerHTML = "";
      select.classList.add("hidden");
      canvas.classList.remove("show");
      status.textContent = "Assembling forecast, atmosphere, ocean, flood, archive and ensemble feeds…";
      status.className = "point-modal-status";
      summaryPanel.innerHTML = '<div class="point-summary-empty">Loading weather summary…</div>';
      root.classList.add("show");
      position(anchor);
    }

    function setLoaded(html, count = 0, options = {}) {
      const safeCount = Math.max(0, Number(count) || 0);
      loadedCount.textContent = String(safeCount);
      loadedPanel.innerHTML = html || `<div class="point-loaded-summary"><span>NO LOADED FEATURES AT THIS POINT</span><span>0 MATCHES</span></div><div class="point-modal-status ready">Open-Meteo still provides model data for the selected coordinates.</div>`;
      // Clicking an actual marker/feature (an earthquake, a buoy reading,
      // etc) takes you to what's loaded there. Clicking blank map -- which
      // includes clicking on satellite/imagery overlays, since those aren't
      // "loaded features" -- has nothing to show on that tab, so it falls
      // back to Summary instead of landing on an empty list. Control
      // changes (model, history depth, advanced toggle) re-run the same
      // point's fetch to refresh its data -- without skipActivate that
      // refresh was forcing the tab to jump every time, so switching the
      // model while reading a chart, for instance, would boot you out of it.
      if (!options.skipActivate) activate(safeCount > 0 ? "loaded" : "summary");
    }

    function setSummary(html) {
      summaryPanel.innerHTML = html || '<div class="point-summary-empty">No weather summary available for this point.</div>';
    }

    function setModels(models, selected = "best_match") {
      modelSelect.innerHTML = (models || []).map((model) => `<option value="${String(model.id).replace(/"/g, "&quot;")}">${String(model.label)}</option>`).join("");
      modelSelect.value = selected;
    }

    function setCharts(nextCharts, nextContext = {}) {
      context = { ...context, ...nextContext };
      // The point bundle can now land in two waves (fast weather/AQ/marine
      // data, then archive/flood/ensemble a moment later -- see
      // openPointAt) so this can be called twice for the same point.
      // Remember what was selected so a slower second call doesn't yank the
      // dropdown back to the first option out from under someone reading a
      // chart.
      const previousValue = select.value;
      charts = (nextCharts || []).filter((chart) => chart?.series?.some((series) => series.points?.length));
      // With "all variables" enabled this list can run into the hundreds —
      // group it into <optgroup> sections (USGS Water, Weather, Air
      // quality, Marine, Archive, ...) instead of one flat unsorted list.
      const groups = new Map();
      charts.forEach((chart) => {
        const key = chart.group || "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(chart);
      });
      const optionHtml = (chart) => `<option value="${String(chart.id).replace(/"/g, "&quot;")}">${String(chart.label)}</option>`;
      select.innerHTML = [...groups.entries()].map(([group, list]) => (
        group
          ? `<optgroup label="${String(group).replace(/"/g, "&quot;")}">${list.map(optionHtml).join("")}</optgroup>`
          : list.map(optionHtml).join("")
      )).join("");
      select.classList.toggle("hidden", !charts.length);
      if (previousValue && charts.some((chart) => chart.id === previousValue)) select.value = previousValue;
      status.textContent = charts.length
        ? `${charts.length} chart views · select a variable or export the current view`
        : "No chartable values were returned for this point.";
      status.className = `point-modal-status${charts.length ? " ready" : " error"}`;
      draw();
    }

    function setError(message) {
      status.textContent = message || "Point lookup failed.";
      status.className = "point-modal-status error";
      canvas.classList.remove("show");
    }

    function exportPng() {
      const chart = currentChart();
      if (!chart || !canvas.classList.contains("show")) return;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const slug = chart.id.replace(/[^a-z0-9_-]+/gi, "-");
        download(blob, `metis-location-${slug}-${Date.now()}.png`);
      }, "image/png");
    }

    function exportCsv() {
      const chart = currentChart();
      if (!chart) return;
      const series = chart.series.filter((item) => item.points?.length);
      const times = [...new Set(series.flatMap((item) => item.points.map((point) => point.t ?? "")))]
        .sort((a, b) => Number(a) - Number(b));
      const maps = series.map((item) => new Map(item.points.map((point) => [point.t ?? "", point.v])));
      const header = [
        "timestamp", "latitude", "longitude", "model", "chart", "unit",
        ...series.map((item) => `${item.label || "value"}${item.unit ? ` [${item.unit}]` : ""}`),
      ];
      const rows = [header.map(csvCell).join(",")];
      for (const time of times) {
        rows.push([
          time === "" ? "" : new Date(Number(time)).toISOString(),
          context.lat, context.lon, context.model || "", chart.label, chart.unit || "",
          ...maps.map((values) => values.get(time) ?? ""),
        ].map(csvCell).join(","));
      }
      const slug = chart.id.replace(/[^a-z0-9_-]+/gi, "-");
      download(new Blob([`\uFEFF${rows.join("\r\n")}`], { type: "text/csv;charset=utf-8" }),
        `metis-location-${slug}-${Date.now()}.csv`);
    }

    try {
      advancedCheckbox.checked = localStorage.getItem("metis-advanced-charts") === "1";
    } catch { /* localStorage unavailable (e.g. private browsing) — default unchecked */ }
    try {
      const savedDepth = localStorage.getItem("metis-history-depth");
      if (savedDepth && [...historyDepthSelect.options].some((option) => option.value === savedDepth)) {
        historyDepthSelect.value = savedDepth;
      }
    } catch { /* default to the 30-day option already selected in markup */ }

    select.addEventListener("change", draw);
    modelSelect.addEventListener("change", () => {
      context.model = modelSelect.value;
      if (typeof onModelChange === "function") onModelChange(modelSelect.value);
    });
    historyDepthSelect.addEventListener("change", () => {
      try { localStorage.setItem("metis-history-depth", historyDepthSelect.value); } catch { /* ignore */ }
      if (typeof onHistoryDepthChange === "function") onHistoryDepthChange(Number(historyDepthSelect.value));
    });
    advancedCheckbox.addEventListener("change", () => {
      try { localStorage.setItem("metis-advanced-charts", advancedCheckbox.checked ? "1" : "0"); } catch { /* ignore */ }
      if (typeof onAdvancedChange === "function") onAdvancedChange(advancedCheckbox.checked);
    });
    tabButtons.forEach((button) => button.addEventListener("click", () => activate(button.dataset.view)));
    header.addEventListener("pointerdown", (event) => beginInteraction(event, "drag"));
    resizeHandle.addEventListener("pointerdown", (event) => beginInteraction(event, "resize"));
    window.addEventListener("pointermove", moveInteraction);
    window.addEventListener("pointerup", endInteraction);
    window.addEventListener("pointercancel", endInteraction);
    root.querySelector('[data-action="close"]').addEventListener("click", () => root.classList.remove("show"));
    root.querySelector('[data-action="png"]').addEventListener("click", exportPng);
    root.querySelector('[data-action="csv"]').addEventListener("click", exportCsv);
    root.querySelector('[data-action="expand"]').addEventListener("click", (event) => {
      const expanding = !root.classList.contains("expanded");
      if (expanding) {
        restoreBox = {
          left: root.style.left, top: root.style.top,
          width: root.style.width, height: root.style.height,
        };
      }
      root.classList.toggle("expanded", expanding);
      if (!expanding && restoreBox) Object.assign(root.style, restoreBox);
      event.currentTarget.textContent = expanding ? "RESTORE" : "EXPAND";
      requestAnimationFrame(draw);
    });
    window.addEventListener("resize", () => {
      position(context.anchor);
      if (root.classList.contains("show")) requestAnimationFrame(draw);
    });
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(() => {
        if (root.classList.contains("show")) requestAnimationFrame(draw);
      });
      observer.observe(root);
    }
    // The other in-app dialogs (confirm prompts, the API key manager) all
    // close on Escape; this one didn't, despite being the panel a user
    // interacts with most.
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && root.classList.contains("show")) root.classList.remove("show");
    });

    function setRasterReadings(html) {
      rasterPanel.innerHTML = html || "";
    }

    return {
      showLoading, setCharts, setError, setLoaded, setModels, setSummary, setRasterReadings,
      modelValue: () => modelSelect.value || "best_match",
      advancedValue: () => advancedCheckbox.checked,
      historyDepthValue: () => Number(historyDepthSelect.value) || 7,
      activate, close: () => root.classList.remove("show"), root,
    };
  }

  return { create };
})();
