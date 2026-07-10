/* CORS-direct global layer fetchers — browser fetch only, no proxy */
window.GlobalLayers = (() => {
  "use strict";

  const WORLD_CITIES = [
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
    ["Honolulu", 21.31, -157.86], ["Miami", 25.76, -80.19], ["San Francisco", 37.77, -122.42],
    ["Lima", -12.05, -77.04], ["Bogotá", 4.71, -74.07], ["Santiago", -33.45, -70.67],
    ["Cape Town", -33.92, 18.42], ["Casablanca", 33.57, -7.59], ["Tehran", 35.69, 51.39],
    ["Karachi", 24.86, 67.00], ["Dhaka", 23.81, 90.41], ["Manila", 14.60, 120.98],
    ["Taipei", 25.03, 121.57], ["Hong Kong", 22.32, 114.17], ["Auckland", -36.85, 174.76],
  ];

  const COASTAL_CITIES = [
    ["Honolulu", 21.31, -157.86], ["San Francisco", 37.77, -122.42], ["Los Angeles", 33.74, -118.27],
    ["Miami", 25.76, -80.19], ["New York", 40.58, -73.94], ["Vancouver", 49.28, -123.12],
    ["Sydney", -33.87, 151.21], ["Melbourne", -37.81, 144.96], ["Tokyo", 35.45, 139.77],
    ["Oslo", 59.91, 10.75], ["Reykjavik", 64.15, -21.94], ["Lisbon", 38.72, -9.14],
    ["Barcelona", 41.39, 2.20], ["Athens", 37.94, 23.64], ["Istanbul", 41.01, 29.01],
    ["Dubai", 25.27, 55.30], ["Mumbai", 18.94, 72.83], ["Singapore", 1.26, 103.85],
    ["Jakarta", -6.12, 106.85], ["Manila", 14.58, 120.97], ["Auckland", -36.84, 174.77],
    ["Cape Town", -33.90, 18.42], ["Rio de Janeiro", -22.91, -43.17], ["Buenos Aires", -34.61, -58.37],
    ["Anchorage", 61.22, -149.90], ["Seattle", 47.61, -122.34], ["Boston", 42.36, -71.06],
  ];

  function bboxCentroid(bbox) {
    if (!bbox || bbox.length < 4) return null;
    return { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
  }

  function ringCentroid(ring) {
    if (!ring?.length) return null;
    let lat = 0, lon = 0, n = 0;
    for (const c of ring) {
      if (!Array.isArray(c) || c.length < 2) continue;
      lon += c[0]; lat += c[1]; n++;
    }
    return n ? { lon: lon / n, lat: lat / n } : null;
  }

  function geomCentroid(geom) {
    if (!geom) return null;
    if (geom.type === "Point") return { lon: geom.coordinates[0], lat: geom.coordinates[1] };
    if (geom.type === "Polygon" && geom.coordinates?.[0]) return ringCentroid(geom.coordinates[0]);
    if (geom.type === "MultiPolygon" && geom.coordinates?.[0]?.[0]) return ringCentroid(geom.coordinates[0][0]);
    return null;
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

  function batchCoords(cities) {
    return {
      lats: cities.map((c) => c[1]).join(","),
      lons: cities.map((c) => c[2]).join(","),
    };
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
    const days = opts.days || 30;
    const radius = opts.radiusKm || 100;
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const data = await api("earthquake", "/fdsnws/event/1/query", {
      format: "geojson",
      starttime: start.toISOString().slice(0, 19),
      endtime: end.toISOString().slice(0, 19),
      latitude: lat, longitude: lon, maxradiuskm: radius,
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
      const c = geomCentroid(f.geometry);
      if (!c) continue;
      const id = `tsunami-alert-${p.id || p.sent}`;
      items.set(id, {
        kind: "tsunami", id,
        name: p.event || p.headline || "Active tsunami alert",
        lat: c.lat, lon: c.lon, severity: p.severity, urgency: p.urgency,
        source: "NWS", active: true,
        time: p.sent ? new Date(p.sent).getTime() : Date.now(),
        raw: p, geometry: f.geometry,
      });
    }
    return items;
  }

  async function fetchNwsAlerts(api) {
    const data = await api("nws", "/alerts/active", {});
    const items = new Map();
    for (const f of data?.features || []) {
      const p = f.properties || {};
      const c = geomCentroid(f.geometry);
      if (!c) continue;
      const id = `nws-${p.id || p.sent}`;
      items.set(id, {
        kind: "nwsalert", id,
        name: p.headline || p.event || "Weather alert",
        event: p.event, severity: p.severity, urgency: p.urgency,
        lat: c.lat, lon: c.lon,
        area: p.areaDesc, sender: p.senderName,
        time: p.sent ? new Date(p.sent).getTime() : null,
        expires: p.expires ? new Date(p.expires).getTime() : null,
        description: p.description, instruction: p.instruction,
        geometry: f.geometry, raw: p,
      });
    }
    return items;
  }

  async function fetchAirQuality(api) {
    const { lats, lons } = batchCoords(WORLD_CITIES);
    const om = window.OpenMeteo;
    const data = await api("openmeteoAq", "/v1/air-quality", {
      latitude: lats, longitude: lons,
      current: om.AQ_CURRENT_LITE,
    });
    const rows = Array.isArray(data) ? data : [data];
    const items = new Map();
    rows.forEach((row, i) => {
      const city = WORLD_CITIES[i];
      if (!city) return;
      const [, lat, lon] = city;
      const aq = om.summarizeAq(row?.current);
      items.set(`aq-${city[0]}`, {
        kind: "airquality", id: `aq-${city[0]}`,
        name: city[0], lat, lon,
        aqi: aq.aqi, euAqi: aq.euAqi,
        pm25: aq.pm25, pm10: aq.pm10,
        ozone: aq.ozone, no2: aq.no2, uv: aq.uv,
        time: aq.time, raw: row,
      });
    });
    return items;
  }

  async function fetchWeather(api, opts = {}) {
    const { lats, lons } = batchCoords(WORLD_CITIES);
    const om = window.OpenMeteo;
    const params = {
      latitude: lats, longitude: lons,
      current: om.FORECAST_CURRENT_LITE,
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
      timezone: "auto", forecast_days: 7,
    };
    if (opts.model && opts.model !== "best_match") params.models = opts.model;
    const data = await api("openmeteo", "/v1/forecast", params);
    const rows = Array.isArray(data) ? data : [data];
    const items = new Map();
    rows.forEach((row, i) => {
      const city = WORLD_CITIES[i];
      if (!city) return;
      const [, lat, lon] = city;
      const s = om.summarizeCurrent(row?.current);
      items.set(`wx-${city[0]}`, {
        kind: "weather", id: `wx-${city[0]}`,
        name: city[0], lat, lon,
        temp: s.temp, feelsLike: s.feelsLike,
        humidity: s.humidity, wind: s.wind, gusts: s.gusts,
        pressure: s.pressure, cloud: s.cloud,
        weatherCode: s.weatherCode, precip: s.precip,
        time: s.time, forecast: row,
      });
    });
    return items;
  }

  async function fetchMarine(api) {
    const { lats, lons } = batchCoords(COASTAL_CITIES);
    const om = window.OpenMeteo;
    const data = await api("openmeteoMarine", "/v1/marine", {
      latitude: lats, longitude: lons,
      current: om.MARINE_CURRENT,
      hourly: om.MARINE_HOURLY,
      timezone: "auto", forecast_days: 7, past_days: 3,
    });
    const rows = Array.isArray(data) ? data : [data];
    const items = new Map();
    rows.forEach((row, i) => {
      const city = COASTAL_CITIES[i];
      if (!city) return;
      const [, lat, lon] = city;
      const cur = row?.current || {};
      items.set(`marine-${city[0]}`, {
        kind: "marine", id: `marine-${city[0]}`,
        name: city[0], lat, lon,
        waveHeight: cur.wave_height, waveDir: cur.wave_direction,
        wavePeriod: cur.wave_period,
        sst: cur.sea_surface_temperature, current: cur.ocean_current_velocity,
        time: cur.time ? new Date(cur.time).getTime() : null,
        forecast: row,
      });
    });
    return items;
  }

  async function fetchPointWeather(api, lat, lon, opts = {}) {
    return window.OpenMeteo.fetchPointBundle(api, lat, lon, opts);
  }

  async function fetchWeatherBbox(api, bbox, model, opts = {}) {
    const cells = await window.OpenMeteo.fetchBboxGrid(api, bbox, model, opts);
    const items = new Map();
    for (const cell of cells) {
      if (!Number.isFinite(cell.lat) || !Number.isFinite(cell.lon)) continue;
      items.set(cell.id, cell);
    }
    return items;
  }

  async function fetchWeatherFull(api, lat, lon, opts) {
    return window.OpenMeteo.fetchForecastFull(api, lat, lon, opts);
  }

  async function fetchAirQualityFull(api, lat, lon, opts) {
    return window.OpenMeteo.fetchAirQualityFull(api, lat, lon, opts);
  }

  async function fetchMarineFull(api, lat, lon, opts) {
    return window.OpenMeteo.fetchMarineFull(api, lat, lon, opts);
  }

  async function fetchWeatherArchive(api, lat, lon, days = 30) {
    return window.OpenMeteo.fetchArchive(api, lat, lon, days);
  }

  async function fetchAirQualityHistory(api, lat, lon, pastDays = 7) {
    return window.OpenMeteo.fetchAirQualityFull(api, lat, lon, { pastDays, forecastDays: 3 });
  }

  async function fetchSpaceWeather(api) {
    const [kp1m, kp3h, solarWind, xrays] = await Promise.all([
      api("swpc", "/json/planetary_k_index_1m.json", {}).catch(() => []),
      api("swpc", "/products/noaa-planetary-k-index.json", {}).catch(() => []),
      api("swpc", "/json/rtsw/rtsw_wind_1m.json", {}).catch(() => []),
      api("swpc", "/json/goes/primary/xrays-6-hour.json", {}).catch(() => []),
    ]);
    const r1 = Array.isArray(kp1m) && kp1m.length ? kp1m[kp1m.length - 1] : null;
    const r3 = Array.isArray(kp3h) && kp3h.length ? kp3h[kp3h.length - 1] : null;
    const kIndex = r1?.kp_index ?? r1?.estimated_kp ?? r3?.Kp ?? null;
    const kp3hSeries = (Array.isArray(kp3h) ? kp3h : [])
      .map((r) => ({ t: new Date(r.time_tag).getTime(), v: r.Kp }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
    const kp1mSeries = (Array.isArray(kp1m) ? kp1m : []).slice(-180)
      .map((r) => ({ t: new Date(r.time_tag).getTime(), v: r.kp_index ?? r.estimated_kp }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));

    let windSpeed = null;
    let windTime = null;
    const swRows = Array.isArray(solarWind) ? solarWind : [];
    if (swRows.length) {
      const last = swRows[swRows.length - 1];
      windSpeed = last?.proton_speed ?? null;
      windTime = last?.time_tag ?? null;
    }
    const windSeries = swRows.slice(-240)
      .map((r) => ({ t: new Date(r.time_tag).getTime(), v: r.proton_speed }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));

    const xraySeries = (Array.isArray(xrays) ? xrays : []).slice(-120)
      .map((r) => ({ t: new Date(r.time_tag).getTime(), v: r.flux }))
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
      solarWindSpeed: windSpeed,
      solarWindTime: windTime,
      windSeries,
      xraySeries,
    };
  }

  async function fetchAurora(api) {
    const data = await api("swpc", "/json/ovation_aurora_latest.json", {});
    const items = new Map();
    const coords = data?.coordinates || [];
    let i = 0;
    for (const [lon, lat, prob] of coords) {
      if (prob < 20 || lat < 35) continue;
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

  const WMO_CODES = {
    0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle", 53: "Drizzle",
    55: "Dense drizzle", 61: "Slight rain", 63: "Rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers",
    81: "Rain showers", 82: "Violent rain showers", 95: "Thunderstorm",
    96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
  };

  function weatherLabel(code) {
    return WMO_CODES[code] || (code != null ? `Code ${code}` : "—");
  }

  return {
    WORLD_CITIES, COASTAL_CITIES,
    isElevatedVolcano, normQuake, normVolcano, weatherLabel, geomCentroid,
    fetchEarthquakes, fetchRegionalQuakes, fetchVolcanoes, fetchTsunami,
    fetchNwsAlerts, fetchAirQuality, fetchWeather, fetchMarine,
    fetchPointWeather, fetchWeatherBbox, fetchWeatherFull, fetchAirQualityFull, fetchMarineFull,
    fetchWeatherArchive, fetchAirQualityHistory,
    fetchSpaceWeather, fetchAurora, fetchEarthImagery,
  };
})();
