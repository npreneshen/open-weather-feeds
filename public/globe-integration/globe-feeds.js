/* Globe Live Feeds — earthquakes, weather, marine, bbox, Ocean Pro point popup */
window.GlobeFeeds = function (api) {
  "use strict";
  if (!api?.projection || !api?.gLabels) {
    console.warn("[GlobeFeeds] GlobeAPI not ready");
    return;
  }

  const GL = () => window.GlobalLayers;
  const GC = () => window.GlobalCharts;
  const OM = () => window.OpenMeteo;
  const sampleAt = window.sampleAt;
  const extractSlice = window.extractSlice;

  const API_BASES = {
    earthquake: "https://earthquake.usgs.gov",
    volcanoes: "https://volcanoes.usgs.gov",
    openmeteo: "https://api.open-meteo.com",
    openmeteoAq: "https://air-quality-api.open-meteo.com",
    openmeteoMarine: "https://marine-api.open-meteo.com",
    openmeteoArchive: "https://archive-api.open-meteo.com",
  };

  async function dataApi(service, path, params = {}) {
    const base = API_BASES[service];
    if (!base) throw new Error(`Unknown service: ${service}`);
    const p = path.startsWith("/") ? path : `/${path}`;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null) qs.append(k, String(v));
    }
    const url = qs.toString() ? `${base}${p}?${qs}` : `${base}${p}`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "GlobeFeeds/1.0" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  const feed = {
    enabled: new Set(),
    data: new Map(),
    model: "ecmwf_ifs",
    quakeMag: "2.5",
    quakePeriod: "week",
    pointClick: true,
    bbox: null,
    bboxPick: null,
    loading: false,
    selected: null,
    timer: null,
  };

  const KIND_COLOR = {
    earthquake: "#ff6b4a",
    weather: "#7fd0ff",
    marine: "#38e0a0",
    weathergrid: "#c4b5fd",
    pointlookup: "#ffd27f",
  };

  const gFeed = api.A.el("g", { id: "gf-markers" }, api.gLabels);
  gFeed.style.pointerEvents = "auto";
  const gBbox = api.A.el("path", {
    fill: "rgba(127,208,255,0.08)",
    stroke: "rgba(127,208,255,0.75)",
    "stroke-width": 1.4,
    "stroke-dasharray": "6 4",
    display: "none",
  }, api.gLabels);
  gBbox.style.pointerEvents = "none";

  let statusEl = null;
  let popupEl = null;
  let detailEl = null;

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtCoord(lon, lat) {
    const lonAbs = Math.abs(lon).toFixed(3);
    const latAbs = Math.abs(lat).toFixed(3);
    return `${lonAbs} ${lon >= 0 ? "E" : "W"}, ${latAbs} ${lat >= 0 ? "N" : "S"}`;
  }

  function lonLatOnGlobe(e) {
    const proj = api.projection;
    const [pcx, pcy] = proj.translate();
    const pR = proj.scale();
    const dx = e.clientX - pcx;
    const dy = e.clientY - pcy;
    if (dx * dx + dy * dy > pR * pR) return null;
    const ll = proj.invert([e.clientX, e.clientY]);
    if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return null;
    return ll;
  }

  function getNcOverlays() {
    return api._ncOverlays || window.GlobeAPI?._ncOverlays || [];
  }

  function activeNcOverlay() {
    const ovs = getNcOverlays();
    return ovs.find((o) => o.renderSlice && o.activeSlice) || ovs[0] || null;
  }

  function ncLevelCount(ov) {
    const g = ov?.frames?.[0]?.grid;
    if (g?.levels?.length > 1) return g.levels.length;
    const v = ov?.frames?.[0]?.reader?.variables?.find((x) => x.name === ov.selVar);
    if (v?._levels?.length > 1) return v._levels.length;
    return 1;
  }

  function ncTimeSeries(ov, lon, lat) {
    if (!ov?.frames?.length || !extractSlice || !sampleAt) return null;
    const labels = [];
    const values = [];
    let units = "";
    for (let t = 0; t < ov.frames.length; t++) {
      const fr = ov.frames[t];
      const sl = extractSlice(fr.reader, fr.grid, ov.selVar, fr.localT ?? t, 1, ov.selLevIdx ?? 0);
      if (!sl) continue;
      units = sl.units || units;
      labels.push(fr.label || `t${t}`);
      values.push(sampleAt(lon, lat, sl, sl.lats, sl.lons));
    }
    return values.length ? { labels, values, units, varName: ov.selVar } : null;
  }

  function ncVerticalProfile(ov, lon, lat, timeIdx = 0) {
    if (!ov?.frames?.length || !extractSlice || !sampleAt) return null;
    const nLev = ncLevelCount(ov);
    if (nLev < 2) return null;
    const fr = ov.frames[Math.min(timeIdx, ov.frames.length - 1)];
    const grid = fr.grid;
    const depths = [];
    const values = [];
    let units = "";
    for (let li = 0; li < nLev; li++) {
      const sl = extractSlice(fr.reader, grid, ov.selVar, fr.localT ?? timeIdx, 1, li);
      if (!sl) continue;
      units = sl.units || units;
      const lev = grid.levels?.[li];
      depths.push(lev != null ? -Math.abs(lev) : -(li + 1));
      values.push(sampleAt(lon, lat, sl, sl.lats, sl.lons));
    }
    return depths.length ? { depths, values, units, varName: ov.selVar } : null;
  }

  function ncSurfaceValue(ov, lon, lat) {
    const rs = ov?.renderSlice;
    if (!rs) return null;
    const v = sampleAt(lon, lat, rs, rs.lats, rs.lons);
    if (isNaN(v)) return null;
    return {
      key: ov.selVar || "value",
      label: ov.selVar || "overlay",
      value: v,
      units: ov.activeSlice?.units || "",
    };
  }

  function drawMiniSeries(canvas, labels, values, opts = {}) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    const valid = values.map((v, i) => ({ v, i })).filter((p) => !isNaN(p.v));
    if (valid.length < 2) {
      ctx.fillStyle = "#7a93a8";
      ctx.font = "10px IBM Plex Mono, monospace";
      ctx.fillText("No series data", 8, h / 2);
      return null;
    }
    const vmin = Math.min(...valid.map((p) => p.v));
    const vmax = Math.max(...valid.map((p) => p.v));
    const vr = (vmax - vmin) || 1;
    const L = 34;
    const R = 8;
    const T = 18;
    const B = 22;
    const pw = w - L - R;
    const ph = h - T - B;

    ctx.strokeStyle = "rgba(255,210,80,0.85)";
    ctx.lineWidth = 1;
    ctx.strokeRect(L, T, pw, ph);

    const px = (k) => L + (k / Math.max(1, values.length - 1)) * pw;
    const py = (v) => T + ph - ((v - vmin) / vr) * ph;

    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < values.length; k++) {
      if (isNaN(values[k])) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(px(k), py(values[k]));
        started = true;
      } else ctx.lineTo(px(k), py(values[k]));
    }
    ctx.stroke();

    ctx.fillStyle = "#9fb6c9";
    ctx.font = "9px IBM Plex Mono, monospace";
    ctx.textAlign = "left";
    ctx.fillText(opts.ylabel || "", 4, 12);
    ctx.textAlign = "center";
    ctx.fillText("t", L + pw / 2, h - 4);

    const mean = valid.reduce((s, p) => s + p.v, 0) / valid.length;
    return { mean, vmin, vmax, units: opts.units || "" };
  }

  function drawMiniProfile(canvas, depths, values, opts = {}) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    const pairs = depths.map((d, i) => ({ d, v: values[i] })).filter((p) => !isNaN(p.v));
    if (pairs.length < 2) {
      ctx.fillStyle = "#7a93a8";
      ctx.font = "10px IBM Plex Mono, monospace";
      ctx.fillText("No profile data", 8, h / 2);
      return;
    }
    const dmin = Math.min(...pairs.map((p) => p.d));
    const dmax = Math.max(...pairs.map((p) => p.d));
    const vmin = Math.min(...pairs.map((p) => p.v));
    const vmax = Math.max(...pairs.map((p) => p.v));
    const dr = (dmax - dmin) || 1;
    const vr = (vmax - vmin) || 1;
    const L = 42;
    const R = 8;
    const T = 18;
    const B = 16;
    const pw = w - L - R;
    const ph = h - T - B;

    ctx.strokeStyle = "rgba(255,210,80,0.85)";
    ctx.strokeRect(L, T, pw, ph);

    const px = (v) => L + ((v - vmin) / vr) * pw;
    const py = (d) => T + ((d - dmin) / dr) * ph;

    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    pairs.forEach((p, i) => {
      const x = px(p.v);
      const y = py(p.d);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = "#9fb6c9";
    ctx.font = "9px IBM Plex Mono, monospace";
    ctx.textAlign = "right";
    [0, 0.5, 1].forEach((f) => {
      const d = dmin + dr * f;
      ctx.fillText(String(Math.round(d)), L - 4, py(d) + 3);
    });
    ctx.textAlign = "center";
    ctx.fillText(opts.varName || "value", L + pw / 2, 10);
    ctx.fillText("h", w - 10, T + ph / 2);
  }

  function ensurePopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement("div");
    popupEl.id = "gf-point-popup";
    popupEl.className = "gf-popup";
    popupEl.style.display = "none";
    popupEl.innerHTML =
      '<div class="gf-popup-head">' +
      '<span class="gf-popup-coords"></span>' +
      '<div class="gf-popup-btns">' +
      '<button type="button" class="gf-expand" title="Expand">⤢</button>' +
      '<button type="button" class="gf-close" title="Close">✕</button>' +
      "</div></div>" +
      '<div class="gf-popup-values"></div>' +
      '<div class="gf-popup-chart-wrap"><div class="gf-chart-label"></div><canvas class="gf-ts-canvas" height="90"></canvas><div class="gf-ts-stats"></div></div>' +
      '<div class="gf-popup-chart-wrap gf-profile-wrap" style="display:none">' +
      '<div class="gf-chart-label gf-profile-label"></div><canvas class="gf-prof-canvas" height="110"></canvas></div>' +
      '<div class="gf-popup-status"></div>';
    document.body.appendChild(popupEl);

    let drag = false;
    let mx0 = 0;
    let my0 = 0;
    let ox0 = 0;
    let oy0 = 0;
    popupEl.querySelector(".gf-popup-head").addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      drag = true;
      mx0 = e.clientX;
      my0 = e.clientY;
      ox0 = popupEl.offsetLeft;
      oy0 = popupEl.offsetTop;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      popupEl.style.left = `${ox0 + e.clientX - mx0}px`;
      popupEl.style.top = `${oy0 + e.clientY - my0}px`;
    });
    document.addEventListener("mouseup", () => {
      drag = false;
    });
    popupEl.querySelector(".gf-close").addEventListener("click", () => {
      popupEl.style.display = "none";
    });
    popupEl.querySelector(".gf-expand").addEventListener("click", () => {
      popupEl.classList.toggle("gf-expanded");
      const btn = popupEl.querySelector(".gf-expand");
      btn.textContent = popupEl.classList.contains("gf-expanded") ? "⤡" : "⤢";
      redrawPopupCharts();
    });
    return popupEl;
  }

  let lastPopupData = null;

  function redrawPopupCharts() {
    if (!popupEl || !lastPopupData) return;
    const ts = popupEl.querySelector(".gf-ts-canvas");
    const prof = popupEl.querySelector(".gf-prof-canvas");
    if (lastPopupData.series) {
      const stats = drawMiniSeries(ts, lastPopupData.series.labels, lastPopupData.series.values, {
        ylabel: lastPopupData.series.varName,
        units: lastPopupData.series.units,
      });
      const st = popupEl.querySelector(".gf-ts-stats");
      if (stats) {
        st.textContent = `x̄ ${stats.mean.toFixed(1)}  ↓ ${stats.vmin.toFixed(1)}  ↑ ${stats.vmax.toFixed(1)} ${stats.units}`;
      }
    }
    if (lastPopupData.profile) {
      drawMiniProfile(prof, lastPopupData.profile.depths, lastPopupData.profile.values, {
        varName: lastPopupData.profile.varName,
      });
    }
  }

  function showPointPopup(lon, lat, prefill) {
    const pop = ensurePopup();
    pop.style.display = "block";
    pop.style.left = `${Math.min(window.innerWidth - 320, Math.max(12, (window.innerWidth - 300) / 2))}px`;
    pop.style.top = `${Math.min(window.innerHeight - 420, 72)}px`;
    pop.querySelector(".gf-popup-coords").textContent = fmtCoord(lon, lat);
    const valsEl = pop.querySelector(".gf-popup-values");
    const statusEl2 = pop.querySelector(".gf-popup-status");
    valsEl.innerHTML = '<span class="gf-loading">Loading…</span>';
    statusEl2.textContent = "";
    lastPopupData = null;

    (async () => {
      const rows = [];
      const ov = activeNcOverlay();
      if (ov?.renderSlice) {
        const nv = ncSurfaceValue(ov, lon, lat);
        if (nv) rows.push(nv);
      }

      let bundle = prefill;
      if (!bundle) {
        try {
          bundle = await GL().fetchPointWeather(dataApi, lat, lon, { model: feed.model });
        } catch (err) {
          statusEl2.textContent = err.message;
        }
      }

      if (bundle?.weather?.current) {
        const c = bundle.weather.current;
        if (c.temperature_2m != null) {
          rows.push({ key: "thetao", label: "thetao", value: c.temperature_2m, units: "°C", note: "air temp (no SST)" });
        }
        if (c.wind_speed_10m != null) {
          rows.push({ key: "swv", label: "swv", value: c.wind_speed_10m, units: "km/h" });
        }
      }
      if (bundle?.marine?.current) {
        const m = bundle.marine.current;
        if (m.sea_surface_temperature != null) {
          const existing = rows.find((r) => r.key === "thetao");
          if (existing) {
            existing.value = m.sea_surface_temperature;
            existing.note = "SST";
          } else {
            rows.push({ key: "thetao", label: "thetao", value: m.sea_surface_temperature, units: "°C", note: "SST" });
          }
        }
        if (m.ocean_current_velocity != null) {
          rows.push({ key: "swv", label: "swv", value: m.ocean_current_velocity, units: "m/s", note: "current" });
        }
        if (m.wave_height != null) {
          rows.push({ key: "swh", label: "swh", value: m.wave_height, units: "m" });
        }
      }
      if (bundle?.airQuality?.current?.pm2_5 != null) {
        rows.push({ key: "pm25", label: "pm2.5", value: bundle.airQuality.current.pm2_5, units: "µg/m³" });
      }

      valsEl.innerHTML = rows.length
        ? rows.map((r) =>
          `<div class="gf-val-row"><span class="gf-val-key">${esc(r.label)}</span>` +
          `<span class="gf-val-num">${Number(r.value).toPrecision(4)} ${esc(r.units)}</span>` +
          (r.note ? `<span class="gf-val-note">${esc(r.note)}</span>` : "") +
          "</div>"
        ).join("")
        : '<span class="gf-muted">No scalar data at this point</span>';

      let series = null;
      let profile = null;

      if (ov && ov.frames?.length > 1) {
        series = ncTimeSeries(ov, lon, lat);
        pop.querySelector(".gf-chart-label").textContent = series?.varName || "time series";
      }
      if (ov && ncLevelCount(ov) > 1) {
        profile = ncVerticalProfile(ov, lon, lat, ov.selTime ?? 0);
        pop.querySelector(".gf-profile-wrap").style.display = profile ? "" : "none";
        pop.querySelector(".gf-profile-label").textContent = profile?.varName || "profile";
      }

      if (!series && bundle?.marine?.hourly?.time?.length) {
        const h = bundle.marine.hourly;
        series = {
          labels: h.time,
          values: h.sea_surface_temperature || h.wave_height || [],
          units: h.sea_surface_temperature ? "°C" : "m",
          varName: h.sea_surface_temperature ? "thetao" : "swh",
        };
        pop.querySelector(".gf-chart-label").textContent = series.varName;
      } else if (!series && bundle?.weather?.hourly?.time?.length) {
        const h = bundle.weather.hourly;
        series = {
          labels: h.time,
          values: h.temperature_2m || [],
          units: "°C",
          varName: "temperature",
        };
        pop.querySelector(".gf-chart-label").textContent = "temperature";
      }

      lastPopupData = { series, profile };
      redrawPopupCharts();

      if (!series && !profile) {
        pop.querySelector(".gf-popup-chart-wrap").style.display = "none";
      } else {
        pop.querySelector(".gf-popup-chart-wrap").style.display = "";
      }
    })();
  }

  function ensureDetail() {
    if (detailEl) return detailEl;
    detailEl = document.createElement("div");
    detailEl.id = "gf-detail-panel";
    detailEl.className = "gf-detail";
    detailEl.innerHTML =
      '<div class="gf-detail-head"><span class="gf-detail-title"></span>' +
      '<button type="button" class="gf-detail-close">✕</button></div>' +
      '<div class="gf-detail-body"></div>' +
      '<div class="gf-detail-charts"></div>';
    document.body.appendChild(detailEl);
    detailEl.querySelector(".gf-detail-close").addEventListener("click", () => {
      detailEl.classList.remove("show");
      feed.selected = null;
      drawMarkers();
    });
    return detailEl;
  }

  function showFeedDetail(item) {
    const panel = ensureDetail();
    feed.selected = item.id;
    drawMarkers();
    panel.classList.add("show");
    panel.querySelector(".gf-detail-title").textContent = item.name || item.title || item.id;
    const body = panel.querySelector(".gf-detail-body");
    const charts = panel.querySelector(".gf-detail-charts");
    charts.innerHTML = "";
    body.innerHTML = "";

    if (item.kind === "earthquake") {
      body.innerHTML = `<dl class="gf-dl">
        <dt>Magnitude</dt><dd>M${item.mag?.toFixed(1) ?? "?"}</dd>
        <dt>Depth</dt><dd>${item.depth != null ? `${item.depth} km` : "—"}</dd>
        <dt>Place</dt><dd>${esc(item.place)}</dd>
        <dt>Time</dt><dd>${item.time ? new Date(item.time).toLocaleString() : "—"}</dd>
      </dl>`;
      GL().fetchRegionalQuakes(dataApi, item.lat, item.lon).then((quakes) => {
        const points = quakes.filter((q) => q.mag != null && q.time).map((q) => ({ t: q.time, v: q.mag }));
        if (!points.length) return;
        const cv = document.createElement("canvas");
        cv.className = "gf-detail-canvas";
        cv.height = 140;
        charts.appendChild(cv);
        GC().draw(cv, [{ label: "Magnitude", points, color: "#ff6b4a" }], { emptyText: "No quakes" });
      }).catch(() => {});
      return;
    }

    if (item.kind === "weather" || item.kind === "marine" || item.kind === "weathergrid") {
      const wx = GL().weatherLabel(item.weatherCode);
      body.innerHTML = `<dl class="gf-dl">
        <dt>Location</dt><dd>${esc(item.name || fmtCoord(item.lon, item.lat))}</dd>
        <dt>Conditions</dt><dd>${esc(wx)}</dd>
        <dt>Temperature</dt><dd>${item.temp != null ? `${item.temp.toFixed(1)} °C` : (item.sst != null ? `${item.sst.toFixed(1)} °C SST` : "—")}</dd>
        <dt>Wind / waves</dt><dd>${item.wind != null ? `${item.wind} km/h` : (item.waveHeight != null ? `${item.waveHeight} m waves` : "—")}</dd>
      </dl>`;
      GL().fetchPointWeather(dataApi, item.lat, item.lon, { model: feed.model })
        .then((bundle) => {
          const tabs = OM().buildAllCharts(bundle.weather, null, bundle.airQuality, bundle.marine, GC());
          if (!tabs.length) return;
          const wrap = document.createElement("div");
          wrap.className = "gf-chart-tabs";
          tabs.slice(0, 4).forEach((tab, i) => {
            const btn = document.createElement("button");
            btn.textContent = tab.label;
            btn.type = "button";
            if (i === 0) btn.classList.add("on");
            wrap.appendChild(btn);
          });
          const cv = document.createElement("canvas");
          cv.className = "gf-detail-canvas";
          cv.height = 160;
          charts.appendChild(wrap);
          charts.appendChild(cv);
          let cur = 0;
          const render = () => GC().draw(cv, tabs[cur].series, { title: tabs[cur].label, unit: tabs[cur].unit });
          render();
          wrap.querySelectorAll("button").forEach((b, i) => {
            b.addEventListener("click", () => {
              wrap.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
              b.classList.add("on");
              cur = i;
              render();
            });
          });
        }).catch(() => {});
    }
  }

  function magRadius(mag) {
    return Math.max(4, Math.min(14, 3 + (mag || 0) * 1.8));
  }

  function drawMarkers() {
    while (gFeed.firstChild) gFeed.removeChild(gFeed.firstChild);
    if (!feed.enabled.size) return;

    const path = api.path;
    const proj = api.projection;
    for (const item of feed.data.values()) {
      const show =
        (item.kind === "earthquake" && feed.enabled.has("earthquakes")) ||
        (item.kind === "weather" && feed.enabled.has("weather")) ||
        (item.kind === "marine" && feed.enabled.has("marine")) ||
        (item.kind === "weathergrid" && feed.enabled.has("weathergrid"));
      if (!show) continue;

      const pt = proj([item.lon, item.lat]);
      if (!pt) continue;
      const col = KIND_COLOR[item.kind] || "#fff";
      const sel = feed.selected === item.id;
      const g = api.A.el("g", { "data-feed-id": item.id, transform: `translate(${pt[0]},${pt[1]})` }, gFeed);
      g.style.cursor = "pointer";
      if (item.kind === "earthquake") {
        const r = magRadius(item.mag);
        api.A.el("circle", {
          r,
          fill: col,
          "fill-opacity": sel ? 0.95 : 0.55,
          stroke: col,
          "stroke-width": sel ? 2 : 1,
        }, g);
        if (item.mag != null) {
          api.A.el("text", {
            y: 3,
            "text-anchor": "middle",
            fill: "#061119",
            "font-size": Math.max(7, r * 0.75),
            "font-weight": 700,
            text: String(item.mag.toFixed(1)),
          }, g);
        }
      } else {
        api.A.el("circle", {
          r: sel ? 7 : 5,
          fill: col,
          "fill-opacity": 0.85,
          stroke: "#061119",
          "stroke-width": 1,
        }, g);
      }
    }
    gFeed.appendChild(gBbox);
  }

  function drawBbox() {
    if (!feed.bbox) {
      gBbox.setAttribute("display", "none");
      return;
    }
    const { west, south, east, north } = feed.bbox;
    const ring = [
      [west, south], [east, south], [east, north], [west, north], [west, south],
    ];
    try {
      gBbox.setAttribute("d", api.path({ type: "Polygon", coordinates: [ring] }) || "");
      gBbox.setAttribute("display", "");
    } catch (e) {
      gBbox.setAttribute("display", "none");
    }
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  async function refreshFeeds() {
    if (feed.loading) return;
    feed.loading = true;
    setStatus("Fetching…");
    const tasks = [];
    if (feed.enabled.has("earthquakes")) {
      tasks.push(
        GL().fetchEarthquakes(dataApi, { mag: feed.quakeMag, period: feed.quakePeriod, useCustom: false })
          .then((m) => m.forEach((v, k) => feed.data.set(k, v)))
      );
    }
    if (feed.enabled.has("weather")) {
      tasks.push(
        GL().fetchWeather(dataApi, { model: feed.model })
          .then((m) => m.forEach((v, k) => feed.data.set(k, v)))
      );
    }
    if (feed.enabled.has("marine")) {
      tasks.push(
        GL().fetchMarine(dataApi).then((m) => m.forEach((v, k) => feed.data.set(k, v)))
      );
    }
    if (feed.enabled.has("weathergrid") && feed.bbox) {
      tasks.push(
        GL().fetchWeatherBbox(dataApi, feed.bbox, feed.model)
          .then((m) => {
            for (const [k] of feed.data) {
              if (k.startsWith("grid-")) feed.data.delete(k);
            }
            m.forEach((v, k) => feed.data.set(k, v));
          })
      );
    }
    try {
      await Promise.all(tasks);
      setStatus(`Updated ${new Date().toLocaleTimeString()} · ${feed.data.size} items`);
      drawMarkers();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      console.error("[GlobeFeeds]", err);
    } finally {
      feed.loading = false;
    }
  }

  function buildUi() {
    const ctrl = document.getElementById("ctrl");
    const earth = ctrl?.querySelector('.gp-pane[data-tab="earth"]');
    if (!earth || document.getElementById("gf-sect")) return;

    const sect = document.createElement("div");
    sect.className = "gp-sect gf-sect";
    sect.id = "gf-sect";
    const models = OM().WEATHER_MODELS.map(
      (m) => `<option value="${m.id}">${esc(m.label)}</option>`
    ).join("");
    sect.innerHTML =
      '<div class="gp-sect-title">Live data feeds (CORS)</div>' +
      '<div class="gf-hint">Earthquakes, weather cities, marine, bbox grid — click globe or markers for Ocean Pro–style popups.</div>' +
      '<div class="gf-row"><label class="gf-check"><input type="checkbox" data-layer="earthquakes"> Earthquakes (USGS)</label></div>' +
      '<div class="gf-row"><label class="gf-check"><input type="checkbox" data-layer="weather"> Weather cities (50)</label></div>' +
      '<div class="gf-row"><label class="gf-check"><input type="checkbox" data-layer="marine"> Marine coastal (27)</label></div>' +
      '<div class="gf-row"><label class="gf-check"><input type="checkbox" data-layer="weathergrid"> Weather bbox grid</label></div>' +
      '<div class="gf-row"><label class="gf-check"><input type="checkbox" data-layer="pointclick" checked> Point-click lookup</label></div>' +
      '<div class="gf-controls">' +
      '<label>Mag <select id="gf-quake-mag"><option value="2.5">M2.5+</option><option value="4.5">M4.5+</option><option value="1.0">M1.0+</option></select></label>' +
      '<label>Period <select id="gf-quake-period"><option value="day">Day</option><option value="week" selected>Week</option><option value="month">Month</option></select></label>' +
      '<label>Model <select id="gf-model">' + models + "</select></label>" +
      "</div>" +
      '<div class="gf-btns">' +
      '<button type="button" id="gf-fetch">Fetch now</button>' +
      '<button type="button" id="gf-bbox-draw">Draw bbox</button>' +
      '<button type="button" id="gf-bbox-fetch">Fetch grid</button>' +
      '<button type="button" id="gf-bbox-clear">Clear bbox</button>' +
      "</div>" +
      '<div class="gf-status" id="gf-status"></div>';

    const geoSect = document.getElementById("gp-user-geo-sect");
    if (geoSect?.parentNode) geoSect.parentNode.insertBefore(sect, geoSect);
    else earth.appendChild(sect);

    statusEl = sect.querySelector("#gf-status");

    sect.querySelectorAll("input[data-layer]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const id = inp.dataset.layer;
        if (id === "pointclick") {
          feed.pointClick = inp.checked;
          return;
        }
        if (inp.checked) feed.enabled.add(id);
        else feed.enabled.delete(id);
        if (feed.enabled.size) refreshFeeds();
        else drawMarkers();
      });
    });

    sect.querySelector("#gf-quake-mag").addEventListener("change", (e) => {
      feed.quakeMag = e.target.value;
    });
    sect.querySelector("#gf-quake-period").addEventListener("change", (e) => {
      feed.quakePeriod = e.target.value;
    });
    const modelSel = sect.querySelector("#gf-model");
    modelSel.value = feed.model;
    modelSel.addEventListener("change", (e) => {
      feed.model = e.target.value;
    });

    sect.querySelector("#gf-fetch").addEventListener("click", () => {
      if (!feed.enabled.size) {
        feed.enabled.add("earthquakes");
        sect.querySelector('input[data-layer="earthquakes"]').checked = true;
      }
      refreshFeeds();
    });

    sect.querySelector("#gf-bbox-draw").addEventListener("click", () => {
      feed.bboxPick = { pts: [] };
      setStatus("Click first corner on globe…");
    });
    sect.querySelector("#gf-bbox-clear").addEventListener("click", () => {
      feed.bbox = null;
      feed.bboxPick = null;
      drawBbox();
      setStatus("BBox cleared");
    });
    sect.querySelector("#gf-bbox-fetch").addEventListener("click", async () => {
      if (!feed.bbox) {
        setStatus("Draw a bbox first");
        return;
      }
      feed.enabled.add("weathergrid");
      sect.querySelector('input[data-layer="weathergrid"]').checked = true;
      await refreshFeeds();
    });
  }

  gFeed.addEventListener("click", (e) => {
    let el = e.target;
    while (el && el !== gFeed) {
      const id = el.getAttribute?.("data-feed-id");
      if (id && feed.data.has(id)) {
        e.stopPropagation();
        showFeedDetail(feed.data.get(id));
        return;
      }
      el = el.parentNode;
    }
  });

  document.addEventListener("click", (e) => {
    if (feed.bboxPick) {
      if (e.target.closest(".ctrl,.gf-popup,.gf-detail,.nc-plot-win,#info-panel")) return;
      const ll = lonLatOnGlobe(e);
      if (!ll) return;
      feed.bboxPick.pts.push(ll);
      if (feed.bboxPick.pts.length < 2) {
        setStatus("Click opposite corner…");
        return;
      }
      const [a, b] = feed.bboxPick.pts;
      feed.bbox = {
        west: Math.min(a[0], b[0]),
        east: Math.max(a[0], b[0]),
        south: Math.min(a[1], b[1]),
        north: Math.max(a[1], b[1]),
      };
      feed.bboxPick = null;
      drawBbox();
      setStatus(`BBox ${feed.bbox.west.toFixed(1)}°–${feed.bbox.east.toFixed(1)}°E, ${feed.bbox.south.toFixed(1)}°–${feed.bbox.north.toFixed(1)}°N`);
      e.stopPropagation();
      return;
    }

    if (!feed.pointClick) return;
    if (e.target.closest(".ctrl,.gf-popup,.gf-detail,.nc-plot-win,#info-panel,[data-feed-id],[data-info]")) return;
    if (api.isDragging) return;
    const ll = lonLatOnGlobe(e);
    if (!ll) return;
    showPointPopup(ll[0], ll[1]);
  }, true);

  const prevRedraw = api.onRedraw;
  api.onRedraw = function () {
    if (typeof prevRedraw === "function") prevRedraw();
    drawMarkers();
    drawBbox();
  };

  buildUi();
  api.redraw();
  window.GlobeFeedsAPI = { refresh: refreshFeeds, showPoint: showPointPopup, feed };
  console.log("[GlobeFeeds] ready");
};
