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
  // daily-satellite-picker.js's picker; Aqua/VIIRS still exist as GIBS_DAILY
  // build targets and separate playback frame sources, just not as their
  // own layers.json/grid entries any more.
  const dailySat = layersJson.find((l) => l.id === "satelliteAqua" || l.id === "satelliteViirs");
  assert.equal(dailySat, undefined);
  assert.match(dailySatPicker, /satelliteAqua/);
  assert.match(dailySatPicker, /satelliteViirs/);
  assert.match(overlays, /satelliteAqua/);
  assert.match(overlays, /satelliteViirs/);
  assert.match(playback, /satelliteAqua/);
  assert.match(playback, /satelliteViirs/);
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
  assert.match(playback, /SENTINEL_MAX_WINDOW_DAYS/);
  assert.match(playback, /cloud cap lifted/);
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
