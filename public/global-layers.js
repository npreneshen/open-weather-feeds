/* Global real-time layer fetchers — used by index.html */
window.GlobalLayers = (() => {
  "use strict";

  const AQ_CITIES = [
    ["New York", 40.71, -74.01], ["Los Angeles", 34.05, -118.24], ["Chicago", 41.88, -87.63],
    ["London", 51.51, -0.13], ["Paris", 48.86, 2.35], ["Berlin", 52.52, 13.41],
    ["Madrid", 40.42, -3.70], ["Rome", 41.90, 12.50], ["Moscow", 55.76, 37.62],
    ["Istanbul", 41.01, 28.98], ["Cairo", 30.04, 31.24], ["Lagos", 6.52, 3.38],
    ["Nairobi", -1.29, 36.82], ["Johannesburg", -26.20, 28.04], ["Dubai", 25.20, 55.27],
    ["Mumbai", 19.08, 72.88], ["Delhi", 28.61, 77.21], ["Bangkok", 13.76, 100.50],
    ["Singapore", 1.35, 103.82], ["Jakarta", -6.21, 106.85], ["Beijing", 39.90, 116.41],
    ["Shanghai", 31.23, 121.47], ["Tokyo", 35.68, 139.69], ["Seoul", 37.57, 126.98],
    ["Sydney", -33.87, 151.21], ["Melbourne", -37.81, 144.96], ["São Paulo", -23.55, -46.63],
    ["Mexico City", 19.43, -99.13], ["Buenos Aires", -34.60, -58.38], ["Toronto", 43.65, -79.38],
    ["Vancouver", 49.28, -123.12], ["Reykjavik", 64.15, -21.94], ["Oslo", 59.91, 10.75],
    ["Stockholm", 59.33, 18.07], ["Helsinki", 60.17, 24.94], ["Anchorage", 61.22, -149.90],
  ];

  function ndbcNum(s) {
    const v = String(s ?? "").trim();
    if (!v || v === "MM") return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  function parseNdbcHistory(raw, field = "WVHT", maxRows = 1200) {
    const lines = String(raw || "").split(/\r?\n/);
    const headerLine = lines.find((line) => line.startsWith("#") && /\bYY\b|\bYR\b/i.test(line));
    const headers = headerLine ? headerLine.replace(/^#/, "").trim().split(/\s+/).map((name) => name.toUpperCase()) : [];
    const fallback = { WDIR: 5, WSPD: 6, GST: 7, WVHT: 8, DPD: 9, APD: 10, MWD: 11, PRES: 12, ATMP: 13, WTMP: 14, DEWP: 15, VIS: 16, PTDY: 17, TIDE: 18 };
    const wanted = String(field || "WVHT").toUpperCase();
    const idx = headers.indexOf(wanted) >= 5 ? headers.indexOf(wanted) : fallback[wanted];
    if (!Number.isInteger(idx)) return [];
    const points = [];
    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;
      const c = line.trim().split(/\s+/);
      if (c.length <= idx) continue;
      const yy = +c[0], mo = +c[1], dd = +c[2], hh = +c[3], mn = +c[4];
      const v = ndbcNum(c[idx]);
      if (v == null) continue;
      const t = Date.UTC(yy, mo - 1, dd, hh, mn);
      if (!Number.isFinite(t)) continue;
      points.push({ t, v });
    }
    if (points.length <= maxRows) return points;
    const stride = Math.ceil(points.length / maxRows);
    return points.filter((_point, index) => index % stride === 0 || index === points.length - 1);
  }

  function parseNdbcHistorySeries(raw, fields = [], maxRows = 1200) {
    const result = {};
    for (const field of fields) result[field] = parseNdbcHistory(raw, field, maxRows);
    return result;
  }

  function parseNdbcText(raw) {
    const lines = String(raw || "").split(/\r?\n/);
    const items = new Map();
    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;
      const c = line.trim().split(/\s+/);
      if (c.length < 13) continue;
      const stn = c[0];
      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[2]);
      if (!stn || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) continue;
      let obsTime = null;
      if (c.length >= 9) {
        const t = Date.UTC(+c[3], +c[4] - 1, +c[5], +c[6], +c[7]);
        if (Number.isFinite(t)) obsTime = t;
      }
      items.set(`buoy-${stn}`, {
        kind: "buoy", id: `buoy-${stn}`, name: stn, lat, lon, obsTime,
        wdir: ndbcNum(c[8]),
        wspd: ndbcNum(c[9]),
        gst: ndbcNum(c[10]),
        wvht: ndbcNum(c[11]),
        dpd: ndbcNum(c[12]),
        apd: ndbcNum(c[13]),
        mwd: ndbcNum(c[14]),
        pres: ndbcNum(c[15]),
        ptdy: ndbcNum(c[16]),
        atmp: ndbcNum(c[17]),
        wtmp: ndbcNum(c[18]),
        dewp: ndbcNum(c[19]),
        vis: ndbcNum(c[20]),
        tide: ndbcNum(c[21]),
      });
    }
    return items;
  }

  function polyCentroid(coords) {
    if (!coords?.length) return null;
    let lat = 0, lon = 0, n = 0;
    for (const c of coords) {
      if (c.lat == null || c.lon == null) continue;
      lat += c.lat; lon += c.lon; n++;
    }
    return n ? { lat: lat / n, lon: lon / n } : null;
  }

  function bboxCentroid(bbox) {
    if (!bbox || bbox.length < 4) return null;
    return { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
  }

  /** Parse RA — hours (HMS) or degrees → degrees [0, 360). */
  function parseRa(ra) {
    if (ra == null || ra === "") return null;
    if (typeof ra === "number" && Number.isFinite(ra)) return ((ra < 25 ? ra * 15 : ra) % 360 + 360) % 360;
    const s = String(ra).trim();
    if (/[\s:]/.test(s)) {
      const parts = s.replace(/:/g, " ").split(/\s+/).map(Number);
      if (parts.some((p) => !Number.isFinite(p))) return null;
      const hours = parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
      return ((hours * 15) % 360 + 360) % 360;
    }
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return null;
    return ((n < 25 ? n * 15 : n) % 360 + 360) % 360;
  }

  /** Parse Dec — signed DMS or decimal degrees. */
  function parseDec(dec) {
    if (dec == null || dec === "") return null;
    if (typeof dec === "number" && Number.isFinite(dec)) return dec;
    const s = String(dec).trim();
    const sign = s.startsWith("-") ? -1 : 1;
    const clean = s.replace(/^[+-]/, "");
    if (/[\s:]/.test(clean)) {
      const parts = clean.replace(/:/g, " ").split(/\s+/).map(Number);
      if (parts.some((p) => !Number.isFinite(p))) return null;
      return sign * (parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600);
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  function parseEphemerisTime(t) {
    if (!t) return null;
    const ms = Date.parse(String(t).replace(" ", "T"));
    return Number.isFinite(ms) ? ms : null;
  }

  /** GMST in degrees [0, 360) — sufficient for zenith subpoint. */
  function gmstDegrees(date) {
    const d = date instanceof Date ? date : new Date(date);
    const jd = d.getTime() / 86400000 + 2440587.5;
    const T = (jd - 2451545.0) / 36525.0;
    let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
      + 0.000387933 * T * T - (T * T * T) / 38710000;
    return ((gmst % 360) + 360) % 360;
  }

  /** Earth point where RA/Dec is at zenith at given UTC time. */
  function zenithSubpoint(raDeg, decDeg, timeMs) {
    if (raDeg == null || decDeg == null || timeMs == null) return null;
    const gmst = gmstDegrees(new Date(timeMs));
    let lon = raDeg - gmst;
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    const lat = Math.max(-90, Math.min(90, decDeg));
    return { lat, lon, gmst };
  }

  function formatRaHms(raDeg) {
    if (raDeg == null) return "—";
    let h = raDeg / 15;
    h = ((h % 24) + 24) % 24;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    const ss = ((h - hh) * 60 - mm) * 60;
    return `${hh}h ${String(mm).padStart(2, "0")}m ${ss.toFixed(1)}s`;
  }

  function formatDecDms(decDeg) {
    if (decDeg == null) return "—";
    const sign = decDeg < 0 ? "-" : "+";
    const a = Math.abs(decDeg);
    const dd = Math.floor(a);
    const mm = Math.floor((a - dd) * 60);
    const ss = ((a - dd) * 60 - mm) * 60;
    return `${sign}${dd}° ${String(mm).padStart(2, "0")}' ${ss.toFixed(1)}"`;
  }

  function normQuake(feature) {
    const p = feature.properties || {};
    const [lon, lat, depth] = feature.geometry?.coordinates || [0, 0, 0];
    return {
      kind: "earthquake",
      id: p.id || feature.id || `eq-${p.time}-${lat}`,
      title: p.title || p.place || "Earthquake",
      lat, lon, depth, mag: p.mag ?? null,
      time: p.time ? new Date(p.time).getTime() : null,
      place: p.place || "", url: p.url || "", alert: p.alert || "",
      tsunami: p.tsunami || 0, sig: p.sig || 0, raw: feature,
    };
  }

  function normVolcano(raw, status = {}) {
    const lat = parseFloat(raw.latitude ?? raw.lat ?? status.lat);
    const lon = parseFloat(raw.longitude ?? raw.long ?? status.long);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const vnum = String(raw.vnum || status.vnum || "");
    const alertLevel = status.alertLevel || raw.alertLevel || null;
    const colorCode = status.colorCode || raw.colorCode || null;
    const elevated = alertLevel && !/NORMAL|UNASSIGNED/i.test(alertLevel)
      && colorCode && !/GREEN|UNASSIGNED/i.test(colorCode);
    return {
      kind: "volcano", id: `volcano-${vnum}`,
      name: raw.vName || raw.volcanoName || status.vName || vnum,
      vnum, country: raw.country || "", region: raw.subregion || status.region || "",
      lat, lon, elevation: raw.elevation_m ?? null,
      alertLevel, colorCode, monitored: !!(alertLevel || status.obs),
      elevated: !!elevated, threat: status.nvewsThreat || null,
      synopsis: status.noticeSynopsis || null,
      url: status.volcanoUrl || raw.volcanoUrl || raw.webpage || "",
      noticeUrl: status.noticeUrl || null, raw,
    };
  }

  function isElevatedVolcano(v) {
    return v.elevated || (v.colorCode && /ORANGE|RED/i.test(v.colorCode))
      || (v.alertLevel && /WATCH|WARNING|ADVISORY/i.test(v.alertLevel));
  }

  async function fetchEarthquakes(api, opts) {
    const feedId = opts.useCustom ? "custom" : `${opts.mag}_${opts.period}`;
    let data;
    if (opts.useCustom) {
      const end = new Date();
      const start = new Date(end.getTime() - (opts.days || 1) * 86400000);
      data = await api("earthquake", "/fdsnws/event/1/query", {
        format: "geojson",
        starttime: start.toISOString().slice(0, 19),
        endtime: end.toISOString().slice(0, 19),
        minmagnitude: opts.minMag || 0,
        orderby: "time",
      });
    } else {
      data = await api("earthquake", `/earthquakes/feed/v1.0/summary/${feedId}.geojson`, {});
    }
    const items = new Map();
    for (const f of data?.features || []) {
      const e = normQuake(f);
      items.set(e.id, e);
    }
    return items;
  }

  async function fetchRegionalQuakes(api, lat, lon, opts = {}) {
    const days = Math.max(1, Math.min(365, Number(opts.days) || 30));
    const radiusKm = Math.max(1, Math.min(2000, Number(opts.radiusKm) || 150));
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const data = await api("earthquake", "/fdsnws/event/1/query", {
      format: "geojson",
      starttime: start.toISOString().slice(0, 19),
      endtime: end.toISOString().slice(0, 19),
      latitude: lat,
      longitude: lon,
      maxradiuskm: radiusKm,
      minmagnitude: opts.minMag ?? 2,
      orderby: "time",
    });
    return (data?.features || []).map(normQuake);
  }

  async function fetchVolcanoes(api, opts) {
    const [gvp, statusGeo] = await Promise.all([
      api("volcanoes", "/vsc/api/volcanoApi/volcanoesGVP", {}),
      api("volcanoes", "/vsc/api/volcanoApi/geojson", {}).catch(() => ({ features: [] })),
    ]);
    const statusByVnum = {};
    for (const f of statusGeo?.features || []) {
      const p = f.properties || {};
      if (p.vnum) statusByVnum[p.vnum] = {
        ...p, lat: f.geometry?.coordinates?.[1], long: f.geometry?.coordinates?.[0],
      };
    }
    const items = new Map();
    for (const raw of Array.isArray(gvp) ? gvp : []) {
      const v = normVolcano(raw, statusByVnum[raw.vnum] || {});
      if (!v) continue;
      if (opts.filter === "monitored" && !v.monitored) continue;
      if (opts.filter === "elevated" && !isElevatedVolcano(v)) continue;
      items.set(v.id, v);
    }
    return items;
  }

  // Esri Living Atlas' public feed combines NOAA NHC (Atlantic/East Pacific
  // -- all the old nhc-only version ever covered) with the Joint Typhoon
  // Warning Center (West/Central Pacific, Indian Ocean, Southern Hemisphere),
  // so this is a strict superset -- genuinely global instead of Americas-only.
  // The service returns one row per forecast time step per storm (current
  // position plus several days of forecast track); this keeps only the
  // earliest (current) row per storm to match the old one-point-per-storm
  // shape the rest of the app (icons, detail panel) already expects.
  async function fetchCyclones(api) {
    const data = await api("arcgisCyclones", "/FeatureServer/0/query", {
      where: "1=1", outFields: "*", f: "json",
    });
    const rows = [...(data?.features || [])].sort((a, b) => (a.attributes?.OBJECTID ?? 0) - (b.attributes?.OBJECTID ?? 0));
    const clean = (v) => (Number.isFinite(v) && v !== 9999) ? v : null;
    const items = new Map();
    const seenStorms = new Set();
    for (const f of rows) {
      const a = f.attributes || {};
      const stormKey = `${a.BASIN || "?"}-${a.STORMNUM ?? a.STORMNAME ?? ""}`;
      if (seenStorms.has(stormKey)) continue;
      const lat = Number(a.LAT), lon = Number(a.LON);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      seenStorms.add(stormKey);
      const id = `cyclone-${stormKey}`;
      items.set(id, {
        kind: "cyclone", id,
        name: String(a.STORMNAME || "").trim() || stormKey,
        classification: String(a.ITCDVLP || a.TCDVLP || "").trim(),
        intensity: clean(Number(a.MAXWIND)), pressure: clean(Number(a.MSLP)),
        lat, lon, movementDir: clean(Number(a.TCDIR)), movementSpeed: clean(Number(a.TCSPD)),
        lastUpdate: a.FLDATELBL || (Number.isFinite(a.ADVDATE) ? new Date(a.ADVDATE).toISOString() : ""),
        basin: a.BASIN || "", raw: a,
      });
    }
    return items;
  }

  async function fetchTsunami(api) {
    const items = new Map();
    const [hist, alerts] = await Promise.all([
      api("ncei", "/arcgis/rest/services/web_mercator/hazards/MapServer/0/query", {
        where: "YEAR>=2000", outFields: "ID,YEAR,MONTH,DAY,LOCATION_NAME,TS_INTENSITY,CAUSE,EVENT_VALIDITY",
        returnGeometry: true, resultRecordCount: 500, f: "geojson",
      }).catch(() => ({ features: [] })),
      api("nws", "/alerts/active", { event: "Tsunami Warning,Tsunami Advisory,Tsunami Watch" })
        .catch(() => ({ features: [] })),
    ]);
    for (const f of hist?.features || []) {
      const p = f.properties || {};
      const [lon, lat] = f.geometry?.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const id = `tsunami-${p.ID || p.YEAR}-${lat}`;
      items.set(id, {
        kind: "tsunami", id,
        name: p.LOCATION_NAME || `Tsunami ${p.YEAR}`,
        lat, lon, year: p.YEAR, month: p.MONTH, day: p.DAY,
        intensity: p.TS_INTENSITY, cause: p.CAUSE, validity: p.EVENT_VALIDITY,
        source: "NCEI", time: p.YEAR ? new Date(p.YEAR, (p.MONTH || 1) - 1, p.DAY || 1).getTime() : null,
        raw: p,
      });
    }
    for (const f of alerts?.features || []) {
      const p = f.properties || {};
      let lat, lon;
      const g = f.geometry;
      if (g?.type === "Point") [lon, lat] = g.coordinates;
      else if (g?.coordinates?.[0]?.[0]) [lon, lat] = g.coordinates[0][0];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const id = `tsunami-alert-${p.id || p.sent}`;
      items.set(id, {
        kind: "tsunami", id,
        name: p.event || p.headline || "Active tsunami alert",
        lat, lon, severity: p.severity, urgency: p.urgency,
        source: "NWS", active: true,
        time: p.sent ? new Date(p.sent).getTime() : Date.now(),
        raw: p,
      });
    }
    return items;
  }

  async function fetchVolcanicAsh(api) {
    const data = await api("aviation", "/api/data/isigmet", { format: "json" });
    const items = new Map();
    for (const s of Array.isArray(data) ? data : []) {
      if (s.hazard !== "VA") continue;
      const c = polyCentroid(s.coords);
      if (!c) continue;
      const id = `va-${s.firId}-${s.seriesId}-${s.validTimeFrom}`;
      items.set(id, {
        kind: "volcanicash", id,
        name: s.qualifier ? `Ash: ${s.qualifier}` : "Volcanic ash",
        lat: c.lat, lon: c.lon,
        volcano: s.qualifier || "", base: s.base, top: s.top,
        validFrom: s.validTimeFrom, validTo: s.validTimeTo,
        movement: s.dir && s.spd ? `${s.dir} ${s.spd}kt` : "",
        fir: s.firName || s.firId, raw: s,
      });
    }
    return items;
  }

  async function fetchFireballs(api) {
    const days = 30;
    const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const data = await api("cneos", "/fireball.api", { limit: 200, "date-min": start });
    const items = new Map();
    const fields = data?.fields || [];
    const fi = (n) => fields.indexOf(n);
    for (const row of data?.data || []) {
      const lat = parseFloat(row[fi("lat")]);
      const lon = parseFloat(row[fi("lon")]);
      const latDir = row[fi("lat-dir")] || "N";
      const lonDir = row[fi("lon-dir")] || "E";
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const latDec = latDir === "S" ? -lat : lat;
      const lonDec = lonDir === "W" ? -lon : lon;
      const date = row[fi("date")];
      const energy = parseFloat(row[fi("energy")]);
      const vel = parseFloat(row[fi("vel")]);
      const impactKt = parseFloat(row[fi("impact-e")]);
      items.set(`fireball-${date}-${latDec}`, {
        kind: "fireball", id: `fireball-${date}-${latDec}`,
        name: `Fireball ${date}`, lat: latDec, lon: lonDec,
        time: date ? new Date(date).getTime() : null,
        energy, energyJ: Number.isFinite(energy) ? energy * 1e10 : null,
        impactKt: Number.isFinite(impactKt) ? impactKt : null,
        altKm: parseFloat(row[fi("alt")]), velKmS: vel,
        raw: row,
      });
    }
    return items;
  }

  async function fetchBuoys(api) {
    const data = await api("ndbc", "/data/latest_obs/latest_obs.txt", {}, { text: true });
    return parseNdbcText(data?.raw ?? data);
  }

  async function fetchMetar(api, bounds) {
    if (!bounds) return new Map();
    // aviationweather.gov expects minLat,minLon,maxLat,maxLon — not the
    // minLon,minLat,maxLon,maxLat order used elsewhere in this app. Sending
    // the wrong order silently returned zero stations for almost every
    // real-world bbox (verified directly against the API).
    const data = await api("aviation", "/api/data/metar", {
      format: "json", hours: 1,
      bbox: `${bounds.latBottom},${bounds.lonLeft},${bounds.latTop},${bounds.lonRight}`,
    });
    const items = new Map();
    for (const m of Array.isArray(data) ? data : []) {
      if (m.lat == null || m.lon == null) continue;
      const id = `metar-${m.icaoId || m.stationId}`;
      items.set(id, {
        kind: "metar", id,
        name: m.icaoId || m.stationId || "Station",
        lat: m.lat, lon: m.lon,
        temp: m.temp, wdir: m.wdir, wspd: m.wspd, wgst: m.wgst,
        visib: m.visib, altim: m.altim, fltCat: m.fltCat,
        time: m.obsTime ? m.obsTime * 1000 : null,
        raw: m,
      });
    }
    return items;
  }

  async function fetchAirQuality(api) {
    const lats = AQ_CITIES.map((c) => c[1]).join(",");
    const lons = AQ_CITIES.map((c) => c[2]).join(",");
    const data = await api("openmeteoAq", "/v1/air-quality", {
      latitude: lats, longitude: lons, current: "us_aqi,pm2_5,pm10",
    });
    const rows = Array.isArray(data) ? data : [data];
    const items = new Map();
    rows.forEach((row, i) => {
      const city = AQ_CITIES[i];
      if (!city) return;
      const [, lat, lon] = city;
      const aqi = row?.current?.us_aqi;
      items.set(`aq-${city[0]}`, {
        kind: "airquality", id: `aq-${city[0]}`,
        name: city[0], lat, lon,
        aqi, pm25: row?.current?.pm2_5, pm10: row?.current?.pm10,
        time: row?.current?.time ? new Date(row.current.time).getTime() : null,
        raw: row,
      });
    });
    return items;
  }

  async function fetchNasaEvents(api) {
    const data = await api("eonet", "/api/v3/events", {
      status: "open", days: 30, limit: 250,
    });
    const items = new Map();
    for (const event of data?.events || []) {
      const geometry = event.geometry?.[event.geometry.length - 1];
      if (!geometry) continue;
      let lon, lat;
      if (geometry.type === "Point") {
        [lon, lat] = geometry.coordinates || [];
      } else {
        const ring = geometry.type === "Polygon"
          ? geometry.coordinates?.[0]
          : geometry.coordinates?.[0]?.[0];
        if (ring?.length) {
          lon = ring.reduce((sum, point) => sum + Number(point[0] || 0), 0) / ring.length;
          lat = ring.reduce((sum, point) => sum + Number(point[1] || 0), 0) / ring.length;
        }
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const category = event.categories?.map((item) => item.title).join(", ") || "Natural event";
      const id = `eonet-${event.id}`;
      items.set(id, {
        kind: "eonet", id, name: event.title || category,
        category, lat, lon,
        time: geometry.date ? new Date(geometry.date).getTime() : null,
        closed: event.closed ? new Date(event.closed).getTime() : null,
        sourceUrl: event.sources?.[0]?.url || "",
        raw: { id: event.id, link: event.link },
      });
    }
    return items;
  }

  function geometryCenter(geometry) {
    if (!geometry?.coordinates) return null;
    const points = [];
    const visit = (value) => {
      if (Array.isArray(value) && value.length >= 2
        && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
        points.push([Number(value[0]), Number(value[1])]);
        return;
      }
      if (Array.isArray(value)) value.forEach(visit);
    };
    visit(geometry.coordinates);
    if (!points.length) return null;
    return {
      lon: points.reduce((sum, point) => sum + point[0], 0) / points.length,
      lat: points.reduce((sum, point) => sum + point[1], 0) / points.length,
    };
  }

  async function fetchGdacs(api) {
    // EVENTS4APP (the previous endpoint) has been hanging/unresponsive from
    // GDACS's side (verified with a direct curl — TLS connects fine, no HTTP
    // response ever arrives); SEARCH is documented as an equivalent geojson
    // event-list endpoint and responds normally.
    // GDACS's backend now 400s a bare request with no query params at all
    // ("Object reference not set to an instance of an object" -- a null
    // check they added server-side without treating missing params as
    // defaults) -- confirmed live: identical request without these params
    // fails the same way even hitting gdacs.org directly, bypassing our
    // worker entirely. Explicit params matching their documented quickstart
    // example fix it.
    const data = await api("gdacs", "/gdacsapi/api/events/geteventlist/SEARCH", {
      fromdate: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
      todate: new Date().toISOString().slice(0, 10),
      alertlevel: "Green;Orange;Red",
      eventlist: "EQ;TC;FL;VO;DR;WF;TS",
    });
    const features = data?.features || data?.data?.features || (Array.isArray(data) ? data : []);
    // GDACS timestamps have no UTC offset (e.g. "2026-08-02T19:15:18") — force
    // UTC interpretation instead of letting Date.parse treat them as local.
    const toUtcMs = (value) => {
      const text = String(value || "");
      if (!text) return null;
      const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
      return Number.isFinite(ms) ? ms : null;
    };
    const items = new Map();
    for (const feature of features) {
      const p = feature.properties || feature;
      const center = geometryCenter(feature.geometry) || {
        lat: Number(p.latitude ?? p.lat),
        lon: Number(p.longitude ?? p.lon),
      };
      if (!Number.isFinite(center.lat) || !Number.isFinite(center.lon)) continue;
      const eventType = p.eventtype || p.eventType || p.type || "HAZARD";
      const eventId = p.eventid || p.eventId || feature.id || `${eventType}-${center.lat}-${center.lon}`;
      const episodeId = p.episodeid || p.episodeId || "";
      const alertLevel = String(p.alertlevel || p.alertLevel || p.alert || "Green");
      const id = `gdacs-${eventType}-${eventId}-${episodeId}`;
      // p.url is an {geometry, report, details} object on SEARCH, not a
      // flat string — prefer the human-readable report page.
      const reportUrl = typeof p.url === "string" ? p.url : p.url?.report;
      items.set(id, {
        kind: "gdacs", id, name: p.name || p.eventname || p.title || `${eventType} ${eventId}`,
        lat: center.lat, lon: center.lon, eventType, eventId, episodeId,
        alertLevel, alertScore: Number(p.alertscore ?? p.alertScore),
        severity: p.severitydata?.severitytext || p.severity || p.severitytext || p.description || "",
        country: p.country || p.countryname || p.affectedcountries?.[0]?.countryname || "",
        time: toUtcMs(p.fromdate || p.fromDate || p.date),
        updated: p.datemodified || p.todate || p.toDate || p.lastupdate || "",
        url: reportUrl || `https://www.gdacs.org/report.aspx?eventid=${encodeURIComponent(eventId)}&episodeid=${encodeURIComponent(episodeId)}&eventtype=${encodeURIComponent(eventType)}`,
        raw: feature,
      });
    }
    return items;
  }

  async function fetchCoopsStations(api) {
    const data = await api("coops", "/mdapi/prod/webapi/stations.json", { type: "waterlevels" });
    const items = new Map();
    for (const station of data?.stations || []) {
      const lat = Number(station.lat);
      const lon = Number(station.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const id = `coops-${station.id}`;
      items.set(id, {
        kind: "coops", id, stationId: String(station.id), name: station.name || station.id,
        lat, lon, state: station.state || "", tidal: !!station.tidal, greatLakes: !!station.greatlakes,
        tideType: station.tideType || "", affiliations: station.affiliations || "",
        observedSurge: !!station.observedst, floodData: !!station.inundationdb,
        raw: station,
      });
    }
    return items;
  }

  async function fetchCoopsHistory(api, station) {
    const stationId = typeof station === "object" ? station.stationId : station;
    const preferredDatum = typeof station === "object" && station.greatLakes ? "IGLD" : "MLLW";
    let datum = preferredDatum;
    let data;
    try {
      data = await api("coops", "/api/prod/datagetter", {
        date: "recent", station: stationId, product: "water_level", datum,
        time_zone: "gmt", units: "metric", format: "json", application: "MetisWeatherFeeds",
      });
    } catch (error) {
      datum = "STND";
      data = await api("coops", "/api/prod/datagetter", {
        date: "recent", station: stationId, product: "water_level", datum,
        time_zone: "gmt", units: "metric", format: "json", application: "MetisWeatherFeeds",
      });
    }
    const points = (data?.data || []).map((row) => ({
      t: Date.parse(String(row.t || "").replace(" ", "T") + "Z"),
      v: Number(row.v),
    })).filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v));
    points.datum = datum;
    return points;
  }

  async function fetchAircraft(api, bounds) {
    if (!bounds) return new Map();
    const params = {
      lamin: bounds.latBottom, lamax: bounds.latTop,
      lomin: bounds.lonLeft, lomax: bounds.lonRight,
    };
    const data = await api("opensky", "/api/states/all", params);
    const items = new Map();
    // Defense-in-depth: even a bbox-capped view over busy airspace (e.g.
    // Western Europe) can carry a few hundred aircraft; a hard cap keeps a
    // single dense view from ever building thousands of map markers.
    const MAX_AIRCRAFT = 600;
    for (const row of (data?.states || []).slice(0, MAX_AIRCRAFT)) {
      if (!row || row[5] == null || row[6] == null) continue;
      const icao = row[0] || `unk-${row[1]}`;
      items.set(`ac-${icao}`, {
        kind: "aircraft", id: `ac-${icao}`,
        name: row[1] ? `Callsign ${String(row[1]).trim()}` : icao,
        icao, callsign: row[1] ? String(row[1]).trim() : null, country: row[2],
        lat: row[6], lon: row[5],
        baroAlt: row[7], geoAlt: row[13],
        onGround: !!row[8],
        velocity: row[9], trueTrack: row[10], heading: row[10],
        verticalRate: row[11], squawk: row[14],
        raw: row,
      });
    }
    return items;
  }

  async function fetchSpaceWeather(api) {
    const [kp1m, kp3h] = await Promise.all([
      api("swpc", "/json/planetary_k_index_1m.json", {}).catch(() => []),
      api("swpc", "/products/noaa-planetary-k-index.json", {}).catch(() => []),
    ]);
    const r1 = Array.isArray(kp1m) && kp1m.length ? kp1m[kp1m.length - 1] : null;
    const r3 = Array.isArray(kp3h) && kp3h.length ? kp3h[kp3h.length - 1] : null;
    const kIndex = r1?.kp_index ?? r1?.estimated_kp ?? r3?.Kp ?? null;
    const kp3hSeries = (Array.isArray(kp3h) ? kp3h : [])
      .map((r) => ({ t: new Date(r.time_tag).getTime(), v: r.Kp }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
    const kp1mSeries = (Array.isArray(kp1m) ? kp1m : []).slice(-120)
      .map((r) => ({ t: new Date(r.time_tag).getTime(), v: r.kp_index ?? r.estimated_kp }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
    return {
      kIndex,
      kpBand: r1?.kp ?? null,
      time: r1?.time_tag ?? r3?.time_tag ?? null,
      aIndex: r3?.a_running ?? null,
      kp3h: r3?.Kp ?? null,
      source: r1 ? "1-minute" : "3-hour",
      kpSeries: kp3hSeries,
      kp1mSeries,
    };
  }

  function parseCadDate(s) {
    if (!s) return null;
    const t = Date.parse(String(s).replace(/(\d{4})-(\w{3})-(\d{2})/, "$1 $2 $3"));
    return Number.isFinite(t) ? t : null;
  }

  async function fetchNeoApproach(api) {
    const now = new Date();
    const end = new Date(now.getTime() + 400 * 86400000);
    const data = await api("cneos", "/cad.api", {
      "date-min": now.toISOString().slice(0, 10),
      "date-max": end.toISOString().slice(0, 10),
      "dist-max": 0.05,
    });
    const items = new Map();
    const fi = (n) => (data?.fields || []).indexOf(n);
    for (const row of data?.data || []) {
      const des = row[fi("des")];
      const cd = row[fi("cd")];
      const id = `ca-${des}-${cd}`;
      const distAU = parseFloat(row[fi("dist")]);
      items.set(id, {
        kind: "neoapproach", id, listOnly: true,
        name: des, designation: des,
        closeDate: cd,
        distAU, distLD: Number.isFinite(distAU) ? distAU * 389.17 : null,
        distMinAU: parseFloat(row[fi("dist_min")]),
        distMaxAU: parseFloat(row[fi("dist_max")]),
        vRel: parseFloat(row[fi("v_rel")]),
        vInf: parseFloat(row[fi("v_inf")]),
        hMag: parseFloat(row[fi("h")]),
        time: parseCadDate(cd),
        raw: row,
      });
    }
    return items;
  }

  async function fetchSentry(api) {
    const data = await api("cneos", "/sentry.api", {});
    const items = new Map();
    const rows = [...(data?.data || [])]
      .sort((a, b) => parseFloat(b.ip || 0) - parseFloat(a.ip || 0))
      .slice(0, 150);
    for (const row of rows) {
      const des = row.des || row.id;
      items.set(`sentry-${des}`, {
        kind: "sentry", id: `sentry-${des}`, listOnly: true,
        name: row.fullname || des, designation: des,
        impactProb: parseFloat(row.ip),
        palermoCum: parseFloat(row.ps_cum),
        palermoMax: parseFloat(row.ps_max),
        torinoMax: row.ts_max != null ? +row.ts_max : null,
        vInf: parseFloat(row.v_inf),
        yearRange: row.range,
        lastObs: row.last_obs,
        raw: row,
      });
    }
    return items;
  }

  async function fetchScout(api) {
    const data = await api("cneos", "/scout.api", {});
    const items = new Map();
    for (const row of data?.data || []) {
      const name = row.objectName || row.temporaryName || row.des || row.id || "NEOCP";
      const id = `scout-${name}-${row.tEphem || ""}`;
      const raDeg = parseRa(row.ra);
      const decDeg = parseDec(row.dec);
      const time = parseEphemerisTime(row.tEphem) ?? Date.now();
      const sub = zenithSubpoint(raDeg, decDeg, time);
      items.set(id, {
        kind: "scout", id,
        name,
        vmag: row.Vmag != null ? parseFloat(row.Vmag) : null,
        moid: row.moid, vInf: row.vInf != null ? parseFloat(row.vInf) : null,
        ra: row.ra, dec: row.dec, raDeg, decDeg,
        uncertainty: row.unc,
        ephemerisTime: row.tEphem, time,
        ieoScore: row.ieoScore,
        elongation: row.elong, motionRate: row.rate,
        positionType: sub ? "zenith_subpoint" : "celestial",
        lat: sub?.lat ?? null, lon: sub?.lon ?? null,
        coordSystem: "ICRS",
        raw: row,
      });
    }
    return items;
  }

  async function fetchAurora(api) {
    const data = await api("swpc", "/json/ovation_aurora_latest.json", {});
    const items = new Map();
    const coords = data?.coordinates || [];
    let i = 0;
    for (const [lon, lat, prob] of coords) {
      // Aurora activity isn't northern-hemisphere-only -- during quiet
      // geomagnetic conditions (or southern-hemisphere winter) the
      // strongest real activity can sit entirely in the south. Excluding
      // lat<35 outright meant a one-sided globe: whenever nothing qualified
      // north of 35°, the layer silently showed zero points even with real
      // Southern Lights activity present (verified live: current max
      // probability anywhere was 22%, entirely at -60° lat).
      if (prob < 20 || Math.abs(lat) < 35) continue;
      if (i++ % 12 !== 0) continue;
      const id = `aurora-${lon}-${lat}`;
      items.set(id, {
        kind: "aurora", id,
        name: `Aurora ${prob}%`, lat, lon, probability: prob,
        observationTime: data["Observation Time"], forecastTime: data["Forecast Time"],
      });
    }
    return items;
  }

  async function fetchEarthImagery(api) {
    const end = new Date();
    const start = new Date(end.getTime() - 2 * 86400000);
    const data = await api("earthsearch", "/v1/search", {
      limit: 30,
      datetime: `${start.toISOString().slice(0, 19)}Z/${end.toISOString().slice(0, 19)}Z`,
    });
    const items = new Map();
    for (const f of data?.features || []) {
      const c = bboxCentroid(f.bbox);
      if (!c) continue;
      const p = f.properties || {};
      const id = `stac-${f.id}`;
      items.set(id, {
        kind: "earthimagery", id,
        name: p["sat:platform_international_designator"] || f.collection || f.id,
        lat: c.lat, lon: c.lon,
        collection: f.collection, datetime: p.datetime || p.start_datetime,
        cloudCover: p["eo:cloud_cover"], platform: p.platform,
        raw: { id: f.id, bbox: f.bbox, collection: f.collection },
      });
    }
    return items;
  }

  return {
    isElevatedVolcano, normQuake, normVolcano, parseNdbcHistory, parseNdbcHistorySeries,
    parseRa, parseDec, zenithSubpoint, gmstDegrees,
    formatRaHms, formatDecDms,
    fetchEarthquakes, fetchRegionalQuakes, fetchVolcanoes, fetchCyclones, fetchTsunami, fetchVolcanicAsh,
    fetchFireballs, fetchBuoys, fetchMetar, fetchAirQuality, fetchNasaEvents, fetchGdacs,
    fetchCoopsStations, fetchCoopsHistory, fetchAircraft,
    fetchSpaceWeather, fetchAurora, fetchEarthImagery,
    fetchNeoApproach, fetchSentry, fetchScout,
  };
})();
