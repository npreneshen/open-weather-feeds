/* Small floating map-tools panel: measure distance and area. Non-blocking
   (no backdrop) like point-modal.js, so the map stays clickable while it's
   open -- unlike geo-satellite-picker.js's dialog, this one needs the user
   to interact with the map itself while the panel is up. */
window.MetisMapTools = (() => {
  "use strict";

  function ensureStyles() {
    if (document.getElementById("metis-tools-styles")) return;
    const style = document.createElement("style");
    style.id = "metis-tools-styles";
    style.textContent = `
      .metis-tools-panel{position:absolute;top:64px;right:12px;z-index:7000;display:none;
        width:min(260px,calc(100vw - 24px));
        background:linear-gradient(135deg,var(--glass-panel-a,rgba(16,39,45,.9)),var(--glass-panel-b,rgba(7,25,31,.85)));
        backdrop-filter:var(--glass-blur,blur(18px));-webkit-backdrop-filter:var(--glass-blur,blur(18px));
        border:1px solid var(--glass-line,#587078);border-radius:8px;background-clip:padding-box;
        box-shadow:var(--glass-inner,inset 0 1px 0 rgba(255,255,255,.05)),var(--glass-drop,0 8px 24px rgba(0,8,12,.22)),0 8px 24px rgba(0,0,0,.42);
        color:#d8d1bc;font:12px "IBM Plex Mono",Consolas,monospace}
      .metis-tools-panel.show{display:block}
      .metis-tools-head{display:flex;justify-content:space-between;align-items:center;
        padding:8px 10px;border-bottom:1px solid var(--glass-line,#304b52);background:transparent;cursor:move;
        touch-action:none;user-select:none}
      .metis-tools-kicker{color:#68cf91;font-size:9px;letter-spacing:.11em;text-transform:uppercase}
      .metis-tools-close{background:transparent;border:0;color:#77949a;font-size:16px;cursor:pointer;
        line-height:1;padding:0 2px}
      .metis-tools-close:hover{color:#d8d1bc}
      .metis-tools-body{padding:10px}
      .metis-tools-group{margin-bottom:12px}
      .metis-tools-group:last-child{margin-bottom:0}
      .metis-tools-group-title{font-size:10px;letter-spacing:.07em;text-transform:uppercase;
        color:#77949a;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #223840}
      .metis-tools-hint{font-size:10px;color:#77949a;margin:0 0 6px;line-height:1.4}
      .metis-tools-row{display:flex;gap:6px;flex-wrap:wrap}
      .metis-tools-row button{border:1px solid #304b52;background:#102d35;color:#d8d1bc;
        padding:5px 9px;font:600 10px "IBM Plex Mono",monospace;text-transform:uppercase;
        letter-spacing:.04em;cursor:pointer;border-radius:0}
      .metis-tools-row button.active{border-color:#68cf91;color:#68cf91}
      .metis-tools-row button:disabled{opacity:.4;cursor:default}
      .metis-tools-readout{margin:6px 0 0;font-size:12px;color:#d9c69e;min-height:16px}
    `;
    document.head.appendChild(style);
  }

  function formatDistance(meters) {
    const km = meters / 1000;
    const mi = km * 0.621371;
    const kmText = km >= 100 ? km.toFixed(0) : km.toFixed(1);
    const miText = mi >= 100 ? mi.toFixed(0) : mi.toFixed(1);
    return `${kmText} km (${miText} mi)`;
  }

  function formatArea(squareMeters) {
    const km2 = squareMeters / 1e6;
    const mi2 = km2 * 0.386102;
    const kmText = km2 >= 100 ? km2.toFixed(0) : km2.toFixed(2);
    const miText = mi2 >= 100 ? mi2.toFixed(0) : mi2.toFixed(2);
    return `${kmText} km² (${miText} mi²)`;
  }

  // Drags by the header, switching from the panel's default top/right CSS
  // anchor to an explicit left/top in px on the first pointerdown -- keeps
  // it simple to reposition without the right-edge anchor fighting the
  // drag math. Pointer events (not mouse) so this also works on touch.
  function makeDraggable(root, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".metis-tools-close")) return;
      const rect = root.getBoundingClientRect();
      root.style.left = `${rect.left}px`;
      root.style.top = `${rect.top}px`;
      root.style.right = "auto";
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const maxLeft = window.innerWidth - root.offsetWidth;
      const maxTop = window.innerHeight - root.offsetHeight;
      root.style.left = `${Math.max(0, Math.min(maxLeft, startLeft + (event.clientX - startX)))}px`;
      root.style.top = `${Math.max(0, Math.min(maxTop, startTop + (event.clientY - startY)))}px`;
    });
    const stopDrag = (event) => {
      dragging = false;
      try { handle.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    };
    handle.addEventListener("pointerup", stopDrag);
    handle.addEventListener("pointercancel", stopDrag);
  }

  function create({ map, toggleButton } = {}) {
    if (!map || !toggleButton || !window.L) return null;
    ensureStyles();

    let root = null;
    let els = null;

    // ---- Distance state ----
    let distActive = false;
    let distPoints = [];
    let distMarkers = [];
    let distLine = null;

    // ---- Area state ----
    let areaActive = false;
    let areaPoints = [];
    let areaMarkers = [];
    let areaPolygon = null;

    function clearDistanceShapes() {
      distMarkers.forEach((m) => map.removeLayer(m));
      distMarkers = [];
      if (distLine) { map.removeLayer(distLine); distLine = null; }
    }

    function clearAreaShapes() {
      areaMarkers.forEach((m) => map.removeLayer(m));
      areaMarkers = [];
      if (areaPolygon) { map.removeLayer(areaPolygon); areaPolygon = null; }
    }

    function setDistActive(next) {
      distActive = next;
      if (next) setAreaActive(false);
      els.distBtn.textContent = next ? "Cancel" : "Measure";
      els.distBtn.classList.toggle("active", next);
      updateCursor();
    }

    function setAreaActive(next) {
      areaActive = next;
      if (next) setDistActive(false);
      els.areaBtn.textContent = next ? "Cancel" : "Draw";
      els.areaBtn.classList.toggle("active", next);
      els.areaFinishBtn.disabled = !next || areaPoints.length < 3;
      updateCursor();
    }

    function updateCursor() {
      map.getContainer().style.cursor = (distActive || areaActive) ? "crosshair" : "";
    }

    function resetDistance() {
      distPoints = [];
      clearDistanceShapes();
      setDistActive(false);
      els.distReadout.textContent = "";
    }

    function resetArea() {
      areaPoints = [];
      clearAreaShapes();
      setAreaActive(false);
      els.areaReadout.textContent = "";
    }

    function finishArea() {
      if (areaPoints.length < 3) return;
      const squareMeters = L.GeometryUtil.geodesicArea(areaPoints);
      els.areaReadout.textContent = formatArea(squareMeters);
      setAreaActive(false);
    }

    function onMapClick(event) {
      if (distActive) {
        const marker = L.circleMarker(event.latlng, {
          radius: 5, color: "#68cf91", weight: 2, fillColor: "#68cf91", fillOpacity: 0.9,
        }).addTo(map);
        distMarkers.push(marker);
        distPoints.push(event.latlng);
        if (distPoints.length === 1) return;
        distLine = L.polyline(distPoints, { color: "#68cf91", weight: 2, dashArray: "6 4" }).addTo(map);
        els.distReadout.textContent = formatDistance(distPoints[0].distanceTo(distPoints[1]));
        // Ends measuring mode but leaves the line/markers on screen until
        // the next "Measure" click clears them.
        setDistActive(false);
        return;
      }
      if (areaActive) {
        const marker = L.circleMarker(event.latlng, {
          radius: 5, color: "#d9c69e", weight: 2, fillColor: "#d9c69e", fillOpacity: 0.9,
        }).addTo(map);
        areaMarkers.push(marker);
        areaPoints.push(event.latlng);
        if (areaPolygon) map.removeLayer(areaPolygon);
        if (areaPoints.length >= 2) {
          areaPolygon = L.polygon(areaPoints, { color: "#d9c69e", weight: 2, fillOpacity: 0.12 }).addTo(map);
        }
        els.areaFinishBtn.disabled = areaPoints.length < 3;
      }
    }

    function panel() {
      if (root) return root;
      root = document.createElement("div");
      root.className = "metis-tools-panel";
      root.innerHTML = `
        <div class="metis-tools-head">
          <span class="metis-tools-kicker">Map tools</span>
          <button type="button" class="metis-tools-close" data-action="close" aria-label="Close map tools">&times;</button>
        </div>
        <div class="metis-tools-body">
          <div class="metis-tools-group">
            <div class="metis-tools-group-title">Distance</div>
            <div class="metis-tools-row">
              <button type="button" data-action="measure-dist">Measure</button>
              <button type="button" data-action="clear-dist">Clear</button>
            </div>
            <p class="metis-tools-readout" data-readout="dist"></p>
          </div>
          <div class="metis-tools-group">
            <div class="metis-tools-group-title">Area</div>
            <p class="metis-tools-hint">Click points to draw a shape, then Finish.</p>
            <div class="metis-tools-row">
              <button type="button" data-action="draw-area">Draw</button>
              <button type="button" data-action="finish-area" disabled>Finish</button>
              <button type="button" data-action="clear-area">Clear</button>
            </div>
            <p class="metis-tools-readout" data-readout="area"></p>
          </div>
        </div>`;
      document.body.appendChild(root);
      L.DomEvent.disableClickPropagation(root);
      L.DomEvent.disableScrollPropagation(root);
      makeDraggable(root, root.querySelector(".metis-tools-head"));

      els = {
        distBtn: root.querySelector('[data-action="measure-dist"]'),
        distReadout: root.querySelector('[data-readout="dist"]'),
        areaBtn: root.querySelector('[data-action="draw-area"]'),
        areaFinishBtn: root.querySelector('[data-action="finish-area"]'),
        areaReadout: root.querySelector('[data-readout="area"]'),
      };

      els.distBtn.addEventListener("click", () => {
        if (distActive) { resetDistance(); return; }
        clearDistanceShapes();
        distPoints = [];
        setDistActive(true);
      });
      root.querySelector('[data-action="clear-dist"]').addEventListener("click", resetDistance);
      els.areaBtn.addEventListener("click", () => {
        if (areaActive) { resetArea(); return; }
        clearAreaShapes();
        areaPoints = [];
        setAreaActive(true);
      });
      els.areaFinishBtn.addEventListener("click", finishArea);
      root.querySelector('[data-action="clear-area"]').addEventListener("click", resetArea);
      root.querySelector('[data-action="close"]').addEventListener("click", close);

      return root;
    }

    function open() {
      panel();
      root.classList.add("show");
      toggleButton.classList.add("active");
    }

    function close() {
      if (root) root.classList.remove("show");
      toggleButton.classList.remove("active");
    }

    function toggle() {
      if (root?.classList.contains("show")) close();
      else open();
    }

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (distActive) resetDistance();
      else if (areaActive) resetArea();
      else close();
    });

    toggleButton.addEventListener("click", toggle);
    map.on("click", onMapClick);

    return { open, close, toggle, isMeasuring: () => distActive || areaActive };
  }

  return { create };
})();
