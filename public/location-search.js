/* Shared Open-Meteo geocoding control for both map dashboards. */
window.MetisLocationSearch = (() => {
  "use strict";

  function ensureStyles() {
    if (document.getElementById("metis-location-search-styles")) return;
    const style = document.createElement("style");
    style.id = "metis-location-search-styles";
    style.textContent = `
      .metis-location-search{position:relative;width:min(360px,32vw);margin:0;
        color:#d8d1bc;font:11px "IBM Plex Mono",Consolas,monospace}
      .metis-location-search input{box-sizing:border-box;width:100%;height:34px;padding:7px 34px 7px 10px;
        border:1px solid #587078;border-radius:0;background:rgba(6,23,30,.96);color:#e7ddc7;
        box-shadow:4px 4px 0 rgba(0,0,0,.3);font:inherit;outline:none}
      .metis-location-search input:focus{border-color:#68cf91}
      .metis-location-search-mark{position:absolute;right:10px;top:9px;color:#68cf91;pointer-events:none}
      .metis-location-results{position:absolute;top:38px;left:0;right:0;display:none;max-height:260px;overflow:auto;
        border:1px solid #587078;background:rgba(6,23,30,.985);box-shadow:5px 5px 0 rgba(0,0,0,.35)}
      .metis-location-results.show{display:block}
      .metis-location-result{display:block;width:100%;padding:8px 10px;border:0;border-bottom:1px solid #29444b;
        background:transparent;color:#d8d1bc;text-align:left;font:inherit;cursor:pointer}
      .metis-location-result:hover,.metis-location-result:focus{background:#123039;color:#fff}
      .metis-location-result strong{display:block;color:#d9c69e;font:600 13px "Barlow Condensed","Arial Narrow",sans-serif;
        letter-spacing:.04em}
      .metis-location-result small{display:block;margin-top:2px;color:#77949a;font-size:9px}
      .metis-location-empty{padding:9px 10px;color:#ff8a5f}
      .header-search .metis-location-search{width:100%}
      @media(max-width:720px){.metis-location-search{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function create({ map, dataApi, onSelect, zoom = 10, host = null } = {}) {
    if (!map || !dataApi || !window.L) throw new Error("Location search needs a map and data API.");
    ensureStyles();
    let results = [];
    let timer = null;
    let requestId = 0;

    const build = () => {
      const root = document.createElement("div");
      root.className = "metis-location-search";
      root.innerHTML = `
        <input type="search" autocomplete="off" spellcheck="false" aria-label="Search for a location"
          data-lpignore="true" data-1p-ignore="true" data-form-type="other"
          placeholder="Search location…" />
        <span class="metis-location-search-mark" aria-hidden="true">⌖</span>
        <div class="metis-location-results" role="listbox"></div>`;
      const input = root.querySelector("input");
      const list = root.querySelector(".metis-location-results");
      L.DomEvent.disableClickPropagation(root);
      L.DomEvent.disableScrollPropagation(root);

      function close() { list.classList.remove("show"); }

      function choose(result) {
        if (!result) return;
        const lat = Number(result.latitude);
        const lon = Number(result.longitude);
        const label = [result.name, result.admin1, result.country].filter(Boolean).join(", ");
        input.value = label;
        close();
        map.setView([lat, lon], Math.max(map.getZoom(), zoom), { animate: false });
        window.setTimeout(() => onSelect?.({ lat, lon, name: label, raw: result }), 0);
      }

      function render() {
        list.innerHTML = results.length
          ? results.map((result, index) => `
              <button type="button" class="metis-location-result" data-index="${index}" role="option">
                <strong>${escapeHtml(result.name || "Unnamed location")}</strong>
                <small>${escapeHtml([result.admin1, result.country].filter(Boolean).join(" · "))}</small>
              </button>`).join("")
          : '<div class="metis-location-empty">No matching locations</div>';
        list.classList.add("show");
        list.querySelectorAll("[data-index]").forEach((button) => {
          button.addEventListener("click", () => choose(results[Number(button.dataset.index)]));
        });
      }

      async function search(query) {
        const id = ++requestId;
        list.innerHTML = '<div class="metis-location-empty">Searching Open-Meteo…</div>';
        list.classList.add("show");
        try {
          const payload = await dataApi("openmeteoGeocoding", "/v1/search", {
            name: query, count: 8, language: "en", format: "json",
          });
          if (id !== requestId) return;
          results = payload.results || [];
          render();
        } catch (error) {
          if (id !== requestId) return;
          list.innerHTML = `<div class="metis-location-empty">${escapeHtml(error.message || "Search failed")}</div>`;
        }
      }

      input.addEventListener("input", () => {
        clearTimeout(timer);
        const query = input.value.trim();
        if (query.length < 2) { close(); return; }
        timer = setTimeout(() => search(query), 260);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && results.length) {
          event.preventDefault();
          choose(results[0]);
        } else if (event.key === "Escape") {
          close();
        }
      });
      input.addEventListener("focus", () => { if (results.length) list.classList.add("show"); });
      document.addEventListener("pointerdown", (event) => {
        if (!root.contains(event.target)) close();
      });
      return root;
    };
    if (host) {
      const root = build();
      host.replaceChildren(root);
      return root;
    }
    const control = L.control({ position: "topleft" });
    control.onAdd = build;
    control.addTo(map);
    return control;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  return { create };
})();
