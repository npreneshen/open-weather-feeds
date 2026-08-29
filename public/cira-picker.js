/* EXPERIMENTAL -- scoped to this folder only.

   Full RAMMB/CIRA SLIDER browser: every satellite/sector/band CIRA
   publishes, plus a resolution control. This can't become a live Leaflet
   map layer -- CIRA's imagery is in its own fixed geostationary projection,
   not Web Mercator (confirmed live researching the Himawari-only version of
   this), so it stays a standalone image browser, same as CIRA's own SLIDER
   site actually is. index.html's openImageModal() displays whatever this
   picker resolves to; the modal here only picks satellite/sector/band/zoom
   and hands back one entry for that viewer.

   Catalog source: public/rammb-catalog.json, generated from CIRA SLIDER's
   own define-products---rammb-slider.js config (satellite ids/sectors/
   products/max_zoom_level per sector) -- not guessed, pulled live and
   parsed. 8 satellites, matching CIRA's own satellite picker exactly:
   GOES-19/18, Himawari-9, GK2A, Meteosat-9/0deg/12, JPSS. */
window.MetisCiraPicker = (() => {
  "use strict";

  const ORDER = ["goes-19", "goes-18", "himawari", "gk2a", "meteosat-9", "meteosat-0deg", "meteosat-12", "jpss"];
  const GROUPS = [
    { title: "GOES · NOAA", satIds: ["goes-19", "goes-18"] },
    { title: "Himawari · JMA", satIds: ["himawari"] },
    { title: "GEO-KOMPSAT · KMA", satIds: ["gk2a"] },
    { title: "Meteosat · EUMETSAT", satIds: ["meteosat-9", "meteosat-0deg", "meteosat-12"] },
    { title: "JPSS · NOAA/NASA (polar)", satIds: ["jpss"] },
  ];
  const SAT_KEY = "metis-cira-satellite";
  const SEC_KEY = "metis-cira-sector";
  const PROD_KEY = "metis-cira-product";
  const ZOOM_KEY = "metis-cira-zoom";
  const FRAMES_KEY = "metis-cira-frames";
  // "# of Images" on CIRA's own SLIDER, trimmed to what's actually useful
  // here -- their site goes up to 60, matching the ceiling latest_times.json
  // can supply (see MAX_FRAMES). "1" is our own addition, not one of
  // theirs -- just the latest still, for when a whole sequence isn't wanted.
  const FRAME_COUNT_OPTIONS = [1, 6, 12, 24, 48];
  const DEFAULT_FRAME_COUNT = 24;
  // Total tiles in flight across the WHOLE batch, not per frame -- a single
  // shared limiter instead of nested frame/tile caps. Nesting (the old
  // TILE_CONCURRENCY=8 x FRAME_CONCURRENCY=2) meant a low-zoom request (one
  // tile per frame) only ever had 2 requests in flight at a time regardless
  // of the tile-level cap, which is what made a plain zoom-0/24-frame open
  // measure 70-90s live despite every request succeeding -- confirmed by
  // watching the network panel: at most 2 concurrent /api/tiles/cira
  // requests the whole time. One shared budget lets low-zoom opens use it
  // all (up to 24 frames in flight) while still bounding a high-zoom
  // request (many tiles/frame) to the same real concurrency as before.
  const GLOBAL_TILE_CONCURRENCY = 12;
  // latest_times.json returns up to 100 timestamps uncapped (confirmed live:
  // GOES-19 full_disk/geocolor) -- every one requires at least one proxied
  // round trip even at zoom 0, and stitching multiplies that by the tile
  // grid at higher zoom. Hard ceiling regardless of what the History field
  // picks, matching this app's other playback panels' typical session size
  // rather than everything the endpoint happens to retain.
  const MAX_FRAMES = 60;

  // A shared concurrency budget that many independent async tasks (here:
  // every tile fetch across every frame) can borrow from -- see
  // GLOBAL_TILE_CONCURRENCY above for why this replaced nested per-frame/
  // per-batch caps.
  function createLimiter(concurrency) {
    let active = 0;
    const queue = [];
    function next() {
      if (active >= concurrency || queue.length === 0) return;
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(
        (v) => { active--; resolve(v); next(); },
        (e) => { active--; reject(e); next(); },
      );
    }
    return {
      run(fn) {
        return new Promise((resolve, reject) => {
          queue.push({ fn, resolve, reject });
          next();
        });
      },
    };
  }

  // Every tile is proxied through /api/tiles/cira (not fetched directly from
  // slider.cira.colostate.edu) because CIRA sends no Access-Control-Allow-
  // Origin (confirmed live) -- drawing an unproxied cross-origin tile onto
  // the stitch canvas would taint it, and canvas.toBlob() (needed for both
  // display and GIF/PNG export) throws on a tainted canvas. The proxy adds
  // the header itself; see server.py's _handle_cira_tile / worker's
  // ciraTile for the matching server-side story.
  async function fetchTile(satellite, sector, product, timestamp, zoom, row, col) {
    const params = new URLSearchParams({ satellite, sector, product, timestamp, zoom: String(zoom), row: String(row), col: String(col) });
    const res = await fetch(`/api/tiles/cira?${params}`);
    if (!res.ok) throw new Error(`tile ${row}_${col} failed (${res.status})`);
    const blob = await res.blob();
    return createImageBitmap(blob);
  }

  // One frame at the chosen zoom = a 2^zoom x 2^zoom grid of same-size
  // tiles (confirmed live: every tile at every zoom level is the sector's
  // native tileSize px -- zoom adds more tiles, not bigger ones), stitched
  // onto one canvas and exported as a blob URL. A missing tile (edge of
  // coverage, or a transient failure) just leaves that cell blank rather
  // than failing the whole frame -- but a frame where EVERY tile is missing
  // (a band with no current imagery for this satellite/sector, confirmed
  // live: some combinations return 404 for every timestamp) used to still
  // "succeed" with a blank canvas, which is what "loads but no image, and
  // doesn't say no image available" actually was -- buildFrames' per-frame
  // catch only ever saw thrown errors, never a technically-valid empty
  // blob. Throwing here instead lets that same catch (and, if every frame
  // in the batch is empty, the existing "No imagery available right now."
  // message in index.html) handle it the normal way.
  async function stitchFrame({ satellite, sector, product, zoom, tileSize }, timestamp, limiter) {
    const grid = 2 ** zoom;
    const canvas = document.createElement("canvas");
    canvas.width = grid * tileSize;
    canvas.height = grid * tileSize;
    const ctx = canvas.getContext("2d");
    const cells = [];
    for (let row = 0; row < grid; row++) {
      for (let col = 0; col < grid; col++) cells.push({ row, col });
    }
    let drawn = 0;
    await Promise.all(cells.map((cell) => limiter.run(async () => {
      try {
        const bmp = await fetchTile(satellite, sector, product, timestamp, zoom, cell.row, cell.col);
        ctx.drawImage(bmp, cell.col * tileSize, cell.row * tileSize, tileSize, tileSize);
        drawn += 1;
      } catch { /* missing tile just leaves that cell blank */ }
    })));
    if (drawn === 0) throw new Error("No imagery for this timestamp");
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("Could not encode frame")); return; }
        resolve(URL.createObjectURL(blob));
      }, "image/png");
    });
  }

  // The real CIRA SLIDER deep link for this satellite/sector/product --
  // confirmed live that "sat"/"sec"/"p[0]" are the params that matter (x/y/z
  // just recenter the view and fall back to sane defaults when omitted or
  // invalid). Used for "Open original" instead of one of our own blob:
  // frame URLs, which die the moment the modal closes and the blob is
  // revoked -- that was the "link to open original not working" report.
  function originalUrl(satellite, sector, product) {
    const params = new URLSearchParams({ sat: satellite, sec: sector });
    return `https://slider.cira.colostate.edu/?${params}&p%5B0%5D=${encodeURIComponent(product)}`;
  }

  // Every entry in the returned array is a real, stitched, exportable frame
  // -- built upfront (not lazily per-frame) so the existing image-modal
  // viewer (a plain {url,label}[] contract shared with APOD/EPIC/SWPC) and
  // its GIF/PNG export just work without special-casing CIRA's async
  // tile-stitch step. onProgress(done, total), if given, is called after
  // each frame finishes -- a plain "Loading…" the whole time is what read as
  // "our app isn't loading" even though every tile request was succeeding;
  // a 24-frame zoom-0 batch alone measured 70-90s live against CIRA's own
  // servers, which looks stuck with no feedback that long.
  async function buildFrames(picked, onProgress) {
    // /api/proxy is POST-with-JSON-body (service/path/params), not a plain
    // GET -- matches how index.html's dataApi() calls it elsewhere; this
    // module can't reach that closured helper, so it's inlined here.
    const metaRes = await fetch("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "rammbSlider",
        path: `/data/json/${picked.satellite}/${picked.sector}/${picked.product}/latest_times.json`,
        params: {},
      }),
    });
    const meta = await metaRes.json();
    const allTimestamps = Array.isArray(meta?.timestamps_int) ? [...meta.timestamps_int].sort((a, b) => a - b) : [];
    const wanted = Number.isInteger(picked.frameCount) && picked.frameCount > 0 ? picked.frameCount : DEFAULT_FRAME_COUNT;
    const timestamps = allTimestamps.slice(-Math.min(wanted, MAX_FRAMES));
    const frames = new Array(timestamps.length);
    const limiter = createLimiter(GLOBAL_TILE_CONCURRENCY);
    const hdUrl = originalUrl(picked.satellite, picked.sector, picked.product);
    let done = 0;
    const tasks = timestamps.map((ts, i) => async () => {
      const s = String(ts);
      const y = s.slice(0, 4), mo = s.slice(4, 6), d = s.slice(6, 8), hh = s.slice(8, 10), mi = s.slice(10, 12);
      try {
        const url = await stitchFrame(picked, s, limiter);
        frames[i] = { url, hdUrl, label: `${y}-${mo}-${d} ${hh}:${mi} UTC` };
      } catch {
        frames[i] = null;
      }
      done += 1;
      onProgress?.(done, timestamps.length);
    });
    // No frame-level cap here (unlike the old FRAME_CONCURRENCY) -- every
    // frame's tile fetches start immediately and compete for the same
    // GLOBAL_TILE_CONCURRENCY budget above, so a low-zoom batch (few tiles/
    // frame) actually uses the full budget instead of being throttled by a
    // separate, smaller frame-level cap.
    await Promise.all(tasks.map((t) => t()));
    return frames.filter(Boolean);
  }

  let catalog = null;
  let catalogPromise = null;

  async function ensureCatalog() {
    if (catalog) return catalog;
    if (!catalogPromise) catalogPromise = fetch("/rammb-catalog.json").then((r) => r.json());
    catalog = await catalogPromise;
    return catalog;
  }

  function readStored(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  }
  function writeStored(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }

  // --- modal ---
  let root = null;
  let pending = null;

  function ensureStyles() {
    if (document.getElementById("metis-cira-styles")) return;
    const style = document.createElement("style");
    style.id = "metis-cira-styles";
    style.textContent = `
      .metis-cira-backdrop{position:fixed;inset:0;z-index:9200;display:none;
        background:rgba(4,14,18,.6);align-items:center;justify-content:center}
      .metis-cira-backdrop.show{display:flex}
      /* Same aero-glass system the sidepanes use (--glass-* custom
         properties, defined on .atlas-ui/<body> in index.html) -- was a
         flat, near-opaque panel, reported live as not matching the rest of
         the app. */
      .metis-cira-dialog{width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 48px);
        overflow-y:auto;overflow-x:hidden;
        background:linear-gradient(135deg,var(--glass-panel-a,rgba(16,39,45,.9)),var(--glass-panel-b,rgba(7,25,31,.85)));
        backdrop-filter:var(--glass-blur,blur(18px));-webkit-backdrop-filter:var(--glass-blur,blur(18px));
        border:1px solid var(--glass-line,#304b52);border-radius:8px;background-clip:padding-box;
        box-shadow:var(--glass-inner,inset 0 1px 0 rgba(255,255,255,.05)),var(--glass-drop,0 8px 24px rgba(0,8,12,.22)),0 20px 60px rgba(0,0,0,.45);
        font-family:"IBM Plex Mono",Consolas,monospace;color:#d8d1bc}
      .metis-cira-head{padding:8px 10px;border-bottom:1px solid var(--glass-line,#304b52);position:sticky;top:0;background:transparent;
        display:flex;justify-content:flex-end}
      .metis-cira-close{flex:none;background:#334155;border:0;color:#e8edf4;cursor:pointer;
        border-radius:4px;padding:.1rem .5rem;font-size:.9rem;line-height:1.2}
      .metis-cira-body{padding:10px 12px;overflow-x:hidden}
      .metis-cira-field{margin-bottom:10px}
      .metis-cira-field:last-child{margin-bottom:0}
      .metis-cira-field label{display:block;font-size:.6rem;letter-spacing:.06em;text-transform:uppercase;
        color:#77949a;margin-bottom:4px}
      .metis-cira-field select{display:block;width:100%;max-width:100%;box-sizing:border-box;
        background:var(--glass-control,#06171e);border:1px solid var(--glass-control-line,#304b52);color:#d8d1bc;padding:7px 8px;font:inherit;
        border-radius:4px;font-size:.72rem}
      .metis-cira-actions{display:flex;justify-content:flex-end;gap:8px;
        padding:10px 12px;border-top:1px solid var(--glass-line,#304b52);position:sticky;bottom:0;background:transparent}
      .metis-cira-actions button{border:1px solid var(--glass-line,#304b52);background:transparent;
        color:#d8d1bc;padding:6px 12px;font:600 .65rem "IBM Plex Mono",monospace;
        text-transform:uppercase;letter-spacing:.05em;cursor:pointer;border-radius:4px}
      .metis-cira-actions [data-action="open"]{border-color:#68cf91;color:#68cf91}
    `;
    document.head.appendChild(style);
  }

  function satOptionsHtml() {
    return GROUPS.map((group) => `<optgroup label="${group.title}">${group.satIds.map((id) =>
      `<option value="${id}">${catalog[id].satelliteTitle}</option>`).join("")}</optgroup>`).join("");
  }

  function dialog() {
    if (root) return root;
    ensureStyles();
    root = document.createElement("div");
    root.className = "metis-cira-backdrop";
    root.innerHTML = `
      <section class="metis-cira-dialog" role="dialog" aria-modal="true" aria-label="CIRA/RAMMB">
        <header class="metis-cira-head">
          <button type="button" class="metis-cira-close" data-action="close" aria-label="Close">×</button>
        </header>
        <div class="metis-cira-body">
          <div class="metis-cira-field">
            <label for="ciraSatSelect">Satellite</label>
            <select id="ciraSatSelect">${satOptionsHtml()}</select>
          </div>
          <div class="metis-cira-field">
            <label for="ciraSecSelect">Sector</label>
            <select id="ciraSecSelect"></select>
          </div>
          <div class="metis-cira-field">
            <label for="ciraProdSelect">Band</label>
            <select id="ciraProdSelect"></select>
          </div>
          <div class="metis-cira-field">
            <label for="ciraZoomSelect">Resolution</label>
            <select id="ciraZoomSelect"></select>
          </div>
          <div class="metis-cira-field">
            <label for="ciraFramesSelect">History</label>
            <select id="ciraFramesSelect">${FRAME_COUNT_OPTIONS.map((n) =>
              `<option value="${n}">${n === 1 ? "1 frame (latest only)" : `${n} frames`}</option>`).join("")}</select>
          </div>
        </div>
        <div class="metis-cira-actions">
          <button type="button" data-action="cancel">Cancel</button>
          <button type="button" data-action="open">Open</button>
        </div>
      </section>`;
    document.body.appendChild(root);

    const satSel = root.querySelector("#ciraSatSelect");
    const secSel = root.querySelector("#ciraSecSelect");
    const prodSel = root.querySelector("#ciraProdSelect");
    const zoomSel = root.querySelector("#ciraZoomSelect");

    function populateSectors(satId, preferSecId) {
      const sat = catalog[satId];
      const secIds = Object.keys(sat.sectors);
      secSel.innerHTML = secIds.map((id) => `<option value="${id}">${sat.sectors[id].title}</option>`).join("");
      secSel.value = secIds.includes(preferSecId) ? preferSecId : secIds[0];
      populateProducts(satId, secSel.value);
      populateZoom(satId, secSel.value);
    }
    function populateProducts(satId, secId, preferProdId) {
      const sec = catalog[satId].sectors[secId];
      prodSel.innerHTML = sec.groups.map((g) => `<optgroup label="${g.group}">${g.items.map((it) =>
        `<option value="${it.id}">${it.label}</option>`).join("")}</optgroup>`).join("");
      const flatIds = sec.groups.flatMap((g) => g.items.map((it) => it.id));
      prodSel.value = flatIds.includes(preferProdId) ? preferProdId : (flatIds.includes(sec.defaultProduct) ? sec.defaultProduct : flatIds[0]);
    }
    function populateZoom(satId, secId, preferZoom) {
      const sec = catalog[satId].sectors[secId];
      const max = sec.maxZoomLevel || 0;
      const opts = [];
      for (let z = 0; z <= max; z++) {
        const grid = 2 ** z;
        const px = grid * sec.tileSize;
        opts.push(`<option value="${z}">${z === 0 ? "Standard" : `Zoom ${z} (${grid}×${grid} tiles, ~${px}px)`}</option>`);
      }
      zoomSel.innerHTML = opts.join("");
      const wanted = Number.isInteger(preferZoom) ? Math.min(preferZoom, max) : 0;
      zoomSel.value = String(wanted);
    }

    satSel.addEventListener("change", () => populateSectors(satSel.value));
    secSel.addEventListener("change", () => { populateProducts(satSel.value, secSel.value); populateZoom(satSel.value, secSel.value); });

    const framesSel = root.querySelector("#ciraFramesSelect");

    root.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(null));
    root.querySelector('[data-action="close"]').addEventListener("click", () => finish(null));
    root.querySelector('[data-action="open"]').addEventListener("click", () => {
      const picked = {
        satellite: satSel.value, sector: secSel.value, product: prodSel.value, zoom: Number(zoomSel.value) || 0,
        frameCount: Number(framesSel.value) || DEFAULT_FRAME_COUNT,
      };
      writeStored(SAT_KEY, picked.satellite);
      writeStored(SEC_KEY, picked.sector);
      writeStored(PROD_KEY, picked.product);
      writeStored(ZOOM_KEY, String(picked.zoom));
      writeStored(FRAMES_KEY, String(picked.frameCount));
      finish(picked);
    });
    root.addEventListener("pointerdown", (event) => { if (event.target === root) finish(null); });
    root.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(null); });

    root.__populateSectors = populateSectors;
    return root;
  }

  function finish(result) {
    if (!pending) return;
    const current = pending;
    pending = null;
    current.root.classList.remove("show");
    current.resolve(result);
  }

  async function prompt() {
    await ensureCatalog();
    const dlg = dialog();
    if (pending) finish(null);
    const satSel = dlg.querySelector("#ciraSatSelect");
    const storedSat = readStored(SAT_KEY, "goes-19");
    satSel.value = ORDER.includes(storedSat) ? storedSat : "goes-19";
    dlg.__populateSectors(satSel.value, readStored(SEC_KEY, ""));
    const secSel = dlg.querySelector("#ciraSecSelect");
    const zoomSel = dlg.querySelector("#ciraZoomSelect");
    const prodSel = dlg.querySelector("#ciraProdSelect");
    const storedProd = readStored(PROD_KEY, "");
    const sec = catalog[satSel.value].sectors[secSel.value];
    const flatIds = sec.groups.flatMap((g) => g.items.map((it) => it.id));
    if (flatIds.includes(storedProd)) prodSel.value = storedProd;
    const storedZoom = Number(readStored(ZOOM_KEY, "0"));
    if (Number.isInteger(storedZoom)) zoomSel.value = String(Math.min(storedZoom, sec.maxZoomLevel || 0));
    const framesSel = dlg.querySelector("#ciraFramesSelect");
    const storedFrames = readStored(FRAMES_KEY, String(DEFAULT_FRAME_COUNT));
    framesSel.value = FRAME_COUNT_OPTIONS.map(String).includes(storedFrames) ? storedFrames : String(DEFAULT_FRAME_COUNT);
    return new Promise((resolve) => {
      pending = { resolve, root: dlg };
      dlg.classList.add("show");
      requestAnimationFrame(() => satSel.focus());
    });
  }

  function buildEntry(picked) {
    const sat = catalog[picked.satellite];
    const sec = sat.sectors[picked.sector];
    const prodItem = sec.groups.flatMap((g) => g.items).find((it) => it.id === picked.product);
    return {
      id: `cira-${picked.satellite}-${picked.sector}-${picked.product}-z${picked.zoom}-f${picked.frameCount}`,
      label: `${sat.satelliteTitle} — ${sec.title}`,
      source: "RAMMB / CIRA SLIDER",
      note: prodItem ? prodItem.label : picked.product,
      dynamic: "cira",
      cira: { ...picked, tileSize: sec.tileSize },
      openUrl: originalUrl(picked.satellite, picked.sector, picked.product),
    };
  }

  return { ensureCatalog, prompt, buildEntry, buildFrames };
})();
