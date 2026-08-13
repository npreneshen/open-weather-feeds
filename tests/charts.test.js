import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadCharts() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync("public/charts.js", "utf8"), context);
  return context.window.GlobalCharts;
}

const points = (values) => values.map((v, index) => ({ t: index * 1000, v }));

test("chart axes separate explicitly mixed units", () => {
  const charts = loadCharts();
  const assigned = charts.assignAxes([
    { label: "Humidity", unit: "%", points: points([40, 45, 50]) },
    { label: "Pressure", unit: "hPa", points: points([1002, 1005, 1001]) },
  ]);
  assert.equal(assigned[0].axis, "left");
  assert.equal(assigned[1].axis, "right");
});

test("chart axes separate series with vastly different scales", () => {
  const charts = loadCharts();
  const assigned = charts.assignAxes([
    { label: "Index", points: points([1, 2, 3]) },
    { label: "Visibility", points: points([8000, 12000, 10000]) },
  ]);
  assert.equal(assigned[0].axis, "left");
  assert.equal(assigned[1].axis, "right");
});

test("same-unit comparable series share the primary axis", () => {
  const charts = loadCharts();
  const assigned = charts.assignAxes([
    { label: "Maximum", unit: "°C", points: points([20, 21, 22]) },
    { label: "Minimum", unit: "°C", points: points([10, 11, 12]) },
  ]);
  assert.equal(assigned[0].axis, "left");
  assert.equal(assigned[1].axis, "left");
});

test("assignAxes compares later series against the primary (non-right) reference, not array position", () => {
  const charts = loadCharts();
  // A pre-assigned "right" series placed first used to corrupt the magnitude
  // reference for every later series, since it was taken from active[0]
  // regardless of axis.
  const assigned = charts.assignAxes([
    { label: "Small (already right)", axis: "right", points: points([1, 2, 3]) },
    { label: "Primary discharge", points: points([1000, 1005, 1010]) },
    { label: "Comparable discharge", points: points([1002, 1008, 1004]) },
  ]);
  assert.equal(assigned[0].axis, "right");
  assert.equal(assigned[1].axis, "left");
  assert.equal(assigned[2].axis, "left");
});

test("hourlySeries converts Open-Meteo's offset-less wall-clock strings to true UTC instants", () => {
  const charts = loadCharts();
  // Open-Meteo timezone=auto for a UTC+9:30 location returns local wall-clock
  // strings with no offset; the true UTC instant is 9.5 h earlier.
  const points = charts.hourlySeries(["2026-08-02T14:00"], [21.5], 9.5 * 3600);
  assert.equal(points[0].t, Date.parse("2026-08-02T04:30:00Z"));
});

test("hourlySeries treats untouched offset as already-UTC/GMT data", () => {
  const charts = loadCharts();
  const points = charts.hourlySeries(["2026-08-02T14:00"], [21.5]);
  assert.equal(points[0].t, Date.parse("2026-08-02T14:00:00Z"));
});

test("dailySeries parses date-only Open-Meteo values as UTC calendar days", () => {
  const charts = loadCharts();
  const points = charts.dailySeries(["2026-08-02"], [18.2]);
  assert.equal(points[0].t, Date.parse("2026-08-02T00:00:00Z"));
});
