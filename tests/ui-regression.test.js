import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const news = await readFile(new URL("../public/news-feed.js", import.meta.url), "utf8");

test("initial viewport frames the contiguous United States", () => {
  assert.match(html, /const US_DEFAULT_VIEW = \{ latBottom: 24\.2, latTop: 50\.0, lonLeft: -125\.2, lonRight: -66\.3 \}/);
  assert.match(html, /map\.fitBounds\([\s\S]*US_DEFAULT_VIEW\.latBottom[\s\S]*US_DEFAULT_VIEW\.lonRight/);
  assert.doesNotMatch(html, /applyPreset\("California"\)/);
});

test("sidebar tabs sit outside the Leaflet zoom control lane", () => {
  assert.match(html, /\.sidebar-rail-btn \{[\s\S]*top:50%/);
  assert.match(html, /translate\(100%,-50%\)/);
  assert.doesNotMatch(html, /map\.addControl\(drawControl\)/);
});

test("enabling a data layer fetches only that layer and retains its last payload", () => {
  assert.match(html, /fetchGlobal\(false, new Set\(\[layerId\]\)\)/);
  assert.match(html, /const targets = onlyLayerIds/);
  assert.doesNotMatch(html, /global\.data\.delete\(layerId\)/);
  assert.doesNotMatch(html, /water\.sites\.clear\(\)/);
});

test("Satellite is always the startup category", () => {
  assert.match(html, /let activeLayerGroup = "satellite"/);
  assert.doesNotMatch(html, /localStorage\.getItem\("metis-layer-category"\) \|\| "hazards"/);
});

test("the layer rail has five categories with Satellite first and default, and no separate Other rail", () => {
  assert.match(html, /const order = \["satellite", "hazards", "water", "atmosphere", "space"\]/);
  assert.doesNotMatch(html, /icons\.other|labels\.other/);
  assert.match(html, /let activeLayerGroup = "satellite"/);
});

test("satellite true-colour and World Imagery layers belong to their own catalog group, not Air & Ocean's imagery bucket", async () => {
  const layersJson = await readFile(new URL("../public/layers.json", import.meta.url), "utf8");
  const layers = JSON.parse(layersJson);
  const satellite = layers.find((l) => l.id === "satellite");
  const worldimagery = layers.find((l) => l.id === "worldimagery");
  assert.equal(satellite.group, "satellite");
  assert.equal(worldimagery.group, "satellite");
});

test("USGS bounding-box coordinates are capped at seven decimal places", () => {
  assert.match(html, /function coord7\(value\)[\s\S]*toFixed\(7\)/);
  assert.match(html, /bBox: bboxParam\(tile\)/);
  assert.doesNotMatch(html, /bBox: `\$\{tile\.lonLeft\}/);
});

test("NDBC modal exposes multi-variable recent histories", () => {
  assert.match(html, /NDBC · Waves \(recent record, up to 45 d\)/);
  assert.match(html, /Sea-surface temperature/);
  assert.match(html, /3 h pressure tendency/);
});

test("earthquakes prefer direct public CORS and restore contextual history", () => {
  assert.match(html, /\["eonet", "earthquake"\]\.includes\(service\)/);
  assert.match(html, /fetchRegionalQuakes\(dataApi, item\.lat, item\.lon/);
  assert.match(html, /150 km regional history \(\$\{historyDays\} d/);
});

test("news headlines use a lighter newswire hierarchy", () => {
  assert.match(news, /news-item-title\{[^}]*font:500 15px\/1\.25/);
  assert.match(news, /news-results\{[^}]*background:#020a0e/);
});
