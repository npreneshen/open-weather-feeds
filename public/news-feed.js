/* Keyless Google News RSS weather/disaster stream. */
window.MetisNewsFeed = (() => {
  "use strict";

  const TOPICS = [
    ["weather", "weather OR severe weather"],
    ["storms", "storm OR hurricane OR cyclone OR tornado OR typhoon"],
    ["flood", "flood OR flash flood"],
    ["fire", "wildfire OR bushfire"],
    ["geological", "earthquake OR volcano OR tsunami OR landslide"],
    ["drought", "drought OR heatwave OR extreme heat"],
  ];

  const COUNTRY_CODES = ("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW").split(" ");
  const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
  const REGIONS = COUNTRY_CODES.map((code) => [code, regionNames?.of(code) || code]).sort((a, b) => a[1].localeCompare(b[1]));

  function esc(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function ensureStyles() {
    if (document.getElementById("metis-news-styles")) return;
    const style = document.createElement("style");
    style.id = "metis-news-styles";
    style.textContent = `
      .news-stream{display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden;background:#030c11!important;border-left:1px solid #36545c!important}
      .news-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:-.65rem -.65rem 0;padding:9px 10px;background:#010609;border-bottom:2px solid #f0bd3d}
      .news-head h2{margin:0!important;color:#f2c94c!important;font-size:1rem!important}
      .news-location{padding:8px 10px;margin:-2px -.65rem 0;border-left:0;border-bottom:1px solid #42616a;background:#0b222b;color:#b0c0c2;font-size:10px;line-height:1.45}
      .news-location strong{display:block;color:#f0e4c6;font:600 16px "Barlow Condensed",sans-serif;letter-spacing:.05em}
      .news-filter-toggle{width:auto!important;margin:7px 0 0!important;padding:5px 8px!important;text-align:left}
      .news-filters{display:none;margin-top:7px;padding:8px 0;border-top:1px solid rgba(109,185,190,.22);border-bottom:1px solid rgba(109,185,190,.22);background:transparent}
      /* .news-stream (the whole panel) is overflow:hidden so its own edges
         stay put in the outer grid split -- without its own scroll region,
         the filters (topics, custom keywords, window/edition, API key
         button) just got clipped with no way to reach the rest on short
         viewports (esp. mobile), instead of scrolling into view. */
      .news-filters.show{display:block;max-height:min(50vh,320px);overflow-y:auto}
      .news-topic-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 7px;margin-bottom:7px}
      .news-topic-grid label{display:flex!important;align-items:center;gap:5px;margin:0!important;font-size:10px!important;color:#9bacae!important}
      .news-topic-grid input{width:auto!important;margin:0!important}.news-filter-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}
      .news-filters input,.news-filters select{font-size:11px!important;padding:6px!important}.news-actions{display:grid;grid-template-columns:1fr auto;gap:6px;margin-top:7px}
      .news-actions button{margin:0!important}.news-status{min-height:18px;padding:7px 0;color:#77949a;font-size:10px;letter-spacing:.04em}
      .news-status.error{color:#ff7b72}.news-status.loading{color:#f2c94c}.news-results{flex:1;min-height:0;overflow:auto;border-top:1px solid #42616a;background:#020a0e}
      .news-item{display:grid;grid-template-columns:50px 1fr;gap:9px;padding:11px 5px;border-bottom:1px solid #29434b;color:inherit;text-decoration:none;transition:background .16s ease}
      .news-item:hover{background:#0d2932}.news-item-title{color:#f4ecd8;font:500 15px/1.25 "Barlow Condensed",sans-serif;letter-spacing:.012em}
      .news-item-meta{grid-column:1;color:#f2c94c;font-size:9px;line-height:1.35;letter-spacing:.04em;text-transform:uppercase}
      .news-item-copy{grid-column:2}.news-item-source{display:block;margin-bottom:3px;color:#62c9c8;font:600 9px "IBM Plex Mono",monospace;letter-spacing:.07em;text-transform:uppercase}
      .news-item-desc{margin-top:6px;color:#a6b8ba;font-size:10.5px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      .news-empty{padding:18px 4px;color:#77949a;font-size:11px;line-height:1.5}
    `;
    document.head.appendChild(style);
  }

  function create({ host } = {}) {
    if (!host) throw new Error("News feed host is required");
    ensureStyles();
    host.classList.add("news-stream");
    host.innerHTML = `
      <div class="news-head"><h2>Global feeds</h2></div>
      <div class="news-location"><strong>GLOBAL FEED</strong></div>
      <button type="button" class="secondary news-filter-toggle">FILTERS &amp; LOCATION ▾</button>
      <div class="news-filters">
        <div class="news-topic-grid">${TOPICS.map(([id]) => `<label><input type="checkbox" data-topic="${id}" checked> ${id.toUpperCase()}</label>`).join("")}</div>
        <label>CUSTOM KEYWORDS<input class="news-custom" type="text" placeholder="hail, atmospheric river…"></label>
        <div class="news-filter-row">
          <label>WINDOW<select class="news-window"><option value="1">24 HOURS</option><option value="3" selected>3 DAYS</option><option value="7">7 DAYS</option><option value="30">30 DAYS</option></select></label>
          <label>EDITION<select class="news-region">${REGIONS.map(([code, label]) => `<option value="${code}"${code === "US" ? " selected" : ""}>${label}</option>`).join("")}</select></label>
        </div>
        <label><input class="news-use-location" type="checkbox" checked style="width:auto"> FOCUS ON SELECTED LOCATION</label>
        <div class="news-actions"><button type="button" class="news-refresh">REFRESH NEWS</button><select class="news-language" aria-label="News language"><option value="en">EN</option><option value="es">ES</option><option value="fr">FR</option><option value="de">DE</option><option value="pt">PT</option></select></div>
        <div class="news-key-mount"></div>
      </div>
      <div class="news-status">LOADING PUBLIC RSS FEED…</div>
      <div class="news-results"><div class="news-empty">News adds reporting context and is kept distinct from observations.</div></div>`;

    const $ = (selector) => host.querySelector(selector);
    const locationBox = $(".news-location");
    const filters = $(".news-filters");
    const status = $(".news-status");
    const results = $(".news-results");
    let location = null;
    let requestId = 0;
    let timer = null;

    if (window.MetisApiKeys) window.MetisApiKeys.mount($(".news-key-mount"), ["currents"]);

    function setStatus(message, kind = "") {
      status.textContent = message;
      status.className = `news-status${kind ? ` ${kind}` : ""}`;
    }

    // A searched/clicked place resolves to up to three levels -- locality
    // (city), region (state/province), country. Each scope tier searches
    // exactly ONE of those, never several combined: Currents' `keywords`
    // field is a plain-text AND-match, not a boolean query language (verified
    // empirically -- "weather Johannesburg" reliably finds real articles,
    // but "weather storm Johannesburg" already returns zero every time), so
    // "Novorossiysk OR Krasnodar Krai OR Russia" has to mean three separate
    // single-term requests tried in turn, not one combined query -- see
    // load()'s scopes array, which is what actually produces the "OR".
    function placeForScope(scope) {
      if (scope === "global" || !$(".news-use-location").checked || !location) return "";
      if (scope === "placeonly") return location.locality || location.region || location.country || location.label || "";
      if (scope === "region") return location.region || "";
      if (scope === "country") return location.country || "";
      return location.locality || location.label || "";
    }

    function query(scope) {
      const place = placeForScope(scope);
      // "placeonly" drops the topic constraint entirely -- exactly what
      // typing the place name straight into CUSTOM KEYWORDS already does
      // (see rawTerms below), which is why that path surfaces real,
      // specific coverage ("satellite images show... hit at Russia's Black
      // Sea hub") that the topic-constrained tiers miss when the only
      // recent news about a place isn't itself weather/disaster-tagged.
      // It's a last resort, tried only after every topic-constrained tier
      // (full/region/country) has already come back empty -- see load().
      if (scope === "placeonly") return place ? `"${place.replace(/["()]/g, " ").trim().slice(0, 80)}"` : "(weather OR disaster)";
      const placeExpr = place ? `"${place.replace(/["()]/g, " ").trim().slice(0, 60)}"` : "";
      // Google News silently drops required phrases (and falls back to generic
      // top stories) once the combined query passes ~250 characters, so keep
      // the topic clause to one keyword per category whenever a location
      // phrase is competing for that budget instead of every synonym.
      const selected = [...host.querySelectorAll("[data-topic]:checked")]
        .map((input) => TOPICS.find(([id]) => id === input.dataset.topic)?.[1]).filter(Boolean)
        .map((group) => (placeExpr ? group.split(" OR ")[0] : group));
      const custom = $(".news-custom").value.trim();
      if (custom) selected.push(custom);
      let expression = selected.length ? `(${selected.join(" OR ")})` : "(weather OR disaster)";
      if (placeExpr) expression += ` ${placeExpr}`;
      return expression;
    }

    // The worker sends whichever single place term this tier means as
    // `locality` (Currents' own query builder already falls back to
    // `country` when `locality` is empty -- see fetchCurrentsNews in
    // worker/index.js -- so reusing that one field here needs no server
    // change), plus the resolved country/countryCode for display and any
    // future native country filtering. "placeonly" sends the place as
    // `custom` instead -- currentsTopicCandidates() treats a non-empty
    // custom term as the whole search, dropping the topic checkboxes the
    // same way a manually-typed keyword does.
    function rawTerms(scope) {
      if (scope === "placeonly") {
        return { topics: [], custom: placeForScope(scope), locality: "", country: location?.country || "", countryCode: location?.countryCode || "" };
      }
      const topics = [...host.querySelectorAll("[data-topic]:checked")]
        .map((input) => TOPICS.find(([id]) => id === input.dataset.topic)?.[1].split(" OR ")[0]).filter(Boolean);
      const custom = $(".news-custom").value.trim();
      return {
        topics, custom,
        locality: scope === "country" ? "" : placeForScope(scope),
        country: location?.country || "",
        countryCode: location?.countryCode || "",
      };
    }

    function render(items) {
      results.innerHTML = items.length ? items.map((item) => {
        const source = item.source || (item.category || [])[0] || "Google News";
        const time = item.published && !Number.isNaN(Date.parse(item.published))
          ? new Date(item.published).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
        const date = item.published && !Number.isNaN(Date.parse(item.published))
          ? new Date(item.published).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
        const content = `<div class="news-item-meta">${esc(time)}<br>${esc(date)}</div><div class="news-item-copy"><span class="news-item-source">${esc(source)}</span><div class="news-item-title">${esc(item.title)}</div>${item.description ? `<div class="news-item-desc">${esc(item.description)}</div>` : ""}</div>`;
        // The worker/server already strip non-http(s) URLs before this ever
        // arrives, but re-checking here means a link is never rendered on
        // trust alone, even if that upstream guarantee ever changes.
        const safeUrl = /^https?:\/\//i.test(item.url || "") ? item.url : "";
        return safeUrl ? `<a class="news-item" href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">${content}</a>` : `<article class="news-item">${content}</article>`;
      }).join("") : '<div class="news-empty">No matching reports were returned. Broaden the topics, turn off location focus, or increase the time window.</div>';
    }

    async function fetchNews(scope) {
      const currentsKey = window.MetisApiKeys ? window.MetisApiKeys.keyFor("currents") : "";
      const response = await fetch("/api/news", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A little more headroom than the usual 20s: this can fall through
        // to GDELT with a retry-and-backoff if Currents' shared key is ever
        // exhausted, and this runs once per location-scope tier (full ->
        // country -> global) on top of that.
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          query: query(scope),
          ...rawTerms(scope),
          language: $(".news-language").value,
          region: $(".news-region").value,
          days: Number($(".news-window").value) || 3,
          pageSize: 24,
          apiKey: currentsKey || undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
      return payload;
    }

    async function load() {
      const id = ++requestId;
      setStatus("SEARCHING WEATHER & DISASTER REPORTING…", "loading");
      // A narrow location filter (a small town/municipality) often has no
      // dedicated coverage at all -- rather than show "no results", widen
      // locality -> region until something comes back. Each of those is its
      // own single-term, topic-constrained request (see placeForScope) --
      // that's what "Novorossiysk OR Krasnodar Krai OR Russia" actually
      // means, tried in turn, not one combined query.
      // "placeonly" comes next, BEFORE the country-wide tier, and drops the
      // topic constraint: real recent coverage of the exact place (a port
      // city under a non-weather news cycle, say) beats generic country-wide
      // weather news that has nothing to do with the searched place at all
      // -- and "country" only finding *something* (not nothing) is exactly
      // that generic case, so this has to run before "country", not after,
      // or "country" always wins the moment it returns anything.
      const useLocation = $(".news-use-location").checked && !!location;
      const scopes = useLocation && location.country
        ? ["full", ...(location.region ? ["region"] : []), "placeonly", "country", "global"]
        : ["global"];
      // Stopping at the first tier with ANY results (>0) was the same bug
      // twice over: "full" or "country" finding one or two tenuous matches
      // is enough to short-circuit the loop before "placeonly" -- the tier
      // that actually tends to have the real, substantive coverage -- ever
      // gets a chance to run. Requiring a real result count before accepting
      // a tier fixes that; if nothing clears the bar, use whichever tier
      // still had the most (rather than blindly the last one tried).
      const MIN_GOOD_RESULTS = 3;
      try {
        let payload = null;
        let usedScope = scopes[0];
        for (const scope of scopes) {
          const attempt = await fetchNews(scope);
          if (id !== requestId) return;
          if (!payload || (attempt.items || []).length > (payload.items || []).length) {
            payload = attempt;
            usedScope = scope;
          }
          if ((attempt.items || []).length >= MIN_GOOD_RESULTS) break;
        }
        const scopeNote = usedScope === "region" ? ` · ${location.region}-wide (no local reports)`
          : usedScope === "placeonly" ? " · broader coverage of this place (not weather-specific)"
          : usedScope === "country" ? " · country-wide (no local reports)"
          : usedScope === "global" && useLocation ? " · global (no regional reports)" : "";
        render(payload.items || []);
        setStatus(`${payload.count || 0} REPORTS${scopeNote} · UPDATED ${new Date().toLocaleTimeString()} · 10 MIN CACHE`);
      } catch (error) {
        if (id !== requestId) return;
        // Leaving the previous location's articles on screen after a failed
        // fetch reads as "wrong news for this place" -- it's actually stale
        // news for the *last* place that succeeded, not a bad match.
        results.innerHTML = '<div class="news-empty">Could not load reports for this query. The status line below has the reason.</div>';
        setStatus(error.message || "News request failed", "error");
      }
    }

    function setLocation(next) {
      if (next?.pending) {
        const lat = Number(next.lat), lon = Number(next.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          locationBox.innerHTML = `<strong>Locating…</strong><span>${lat.toFixed(3)}°, ${lon.toFixed(3)}° · resolving place name</span>`;
        }
        return;
      }
      location = next && Number.isFinite(Number(next.lat)) && Number.isFinite(Number(next.lon))
        ? {
          label: String(next.label || ""), locality: String(next.locality || ""), region: String(next.region || ""),
          country: String(next.country || ""),
          countryCode: String(next.countryCode || "").toUpperCase(), lat: Number(next.lat), lon: Number(next.lon),
        } : null;
      if (location?.countryCode && COUNTRY_CODES.includes(location.countryCode)) {
        $(".news-region").value = location.countryCode;
      }
      locationBox.innerHTML = location
        ? `<strong>${esc(location.locality || location.label || "SELECTED POINT")}</strong><span>${esc(location.country || "Country resolving…")} · ${location.lat.toFixed(3)}°, ${location.lon.toFixed(3)}° · location-aware reporting</span>`
        : "<strong>GLOBAL FEED</strong>";
      clearTimeout(timer);
      timer = setTimeout(load, 350);
    }

    $(".news-filter-toggle").addEventListener("click", (event) => {
      filters.classList.toggle("show");
      event.currentTarget.textContent = filters.classList.contains("show") ? "FILTERS & LOCATION ▴" : "FILTERS & LOCATION ▾";
    });
    $(".news-refresh").addEventListener("click", load);
    $(".news-custom").addEventListener("keydown", (event) => { if (event.key === "Enter") load(); });
    window.addEventListener("metis-location-selected", (event) => setLocation(event.detail));
    // Saving (or removing, reverting to the site default) a Currents key
    // otherwise sits invisible until the next manual refresh/location change
    // -- fetchNews() already reads the current key fresh each call, this
    // just makes sure a call actually happens right after it changes.
    window.addEventListener("metis-api-key-changed", (event) => {
      if (event.detail?.feed === "currents") load();
    });

    load();
    return { load, setLocation };
  }

  return { create };
})();
