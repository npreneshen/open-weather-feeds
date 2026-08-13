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

  const PRESSURE_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30];

  const FORECAST_CURRENT = [
    "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature",
    "precipitation", "weather_code", "surface_pressure", "cloud_cover",
    "rain", "showers", "snowfall", "pressure_msl", "is_day",
    "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
  ].join(",");

  const FORECAST_HOURLY = [
    "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature",
    "precipitation_probability", "precipitation", "rain", "showers", "snowfall", "snow_depth",
    "weather_code", "pressure_msl", "surface_pressure", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "cloud_cover",
    "visibility", "evapotranspiration", "et0_fao_evapotranspiration", "vapour_pressure_deficit",
    "uv_index", "uv_index_clear_sky", "is_day", "sunshine_duration", "wet_bulb_temperature_2m",
    "total_column_integrated_water_vapour", "cape", "lifted_index", "convective_inhibition",
    "freezing_level_height", "boundary_layer_height",
    "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
    "wind_speed_80m", "wind_speed_120m", "wind_speed_180m",
    "wind_direction_80m", "wind_direction_120m", "wind_direction_180m",
    "temperature_80m", "temperature_120m", "temperature_180m",
    "shortwave_radiation", "direct_radiation", "diffuse_radiation",
    "direct_normal_irradiance", "global_tilted_irradiance", "terrestrial_radiation",
    "shortwave_radiation_instant", "direct_radiation_instant", "diffuse_radiation_instant",
    "direct_normal_irradiance_instant", "global_tilted_irradiance_instant", "terrestrial_radiation_instant",
    "soil_temperature_0cm", "soil_temperature_6cm", "soil_temperature_18cm", "soil_temperature_54cm",
    "soil_moisture_0_to_1cm", "soil_moisture_1_to_3cm", "soil_moisture_3_to_9cm",
    "soil_moisture_9_to_27cm", "soil_moisture_27_to_81cm",
  ].join(",");

  const FORECAST_PRESSURE_HOURLY = PRESSURE_LEVELS.flatMap((hPa) => [
    `temperature_${hPa}hPa`,
    `wind_speed_${hPa}hPa`,
    `wind_direction_${hPa}hPa`,
    `geopotential_height_${hPa}hPa`,
    `relative_humidity_${hPa}hPa`,
    `cloud_cover_${hPa}hPa`,
  ]).join(",");

  const FORECAST_MINUTELY_15 = [
    "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature",
    "precipitation", "rain", "snowfall", "snowfall_height", "freezing_level_height",
    "sunshine_duration", "weather_code", "visibility", "cape", "lightning_potential",
    "is_day", "wind_speed_10m", "wind_speed_80m", "wind_direction_10m", "wind_direction_80m", "wind_gusts_10m",
    "shortwave_radiation", "direct_radiation", "diffuse_radiation",
    "direct_normal_irradiance", "global_tilted_irradiance", "terrestrial_radiation",
    "shortwave_radiation_instant", "direct_radiation_instant", "diffuse_radiation_instant",
    "direct_normal_irradiance_instant", "global_tilted_irradiance_instant", "terrestrial_radiation_instant",
  ].join(",");

  const FORECAST_DAILY = [
    "weather_code", "temperature_2m_max", "temperature_2m_min", "apparent_temperature_max", "apparent_temperature_min",
    "precipitation_sum", "rain_sum", "showers_sum", "snowfall_sum",
    "precipitation_hours", "precipitation_probability_max",
    "wind_speed_10m_max", "wind_gusts_10m_max", "wind_direction_10m_dominant",
    "sunrise", "sunset", "daylight_duration", "sunshine_duration", "uv_index_max", "uv_index_clear_sky_max",
    "shortwave_radiation_sum", "et0_fao_evapotranspiration",
    "temperature_2m_mean", "apparent_temperature_mean", "cape_mean", "cape_max", "cape_min",
    "cloud_cover_mean", "cloud_cover_max", "cloud_cover_min",
    "dew_point_2m_mean", "dew_point_2m_max", "dew_point_2m_min",
    "growing_degree_days_base_0_limit_50", "leaf_wetness_probability_mean",
    "precipitation_probability_mean", "precipitation_probability_min",
    "relative_humidity_2m_mean", "relative_humidity_2m_max", "relative_humidity_2m_min",
    "snowfall_water_equivalent_sum", "pressure_msl_mean", "pressure_msl_max", "pressure_msl_min",
    "surface_pressure_mean", "surface_pressure_max", "surface_pressure_min",
    "updraft_max", "visibility_mean", "visibility_min", "visibility_max",
    "wind_gusts_10m_mean", "wind_gusts_10m_min", "wind_speed_10m_mean", "wind_speed_10m_min",
    "wet_bulb_temperature_2m_mean", "wet_bulb_temperature_2m_max", "wet_bulb_temperature_2m_min",
    "vapour_pressure_deficit_max",
  ].join(",");

  const FORECAST_CURRENT_LITE = [
    "temperature_2m", "relative_humidity_2m", "apparent_temperature",
    "precipitation", "weather_code", "surface_pressure", "cloud_cover",
    "wind_speed_10m", "wind_gusts_10m",
  ].join(",");

  const BBOX_HOURLY_LITE = "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,surface_pressure";

  const AQ_ALL = [
    "pm10", "pm2_5", "carbon_monoxide", "carbon_dioxide", "nitrogen_dioxide", "sulphur_dioxide", "ozone",
    "aerosol_optical_depth", "dust", "uv_index", "uv_index_clear_sky", "ammonia", "methane",
    "alder_pollen", "birch_pollen", "grass_pollen", "mugwort_pollen", "olive_pollen", "ragweed_pollen",
    "european_aqi", "european_aqi_pm2_5", "european_aqi_pm10", "european_aqi_nitrogen_dioxide",
    "european_aqi_ozone", "european_aqi_sulphur_dioxide",
    "us_aqi", "us_aqi_pm2_5", "us_aqi_pm10", "us_aqi_nitrogen_dioxide", "us_aqi_carbon_monoxide",
    "us_aqi_ozone", "us_aqi_sulphur_dioxide",
    "formaldehyde", "glyoxal", "non_methane_volatile_organic_compounds", "pm10_wildfires",
    "peroxyacyl_nitrates", "secondary_inorganic_aerosol", "residential_elementary_carbon",
    "total_elementary_carbon", "pm2_5_total_organic_matter", "sea_salt_aerosol", "nitrogen_monoxide",
  ].join(",");
  const AQ_CURRENT = AQ_ALL;
  const AQ_HOURLY = AQ_ALL;
  const AQ_CURRENT_LITE = "us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide";

  const MARINE_ALL = [
    "wave_height", "wave_direction", "wave_period", "wave_peak_period",
    "wind_wave_height", "wind_wave_direction", "wind_wave_period", "wind_wave_peak_period",
    "swell_wave_height", "swell_wave_direction", "swell_wave_period", "swell_wave_peak_period",
    "secondary_swell_wave_height", "secondary_swell_wave_direction", "secondary_swell_wave_period",
    "tertiary_swell_wave_height", "tertiary_swell_wave_direction", "tertiary_swell_wave_period",
    "sea_level_height_msl", "sea_surface_temperature", "ocean_current_velocity", "ocean_current_direction",
  ].join(",");
  const MARINE_CURRENT = MARINE_ALL;
  const MARINE_HOURLY = MARINE_ALL;
  const MARINE_DAILY = [
    "wave_height_max", "wave_direction_dominant", "wave_period_max",
    "wind_wave_height_max", "wind_wave_direction_dominant", "wind_wave_period_max", "wind_wave_peak_period_max",
    "swell_wave_height_max", "swell_wave_direction_dominant", "swell_wave_period_max", "swell_wave_peak_period_max",
  ].join(",");

  const ARCHIVE_HOURLY = [
    "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature",
    "precipitation", "rain", "snowfall", "snow_depth", "weather_code", "pressure_msl", "surface_pressure",
    "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
    "et0_fao_evapotranspiration", "vapour_pressure_deficit",
    "wind_speed_10m", "wind_speed_100m", "wind_direction_10m", "wind_direction_100m", "wind_gusts_10m",
    "soil_temperature_0_to_7cm", "soil_temperature_7_to_28cm", "soil_temperature_28_to_100cm",
    "soil_temperature_100_to_255cm", "soil_moisture_0_to_7cm", "soil_moisture_7_to_28cm",
    "soil_moisture_28_to_100cm", "soil_moisture_100_to_255cm",
    "boundary_layer_height", "wet_bulb_temperature_2m", "total_column_integrated_water_vapour",
    "is_day", "sunshine_duration", "shortwave_radiation", "direct_radiation", "diffuse_radiation",
    "direct_normal_irradiance", "global_tilted_irradiance", "terrestrial_radiation",
    "shortwave_radiation_instant", "direct_radiation_instant", "diffuse_radiation_instant",
    "direct_normal_irradiance_instant", "global_tilted_irradiance_instant", "terrestrial_radiation_instant",
  ].join(",");

  const ARCHIVE_DAILY = [
    "temperature_2m_max", "temperature_2m_min", "precipitation_sum", "rain_sum", "snowfall_sum",
    "weather_code", "temperature_2m_mean", "apparent_temperature_mean", "apparent_temperature_max",
    "apparent_temperature_min", "sunrise", "sunset", "daylight_duration", "sunshine_duration",
    "precipitation_hours", "wind_speed_10m_max", "wind_gusts_10m_max", "wind_direction_10m_dominant",
    "shortwave_radiation_sum", "et0_fao_evapotranspiration",
    "cloud_cover_mean", "cloud_cover_max", "cloud_cover_min",
    "dew_point_2m_mean", "dew_point_2m_max", "dew_point_2m_min",
    "relative_humidity_2m_mean", "relative_humidity_2m_max", "relative_humidity_2m_min",
    "snowfall_water_equivalent_sum", "pressure_msl_mean", "pressure_msl_max", "pressure_msl_min",
    "surface_pressure_mean", "surface_pressure_max", "surface_pressure_min",
    "wind_gusts_10m_mean", "wind_gusts_10m_min", "wind_speed_10m_mean", "wind_speed_10m_min",
    "wet_bulb_temperature_2m_mean", "wet_bulb_temperature_2m_max", "wet_bulb_temperature_2m_min",
    "vapour_pressure_deficit_max", "soil_moisture_0_to_100cm_mean", "soil_moisture_0_to_7cm_mean",
    "soil_moisture_28_to_100cm_mean", "soil_moisture_7_to_28cm_mean",
    "soil_temperature_0_to_100cm_mean", "soil_temperature_0_to_7cm_mean",
    "soil_temperature_28_to_100cm_mean", "soil_temperature_7_to_28cm_mean",
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

  function series(times, values, gc, offsetSeconds = 0) {
    return gc.hourlySeries(times, values, offsetSeconds);
  }

  function tab(id, label, unit, seriesList, group = "") {
    return { id, label, unit, series: seriesList, group };
  }

  function withGroup(tabs, group) {
    return tabs.map((t) => ({ ...t, group: t.group || group }));
  }

  function line(label, points, color, unit = "", axis = "") {
    return { label, points, color, unit, axis };
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
    const off = wx?.utc_offset_seconds || 0;
    return [
      tab("m15temp", "15-min temperature", "°C", [
        line("2 m", series(m.time, m.temperature_2m, gc, off), "#fbbf24"),
        line("Feels like", series(m.time, m.apparent_temperature, gc, off), "#fb923c"),
        line("Dew point", series(m.time, m.dew_point_2m, gc, off), "#60a5fa"),
      ]),
      tab("m15precip", "15-min precipitation", "mm", [
        line("Total", series(m.time, m.precipitation, gc, off), "#38bdf8"),
        line("Rain", series(m.time, m.rain, gc, off), "#3b82f6"),
        line("Snow", series(m.time, m.snowfall, gc, off), "#e2e8f0"),
      ]),
      tab("m15wind", "15-min wind", "km/h", [
        line("Speed", series(m.time, m.wind_speed_10m, gc, off), "#4ade80"),
        line("Gusts", series(m.time, m.wind_gusts_10m, gc, off), "#22c55e"),
      ]),
      tab("m15solar", "15-min solar", "W/m²", [
        line("Shortwave", series(m.time, m.shortwave_radiation, gc, off), "#fbbf24"),
        line("Direct", series(m.time, m.direct_radiation, gc, off), "#f59e0b"),
        line("Diffuse", series(m.time, m.diffuse_radiation, gc, off), "#fcd34d"),
      ]),
    ];
  }

  function buildPressureCharts(wx, gc) {
    const h = wx?.hourly;
    if (!h?.time?.length) return [];
    const off = wx?.utc_offset_seconds || 0;
    const tabs = [];
    const tempSeries = PRESSURE_LEVELS.map((hPa, i) =>
      line(`${hPa} hPa`, series(h.time, h[`temperature_${hPa}hPa`], gc, off), COLORS[i % COLORS.length])
    ).filter((s) => s.points.length);
    if (tempSeries.length) {
      tabs.push(tab("pltemp", "Pressure-level temperature", "°C", tempSeries));
    }
    const windSeries = [850, 500, 300].map((hPa, i) =>
      line(`${hPa} hPa`, series(h.time, h[`wind_speed_${hPa}hPa`], gc, off), COLORS[i % COLORS.length])
    ).filter((s) => s.points.length);
    if (windSeries.length) {
      tabs.push(tab("plwind", "Pressure-level wind", "km/h", windSeries));
    }
    const ghSeries = [850, 500, 300].map((hPa, i) =>
      line(`${hPa} hPa`, series(h.time, h[`geopotential_height_${hPa}hPa`], gc, off), COLORS[i % COLORS.length])
    ).filter((s) => s.points.length);
    if (ghSeries.length) {
      tabs.push(tab("plheight", "Geopotential height", "m", ghSeries));
    }
    const rhSeries = [1000, 850, 700, 500].map((hPa, i) =>
      line(`${hPa} hPa`, series(h.time, h[`relative_humidity_${hPa}hPa`], gc, off), COLORS[i % COLORS.length])
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
    const off = wx?.utc_offset_seconds || 0;
    const archiveOff = archive?.utc_offset_seconds || 0;

    tabs.push(tab("temp", "Temperature (hourly)", "°C", [
      line("2 m", series(h.time, h.temperature_2m, gc, off), "#fbbf24"),
      line("Feels like", series(h.time, h.apparent_temperature, gc, off), "#fb923c"),
      line("Dew point", series(h.time, h.dew_point_2m, gc, off), "#60a5fa"),
    ]));

    tabs.push(tab("humidity", "Humidity & pressure", "% / hPa", [
      line("Humidity", series(h.time, h.relative_humidity_2m, gc, off), "#38bdf8", "%", "left"),
      line("Pressure", series(h.time, h.surface_pressure, gc, off), "#a78bfa", "hPa", "right"),
    ]));

    tabs.push(tab("precip", "Precipitation", "mm", [
      line("Total", series(h.time, h.precipitation, gc, off), "#38bdf8"),
      line("Rain", series(h.time, h.rain, gc, off), "#3b82f6"),
      line("Showers", series(h.time, h.showers, gc, off), "#60a5fa"),
      line("Snow", series(h.time, h.snowfall, gc, off), "#e2e8f0"),
    ]));

    if (h.precipitation_probability) {
      tabs.push(tab("precipprob", "Precip probability", "%", [
        line("Probability", series(h.time, h.precipitation_probability, gc, off), "#818cf8"),
      ]));
    }

    tabs.push(tab("wind", "Wind", "km/h", [
      line("Speed 10 m", series(h.time, h.wind_speed_10m, gc, off), "#4ade80"),
      line("Speed 80 m", series(h.time, h.wind_speed_80m, gc, off), "#22c55e"),
      line("Speed 120 m", series(h.time, h.wind_speed_120m, gc, off), "#16a34a"),
      line("Gusts", series(h.time, h.wind_gusts_10m, gc, off), "#86efac"),
    ]));

    tabs.push(tab("cloud", "Cloud & visibility", "% / km", [
      line("Total", series(h.time, h.cloud_cover, gc, off), "#94a3b8", "%", "left"),
      line("Low", series(h.time, h.cloud_cover_low, gc, off), "#64748b", "%", "left"),
      line("Mid", series(h.time, h.cloud_cover_mid, gc, off), "#475569", "%", "left"),
      line("High", series(h.time, h.cloud_cover_high, gc, off), "#cbd5e1", "%", "left"),
      line("Visibility", series(h.time, h.visibility, gc, off), "#e2e8f0", "m", "right"),
    ]));

    if (h.shortwave_radiation) {
      tabs.push(tab("solar", "Solar radiation", "W/m²", [
        line("Shortwave", series(h.time, h.shortwave_radiation, gc, off), "#fbbf24"),
        line("Direct", series(h.time, h.direct_radiation, gc, off), "#f59e0b"),
        line("Diffuse", series(h.time, h.diffuse_radiation, gc, off), "#fcd34d"),
      ]));
    }

    if (h.soil_temperature_0cm || h.soil_moisture_0_to_1cm) {
      tabs.push(tab("soil", "Soil", "°C / m³/m³", [
        line("Temp 0 cm", series(h.time, h.soil_temperature_0cm, gc, off), "#ea580c", "°C", "left"),
        line("Temp 6 cm", series(h.time, h.soil_temperature_6cm, gc, off), "#c2410c", "°C", "left"),
        line("Temp 18 cm", series(h.time, h.soil_temperature_18cm, gc, off), "#9a3412", "°C", "left"),
        line("Moist 0–1 cm", series(h.time, h.soil_moisture_0_to_1cm, gc, off), "#854d0e", "m³/m³", "right"),
        line("Moist 1–3 cm", series(h.time, h.soil_moisture_1_to_3cm, gc, off), "#713f12", "m³/m³", "right"),
        line("Moist 3–9 cm", series(h.time, h.soil_moisture_3_to_9cm, gc, off), "#5c3310", "m³/m³", "right"),
      ]));
    }

    if (d?.time?.length) {
      tabs.push(tab("daily", "Daily summary", "°C / mm", [
        line("Max temp", gc.dailySeries(d.time, d.temperature_2m_max, off), "#f87171", "°C", "left"),
        line("Min temp", gc.dailySeries(d.time, d.temperature_2m_min, off), "#60a5fa", "°C", "left"),
        line("Precip sum", gc.dailySeries(d.time, d.precipitation_sum, off), "#38bdf8", "mm", "right"),
      ]));
    }

    if (archive?.daily?.time?.length) {
      const ad = archive.daily;
      tabs.push(tab("archive", "Historical archive", "°C / mm", [
        line("Max", gc.dailySeries(ad.time, ad.temperature_2m_max, archiveOff), "#f87171", "°C", "left"),
        line("Min", gc.dailySeries(ad.time, ad.temperature_2m_min, archiveOff), "#60a5fa", "°C", "left"),
        line("Precip", gc.dailySeries(ad.time, ad.precipitation_sum, archiveOff), "#38bdf8", "mm", "right"),
      ]));
    }

    tabs.push(...buildMinutely15Charts(wx, gc));
    tabs.push(...buildPressureCharts(wx, gc));
    return tabs.map((t) => ({ ...t, group: t.id === "archive" ? "Archive" : "Weather" }));
  }

  function buildAirQualityCharts(aq, gc) {
    const h = aq?.hourly;
    if (!h?.time?.length) return [];
    const off = aq?.utc_offset_seconds || 0;
    return withGroup([
      tab("aqi", "Air quality index", "AQI", [
        line("US AQI", series(h.time, h.us_aqi, gc, off), "#38bdf8"),
        line("European AQI", series(h.time, h.european_aqi, gc, off), "#818cf8"),
      ]),
      tab("pm", "Particulates", "µg/m³", [
        line("PM2.5", series(h.time, h.pm2_5, gc, off), "#f472b6"),
        line("PM10", series(h.time, h.pm10, gc, off), "#fb7185"),
        line("Dust", series(h.time, h.dust, gc, off), "#d97706"),
      ]),
      tab("gases", "Gases & ozone", "µg/m³", [
        line("O₃", series(h.time, h.ozone, gc, off), "#4ade80"),
        line("NO₂", series(h.time, h.nitrogen_dioxide, gc, off), "#a78bfa"),
        line("SO₂", series(h.time, h.sulphur_dioxide, gc, off), "#facc15"),
        line("CO", series(h.time, h.carbon_monoxide, gc, off), "#94a3b8"),
      ]),
      tab("uv", "UV index", "", [
        line("UV", series(h.time, h.uv_index, gc, off), "#fbbf24"),
      ]),
    ], "Air quality");
  }

  function buildMarineCharts(marine, gc) {
    const h = marine?.hourly;
    if (!h?.time?.length) return [];
    const off = marine?.utc_offset_seconds || 0;
    return withGroup([
      tab("waves", "Waves", "m", [
        line("Wave height", series(h.time, h.wave_height, gc, off), "#38bdf8"),
        line("Swell height", series(h.time, h.swell_wave_height, gc, off), "#60a5fa"),
      ]),
      tab("period", "Wave period", "s", [
        line("Wave period", series(h.time, h.wave_period, gc, off), "#4ade80"),
        line("Swell period", series(h.time, h.swell_wave_period, gc, off), "#22c55e"),
      ]),
      tab("sst", "Sea surface temp", "°C", [
        line("SST", series(h.time, h.sea_surface_temperature, gc, off), "#f472b6"),
      ]),
      tab("current", "Ocean current", "km/h", [
        line("Current", series(h.time, h.ocean_current_velocity, gc, off), "#a78bfa"),
      ]),
    ], "Marine");
  }

  function humanizeVariable(value) {
    return String(value || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function buildEveryVariableCharts(dataset, section, gc) {
    const tabs = [];
    if (!dataset) return tabs;
    const off = dataset.utc_offset_seconds || 0;
    for (const period of ["hourly", "minutely_15", "daily"]) {
      const block = dataset[period];
      const times = block?.time;
      if (!times?.length) continue;
      const units = dataset[`${period}_units`] || {};
      for (const [key, values] of Object.entries(block)) {
        if (key === "time" || !Array.isArray(values)) continue;
        const points = period === "daily"
          ? gc.dailySeries(times, values, off)
          : gc.hourlySeries(times, values, off);
        if (!points.length) continue;
        tabs.push(tab(
          `${section}-${period}-${key}`,
          `${section} · ${humanizeVariable(key)} · ${period.replace("_", " ")}`,
          units[key] || "",
          [line(humanizeVariable(key), points, COLORS[tabs.length % COLORS.length])],
          `${section} (all variables)`,
        ));
      }
    }
    return tabs;
  }

  function buildAllCharts(wx, archive, aq, marine, gc, flood = null, ensemble = null, opts = {}) {
    const tabs = [
      ...buildWeatherCharts(wx, archive, gc),
      ...buildAirQualityCharts(aq, gc),
      ...buildMarineCharts(marine, gc),
    ];
    // Enumerating every hourly/daily/minutely_15 variable across all five
    // response families (hundreds of fields, e.g. 19 pressure levels × 6
    // fields each) runs synchronously on the main thread on every map click.
    // Most of those tabs are never opened, so keep it opt-in.
    if (opts.includeEveryVariable) {
      tabs.push(
        ...buildEveryVariableCharts(wx, "Weather", gc),
        ...buildEveryVariableCharts(aq, "Air quality", gc),
        ...buildEveryVariableCharts(marine, "Marine", gc),
        ...buildEveryVariableCharts(archive, "Archive", gc),
        ...buildEveryVariableCharts(flood, "Flood", gc),
        ...buildEveryVariableCharts(ensemble, "Ensemble mean", gc),
      );
    }
    return tabs;
  }

  function summarizeCurrent(cur, gc, offsetSeconds = 0) {
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
      time: cur.time ? gc.localIsoToUtcMs(cur.time, offsetSeconds) : null,
    };
  }

  function summarizeAq(cur, gc, offsetSeconds = 0) {
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
      time: cur.time ? gc.localIsoToUtcMs(cur.time, offsetSeconds) : null,
    };
  }

  function normGridCell(row, model, gc) {
    const s = summarizeCurrent(row?.current, gc, row?.utc_offset_seconds || 0);
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

  async function fetchBboxGrid(api, bbox, model, gc, opts = {}) {
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
    return rows.map((row) => normGridCell(row, model, gc));
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
      minutely_15: "ocean_current_velocity,ocean_current_direction,sea_level_height_msl",
      daily: MARINE_DAILY,
      timezone: "auto",
      forecast_days: Math.min(opts.forecastDays ?? 8, 8),
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
      hourly: ARCHIVE_HOURLY, daily: ARCHIVE_DAILY, timezone: "auto",
    });
  }

  async function fetchEnsembleMean(api, lat, lon, opts = {}) {
    const base = [
      "temperature_2m", "relative_humidity_2m", "dew_point_2m",
      "apparent_temperature", "precipitation", "rain", "snowfall",
      "surface_pressure", "cloud_cover", "wind_speed_10m", "wind_gusts_10m",
      "cape", "uv_index",
    ];
    const hourly = base.flatMap((key) => [key, `${key}_spread`]).join(",");
    return api("openmeteoEnsemble", "/v1/ensemble", {
      latitude: lat,
      longitude: lon,
      hourly,
      models: opts.model || "dwd_icon_eps_ensemble_mean_seamless",
      forecast_days: opts.forecastDays ?? 7,
      timezone: "auto",
    });
  }

  function getSelectedModel(selectEl) {
    return selectEl?.value || "best_match";
  }

  async function fetchPointBundle(api, lat, lon, opts = {}) {
    const model = opts.model;
    const [weather, airQuality, marine, archive, flood, ensemble] = await Promise.all([
      fetchForecastFull(api, lat, lon, { forecastDays: 7, pastDays: 7, model }),
      fetchAirQualityFull(api, lat, lon).catch(() => null),
      fetchMarineFull(api, lat, lon, { forecastDays: 7, pastDays: 3 }).catch(() => null),
      fetchArchive(api, lat, lon, 30).catch(() => null),
      api("openmeteoFlood", "/v1/flood", {
        latitude: lat, longitude: lon,
        daily: "river_discharge,river_discharge_mean,river_discharge_median,river_discharge_max,river_discharge_min,river_discharge_p25,river_discharge_p75",
        past_days: 30, forecast_days: 30,
      }).catch(() => null),
      fetchEnsembleMean(api, lat, lon).catch(() => null),
    ]);
    return { weather, airQuality, marine, archive, flood, ensemble, lat, lon, model };
  }

  return {
    WEATHER_MODELS, PRESSURE_LEVELS,
    FORECAST_CURRENT, FORECAST_CURRENT_LITE, FORECAST_HOURLY, FORECAST_DAILY,
    FORECAST_PRESSURE_HOURLY, FORECAST_MINUTELY_15,
    AQ_CURRENT, AQ_CURRENT_LITE, AQ_HOURLY,
    MARINE_CURRENT, MARINE_HOURLY, MARINE_DAILY, ARCHIVE_HOURLY, ARCHIVE_DAILY,
    modelById, estimateBboxCells, getSelectedModel, normGridCell,
    buildWeatherCharts, buildMinutely15Charts, buildPressureCharts,
    buildAirQualityCharts, buildMarineCharts, buildEveryVariableCharts, buildAllCharts,
    summarizeCurrent, summarizeAq,
    fetchForecast, fetchForecastFull, fetchBboxGrid,
    fetchAirQualityFull, fetchMarineFull, fetchArchive, fetchEnsembleMean, fetchPointBundle,
  };
})();
