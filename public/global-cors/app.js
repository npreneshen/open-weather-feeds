(() => {
  "use strict";

  const API_BASES = {
    earthquake: "https://earthquake.usgs.gov",
    volcanoes: "https://volcanoes.usgs.gov",
    swpc: "https://services.swpc.noaa.gov",
    ncei: "https://gis.ngdc.noaa.gov",
    nws: "https://api.weather.gov",
    openmeteo: "https://api.open-meteo.com",
    openmeteoAq: "https://air-quality-api.open-meteo.com",
    openmeteoMarine: "https://marine-api.open-meteo.com",
    openmeteoArchive: "https://archive-api.open-meteo.com",
    earthsearch: "https://earth-search.aws.element84.com",
  };

  async function dataApi(service, path, params = {}, opts = {}) {
    const base = API_BASES[service];
    if (!base) throw new Error(`Unknown service: ${service}`);
    const p = path.startsWith("/") ? path : `/${path}`;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null) qs.append(k, String(v));
    }
    const url = qs.toString() ? `${base}${p}?${qs}` : `${base}${p}`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json, text/plain, */*", "User-Agent": "GlobalFeedsCors/2.0" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (opts.text || (!text.trim().startsWith("{") && !text.trim().startsWith("["))) {
      return { raw: text };
    }
    return JSON.parse(text);
  }

  const GL = () => window.GlobalLayers;
  const GC = () => window.GlobalCharts;
  const OM = () => window.OpenMeteo;

  const els = {};
  [
    "feedDot", "feedLabel", "globalCount", "feedName", "layerGrid", "swpcStatus",
    "eqControls", "volControls", "fdsnControls", "quakeMag", "quakePeriod", "volcanoFilter",
    "feedInterval", "fetchFeedBtn", "startFeedBtn", "stopFeedBtn", "globalStatus",
    "minMag", "quakeDays", "customQueryBtn", "exportGeoBtn", "copyGeoBtn",
    "listCount", "listFilter", "entityList", "detailPanel", "closeDetail",
    "detailTitle", "detailBody", "chartLabel", "chartTabs", "liveChart",
    "toggleLeft", "toggleRight", "mapClickToggle", "mapHint",
    "omModel", "drawBboxBtn", "clearBboxBtn", "fetchBboxBtn", "bboxStatus",
  ].forEach((id) => { els[id] = document.getElementById(id); });

  const global = {
    enabled: new Set(["earthquakes", "volcanoes"]),
    data: new Map(),
    catalog: [],
    selected: null,
    selectedKind: null,
    spaceWeather: null,
    auroraMeta: null,
    useCustom: false,
    feedTimer: null,
    chartState: null,
    mapClickEnabled: true,
    bbox: null,
    bboxLayer: null,
    pointItem: null,
  };

  function omModel() { return OM().getSelectedModel(els.omModel); }

  const map = L.map("map", { zoomControl: true }).setView([20, 0], 2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OSM &copy; CARTO", subdomains: "abcd", maxZoom: 19,
  }).addTo(map);
  const layers = {
    markers: L.layerGroup().addTo(map),
    polygons: L.layerGroup().addTo(map),
  };

  const drawControl = new L.Control.Draw({
    draw: {
      polygon: false, polyline: false, circle: false, circlemarker: false, marker: false,
      rectangle: {
        shapeOptions: { className: "bbox-rect", color: "#74b9ff", weight: 2 },
      },
    },
    edit: { featureGroup: L.featureGroup(), edit: false, remove: false },
  });

  function initOmModelSelect() {
    els.omModel.innerHTML = OM().WEATHER_MODELS.map((m) => {
      const tag = m.bbox ? " · bbox" : "";
      return `<option value="${m.id}">${m.label}${tag}</option>`;
    }).join("");
    els.omModel.value = "ecmwf_ifs";
    els.omModel.addEventListener("change", updateBboxStatus);
  }

  function updateBboxStatus() {
    if (!global.bbox) {
      els.bboxStatus.textContent = "No bounding box drawn. Pick a bbox-capable model, draw a rectangle, then Fetch.";
      return;
    }
    const { south, west, north, east } = global.bbox;
    const model = omModel();
    const m = OM().modelById(model);
    const est = m.bbox ? OM().estimateBboxCells(global.bbox, model) : null;
    const span = `${south.toFixed(2)}°S ${west.toFixed(2)}°W → ${north.toFixed(2)}°N ${east.toFixed(2)}°E`;
    if (!m.bbox) {
      els.bboxStatus.innerHTML = `<span style="color:#fcd34d">BBox set (${span}) but <strong>${m.label}</strong> needs points — select ECMWF/ICON/GEM for grid.</span>`;
      return;
    }
    const warn = est > 1000 ? ' <span style="color:#fca5a5">Too large — shrink box.</span>' : "";
    els.bboxStatus.innerHTML = `BBox: ${span} · ~${est} cells · model <strong>${m.label}</strong>${warn}`;
  }

  function setBboxFromLayer(layer) {
    const ll = layer.getBounds();
    const sw = ll.getSouthWest();
    const ne = ll.getNorthEast();
    global.bbox = { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng };
    if (global.bboxLayer) map.removeLayer(global.bboxLayer);
    global.bboxLayer = layer;
    global.bboxLayer.addTo(map);
    updateBboxStatus();
  }

  function clearBbox() {
    global.bbox = null;
    if (global.bboxLayer) { map.removeLayer(global.bboxLayer); global.bboxLayer = null; }
    updateBboxStatus();
  }

  async function fetchBboxWeather() {
    if (!global.bbox) {
      setStatus(els.globalStatus, "Draw a bounding box on the map first.", "warn");
      return;
    }
    const model = omModel();
    const m = OM().modelById(model);
    if (!m.bbox) {
      setStatus(els.globalStatus, `${m.label} does not support bounding_box. Select ECMWF IFS, ICON Global, GEM, etc.`, "error");
      return;
    }
    const est = OM().estimateBboxCells(global.bbox, model);
    if (est > 1000) {
      setStatus(els.globalStatus, `BBox ~${est} cells exceeds Open-Meteo limit of 1000. Draw a smaller box.`, "error");
      return;
    }
    setStatus(els.globalStatus, `Fetching ~${est} grid cells (${m.label})…`, "warn");
    try {
      const items = await GL().fetchWeatherBbox(dataApi, global.bbox, model);
      global.data.set("weathergrid", items);
      global.enabled.add("weathergrid");
      setStatus(els.globalStatus, `Loaded ${items.size} grid cells from Open-Meteo bbox.`, "ok");
      refreshMap();
      renderList();
      updateLayerControls();
      map.fitBounds(global.bboxLayer.getBounds().pad(0.05));
    } catch (err) {
      setStatus(els.globalStatus, err.message, "error");
    }
  }

  function globalAllItems() {
    const items = [];
    for (const layerId of global.enabled) {
      const m = global.data.get(layerId);
      if (m) items.push(...m.values());
    }
    return items;
  }

  function toGeoJSON() {
    const features = [];
    for (const item of globalAllItems()) {
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
      const coords = item.kind === "earthquake" ? [item.lon, item.lat, item.depth] : [item.lon, item.lat];
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: coords },
        properties: { layer: item.kind, ...item, raw: undefined, forecast: undefined, geometry: undefined },
      });
    }
    return { type: "FeatureCollection", features };
  }

  function setStatus(el, msg, kind = "") {
    el.textContent = msg;
    el.className = "status" + (kind ? ` ${kind}` : "");
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtNum(v, dec = 1, unit = "") {
    if (v == null || !Number.isFinite(v)) return null;
    return `${v.toFixed(dec)}${unit ? ` ${unit}` : ""}`;
  }

  function fmtTime(ts) {
    if (!ts) return null;
    return new Date(ts).toLocaleString();
  }

  function dlRow(label, value) {
    if (value == null || value === "" || value === "—") return "";
    return `<dt>${esc(label)}</dt><dd>${value}</dd>`;
  }

  function magClass(mag) {
    if (mag == null) return "";
    if (mag >= 6) return "strong";
    if (mag >= 5) return "moderate";
    if (mag >= 4) return "light";
    if (mag >= 2.5) return "minor";
    return "";
  }

  function aqiBadgeClass(aqi) {
    if (aqi == null) return "";
    if (aqi <= 50) return "green";
    if (aqi <= 100) return "yellow";
    if (aqi <= 150) return "light";
    return "strong";
  }

  function nwsSeverityClass(sev) {
    if (/Extreme|Severe/i.test(sev || "")) return "severe";
    if (/Moderate/i.test(sev || "")) return "moderate";
    if (/Minor/i.test(sev || "")) return "minor";
    return "unknown";
  }

  const GROUP_LABELS = {
    hazards: "Hazards", atmosphere: "Atmosphere", ocean: "Ocean",
    space: "Space", imagery: "Imagery",
  };

  async function loadLayerCatalog() {
    try {
      global.catalog = await (await fetch("layers.json")).json();
    } catch {
      global.catalog = [
        { id: "earthquakes", label: "Earthquakes", provider: "USGS", default: true, group: "hazards" },
        { id: "volcanoes", label: "Volcanoes", provider: "USGS", default: true, group: "hazards" },
      ];
    }
    for (const layer of global.catalog) {
      if (layer.default) global.enabled.add(layer.id);
    }
    renderLayerGrid();
  }

  function renderLayerGrid() {
    const groups = {};
    for (const layer of global.catalog) {
      const g = layer.group || "other";
      if (!groups[g]) groups[g] = [];
      groups[g].push(layer);
    }
    const order = ["hazards", "atmosphere", "ocean", "space", "imagery", "other"];
    els.layerGrid.innerHTML = order.filter((g) => groups[g]).map((g) => {
      const items = groups[g].map((layer) => {
        const chk = global.enabled.has(layer.id) ? " checked" : "";
        const hist = layer.history ? ` <span style="color:var(--muted);font-size:.62rem">(${layer.history})</span>` : "";
        return `<label class="preset-item"><input type="checkbox" data-layer="${layer.id}"${chk}/> ${layer.label}${hist}</label>`;
      }).join("");
      return `<div class="layer-group"><div class="layer-group-title">${GROUP_LABELS[g] || g}</div>${items}</div>`;
    }).join("");

    els.layerGrid.querySelectorAll("input[data-layer]").forEach((inp) => {
      inp.addEventListener("change", () => {
        if (inp.checked) global.enabled.add(inp.dataset.layer);
        else global.enabled.delete(inp.dataset.layer);
        updateLayerControls();
        renderList();
        refreshMap();
      });
    });
    updateLayerControls();
  }

  function updateLayerControls() {
    const on = (id) => global.enabled.has(id);
    els.eqControls.classList.toggle("hidden", !on("earthquakes"));
    els.volControls.classList.toggle("hidden", !on("volcanoes"));
    els.fdsnControls.classList.toggle("hidden", !on("earthquakes"));
    document.body.classList.toggle("dataset-volcano", on("volcanoes") && !on("earthquakes"));
    document.body.classList.toggle("dataset-weather", on("weather") || on("airquality") || on("weathergrid"));
    els.globalCount.textContent = globalAllItems().length;
    els.feedName.textContent = [...global.enabled].join(", ") || "—";

    if (global.spaceWeather?.kIndex != null || global.auroraMeta) {
      const parts = [];
      const sw = global.spaceWeather;
      if (sw?.kIndex != null) {
        const band = sw.kpBand ? ` (${sw.kpBand})` : "";
        parts.push(`Kp ${fmtNum(sw.kIndex, 0)}${band}`);
        if (sw.solarWindSpeed != null) parts.push(`SW ${fmtNum(sw.solarWindSpeed, 0)} km/s`);
      }
      if (global.auroraMeta) parts.push(`Aurora: ${global.auroraMeta.observationTime || "—"}`);
      els.swpcStatus.textContent = parts.join(" · ");
      els.swpcStatus.classList.toggle("clickable", !!(sw?.kpSeries?.length));
      els.swpcStatus.title = sw?.kpSeries?.length ? "Click for space weather charts" : "";
    } else {
      els.swpcStatus.textContent = "";
      els.swpcStatus.classList.remove("clickable");
      els.swpcStatus.title = "";
    }
  }

  async function fetchGlobal(useCustom = false) {
    global.useCustom = useCustom;
    els.feedDot.classList.add("on");
    els.feedLabel.textContent = "Fetching…";
    setStatus(els.globalStatus, "Fetching global data…", "warn");
    const parts = [];
    const gl = GL();

    for (const layerId of global.enabled) {
      try {
        setStatus(els.globalStatus, `Fetching ${layerId}…`, "warn");
        let items;
        if (layerId === "earthquakes") {
          items = await gl.fetchEarthquakes(dataApi, {
            useCustom,
            mag: els.quakeMag.value,
            period: els.quakePeriod.value,
            days: parseInt(els.quakeDays.value, 10) || 1,
            minMag: parseFloat(els.minMag.value) || 0,
          });
        } else if (layerId === "volcanoes") {
          items = await gl.fetchVolcanoes(dataApi, { filter: els.volcanoFilter.value });
        } else if (layerId === "tsunami") {
          items = await gl.fetchTsunami(dataApi);
        } else if (layerId === "nwsalerts") {
          items = await gl.fetchNwsAlerts(dataApi);
        } else if (layerId === "airquality") {
          items = await gl.fetchAirQuality(dataApi);
        } else if (layerId === "weather") {
          items = await gl.fetchWeather(dataApi, { model: omModel() });
        } else if (layerId === "marine") {
          items = await gl.fetchMarine(dataApi);
        } else if (layerId === "aurora") {
          items = await gl.fetchAurora(dataApi);
          const first = items.values().next().value;
          global.auroraMeta = first
            ? { observationTime: first.observationTime, forecastTime: first.forecastTime }
            : null;
        } else if (layerId === "earthimagery") {
          items = await gl.fetchEarthImagery(dataApi);
        } else if (layerId === "spaceweather") {
          global.spaceWeather = await gl.fetchSpaceWeather(dataApi);
          parts.push(`K=${global.spaceWeather.kIndex ?? "?"}`);
          updateLayerControls();
          continue;
        } else continue;
        global.data.set(layerId, items);
        parts.push(`${items.size} ${layerId}`);
      } catch (err) {
        if (global.enabled.size === 1) throw err;
        console.warn(`${layerId} failed:`, err.message);
        parts.push(`${layerId}: ${err.message}`);
      }
    }
    setStatus(els.globalStatus, parts.length ? `Loaded ${parts.join(", ")}.` : "No layers enabled.", "ok");
    els.feedLabel.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    updateLayerControls();
    refreshMap();
    renderList();
  }

  function volcanoAlertClass(v) {
    if (/RED|WARNING/i.test(v.colorCode || "") || /WARNING/i.test(v.alertLevel || "")) return "red";
    if (/ORANGE|WATCH/i.test(v.colorCode || "") || /WATCH/i.test(v.alertLevel || "")) return "orange";
    if (/YELLOW|ADVISORY/i.test(v.colorCode || "") || /ADVISORY/i.test(v.alertLevel || "")) return "yellow";
    if (/GREEN|NORMAL/i.test(v.colorCode || "") || /NORMAL/i.test(v.alertLevel || "")) return "green";
    return "gray";
  }

  function volcanoColor(v) {
    const cls = volcanoAlertClass(v);
    return { red: "#dc2626", orange: "#ea580c", yellow: "#ca8a04", green: "#16a34a", gray: "#64748b" }[cls];
  }

  function isElevatedVolcano(v) { return GL().isElevatedVolcano(v); }

  function globalMarkerSvg(kind, item, sel) {
    const size = sel ? 22 : 14;
    const palette = {
      tsunami: "#74b9ff", aurora: "#dfe6e9", earthimagery: "#b2bec3", nwsalert: "#f59e0b",
    };
    const fill = sel ? "#fff" : (palette[kind] || "#94a3b8");

    if (kind === "airquality") {
      const ac = aqiBadgeClass(item.aqi);
      const aqFill = sel ? "#fff" : ({ green: "#16a34a", yellow: "#ca8a04", light: "#ea580c", strong: "#dc2626" }[ac] || "#81ecec");
      const label = item.aqi != null ? Math.round(item.aqi) : "?";
      const fg = sel ? "#0c1219" : "#fff";
      const fs = Math.max(7, Math.round(size * 0.48));
      return `<div class="g-marker aq" style="width:${size}px;height:${size}px;background:${aqFill};color:${fg};font-size:${fs}px">${label}</div>`;
    }
    if (kind === "weather") {
      const t = item.temp;
      const label = t != null ? `${Math.round(t)}°` : "?";
      const fg = sel ? "#0c1219" : "#fff";
      const bg = sel ? "#fff" : "#2563eb";
      const fs = Math.max(6, Math.round(size * 0.42));
      return `<div class="g-marker wx" style="width:${size}px;height:${size}px;background:${bg};color:${fg};font-size:${fs}px">${label}</div>`;
    }
    if (kind === "marine") {
      const h = item.waveHeight;
      const label = h != null ? `${h.toFixed(1)}` : "?";
      const fg = sel ? "#0c1219" : "#fff";
      const bg = sel ? "#fff" : "#0369a1";
      const fs = Math.max(6, Math.round(size * 0.4));
      return `<div class="g-marker marine" style="width:${size}px;height:${size}px;background:${bg};color:${fg};font-size:${fs}px">${label}</div>`;
    }
    if (kind === "tsunami") {
      return `<div class="g-marker" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M2 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0 2-2 4 0" fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round"/><path d="M2 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0 2-2 4 0" fill="none" stroke="${fill}" stroke-width="1.5" stroke-linecap="round" opacity=".7"/></svg></div>`;
    }
    if (kind === "aurora") {
      return `<div class="g-marker" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M6 18 Q12 4 18 18" fill="none" stroke="${fill}" stroke-width="2"/><path d="M8 18 Q12 8 16 18" fill="none" stroke="#a29bfe" stroke-width="1.5" opacity=".8"/></svg></div>`;
    }
    if (kind === "earthimagery") {
      return `<div class="g-marker" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${size}" height="${size}"><rect x="5" y="8" width="14" height="9" rx="1.5" fill="${fill}" stroke="#fff" stroke-width="1"/><path d="M8 6 L12 3 L16 6" fill="none" stroke="${fill}" stroke-width="1.5"/><circle cx="16" cy="11" r="1.5" fill="#74b9ff"/></svg></div>`;
    }
    if (kind === "nwsalert") {
      return `<div class="g-marker" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 3 L3 20h18Z" fill="${fill}" stroke="#fff" stroke-width="1.2"/><text x="12" y="17" text-anchor="middle" fill="#0c1219" font-size="9" font-weight="700">!</text></svg></div>`;
    }
    return `<div class="g-marker" style="width:${size}px;height:${size}px;border-radius:50%;background:${fill};border:2px solid #fff"></div>`;
  }

  function makeGlobalDivIcon(item, sel) {
    const size = sel ? 22 : 14;
    return L.divIcon({
      className: "g-marker-icon",
      html: globalMarkerSvg(item.kind, item, sel),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function makeVolcanoIcon(v, sel) {
    const color = sel ? "#fff" : volcanoColor(v);
    const r = isElevatedVolcano(v) ? 10 : 7;
    return L.divIcon({
      className: "",
      html: `<div style="width:0;height:0;border-left:${r}px solid transparent;border-right:${r}px solid transparent;border-bottom:${r * 1.6}px solid ${color};filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))"></div>`,
      iconSize: [r * 2, r * 1.6], iconAnchor: [r, r * 1.6],
    });
  }

  function makeQuakeIcon(e, sel) {
    const mag = e.mag ?? 0;
    const r = Math.min(18, Math.max(6, mag * 3));
    const colors = { strong: "#7f1d1d", moderate: "#dc2626", light: "#ea580c", minor: "#ca8a04" };
    const cls = magClass(mag);
    const color = sel ? "#fff" : (colors[cls] || "#94a3b8");
    return L.divIcon({
      className: "",
      html: `<div style="width:${r * 2}px;height:${r * 2}px;border-radius:50%;background:${color};border:2px solid #fff;opacity:.9;box-shadow:0 0 ${sel ? 12 : 6}px ${color}"></div>`,
      iconSize: [r * 2, r * 2], iconAnchor: [r, r],
    });
  }

  function makeGlobalIcon(item, sel) {
    if (item.kind === "earthquake") return makeQuakeIcon(item, sel);
    if (item.kind === "volcano") return makeVolcanoIcon(item, sel);
    if (item.kind === "weathergrid") return makeGlobalDivIcon({ ...item, kind: "weather" }, sel);
    return makeGlobalDivIcon(item, sel);
  }

  function getGlobalItem(id) {
    for (const m of global.data.values()) {
      if (m.has(id)) return m.get(id);
    }
    return null;
  }

  function refreshPolygons() {
    layers.polygons.clearLayers();
    if (!global.enabled.has("nwsalerts")) return;
    const alerts = global.data.get("nwsalerts");
    if (!alerts) return;
    for (const item of alerts.values()) {
      const geom = item.geometry;
      if (!geom) continue;
      const cls = nwsSeverityClass(item.severity);
      const style = { className: `nws-polygon ${cls}` };
      let layer;
      if (geom.type === "Polygon") {
        const latlngs = geom.coordinates[0].map((c) => [c[1], c[0]]);
        layer = L.polygon(latlngs, style);
      } else if (geom.type === "MultiPolygon") {
        const latlngs = geom.coordinates.map((poly) => poly[0].map((c) => [c[1], c[0]]));
        layer = L.polygon(latlngs, style);
      }
      if (layer) {
        layer.on("click", () => showGlobalDetail(item));
        layers.polygons.addLayer(layer);
      }
    }
  }

  function refreshMap() {
    layers.markers.clearLayers();
    refreshPolygons();
    const bounds = map.getBounds().pad(0.1);
    for (const item of globalAllItems()) {
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
      if (!bounds.contains([item.lat, item.lon])) continue;
      const sel = global.selected === item.id && global.selectedKind === item.kind;
      const m = L.marker([item.lat, item.lon], {
        icon: makeGlobalIcon(item, sel), zIndexOffset: sel ? 1000 : 0,
      });
      m.on("click", () => showGlobalDetail(item));
      layers.markers.addLayer(m);
    }
  }

  map.on("moveend", refreshMap);

  function renderList() {
    const filter = (els.listFilter.value || "").toLowerCase();
    let items = globalAllItems();
    items.sort((a, b) => (b.time || 0) - (a.time || 0) || (a.name || a.title || "").localeCompare(b.name || b.title || ""));
    if (filter) items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(filter));
    els.listCount.textContent = items.length;

    els.entityList.innerHTML = items.map((item) => {
      const active = global.selected === item.id && global.selectedKind === item.kind ? " active" : "";
      if (item.kind === "volcano") {
        const ac = volcanoAlertClass(item);
        const status = item.alertLevel ? `${item.colorCode || ""}/${item.alertLevel}` : "unmonitored";
        return `<div class="list-item${active}" data-id="${item.id}" data-kind="volcano">
          <div class="dot"></div>
          <div><div class="name">${esc(item.name)} <span style="color:var(--muted);font-weight:400">(${esc(item.country)})</span></div>
          <div class="meta"><span class="badge alert-badge ${ac}">${esc(status)}</span>
          ${item.elevation != null ? `${item.elevation} m` : ""}</div></div></div>`;
      }
      if (item.kind === "earthquake") {
        const mc = magClass(item.mag);
        return `<div class="list-item${active}" data-id="${item.id}" data-kind="earthquake">
          <div class="dot"></div>
          <div><div class="name">M${item.mag?.toFixed(1) ?? "?"} — ${esc(item.place || item.title)}</div>
          <div class="meta"><span class="badge mag-badge ${mc}">M${item.mag?.toFixed(1) ?? "?"}</span>
          ${item.time ? new Date(item.time).toLocaleString() : ""}</div></div></div>`;
      }
      if (item.kind === "weather" || item.kind === "weathergrid") {
        const modelTag = item.model ? ` · ${item.model}` : "";
        return `<div class="list-item${active}" data-id="${item.id}" data-kind="${item.kind}">
          <div class="list-icon">${globalMarkerSvg("weather", item, false)}</div>
          <div><div class="name">${esc(item.name)}</div>
          <div class="meta"><span class="badge wx-badge">${item.temp != null ? `${item.temp.toFixed(1)}°C` : "—"}</span>
          ${GL().weatherLabel(item.weatherCode)} · ${item.wind ?? "—"} km/h${modelTag}</div></div></div>`;
      }
      if (item.kind === "marine") {
        return `<div class="list-item${active}" data-id="${item.id}" data-kind="marine">
          <div class="list-icon">${globalMarkerSvg("marine", item, false)}</div>
          <div><div class="name">${esc(item.name)}</div>
          <div class="meta"><span class="badge marine-badge">${item.waveHeight != null ? `${item.waveHeight.toFixed(1)} m` : "—"}</span>
          ${item.wavePeriod != null ? `${item.wavePeriod.toFixed(0)}s period` : ""}
          · SST ${item.sst != null ? `${item.sst.toFixed(1)}°C` : "—"}</div></div></div>`;
      }
      if (item.kind === "airquality") {
        return `<div class="list-item${active}" data-id="${item.id}" data-kind="airquality">
          <div class="list-icon">${globalMarkerSvg("airquality", item, false)}</div>
          <div><div class="name">${esc(item.name)}</div>
          <div class="meta"><span class="badge">AQI ${item.aqi ?? "—"}</span>
          ${item.pm25 != null ? `PM2.5 ${item.pm25}` : ""}
          ${item.ozone != null ? `· O₃ ${item.ozone}` : ""}</div></div></div>`;
      }
      if (item.kind === "nwsalert") {
        return `<div class="list-item${active}" data-id="${item.id}" data-kind="nwsalert">
          <div class="list-icon">${globalMarkerSvg("nwsalert", item, false)}</div>
          <div><div class="name">${esc(item.name)}</div>
          <div class="meta"><span class="badge alert-badge ${nwsSeverityClass(item.severity)}">${esc(item.event || "Alert")}</span>
          ${esc(item.severity || "")}</div></div></div>`;
      }
      if (item.kind === "tsunami" || item.kind === "aurora" || item.kind === "earthimagery" || item.kind === "pointlookup") {
        return `<div class="list-item${active}" data-id="${item.id}" data-kind="${item.kind}">
          <div class="list-icon">${globalMarkerSvg(item.kind === "pointlookup" ? "weather" : item.kind, item, false)}</div>
          <div><div class="name">${esc(item.name)}</div>
          <div class="meta"><span class="badge">${esc(item.kind)}</span></div></div></div>`;
      }
      return `<div class="list-item${active}" data-id="${item.id}" data-kind="${item.kind}">
        <div class="dot"></div>
        <div><div class="name">${esc(item.name || item.title || item.id)}</div>
        <div class="meta"><span class="badge">${esc(item.kind)}</span></div></div></div>`;
    }).join("") || `<div style="padding:.75rem;color:var(--muted);font-size:.78rem">No data — fetch to populate.</div>`;

    els.entityList.querySelectorAll(".list-item").forEach((el) => {
      el.addEventListener("click", () => {
        const item = getGlobalItem(el.dataset.id) || (global.selectedKind === "pointlookup" && global.selected === el.dataset.id ? global.pointItem : null);
        if (item) {
          if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
            map.setView([item.lat, item.lon], Math.max(map.getZoom(), 6));
          }
          showGlobalDetail(item);
        }
      });
    });
  }

  function hideChart() {
    els.liveChart.classList.add("hidden");
    els.chartLabel.classList.remove("show");
    els.chartLabel.textContent = "";
    els.chartTabs.classList.add("hidden");
    els.chartTabs.innerHTML = "";
    global.chartState = null;
  }

  function showChartTabs(tabs, activeId) {
    if (!tabs?.length) { els.chartTabs.classList.add("hidden"); return; }
    els.chartTabs.classList.remove("hidden");
    els.chartTabs.innerHTML = tabs.map((t) =>
      `<button type="button" data-chart="${t.id}" class="${t.id === activeId ? "active" : ""}">${esc(t.label)}</button>`
    ).join("");
    els.chartTabs.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = tabs.find((t) => t.id === btn.dataset.chart);
        if (tab) renderChartTab(tab, tabs);
      });
    });
  }

  function renderChartTab(tab, tabs) {
    global.chartState = { tabs, activeId: tab.id };
    els.chartLabel.textContent = tab.label || "";
    els.chartLabel.classList.add("show");
    els.liveChart.classList.remove("hidden");
    GC().draw(els.liveChart, tab.series, { unit: tab.unit, legend: tab.series?.length > 1 });
    els.chartTabs.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.chart === tab.id);
    });
  }

  function showMultiChart(tabs, activeId) {
    if (!tabs?.length) { hideChart(); return; }
    const first = tabs.find((t) => t.id === activeId) || tabs[0];
    showChartTabs(tabs, first.id);
    renderChartTab(first, tabs);
  }

  async function loadGlobalHistory(item) {
    const gl = GL();
    const gc = GC();
    const om = OM();
    const model = item.model || omModel();
    try {
      if (item.kind === "airquality") {
        const data = await gl.fetchAirQualityFull(dataApi, item.lat, item.lon);
        const tabs = om.buildAirQualityCharts(data, gc);
        if (tabs.length) { showMultiChart(tabs, "aqi"); return; }
      }
      if (["weather", "pointlookup", "weathergrid"].includes(item.kind)) {
        const [wx, archive, aq, marine] = await Promise.all([
          gl.fetchWeatherFull(dataApi, item.lat, item.lon, { forecastDays: 16, pastDays: 7, model }),
          gl.fetchWeatherArchive(dataApi, item.lat, item.lon, 30).catch(() => null),
          gl.fetchAirQualityFull(dataApi, item.lat, item.lon).catch(() => null),
          gl.fetchMarineFull(dataApi, item.lat, item.lon).catch(() => null),
        ]);
        const tabs = om.buildAllCharts(wx, archive, aq, marine, gc);
        if (tabs.length) { showMultiChart(tabs, "temp"); return; }
      }
      if (item.kind === "marine") {
        const marine = item.forecast?.hourly
          ? item.forecast
          : await gl.fetchMarineFull(dataApi, item.lat, item.lon).catch(() => null);
        const tabs = om.buildMarineCharts(marine, gc);
        if (tabs.length) { showMultiChart(tabs, "waves"); return; }
      }
      if (item.kind === "earthquake") {
        const regional = await gl.fetchRegionalQuakes(dataApi, item.lat, item.lon, { days: 30, radiusKm: 150 });
        const points = regional
          .filter((q) => q.mag != null && q.time)
          .map((q) => ({ t: q.time, v: q.mag }));
        if (points.length) {
          showMultiChart([{
            id: "regional", label: `Regional quakes (150 km, 30d) — ${points.length} events`,
            unit: "Magnitude",
            series: [{ label: "Magnitude", points, color: "#e17055" }],
          }], "regional");
          return;
        }
      }
    } catch (err) {
      console.warn("History fetch failed:", err.message);
    }
    hideChart();
  }

  function showQuakeDetail(e) {
    global.selected = e.id;
    global.selectedKind = "earthquake";
    els.detailTitle.textContent = e.title || `M${e.mag} — ${e.place}`;
    els.detailBody.innerHTML = `
      <div class="detail-section">
        <div class="detail-section-title">Earthquake</div>
        <dl>
          <dt>Magnitude</dt><dd>M${e.mag?.toFixed(1) ?? "?"}</dd>
          <dt>Depth</dt><dd>${e.depth != null ? `${e.depth} km` : "—"}</dd>
          <dt>Time</dt><dd>${e.time ? new Date(e.time).toLocaleString() : "—"}</dd>
          <dt>Place</dt><dd>${esc(e.place)}</dd>
          <dt>Alert</dt><dd>${esc(e.alert || "—")}</dd>
          <dt>Tsunami</dt><dd>${e.tsunami ? "Possible" : "No"}</dd>
        </dl>
        ${e.url ? `<p class="ext-link"><a href="${esc(e.url)}" target="_blank" rel="noopener">USGS event page ↗</a></p>` : ""}
      </div>`;
    els.detailPanel.classList.add("show");
    refreshMap();
    renderList();
    loadGlobalHistory(e);
  }

  function showVolcanoDetail(v) {
    global.selected = v.id;
    global.selectedKind = "volcano";
    const status = v.alertLevel ? `${v.colorCode || ""} / ${v.alertLevel}` : "Unmonitored";
    els.detailTitle.textContent = v.name;
    els.detailBody.innerHTML = `
      <div class="detail-section">
        <div class="detail-section-title">Volcano</div>
        <dl>
          <dt>VNUM</dt><dd>${esc(v.vnum)}</dd>
          <dt>Country</dt><dd>${esc(v.country)}</dd>
          <dt>Region</dt><dd>${esc(v.region)}</dd>
          <dt>Elevation</dt><dd>${v.elevation != null ? `${v.elevation} m` : "—"}</dd>
          <dt>Alert status</dt><dd>${esc(status)}</dd>
          ${v.threat ? `<dt>Threat</dt><dd>${esc(v.threat)}</dd>` : ""}
          <dt>Location</dt><dd>${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}</dd>
        </dl>
        ${v.synopsis ? `<div class="detail-section"><div class="detail-section-title">Notice</div><p class="detail-desc">${esc(v.synopsis)}</p></div>` : ""}
        ${v.url ? `<p class="ext-link"><a href="${esc(v.url)}" target="_blank" rel="noopener">Volcano info ↗</a></p>` : ""}
      </div>`;
    hideChart();
    els.detailPanel.classList.add("show");
    refreshMap();
    renderList();
  }

  function showSpaceWeatherDetail() {
    const sw = global.spaceWeather;
    if (!sw) return;
    global.selected = "spaceweather";
    global.selectedKind = "spaceweather";
    els.detailTitle.textContent = "Space weather";
    els.detailBody.innerHTML = `<div class="detail-section"><div class="detail-section-title">Current conditions</div><dl>
      ${dlRow("Planetary Kp", fmtNum(sw.kIndex, 0))}
      ${dlRow("Kp band", esc(sw.kpBand))}
      ${dlRow("3-hour Kp", fmtNum(sw.kp3h, 2))}
      ${dlRow("A-index", fmtNum(sw.aIndex, 0))}
      ${dlRow("Solar wind", sw.solarWindSpeed != null ? `${sw.solarWindSpeed.toFixed(0)} km/s` : null)}
      ${dlRow("Source", esc(sw.source))}
      ${dlRow("Updated", esc(sw.time))}
    </dl></div>`;
    els.detailPanel.classList.add("show");
    refreshMap();
    renderList();

    const tabs = [];
    if (sw.kpSeries?.length) tabs.push({ id: "kp3h", label: "Kp (3-hour, ~3 days)", unit: "Kp", series: [{ label: "Kp", points: sw.kpSeries, color: "#a78bfa" }] });
    if (sw.kp1mSeries?.length) tabs.push({ id: "kp1m", label: "Kp (1-minute)", unit: "Kp", series: [{ label: "Kp", points: sw.kp1mSeries, color: "#c084fc" }] });
    if (sw.windSeries?.length) tabs.push({ id: "wind", label: "Solar wind speed (24h)", unit: "km/s", series: [{ label: "Wind", points: sw.windSeries, color: "#38bdf8" }] });
    if (sw.xraySeries?.length) tabs.push({ id: "xray", label: "GOES X-ray flux (6h)", unit: "W/m²", series: [{ label: "Flux", points: sw.xraySeries, color: "#fbbf24" }] });
    showMultiChart(tabs, "kp3h");
  }

  function showGlobalDetail(item) {
    if (item.kind === "earthquake") return showQuakeDetail(item);
    if (item.kind === "volcano") return showVolcanoDetail(item);
    global.selected = item.id;
    global.selectedKind = item.kind;
    els.detailTitle.textContent = item.name || item.title || item.id;
    let body = "";

    if (item.kind === "weather" || item.kind === "pointlookup" || item.kind === "weathergrid") {
      const wxLabel = GL().weatherLabel(item.weatherCode ?? item.forecast?.current?.weather_code);
      const modelRow = item.model ? dlRow("Model", esc(item.model)) : dlRow("Model", esc(omModel()));
      body = `<div class="detail-section"><div class="detail-section-title">Weather (Open-Meteo)</div><dl>
        ${dlRow("Location", item.name || `${item.lat.toFixed(4)}, ${item.lon.toFixed(4)}`)}
        ${modelRow}
        ${item.elevation != null ? dlRow("Elevation", `${item.elevation} m`) : ""}
        ${dlRow("Conditions", wxLabel)}
        ${dlRow("Temperature", item.temp != null ? `${item.temp.toFixed(1)} °C` : null)}
        ${dlRow("Feels like", item.feelsLike != null ? `${item.feelsLike.toFixed(1)} °C` : null)}
        ${dlRow("Humidity", item.humidity != null ? `${item.humidity}%` : null)}
        ${dlRow("Dew point", item.dewPoint != null ? `${item.dewPoint.toFixed(1)} °C` : null)}
        ${dlRow("Pressure", item.pressure != null ? `${item.pressure.toFixed(0)} hPa` : null)}
        ${dlRow("Cloud cover", item.cloud != null ? `${item.cloud}%` : null)}
        ${dlRow("Wind", item.wind != null ? `${item.wind} km/h` : null)}
        ${dlRow("Gusts", item.gusts != null ? `${item.gusts} km/h` : null)}
        ${dlRow("Precipitation", item.precip != null ? `${item.precip} mm` : null)}
        ${dlRow("US AQI", item.aqi != null ? String(item.aqi) : null)}
        ${dlRow("EU AQI", item.euAqi != null ? String(item.euAqi) : null)}
        ${dlRow("PM2.5", item.pm25 != null ? `${item.pm25} µg/m³` : null)}
        ${dlRow("O₃", item.ozone != null ? `${item.ozone} µg/m³` : null)}
        ${dlRow("UV index", item.uv != null ? String(item.uv) : null)}
        ${dlRow("Updated", fmtTime(item.time))}
      </dl>
      <p class="card-hint" style="margin:.35rem 0 0;font-size:.68rem">Charts: hourly, 15-min, pressure levels, solar, soil, daily, archive, AQ, marine…</p>
      </div>`;
    } else if (item.kind === "marine") {
      body = `<div class="detail-section"><div class="detail-section-title">Marine (Open-Meteo)</div><dl>
        ${dlRow("Location", esc(item.name))}
        ${dlRow("Wave height", item.waveHeight != null ? `${item.waveHeight.toFixed(2)} m` : null)}
        ${dlRow("Wave period", item.wavePeriod != null ? `${item.wavePeriod.toFixed(1)} s` : null)}
        ${dlRow("Wave direction", item.waveDir != null ? `${item.waveDir}°` : null)}
        ${dlRow("Sea surface temp", item.sst != null ? `${item.sst.toFixed(1)} °C` : null)}
        ${dlRow("Current", item.current != null ? `${item.current} km/h` : null)}
        ${dlRow("Updated", fmtTime(item.time))}
      </dl>
      <p class="card-hint" style="margin:.35rem 0 0;font-size:.68rem">Charts: waves, swell, period, SST, current</p>
      </div>`;
    } else if (item.kind === "airquality") {
      body = `<div class="detail-section"><div class="detail-section-title">Air quality (Open-Meteo)</div><dl>
        ${dlRow("City", esc(item.name))}
        ${dlRow("US AQI", item.aqi != null ? String(item.aqi) : null)}
        ${dlRow("EU AQI", item.euAqi != null ? String(item.euAqi) : null)}
        ${dlRow("PM2.5", item.pm25 != null ? `${item.pm25} µg/m³` : null)}
        ${dlRow("PM10", item.pm10 != null ? `${item.pm10} µg/m³` : null)}
        ${dlRow("O₃", item.ozone != null ? `${item.ozone} µg/m³` : null)}
        ${dlRow("NO₂", item.no2 != null ? `${item.no2} µg/m³` : null)}
        ${dlRow("UV index", item.uv != null ? String(item.uv) : null)}
        ${dlRow("Updated", fmtTime(item.time))}
        ${dlRow("Location", `${item.lat.toFixed(4)}, ${item.lon.toFixed(4)}`)}
      </dl>
      <p class="card-hint" style="margin:.35rem 0 0;font-size:.68rem">Charts: AQI, particulates, gases, UV</p>
      </div>`;
    } else if (item.kind === "nwsalert") {
      body = `<div class="detail-section"><div class="detail-section-title">NWS alert</div><dl>
        ${dlRow("Event", esc(item.event))}
        ${dlRow("Severity", esc(item.severity))}
        ${dlRow("Urgency", esc(item.urgency))}
        ${dlRow("Area", esc(item.area))}
        ${dlRow("Sent", fmtTime(item.time))}
        ${dlRow("Expires", fmtTime(item.expires))}
        ${dlRow("Sender", esc(item.sender))}
      </dl>
      ${item.description ? `<div class="detail-section"><div class="detail-section-title">Description</div><p class="detail-desc">${esc(item.description)}</p></div>` : ""}
      </div>`;
      hideChart();
    } else if (item.kind === "tsunami") {
      body = `<div class="detail-section"><div class="detail-section-title">Tsunami</div><dl>
        ${dlRow("Name", esc(item.name))}
        ${dlRow("Year", item.year)}
        ${dlRow("Intensity", esc(item.intensity))}
        ${dlRow("Cause", esc(item.cause))}
        ${dlRow("Source", esc(item.source))}
        ${dlRow("Active alert", item.active ? "Yes" : null)}
        ${dlRow("Location", `${item.lat.toFixed(4)}, ${item.lon.toFixed(4)}`)}
      </dl></div>`;
      hideChart();
    } else if (item.kind === "aurora") {
      body = `<div class="detail-section"><div class="detail-section-title">Aurora forecast (OVATION)</div><dl>
        ${dlRow("Probability", `${item.probability}%`)}
        ${dlRow("Observation", esc(item.observationTime))}
        ${dlRow("Forecast", esc(item.forecastTime))}
        ${dlRow("Location", `${item.lat.toFixed(2)}, ${item.lon.toFixed(2)}`)}
      </dl></div>`;
      hideChart();
    } else if (item.kind === "earthimagery") {
      body = `<div class="detail-section"><div class="detail-section-title">Satellite scene (STAC)</div><dl>
        ${dlRow("Scene ID", esc(item.raw?.id || item.id))}
        ${dlRow("Collection", esc(item.collection))}
        ${dlRow("Platform", esc(item.platform || item.name))}
        ${dlRow("Datetime", esc(item.datetime))}
        ${dlRow("Cloud cover", item.cloudCover != null ? `${item.cloudCover}%` : null)}
        ${dlRow("Centroid", `${item.lat.toFixed(4)}, ${item.lon.toFixed(4)}`)}
      </dl></div>`;
      hideChart();
    }

    els.detailBody.innerHTML = body;
    els.detailPanel.classList.add("show");
    refreshMap();
    renderList();
    if (["airquality", "weather", "marine", "pointlookup", "weathergrid"].includes(item.kind)) {
      loadGlobalHistory(item);
    }
  }

  async function handleMapClick(e) {
    if (!global.mapClickEnabled) return;
    const { lat, lng: lon } = e.latlng;
    setStatus(els.globalStatus, `Looking up ${lat.toFixed(2)}, ${lon.toFixed(2)}…`, "warn");
    try {
      const data = await GL().fetchPointWeather(dataApi, lat, lon, { model: omModel() });
      const om = OM();
      const wx = om.summarizeCurrent(data.weather?.current);
      const aq = om.summarizeAq(data.airQuality?.current);
      const mcur = data.marine?.current || {};
      const item = {
        kind: "pointlookup",
        id: `point-${lat.toFixed(3)}-${lon.toFixed(3)}`,
        name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
        lat, lon,
        model: data.model || omModel(),
        ...wx, ...aq,
        waveHeight: mcur.wave_height,
        wavePeriod: mcur.wave_period,
        sst: mcur.sea_surface_temperature,
        time: wx.time || Date.now(),
        forecast: data.weather,
        raw: data,
      };
      global.pointItem = item;
      showGlobalDetail(item);
      setStatus(els.globalStatus, "Open-Meteo lookup loaded (weather + AQ + marine).", "ok");
    } catch (err) {
      setStatus(els.globalStatus, `Lookup failed: ${err.message}`, "error");
    }
  }

  function closeDetail() {
    els.detailPanel.classList.remove("show");
    hideChart();
    global.selected = null;
    global.selectedKind = null;
    refreshMap();
    renderList();
  }

  function exportGeoJSON() {
    const geo = toGeoJSON();
    const blob = new Blob([JSON.stringify(geo, null, 2)], { type: "application/geo+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `global-feeds-${Date.now()}.geojson`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function copyGeoJSON() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(toGeoJSON(), null, 2));
      setStatus(els.globalStatus, "GeoJSON copied to clipboard.", "ok");
    } catch {
      setStatus(els.globalStatus, "Clipboard failed — use Export.", "error");
    }
  }

  function startFeedPoll() {
    stopFeedPoll();
    const sec = Math.max(30, parseInt(els.feedInterval.value, 10) || 60);
    els.startFeedBtn.disabled = true;
    els.stopFeedBtn.disabled = false;
    els.feedDot.classList.add("on");
    const tick = () => fetchGlobal().catch((e) => setStatus(els.globalStatus, e.message, "error"));
    tick();
    global.feedTimer = setInterval(tick, sec * 1000);
  }

  function stopFeedPoll() {
    if (global.feedTimer) clearInterval(global.feedTimer);
    global.feedTimer = null;
    els.startFeedBtn.disabled = false;
    els.stopFeedBtn.disabled = true;
    if (!globalAllItems().length) { els.feedDot.classList.remove("on"); els.feedLabel.textContent = "Idle"; }
  }

  function toggleSidebar(side) {
    document.body.classList.toggle(`${side}-collapsed`);
    localStorage.setItem(`global-${side}-collapsed`, document.body.classList.contains(`${side}-collapsed`));
    setTimeout(() => map.invalidateSize(), 250);
  }

  els.fetchFeedBtn.addEventListener("click", () => fetchGlobal().catch((e) => setStatus(els.globalStatus, e.message, "error")));
  els.startFeedBtn.addEventListener("click", startFeedPoll);
  els.stopFeedBtn.addEventListener("click", stopFeedPoll);
  els.volcanoFilter.addEventListener("change", () => {
    if (global.enabled.has("volcanoes")) {
      fetchGlobal().catch((e) => setStatus(els.globalStatus, e.message, "error"));
    }
  });
  els.customQueryBtn.addEventListener("click", () => {
    global.enabled.add("earthquakes");
    const inp = els.layerGrid?.querySelector('input[data-layer="earthquakes"]');
    if (inp) inp.checked = true;
    updateLayerControls();
    fetchGlobal(true).catch((e) => setStatus(els.globalStatus, e.message, "error"));
  });
  els.exportGeoBtn.addEventListener("click", exportGeoJSON);
  els.copyGeoBtn.addEventListener("click", copyGeoJSON);
  els.closeDetail.addEventListener("click", closeDetail);
  els.swpcStatus.addEventListener("click", () => {
    if (global.spaceWeather?.kpSeries?.length) showSpaceWeatherDetail();
  });
  els.listFilter.addEventListener("input", renderList);
  els.toggleLeft.addEventListener("click", () => toggleSidebar("left"));
  els.toggleRight.addEventListener("click", () => toggleSidebar("right"));
  els.mapClickToggle.addEventListener("change", () => {
    global.mapClickEnabled = els.mapClickToggle.checked;
    els.mapHint.style.display = global.mapClickEnabled ? "" : "none";
  });
  els.drawBboxBtn.addEventListener("click", () => {
    new L.Draw.Rectangle(map, drawControl.options.draw.rectangle).enable();
  });
  els.clearBboxBtn.addEventListener("click", () => {
    clearBbox();
    global.data.delete("weathergrid");
    global.enabled.delete("weathergrid");
    refreshMap();
    renderList();
    updateLayerControls();
  });
  els.fetchBboxBtn.addEventListener("click", () => fetchBboxWeather());
  map.on(L.Draw.Event.CREATED, (e) => {
    if (e.layerType === "rectangle") setBboxFromLayer(e.layer);
  });
  map.on("click", handleMapClick);

  window.addEventListener("resize", () => {
    if (global.chartState) {
      const tab = global.chartState.tabs.find((t) => t.id === global.chartState.activeId);
      if (tab) renderChartTab(tab, global.chartState.tabs);
    }
  });

  (async () => {
    initOmModelSelect();
    await loadLayerCatalog();
    if (localStorage.getItem("global-left-collapsed") === "true") document.body.classList.add("left-collapsed");
    if (localStorage.getItem("global-right-collapsed") === "true") document.body.classList.add("right-collapsed");
  })();
})();
