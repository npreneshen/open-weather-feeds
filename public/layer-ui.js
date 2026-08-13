/* Shared layer catalogue descriptions and compact, collapsible control styling. */
window.MetisLayerUI = (() => {
  "use strict";

  const DESCRIPTIONS = {
    usgswater: "Live USGS streamflow, gauge height, water temperature and related station observations.",
    earthquakes: "Recent seismic events with magnitude, depth, time and USGS event details.",
    volcanoes: "USGS volcano notices and current activity information.",
    cyclones: "Active tropical cyclone tracks and forecast positions.",
    nasaevents: "NASA EONET natural-event records including storms, fires and severe weather.",
    gdacs: "Global Disaster Alert and Coordination System impact and severity alerts.",
    firms: "Near-real-time VIIRS thermal anomalies from NASA FIRMS for the visible map area. Enter a free map key when enabled, then zoom into a regional view.",
    tsunami: "Recent tsunami events and related NOAA hazard records.",
    volcanicash: "Volcanic ash advisories for aviation, including flight levels and validity windows.",
    fireballs: "Reported meteors and atmospheric fireball events.",
    neoapproach: "Near-Earth objects making close approaches to Earth.",
    sentry: "Objects tracked by NASA Sentry for possible future Earth impact risk.",
    scout: "Newly detected near-Earth-object candidates awaiting refined orbits.",
    buoys: "Ocean buoy measurements and station positions from NOAA NDBC.",
    coops: "NOAA coastal stations with water level, temperature, wind and tide observations.",
    metar: "Surface aviation weather observations from stations inside the current map view.",
    weather: "Current Open-Meteo conditions sampled across major world cities.",
    weathergrid: "Open-Meteo model points sampled from a user-drawn bounding box.",
    airquality: "Open-Meteo particulate, gas, pollen, UV and air-quality-index observations.",
    airnow: "Near-real-time regulatory monitoring-site AQI and pollutant concentrations from EPA AirNow across the United States, Canada and Mexico. Enter a free API key when enabled.",
    marine: "Open-Meteo wave, swell, sea-temperature and ocean-current conditions at coastal points.",
    nwsalerts: "Active US National Weather Service warnings, watches and advisories.",
    aircraft: "Recent public aircraft positions where an unauthenticated feed is available. Note: OpenSky is known to time out on this Cloudflare-hosted deployment; it works reliably when run locally.",
    spaceweather: "NOAA solar-wind and geomagnetic activity, including the planetary K-index.",
    aurora: "NOAA short-term aurora probability forecast.",
    earthimagery: "Searchable public Earth-observation scenes from the Element 84 STAC catalogue.",
    satellite: "NASA GIBS daily true-colour satellite imagery. Terra is shown by default; the ⚙ button switches to Aqua (afternoon overpass) or VIIRS SNPP (sharper composite) -- all three share the same date stepper.",
    geostationary: "Live full-disk imagery from every free geostationary weather satellite this app can reach: GOES-East/West (Americas/Atlantic/Pacific), Himawari-9 (Asia-Pacific), Meteosat-0°/IODC (Europe, Africa, Indian Ocean), and MTG (Europe/Africa, includes a live lightning imager). GOES-East is shown by default; the ⚙ button opens a picker to add the others and choose each one's product (GeoColor/natural colour, Dust, Fire, Air Mass, Clean Infrared, lightning and more). Updates every 5-15 minutes depending on source.",
    radar: "NOAA MRMS radar precipitation-type mosaic for the United States.",
    sentinelhub: "Sentinel-2 imagery (true colour by default, or any layer/band your Sentinel Hub config supports) via Copernicus Data Space, ~5-day revisit. Enter a free WMS configuration instance ID when enabled.",
  };

  const GROUP_LABELS = {
    water: "Water & rivers",
    hazards: "Hazards & alerts",
    atmosphere: "Weather & air",
    ocean: "Ocean & coast",
    space: "Space weather",
    imagery: "Satellite & radar",
    transport: "Transport",
    other: "Other feeds",
  };

  function ensureStyles() {
    if (document.getElementById("metis-layer-ui-styles")) return;
    const style = document.createElement("style");
    style.id = "metis-layer-ui-styles";
    style.textContent = `
      details.layer-group{margin:0 0 7px;border:1px solid color-mix(in srgb,var(--line,#304b52) 78%,transparent);
        background:color-mix(in srgb,var(--panel,#081d25) 75%,transparent)}
      details.layer-group>summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px;
        cursor:pointer;list-style:none;color:var(--accent,#68cf91);font-size:.66rem;letter-spacing:.09em;text-transform:uppercase}
      details.layer-group>summary::-webkit-details-marker{display:none}
      details.layer-group>summary:before{content:"›";font-size:14px;transform:rotate(0deg);transition:transform .15s}
      details.layer-group[open]>summary:before{transform:rotate(90deg)}
      .layer-group-count{margin-left:auto;color:var(--muted,#77949a);font-size:.58rem;letter-spacing:0}
      .layer-group-items{padding:0 5px 5px}
      label.layer-picker-row{position:relative;display:grid!important;grid-template-columns:auto 1fr 17px 17px;align-items:center;gap:7px;
        min-height:34px;margin:2px 0!important;padding:5px 6px!important}
      .layer-copy{min-width:0;line-height:1.05}
      .layer-name{display:block;color:var(--text,#d8d1bc);font-size:.72rem}
      .layer-provider{display:block;margin-top:3px;color:var(--muted,#77949a);font-size:.57rem}
      .layer-info{position:relative;display:grid;place-items:center;width:17px;height:17px;border:1px solid var(--line,#304b52);
        color:var(--accent,#68cf91);font-size:10px;cursor:help}
      .layer-config-btn{position:relative;display:grid;place-items:center;width:17px;height:17px;padding:0;margin:0;
        border:1px solid var(--line,#304b52);background:transparent;color:var(--accent,#68cf91);font-size:10px;cursor:pointer;border-radius:0}
      .layer-config-btn:hover,.layer-config-btn:focus-visible{background:var(--accent,#68cf91);color:#06171e}
      .layer-tooltip-portal{position:fixed;z-index:9000;display:none;width:min(260px,calc(100vw - 20px));padding:9px 10px;
        border:1px solid #587078;background:#06171e;color:#d8d1bc;box-shadow:5px 5px 0 rgba(0,0,0,.42);
        font:10px/1.5 "IBM Plex Mono",Consolas,monospace;pointer-events:none}
      .layer-tooltip-portal.show{display:block}
    `;
    document.head.appendChild(style);
  }

  function description(layer) {
    return layer.description || layer.note || DESCRIPTIONS[layer.id] || `${layer.provider || "Public"} data layer.`;
  }

  function groupLabel(group) {
    return GROUP_LABELS[group] || group;
  }

  function wireTooltips(host) {
    if (!host) return;
    let portal = document.querySelector(".layer-tooltip-portal");
    if (!portal) {
      portal = document.createElement("div");
      portal.className = "layer-tooltip-portal";
      document.body.appendChild(portal);
    }
    const hide = () => portal.classList.remove("show");
    host.querySelectorAll(".layer-info").forEach((info) => {
      const show = () => {
        portal.textContent = info.dataset.tip || "";
        portal.classList.add("show");
        const box = info.getBoundingClientRect();
        const width = portal.offsetWidth;
        const height = portal.offsetHeight;
        portal.style.left = `${Math.max(8, Math.min(box.right + 9, innerWidth - width - 8))}px`;
        portal.style.top = `${Math.max(8, Math.min(box.top - 8, innerHeight - height - 8))}px`;
      };
      info.addEventListener("mouseenter", show);
      info.addEventListener("focus", show);
      info.addEventListener("mouseleave", hide);
      info.addEventListener("blur", hide);
    });
  }

  ensureStyles();
  return { description, groupLabel, wireTooltips, DESCRIPTIONS };
})();
