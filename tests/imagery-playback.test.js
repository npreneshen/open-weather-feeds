import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const playback = await readFile(new URL("../public/imagery-playback.js", import.meta.url), "utf8");
const sentinel = await readFile(new URL("../public/sentinel-hub.js", import.meta.url), "utf8");
const overlays = await readFile(new URL("../public/map-overlays.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const layersJson = JSON.parse(await readFile(new URL("../public/layers.json", import.meta.url), "utf8"));
const dailySatPicker = await readFile(new URL("../public/daily-satellite-picker.js", import.meta.url), "utf8");

test("Wayback playback searches past N releases for distinct viewport fingerprints", () => {
  assert.match(playback, /selectDistinctWaybackFrames/);
  assert.match(playback, /const searchLimit = newestFirst\.length/);
  assert.match(playback, /probeWorldImageryFingerprint/);
  assert.match(playback, /reproducing the mixed-age mosaic seen live/);
});

test("Sentinel playback uses the same dated WMS window as live view", () => {
  assert.match(sentinel, /const WINDOW_DAYS = 10/);
  assert.doesNotMatch(sentinel, /PLAYBACK_WINDOW_DAYS/);
  assert.doesNotMatch(playback, /sentinelCoverageProbe/);
  assert.doesNotMatch(playback, /skipPartial/);
  assert.match(playback, /const shWindow = window\.MetisSentinelHub\?\.WINDOW_DAYS/);
});

test("playback keeps requested dates and rejects rendered white error frames", () => {
  assert.match(playback, /Preserve every requested date/);
  assert.doesNotMatch(playback, /same as previous frame/);
  assert.match(playback, /renderedError/);
});

test("playback can cancel in-flight loads and capture frames concurrently", () => {
  assert.match(playback, /AbortController/);
  assert.match(playback, /cancelLoad/);
  assert.match(playback, /FRAME_CAPTURE_CONCURRENCY/);
  assert.match(playback, /TILE_CACHE_MAX/);
});

test("GIBS Aqua and VIIRS are catalogued satellite layers", () => {
  // Terra/Aqua/VIIRS collapsed into one "satellite" grid layer plus
  // daily-satellite-picker.js's picker; Aqua/VIIRS still exist as
  // MetisDailySat.SATELLITES entries and separate playback frame sources,
  // just not as their own layers.json/grid entries any more. overlays/
  // playback no longer name satelliteAqua/satelliteViirs literally -- both
  // resolve satellite AND product dynamically through window.MetisDailySat
  // (see buildGibsDaily/tileUrlFor), the same pattern geoWmsInfo() uses for
  // the GOES/Meteosat/MTG family.
  const dailySat = layersJson.find((l) => l.id === "satelliteAqua" || l.id === "satelliteViirs");
  assert.equal(dailySat, undefined);
  assert.match(dailySatPicker, /satelliteAqua/);
  assert.match(dailySatPicker, /satelliteViirs/);
  assert.match(overlays, /window\.MetisDailySat\?\.layerInfo/);
  assert.match(playback, /window\.MetisDailySat\?\.SATELLITES\[layerId\]/);
});

test("map overlays expose Wayback probe helpers for playback", () => {
  assert.match(overlays, /probeWorldImageryFingerprint/);
  assert.match(overlays, /probeWorldImageryItemId,/);
});

test("capture measures real imagery coverage rather than trusting HTTP success", () => {
  // A transparent or no-data-black tile is a 200 OK, so tile counts alone
  // cannot tell a full frame from an empty one.
  assert.match(playback, /function coverageFromImageData/);
  assert.match(playback, /function imageCoverage/);
  assert.match(playback, /function canvasDataCoverage/);
  assert.match(playback, /pixelCoverage: dataCoverage/);
});

test("gap fill degrades along each provider's own axis", () => {
  assert.match(playback, /function gapFillPlan/);
  // Sentinel's escalation plan lives in sentinel-hub.js rather than being
  // hand-rolled here, so the resolved-date/window semantics stay in one place.
  assert.match(playback, /window\.MetisSentinelHub\.gapFillPlan\(windowDays, \{/);
  assert.match(sentinel, /function gapFillPlan/);
  assert.match(sentinel, /MAX_WINDOW_DAYS/);
  assert.match(sentinel, /cloud cap lifted/);
  // Widen-vs-lift-cap order flips with priority: "mostRecent" lifts the cap
  // at the current window before ever searching further back in time
  // (recency beats clarity); "leastCC" (default) widens first and only
  // lifts the cap as a last resort (clarity beats recency).
  assert.match(sentinel, /priority === "mostRecent"/);
  assert.match(playback, /siblingLayer/);
  assert.match(playback, /shiftGoesSlot/);
  assert.match(playback, /function providerUsesAlpha/);
  // Fills go underneath what is already drawn, so real data is never lost.
  assert.match(playback, /destination-over/);
  // Swath wedges cut through tiles, so opaque JPEG no-data black is keyed to
  // alpha and filled per pixel rather than only whole-tile.
  assert.match(playback, /function keyTileNoData/);
  assert.match(playback, /const perPixelFill = nativeAlpha \|\| keyNoData/);
});

test("playback steps each EUMETSAT feed by its own advertised publish period", () => {
  // Measured live against EUMETSAT's GetCapabilities: these Dimensions
  // declare wildly different periods (Metop PT1H40M, Meteosat PT15M, MTG
  // PT10M, OSI SAF SST PT12H) plus nearestValue="1", so every request inside
  // one period snaps to the same scene. Stepping Metop on GIBS' 10-minute
  // GOES grid returned 7 frames that were 2 distinct images, and generated 61
  // requests for a 10-hour span that holds only 6 real scenes.
  assert.match(overlays, /function parseIsoPeriodMinutes/);
  assert.match(overlays, /mtgTimePeriodFor:/);
  assert.match(playback, /function timeRange\(hoursBack, intervalMinutes, latestSlotMs, periodMinutes\)/);
  assert.match(playback, /mtgTimePeriodFor\?\.\(geoInfo\.wmsLayer\)/);
  // A confirmed slot is a real published timestamp (Metop's are orbit phase,
  // e.g. 12:07Z) and must not be re-rounded onto a 10-minute wall clock.
  assert.match(playback, /\? latestSlotMs\b/);
});

// Guards the arithmetic itself, not just that the wiring exists.
test("timeRange never steps finer than the publish period and ends on the real slot", async () => {
  const src = await readFile(new URL("../public/imagery-playback.js", import.meta.url), "utf8");
  const extracted = src.match(/function timeRange\(hoursBack[\s\S]*?\n {2}\}/);
  assert.ok(extracted, "timeRange should be extractable");
  // eslint-disable-next-line no-new-func
  const timeRange = new Function(`${extracted[0]}; return timeRange;`)();

  const latest = Date.parse("2026-08-23T12:07:00Z"); // a real Metop slot, off-grid
  const frames = timeRange(10, 10, latest, 100); // ask for a 10-min step on a 100-min feed
  assert.equal(frames[frames.length - 1], "2026-08-23T12:07:00Z", "newest frame is the real slot");
  assert.equal(new Set(frames).size, frames.length, "every frame is a distinct timestamp");
  // 10 hours at a 100-minute cadence is 6 whole steps back, so 7 frames --
  // not the 61 a 10-minute grid produced.
  assert.equal(frames.length, 7);
  for (let i = 1; i < frames.length; i++) {
    const gap = Date.parse(frames[i]) - Date.parse(frames[i - 1]);
    assert.equal(gap, 100 * 60000, "consecutive frames are one whole period apart");
  }
  // GOES' 10-minute default is unchanged, and still ends on its confirmed slot.
  const goes = timeRange(1, 10, Date.parse("2026-08-23T17:30:00Z"), 10);
  assert.equal(goes.length, 7);
  assert.equal(goes[goes.length - 1], "2026-08-23T17:30:00Z");
});

test("near-real-time playback requests the provider's real slots, not a guessed cadence", async () => {
  // GetCapabilities' time Dimension is "start/end/period", which enumerates
  // every timestamp the provider actually holds. Verified live: a 12-hour
  // range enumerated 8 real Metop-B slots and 73 real MTG slots and every
  // one returned imagery -- 0 errors. The old hours-back/interval path
  // produced 61 frames for 10 hours of Metop, which publishes ~6.
  assert.match(overlays, /let mtgTimeExtents = \{\}/);
  assert.match(overlays, /mtgTimeSlotsBetween: \(wmsLayer, fromMs, toMs, stepDivisor = 1\)/);
  assert.match(overlays, /mtgTimeExtentFor:/);
  // Slots must be phase-locked to the extent's END walking backwards. Metop's
  // extent is not a whole number of periods (75 min over), so enumerating
  // forward from its start lands off every real slot -- and EUMETSAT answers
  // a between-slots TIME with a slow 502, not a fast 404.
  assert.match(overlays, /extent\.endMs - Math\.floor\(\(extent\.endMs - upper\) \/ stepMs\) \* stepMs/);
  assert.match(playback, /mtgTimeSlotsBetween\?\.\(geoInfo\.wmsLayer, rangeStartMs, rangeEndMs, enumStepDivisor\)/);
  assert.match(playback, /async function previewRange/);
  assert.match(playback, /async function layerExtent/);

  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="playbackRangeStartDate"/);
  assert.match(html, /id="playbackRangeEndDate"/);
  // A wide range on a 10-minute feed is thousands of requests -- confirm first.
  assert.match(html, /BULK_FRAME_CONFIRM_THRESHOLD/);
  // The default range comes from the layer's own extent. No fixed lookback
  // works for both MTG (minutes old) and Metop-A (ended 2021).
  assert.match(html, /imageryPlayback\.layerExtent\(layerId\)/);
  // From/To each get their own full-width row -- a datetime-local packs date
  // and time into one control and gets clipped at half the sidebar's width.
  assert.match(html, /class="playback-range-row"/);
  assert.match(html, /id="playbackRangeStartDate"/);
  assert.match(html, /id="playbackRangeStartTime"/);
  assert.match(html, /playback-range-presets/);
});

test("playback fetches one GetMap per frame instead of a tile grid", async () => {
  // Measured against the EUMETSAT proxy: 25 tiles at 6-way concurrency took
  // 10.9s; the equivalent single 1280x1280 GetMap took 3.1s (3.5x), taking 22
  // frames from ~4 min to ~1.2 min. Raising concurrency does NOT help -- the
  // browser already reaches 24 in flight but the provider saturates at ~2.9
  // responses/sec, so only cutting request COUNT moves the wall clock. No
  // resolution is lost: one 1280x1280 GetMap over a 5x5 tile view is the same
  // pixels the tiles produced.
  assert.match(playback, /async function captureViewWmsFrame/);
  assert.match(playback, /const SINGLE_VIEW_MAX_PX = 1600/);
  // Must stay within the proxy's own cap, and fall back to tiles beyond it.
  const server = await readFile(new URL("../server.py", import.meta.url), "utf8");
  assert.match(server, /1 <= width <= 1600 and 1 <= height <= 1600/);
  assert.match(playback, /width <= SINGLE_VIEW_MAX_PX && height <= SINGLE_VIEW_MAX_PX/);
  // No fall-through to the tile grid on failure: measured, EUMETSAT 502s a
  // given time/area for a 256x256 tile exactly as for a 1599x1599 GetMap, so
  // retrying as 25 tiles just fails 25 more times -- one such frame was 75 of
  // the 105 requests in a 15-frame load.
  assert.doesNotMatch(playback, /if \(frame\) return frame;/);
  assert.match(playback, /Deliberately NO fall-through to the tile grid/);
});

test("each Metop layer resolves its OWN time, never the first layer's", async () => {
  // Measured live against EUMETSAT GetCapabilities: these layers' latest
  // scenes are years apart -- eps:m01_* 2026-08-23T13:49Z, eps:m03_*
  // 2026-08-23T12:31Z, eps:m02_* (Metop-A, decommissioned) 2021-11-15T07:46Z,
  // and the SST composite 00:00Z on a PT12H cadence. A GetMap carries exactly
  // one `time`, so merging them into one comma-list request forces every
  // layer onto one wrong timestamp: measured HTTP 502 for Metop-A and a
  // 475-byte empty PNG for SST, while each returns 149KB/150KB/15.6KB at its
  // own time. With Metop-A first in the list the whole group went blank.
  assert.match(overlays, /const resolveMetopTime = /);
  // No comma-joined multi-layer Metop request may come back.
  assert.doesNotMatch(overlays, /wmsLayerNames\.join\(","\)/);
  // The single-image path builds one layer per entry, each with its own time.
  assert.match(overlays, /entries\.forEach\(\(entry, i\) =>/);
  assert.match(overlays, /resolveMetopTime\(entry\.wmsLayer\)/);
  // The one-slot UI hint reports the NEWEST active layer, not the first,
  // so an archive satellite can't make a current view look four years stale.
  assert.match(overlays, /const noteMetopTime = /);
  assert.match(overlays, /Date\.parse\(t\) > Date\.parse\(lastMetopTime\)/);

  // Playback requests EVERY published slot in the range. A cadence heuristic
  // that thinned to one slot per "accumulation window" kept 9 of 52 real
  // Metop-B slots for 2026-08-20..23, where fetching all 52 yields 39
  // distinct images -- it discarded 30 real images to avoid 10 repeats.
  const picker = await readFile(new URL("../public/metop-picker.js", import.meta.url), "utf8");
  assert.doesNotMatch(picker, /accumOrbits:\s*\d/);
  assert.doesNotMatch(playback, /accumOrbits/);
});

test("Metop's real cadence jitters off its declared nominal period, so playback probes a finer grid and dedupes by actual pixels", async () => {
  // The declared "PT1H40M" period is nominal, not exact: Metop is a polar
  // orbiter. Verified live against the user's own reported 6 timestamps --
  // gaps of 99, 99, 100, 100 minutes, not a flat 100 -- and the previous
  // nominal-grid-only enumeration demonstrably missed real slots sitting a
  // few minutes off its guessed grid (reported live: 6 real frames existed
  // where the app only found 4). Confirmed this is Metop-specific, not a
  // general EUMETSAT property: the identical live check against MTG (PT10M)
  // and Meteosat (PT15M) found 8/8 images exactly on their declared grid,
  // zero jitter -- a fixed geostationary scan schedule, unlike an orbit.
  assert.match(playback, /enumStepDivisor = \(geoInfo\?\.family === "metop" \|\| geoInfo\?\.family === "metopSst"\) \? 2 : 1;/);
  // Declared at loadFrames' top level, not inside the branch that sets it --
  // the dedup pass far below reads it for every layer family.
  assert.match(playback, /let enumStepDivisor = 1;/);
  // A finer grid can legitimately probe the same real slot twice via
  // EUMETSAT's own nearestValue snapping. That's different from the general
  // "preserve every requested date" guarantee below (still intact and
  // still tested), which is about not dropping real-but-similar scenes on
  // OTHER providers -- this collapses two requests that resolved to the
  // literal same pixels, gated on the divisor so it's a no-op everywhere
  // else (MTG, Meteosat, date-range, Wayback never set it above 1).
  assert.match(playback, /function framesLookIdentical\(fpA, fpB\)/);
  assert.match(playback, /changed \/ fpA\.length < DUPLICATE_CHANGED_FRAC/);
  assert.match(playback, /if \(enumStepDivisor > 1 && prevKeptFingerprint && framesLookIdentical\(r\.fingerprint, prevKeptFingerprint\)\)/);
  // The general guarantee is untouched.
  assert.match(playback, /Preserve every requested date/);
});

test("playback's imagery source picks up whichever layer is active on page load", async () => {
  // syncPlaybackToLayer() only ever ran from a checkbox's own "change" event
  // -- correct for a layer switched on mid-session, but loadLayerCatalog()
  // enables the catalog's default layer (World Imagery) without any click to
  // fire that event, so restorePlaybackPrefs() alone decided the dropdown's
  // value: whatever was last picked, not what's actually on screen.
  // Reproduced live: fresh load had World Imagery active on the map and
  // Metop-B (a stale leftover) still selected in Playback.
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /for \(const layerId of \["satellite", "worldimagery", "s2cloudless", "sentinelhub", "nightlights", "geostationary", "metop", "geosmosaic"\]\) \{\s*\n\s*if \(global\.enabled\.has\(layerId\)\) \{ syncPlaybackToLayer\(layerId\); break; \}/);
});

test("manual Prev/Next clamps at the ends instead of wrapping", () => {
  // Reproduced live: with 15 real frames loaded, clicking Next 15 times from
  // frame 1 correctly reaches "Frame 15 / 15", but modulo wraparound made a
  // 16th click silently jump back to "Frame 1 / 15" with only the small text
  // label as a cue -- someone stepping through by eye, not reading the
  // label, counts that as a 16th distinct frame ("I counted 16 frames").
  // Play/loop mode keeps its own separate advanceIndex(), which still wraps
  // per loopMode -- that repetition is the point of a loop. Only the
  // manual-review path (Prev/Next buttons, arrow keys) needed to stop at
  // the ends instead.
  assert.match(playback, /function stepFrame\(delta\) \{/);
  assert.match(playback, /playIndex = Math\.max\(0, Math\.min\(currentDates\.length - 1, playIndex \+ delta\)\);/);
  assert.doesNotMatch(playback, /playIndex = \(playIndex \+ delta \+ currentDates\.length\) % currentDates\.length;/);
  // advanceIndex (used by Play) is untouched -- it must still wrap/bounce.
  assert.match(playback, /playIndex = \(playIndex \+ 1\) % currentDates\.length;/);
});

test("the live Sentinel map layer is a plain WMS layer with no per-tile gap fill", () => {
  // A custom canvas GridLayer that ran the gap-fill escalation against live
  // tiles was tried and reverted: Leaflet holds a tile invisible until
  // createTile's done() fires, so deferring that until the escalation
  // finished left tiles blank for several round-trips, and per-tile
  // escalation with no shared concurrency cap turned one view into ~125
  // requests against a rate-limited free tier. Gap fill stays in playback,
  // which has bounded concurrency and no incremental-paint requirement.
  assert.doesNotMatch(overlays, /SentinelGapFillTileLayer\s*=/);
  assert.doesNotMatch(overlays, /window\.MetisSentinelHub\.gapFillPlan\(/);
  assert.match(overlays, /L\.tileLayer\.wms\(`https:\/\/sh\.dataspace\.copernicus\.eu/);
  // Reading tile pixels back is what forced crossOrigin, which turns any
  // CORS-less error/rate-limit response into a blank tile instead of a
  // displayed one.
  assert.doesNotMatch(overlays, /crossOrigin: true,\s*\n\s*minZoom: 10/);
});

test("gap fill is opt-in and never fabricates data for Esri Wayback", () => {
  assert.match(playback, /gapFill = false/);
  assert.match(html, /id="playbackGapFill"/);
  assert.match(html, /gapFill: els\.playbackGapFill\.checked && !wayback/);
});

test("playback overlay tracks the map instead of drifting on pan", () => {
  assert.match(playback, /function positionOverlay/);
  assert.match(playback, /map\.on\("move zoomend viewreset resize", positionOverlay\)/);
});

test("playback exposes frame stills, per-frame info and persists its settings", () => {
  assert.match(playback, /function exportFramePng/);
  assert.match(playback, /function frameInfo/);
  assert.match(html, /id="playbackPngBtn"/);
  assert.match(html, /PLAYBACK_PREFS_KEY/);
});
