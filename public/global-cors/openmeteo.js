/* Open-Meteo API bundles, models, bbox, pressure levels, 15-min data */
window.OpenMeteo = (() => {
  "use strict";

  const WEATHER_MODELS = [
    { id: "best_match", label: "Best match (auto)", bbox: false, resDeg: null },
    { id: "ecmwf_ifs", label: "ECMWF IFS (~9 km)", bbox: true, resDeg: 0.1 },
    { id: "icon_global", label: "DWD ICON Global", bbox: true, resDeg: 0.13 },
    { id: "gfs_global", label: "NOAA GFS Global", bbox: false, resDeg: 0.25 },
    { id: "gem_global", label: "GEM Canada Global", bbox: true, resDeg: 0.15 },
    { id: "bom_access_global", label: "BOM ACCESS Global", bbox: true, resDeg: 0.2 },
    { id: "ukmo_global_deterministic_10km", label: "UK Met Office 10 km", bbox: true, resDeg: 0.1 },
    { id: "cma_grapes_global", label: "CMA GRAPES Global", bbox: true, resDeg: 0.12 },
    { id: "icon_eu", label: "DWD ICON EU", bbox: false, resDeg: 0.06 },
    { id: "icon_d2", label: "DWD ICON D2 (Central EU)", bbox: false, resDeg: 0.02 },
    { id: "meteofrance_arome_france", label: "Météo-France AROME", bbox: false, resDeg: 0.01 },
    { id: "jma_gsm", label: "JMA GSM", bbox: false, resDeg: 0.2 },
    { id: "metno_nordic", label: "MET Norway Nordic", bbox: false, resDeg: 0.05 },
  ];

  const PRESSURE_LEVELS = [1000, 850, 700, 500, 300, 250, 200];

  const FORECAST_CURRENT = [
    "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature",
    "precipitation", "weather_code", "surface_pressure", "cloud_cover",
    "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
  ].join(",");

  const FORECAST_HOURLY = [
    "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature",
    "precipitation_probability", "precipitation", "rain", "showers", "snowfall", "snow_depth",
    "weather_code", "surface_pressure", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "cloud_cover",
    "visibility", "evapotranspiration", "et0_fao_evapotranspiration", "vapour_pressure_deficit",
    "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
    "wind_speed_80m", "wind_speed_120m", "temperature_80m", "temperature_120m",
    "shortwave_radiation", "direct_radiation", "diffuse_radiation",
    "soil_temperature_0cm", "soil_temperature_6cm", "soil_temperature_18cm",
    "soil_moisture_0_to_1cm", "soil_moisture_1_to_3cm", "soil_moisture_3_to_9cm",
  ].join(",");

  const FORECAST_PRESSURE_HOURLY = PRESSURE_LEVELS.flatMap((hPa) => [
    `temperature_${hPa}hPa`,
    `wind_speed_${hPa}hPa`,
    `wind_direction_${hPa}hPa`,
    `geopotential_height_${hPa}hPa`,
    `relative_humidity_${hPa}hPa`,
  ]).join(",");

  const FORECAST_MINUTELY_15 = [
    "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature",
    "precipitation", "rain", "snowfall", "weather_code",
    "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
    "shortwave_radiation", "direct_radiation", "diffuse_radiation",
  ].join(",");

  const FORECAST_DAILY = [
    "weather_code", "temperature_2m_max", "temperature_2m_min",
    "precipitation_sum", "rain_sum", "showers_sum", "snowfall_sum",
    "wind_speed_10m_max", "wind_gusts_10m_max", "wind_direction_10m_dominant",
    "sunrise", "sunset", "daylight_duration",
  ].join(",");

  const FORECAST_CURRENT_LITE = [
    "temperature_2m", "relative_humidity_2m", "apparent_temperature",
    "precipitation", "weather_code", "surface_pressure", "cloud_cover",
    "wind_speed_10m", "wind_gusts_10m",
  ].join(",");

  const BBOX_HOURLY_LITE = "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,surface_pressure";

  const AQ_CURRENT = "us_aqi,european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone,dust,uv_index";
  const AQ_HOURLY = "us_aqi,european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,dust,uv_index";
  const AQ_CURRENT_LITE = "us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide";

  const MARINE_CURRENT = "wave_height,wave_direction,wave_period,sea_surface_temperature,ocean_current_velocity";
  const MARINE_HOURLY = "wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,sea_surface_temperature,ocean_current_velocity";

  const ARCHIVE_DAILY = [
    "temperature_2m_max", "temperature_2m_min", "precipitation_sum", "rain_sum", "snowfall_sum",
    "wind_speed_10m_max", "shortwave_radiation_sum", "et0_fao_evapotranspiration",
  ].join(",");

  const COLORS = ["#fbbf24", "#fb923c", "#f87171", "#60a5fa", "#38bdf8", "#4ade80", "#a78bfa", "#f472b6"];

  function modelById(id) {
    return WEATHER_MODELS.find((m) => m.id === id) || WEATHER_MODELS[0];
  }

  function estimateBboxCells(bbox, modelId) {
    const m = modelById(modelId);
    const res = m.resDeg || 0.25;
    const latCells = Math.max(1, Math.ceil((bbox.north - bbox.south) / res));
    const lonCells = Math.max(1, Math.ceil((bbox.east - bbox.west) / res));
    return latCells * lonCells;
  }

  function series(times, values, gc) {
    return gc.hourlySeries(times, values);
  }

  function tab(id, label, unit, seriesList) {
    return { id, label, unit, series: seriesList };
  }

  function line(label, points, color) {
    return { label, points, color };
  }

  function buildForecastParams(opts = {}) {
    const full = opts.full !== false;
    const params = {
      forecast_days: opts.forecastDays ?? 16,
      past_days: opts.pastDays ?? 7,
      current: opts.lite ? FORECAST_CURRENT_LITE : FORECAST_CURRENT,
      hourly: opts.lite ? BBOX_HOURLY_LITE : FORECAST_HOURLY,
      daily: opts.lite ? undefined : FORECAST_DAILY,
    };
    if (opts.bbox) {
      params.timezone = "GMT";
    } else {
      params.timezone = "auto";
    }
    if (full && !opts.lite) {
      params.hourly = `${FORECAST_HOURLY},${FORECAST_PRESSURE_HOURLY}`;
      params.minutely_15 = FORECAST_MINUTELY_15;
      params.forecast_minutely_15 = opts.forecastMinutely15 ?? 96;
      params.past_minutely_15 = opts.pastMinutely15 ?? 96;
    }
    const model = opts.model;
    if (model && model !== "best_match") params.models = model;
    if (opts.bbox) {
      const { south, west, north, east } = opts.bbox;
      params.bounding_box = `${south},${west},${north},${east}`;
    } else {
      params.latitude = opts.lat;
      params.longitude = opts.lon;
    }
    for (const k of Object.keys(params)) {
      if (params[k] === undefined) delete params[k];
    }
    return params;
  }

  function buildMinutely15Charts(wx, gc) {
    const m = wx?.minutely_15;
    if (!m?.time?.length) return [];
    return [
      tab("m15temp", "15-min temperature", "°C", [
        line("2 m", series(m.time, m.temperature_2m, gc), "#fbbf24"),
        line("Feels like", series(m.time, m.apparent_temperature, gc), "#fb923c"),
        line("Dew point", series(m.time, m.dew_point_2m, gc), "#60a5fa"),
      ]),
      tab("m15precip", "15-min precipitation", "mm", [
        line("Total", series(m.time, m.precipitation, gc), "#38bdf8"),
        line("Rain", series(m.time, m.rain, gc), "#3b82f6"),
        line("Snow", series(m.time, m.snowfall, gc), "#e2e8f0"),
      ]),
      tab("m15wind", "15-min wind", "km/h", [
        line("Speed", series(m.time, m.wind_speed_10m, gc), "#4ade80"),
        line("Gusts", series(m.time, m.wind_gusts_10m, gc), "#22c55e"),
      ]),
      tab("m15solar", "15-min solar", "W/m²", [
        line("Shortwave", series(m.time, m.shortwave_radiation, gc), "#fbbf24"),
        line("Direct", series(m.time, m.direct_radiation, gc), "#f59e0b"),
        line("Diffuse", series(m.time, m.diffuse_radiation, gc), "#fcd34d"),
      ]),
    ];
  }

  function buildPressureCharts(wx, gc) {
    const h = wx?.hourly;
    if (!h?.time?.length) return [];
    const tabs = [];
    const tempSeries = PRESSURE_LEVELS.map((hPa, i) =>
      line(`${hPa} hPa`, series(h.time, h[`temperature_${hPa}hPa`], gc), COLORS[i % COLORS.length])
    ).filter((s) => s.points.length);
    if (tempSeries.length) {
      tabs.push(tab("pltemp", "Pressure-level temperature", "°C", tempSeries));
    }
    const windSeries = [850, 500, 300].map((hPa, i) =>
      line(`${hPa} hPa`, series(h.time, h[`wind_speed_${hPa}hPa`], gc), COLORS[i % COLORS.length])
    ).filter((s) => s.points.length);
    if (windSeries.length) {
      tabs.push(tab("plwind", "Pressure-level wind", "km/h", windSeries));
    }
    const ghSeries = [850, 500, 300].map((hPa, i) =>
      line(`${hPa} hPa`, series(h.time, h[`geopotential_height_${hPa}hPa`], gc), COLORS[i % COLORS.length])
    ).filter((s) => s.points.length);
    if (ghSeries.length) {
      tabs.push(tab("plheight", "Geopotential height", "m", ghSeries));
    }
    const rhSeries = [1000, 850, 700, 500].map((hPa, i) =>
      line(`${hPa} hPa`, series(h.time, h[`relative_humidity_${hPa}hPa`], gc), COLORS[i % COLORS.length])
    ).filter((s) => s.points.length);
    if (rhSeries.length) {
      tabs.push(tab("plrh", "Pressure-level humidity", "%", rhSeries));
    }
    return tabs;
  }

  function buildWeatherCharts(wx, archive, gc) {
    const tabs = [];
    const h = wx?.hourly;
    const d = wx?.daily;
    if (!h?.time?.length) return tabs;

    tabs.push(tab("temp", "Temperature (hourly)", "°C", [
      line("2 m", series(h.time, h.temperature_2m, gc), "#fbbf24"),
      line("Feels like", series(h.time, h.apparent_temperature, gc), "#fb923c"),
      line("Dew point", series(h.time, h.dew_point_2m, gc), "#60a5fa"),
    ]));

    tabs.push(tab("humidity", "Humidity & pressure", "% / hPa", [
      line("Humidity", series(h.time, h.relative_humidity_2m, gc), "#38bdf8"),
      line("Pressure", series(h.time, h.surface_pressure, gc), "#a78bfa"),
    ]));

    tabs.push(tab("precip", "Precipitation", "mm", [
      line("Total", series(h.time, h.precipitation, gc), "#38bdf8"),
      line("Rain", series(h.time, h.rain, gc), "#3b82f6"),
      line("Showers", series(h.time, h.showers, gc), "#60a5fa"),
      line("Snow", series(h.time, h.snowfall, gc), "#e2e8f0"),
    ]));

    if (h.precipitation_probability) {
      tabs.push(tab("precipprob", "Precip probability", "%", [
        line("Probability", series(h.time, h.precipitation_probability, gc), "#818cf8"),
      ]));
    }

    tabs.push(tab("wind", "Wind", "km/h", [
      line("Speed 10 m", series(h.time, h.wind_speed_10m, gc), "#4ade80"),
      line("Speed 80 m", series(h.time, h.wind_speed_80m, gc), "#22c55e"),
      line("Speed 120 m", series(h.time, h.wind_speed_120m, gc), "#16a34a"),
      line("Gusts", series(h.time, h.wind_gusts_10m, gc), "#86efac"),
    ]));

    tabs.push(tab("cloud", "Cloud & visibility", "% / km", [
      line("Total", series(h.time, h.cloud_cover, gc), "#94a3b8"),
      line("Low", series(h.time, h.cloud_cover_low, gc), "#64748b"),
      line("Mid", series(h.time, h.cloud_cover_mid, gc), "#475569"),
      line("High", series(h.time, h.cloud_cover_high, gc), "#cbd5e1"),
      line("Visibility", series(h.time, h.visibility, gc), "#e2e8f0"),
    ]));

    if (h.shortwave_radiation) {
      tabs.push(tab("solar", "Solar radiation", "W/m²", [
        line("Shortwave", series(h.time, h.shortwave_radiation, gc), "#fbbf24"),
        line("Direct", series(h.time, h.direct_radiation, gc), "#f59e0b"),
        line("Diffuse", series(h.time, h.diffuse_radiation, gc), "#fcd34d"),
      ]));
    }

    if (h.soil_temperature_0cm || h.soil_moisture_0_to_1cm) {
      tabs.push(tab("soil", "Soil", "°C / m³/m³", [
        line("Temp 0 cm", series(h.time, h.soil_temperature_0cm, gc), "#ea580c"),
        line("Temp 6 cm", series(h.time, h.soil_temperature_6cm, gc), "#c2410c"),
        line("Temp 18 cm", series(h.time, h.soil_temperature_18cm, gc), "#9a3412"),
        line("Moist 0–1 cm", series(h.time, h.soil_moisture_0_to_1cm, gc), "#854d0e"),
        line("Moist 1–3 cm", series(h.time, h.soil_moisture_1_to_3cm, gc), "#713f12"),
        line("Moist 3–9 cm", series(h.time, h.soil_moisture_3_to_9cm, gc), "#5c3310"),
      ]));
    }

    if (d?.time?.length) {
      tabs.push(tab("daily", "Daily summary", "°C / mm", [
        line("Max temp", gc.dailySeries(d.time, d.temperature_2m_max), "#f87171"),
        line("Min temp", gc.dailySeries(d.time, d.temperature_2m_min), "#60a5fa"),
        line("Precip sum", gc.dailySeries(d.time, d.precipitation_sum), "#38bdf8"),
      ]));
    }

    if (archive?.daily?.time?.length) {
      const ad = archive.daily;
      tabs.push(tab("archive", "Historical archive", "°C / mm", [
        line("Max", gc.dailySeries(ad.time, ad.temperature_2m_max), "#f87171"),
        line("Min", gc.dailySeries(ad.time, ad.temperature_2m_min), "#60a5fa"),
        line("Precip", gc.dailySeries(ad.time, ad.precipitation_sum), "#38bdf8"),
      ]));
    }

    tabs.push(...buildMinutely15Charts(wx, gc));
    tabs.push(...buildPressureCharts(wx, gc));
    return tabs;
  }

  function buildAirQualityCharts(aq, gc) {
    const h = aq?.hourly;
    if (!h?.time?.length) return [];
    return [
      tab("aqi", "Air quality index", "AQI", [
        line("US AQI", series(h.time, h.us_aqi, gc), "#38bdf8"),
        line("European AQI", series(h.time, h.european_aqi, gc), "#818cf8"),
      ]),
      tab("pm", "Particulates", "µg/m³", [
        line("PM2.5", series(h.time, h.pm2_5, gc), "#f472b6"),
        line("PM10", series(h.time, h.pm10, gc), "#fb7185"),
        line("Dust", series(h.time, h.dust, gc), "#d97706"),
      ]),
      tab("gases", "Gases & ozone", "µg/m³", [
        line("O₃", series(h.time, h.ozone, gc), "#4ade80"),
        line("NO₂", series(h.time, h.nitrogen_dioxide, gc), "#a78bfa"),
        line("SO₂", series(h.time, h.sulphur_dioxide, gc), "#facc15"),
        line("CO", series(h.time, h.carbon_monoxide, gc), "#94a3b8"),
      ]),
      tab("uv", "UV index", "", [
        line("UV", series(h.time, h.uv_index, gc), "#fbbf24"),
      ]),
    ];
  }

  function buildMarineCharts(marine, gc) {
    const h = marine?.hourly;
    if (!h?.time?.length) return [];
    return [
      tab("waves", "Waves", "m", [
        line("Wave height", series(h.time, h.wave_height, gc), "#38bdf8"),
        line("Swell height", series(h.time, h.swell_wave_height, gc), "#60a5fa"),
      ]),
      tab("period", "Wave period", "s", [
        line("Wave period", series(h.time, h.wave_period, gc), "#4ade80"),
        line("Swell period", series(h.time, h.swell_wave_period, gc), "#22c55e"),
      ]),
      tab("sst", "Sea surface temp", "°C", [
        line("SST", series(h.time, h.sea_surface_temperature, gc), "#f472b6"),
      ]),
      tab("current", "Ocean current", "km/h", [
        line("Current", series(h.time, h.ocean_current_velocity, gc), "#a78bfa"),
      ]),
    ];
  }

  function buildAllCharts(wx, archive, aq, marine, gc) {
    return [
      ...buildWeatherCharts(wx, archive, gc),
      ...buildAirQualityCharts(aq, gc),
      ...buildMarineCharts(marine, gc),
    ];
  }

  function summarizeCurrent(cur) {
    if (!cur) return {};
    return {
      temp: cur.temperature_2m,
      feelsLike: cur.apparent_temperature,
      humidity: cur.relative_humidity_2m,
      dewPoint: cur.dew_point_2m,
      precip: cur.precipitation,
      pressure: cur.surface_pressure,
      cloud: cur.cloud_cover,
      wind: cur.wind_speed_10m,
      windDir: cur.wind_direction_10m,
      gusts: cur.wind_gusts_10m,
      weatherCode: cur.weather_code,
      time: cur.time ? new Date(cur.time).getTime() : null,
    };
  }

  function summarizeAq(cur) {
    if (!cur) return {};
    return {
      aqi: cur.us_aqi,
      euAqi: cur.european_aqi,
      pm25: cur.pm2_5,
      pm10: cur.pm10,
      ozone: cur.ozone,
      no2: cur.nitrogen_dioxide,
      co: cur.carbon_monoxide,
      dust: cur.dust,
      uv: cur.uv_index,
      time: cur.time ? new Date(cur.time).getTime() : null,
    };
  }

  function normGridCell(row, model) {
    const s = summarizeCurrent(row?.current);
    return {
      kind: "weathergrid",
      id: `wxgrid-${row.latitude?.toFixed(3)}-${row.longitude?.toFixed(3)}`,
      name: `${row.latitude?.toFixed(2)}, ${row.longitude?.toFixed(2)}`,
      lat: row.latitude,
      lon: row.longitude,
      model: model || row.model || null,
      elevation: row.elevation,
      ...s,
      forecast: row,
      time: s.time,
    };
  }

  async function fetchForecast(api, opts = {}) {
    return api("openmeteo", "/v1/forecast", buildForecastParams(opts));
  }

  async function fetchForecastFull(api, lat, lon, opts = {}) {
    return fetchForecast(api, { ...opts, lat, lon, full: true, lite: false });
  }

  async function fetchBboxGrid(api, bbox, model, opts = {}) {
    const m = modelById(model);
    if (!m.bbox) throw new Error(`Model "${m.label}" does not support bounding_box. Pick ECMWF, ICON Global, GEM, etc.`);
    const est = estimateBboxCells(bbox, model);
    if (est > 1000) throw new Error(`BBox ~${est} cells (max 1000). Draw a smaller box or pick a coarser model.`);
    const data = await fetchForecast(api, {
      bbox, model, lite: true, full: false,
      forecastDays: opts.forecastDays ?? 2,
      pastDays: opts.pastDays ?? 1,
    });
    const rows = Array.isArray(data) ? data : [data];
    return rows.map((row) => normGridCell(row, model));
  }

  async function fetchAirQualityFull(api, lat, lon, opts = {}) {
    return api("openmeteoAq", "/v1/air-quality", {
      latitude: lat, longitude: lon,
      current: AQ_CURRENT, hourly: AQ_HOURLY,
      timezone: "auto",
      forecast_days: opts.forecastDays ?? 5,
      past_days: opts.pastDays ?? 7,
    });
  }

  async function fetchMarineFull(api, lat, lon, opts = {}) {
    return api("openmeteoMarine", "/v1/marine", {
      latitude: lat, longitude: lon,
      current: MARINE_CURRENT, hourly: MARINE_HOURLY,
      timezone: "auto",
      forecast_days: opts.forecastDays ?? 7,
      past_days: opts.pastDays ?? 3,
    });
  }

  async function fetchArchive(api, lat, lon, days = 30) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    return api("openmeteoArchive", "/v1/archive", {
      latitude: lat, longitude: lon,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      daily: ARCHIVE_DAILY, timezone: "auto",
    });
  }

  function getSelectedModel(selectEl) {
    return selectEl?.value || "best_match";
  }

  async function fetchPointBundle(api, lat, lon, opts = {}) {
    const model = opts.model;
    const [weather, airQuality, marine] = await Promise.all([
      fetchForecastFull(api, lat, lon, { forecastDays: 7, pastDays: 7, model }),
      fetchAirQualityFull(api, lat, lon).catch(() => null),
      fetchMarineFull(api, lat, lon, { forecastDays: 7, pastDays: 3 }).catch(() => null),
    ]);
    return { weather, airQuality, marine, lat, lon, model };
  }

  return {
    WEATHER_MODELS, PRESSURE_LEVELS,
    FORECAST_CURRENT, FORECAST_CURRENT_LITE, FORECAST_HOURLY, FORECAST_DAILY,
    FORECAST_PRESSURE_HOURLY, FORECAST_MINUTELY_15,
    AQ_CURRENT, AQ_CURRENT_LITE, AQ_HOURLY,
    MARINE_CURRENT, MARINE_HOURLY, ARCHIVE_DAILY,
    modelById, estimateBboxCells, getSelectedModel, normGridCell,
    buildWeatherCharts, buildMinutely15Charts, buildPressureCharts,
    buildAirQualityCharts, buildMarineCharts, buildAllCharts,
    summarizeCurrent, summarizeAq,
    fetchForecast, fetchForecastFull, fetchBboxGrid,
    fetchAirQualityFull, fetchMarineFull, fetchArchive, fetchPointBundle,
  };
})();
