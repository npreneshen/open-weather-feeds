/* Secret-backed feeds. API keys remain in the Worker and never reach the browser. */
window.MetisKeyedFeeds = (() => {
  "use strict";

  function bboxArray(box) {
    return [
      Number(box.lonLeft), Number(box.latBottom),
      Number(box.lonRight), Number(box.latTop),
    ];
  }

  async function request(feed, mapBox, options = {}) {
    const bbox = bboxArray(mapBox);
    const started = performance.now();
    let ok = false;
    try {
      const response = await fetch(`/api/keyed/${feed}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          bbox,
          apiKey: window.MetisApiKeys?.keyFor(feed) || undefined,
          ...(feed === "firms" ? {
            days: options.days || 1,
            source: options.source || "VIIRS_SNPP_NRT",
            full: !!options.full,
          } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
      ok = true;
      return new Map((payload.items || []).map((item) => [item.id, item]));
    } finally {
      window.dispatchEvent(new CustomEvent("weather-api-status", {
        detail: {
          service: feed,
          transport: "worker-secret",
          ok,
          latencyMs: Math.round(performance.now() - started),
          at: Date.now(),
        },
      }));
    }
  }

  return {
    fetchFirms: (mapBox, options) => request("firms", mapBox, options),
    fetchAirNow: (mapBox) => request("airnow", mapBox),
  };
})();
