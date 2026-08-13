/* Single source of truth for every Sentinel Hub WMS request this app makes
   (the live toggle layer, playback frames, and GetFeatureInfo resolved-date
   lookups). Having the live layer and the playback tool each hand-roll
   their own copy of this param list was exactly how they quietly drifted
   out of sync -- one "working" and the other not for reasons neither side
   could see. Now there is exactly one place that knows how to build these
   requests. */
window.MetisSentinelHub = (() => {
  "use strict";

  const BASE = "https://sh.dataspace.copernicus.eu/ogc/wms";
  // Sentinel-2's ~5-day revisit means the exact requested date often has no
  // scene at all -- every request asks for the most recent (or least
  // cloudy, see maxcc) scene in a trailing window ending on that date.
  // Live view and playback deliberately share this exact window so a dated
  // playback frame is the same WMS mosaic the user sees on the normal map.
  const WINDOW_DAYS = 10;

  function shiftDay(dateStr, deltaDays) {
    const date = new Date(`${dateStr}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + deltaDays);
    return date.toISOString().slice(0, 10);
  }

  function resolveWindowDays(windowDays) {
    const n = Number(windowDays);
    if (!Number.isFinite(n)) return WINDOW_DAYS;
    return Math.max(1, Math.min(60, Math.round(n)));
  }

  // Sentinel-2's own catalog resolves a start/end TIME range into "whichever
  // scene in that span best matches maxcc/priority" -- that's what the
  // window-widening logic above assumes everywhere. Some other WMS layers
  // (confirmed live: an official Landsat template's numbered layers) don't
  // do that resolution at all -- a range collapses to almost nothing
  // regardless of how wide it is, while a bare single date returns the real
  // scene for that day. singleDate skips the range/window math entirely so
  // callers that have detected this (see gapFillPlan's singleDate entry,
  // and map-overlays.js's sentinelHubResolvedInfo range/single fallback)
  // can ask the same way that's confirmed to actually work for that layer.
  function buildTime(endDate, windowDays, singleDate) {
    if (singleDate) return endDate;
    const days = resolveWindowDays(windowDays);
    const startDate = shiftDay(endDate, -(days - 1));
    return `${startDate}/${endDate}`;
  }

  // The vendor-extra params shared by every request type below (GetMap,
  // GetFeatureInfo, and the live L.tileLayer.wms options object). maxcc is a
  // hard filter -- a scene cloudier than the cap is excluded outright, in
  // either priority mode below, never just "deprioritized". priority then
  // picks which of the surviving (already-within-cap) scenes wins:
  // "leastCC" (default) picks the clearest one in the window, which can be
  // several days old if an earlier day happened to be clearer than the most
  // recent pass; "mostRecent" picks the newest surviving scene instead, even
  // if a clearer-but-older one was available. upsampling/downsampling
  // control how a tile is interpolated when scaled.
  function extras({ maxcc, resample, priority }) {
    const out = {};
    if (maxcc != null) out.maxcc = String(maxcc);
    if (priority) out.priority = priority;
    else if (maxcc != null) out.priority = "leastCC"; // pre-existing default when no explicit choice is passed
    if (resample) { out.upsampling = resample; out.downsampling = resample; }
    return out;
  }

  // Options object for L.tileLayer.wms -- Leaflet appends any non-reserved
  // key into the WMS query string automatically, so this covers the whole
  // live-layer request.
  function wmsOptions({ layer, endDate, maxcc, resample, priority, windowDays, singleDate }) {
    return {
      layers: layer, format: "image/png", transparent: true, version: "1.3.0",
      time: buildTime(endDate, windowDays, singleDate),
      ...extras({ maxcc, resample, priority }),
    };
  }

  // Direct GetMap URL for a single tile -- used by the playback tool, which
  // fetches tiles itself instead of going through a Leaflet layer.
  function tileUrl({ instanceId, layer, endDate, maxcc, resample, priority, bboxMeters, size, windowDays, singleDate }) {
    const params = new URLSearchParams({
      service: "WMS", request: "GetMap", layers: layer, styles: "", format: "image/png",
      transparent: "true", version: "1.3.0", time: buildTime(endDate, windowDays, singleDate),
      width: String(size), height: String(size), crs: "EPSG:3857", bbox: bboxMeters,
      ...extras({ maxcc, resample, priority }),
    });
    return `${BASE}/${instanceId}?${params.toString()}`;
  }

  // GetFeatureInfo -- reports which scene actually got picked for a given
  // point (real date + cloud %), works with the same instance-ID auth as
  // everything else (no separate OAuth like the Catalog/Process APIs need).
  function featureInfoUrl({ instanceId, layer, endDate, maxcc, priority, bboxMeters, size, i, j, windowDays, singleDate }) {
    const params = new URLSearchParams({
      service: "WMS", request: "GetFeatureInfo", version: "1.3.0",
      layers: layer, query_layers: layer, styles: "",
      crs: "EPSG:3857", bbox: bboxMeters, width: String(size), height: String(size),
      i: String(i), j: String(j), info_format: "application/json",
      time: buildTime(endDate, windowDays, singleDate),
      ...extras({ maxcc, priority }),
    });
    return `${BASE}/${instanceId}?${params.toString()}`;
  }

  return {
    WINDOW_DAYS,
    shiftDay,
    resolveWindowDays,
    wmsOptions,
    tileUrl,
    featureInfoUrl,
  };
})();
