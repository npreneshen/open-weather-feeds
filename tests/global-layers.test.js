import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadGlobalLayers(path) {
  const window = {};
  const context = vm.createContext({ window, Date, Map, Number, String, Math, Array });
  vm.runInContext(fs.readFileSync(path, "utf8"), context, { filename: path });
  return window.GlobalLayers;
}

function loadOpenMeteo() {
  const window = {};
  const context = vm.createContext({ window, Date, Map, Number, String, Math, Array, Object });
  vm.runInContext(fs.readFileSync("public/openmeteo.js", "utf8"), context, {
    filename: "public/openmeteo.js",
  });
  return window.OpenMeteo;
}

const eonetFixture = {
  events: [{
    id: "EONET_TEST",
    title: "Example storm",
    categories: [{ id: "severeStorms", title: "Severe Storms" }],
    sources: [{ id: "TEST", url: "https://example.test/event" }],
    geometry: [{
      date: "2026-07-29T12:00:00Z",
      type: "Point",
      coordinates: [28.04, -26.20],
    }],
  }],
};

const gdacsFixture = {
  type: "FeatureCollection",
  features: [{
    id: "EQ-100",
    type: "Feature",
    geometry: { type: "Point", coordinates: [28.04, -26.20] },
    properties: {
      eventtype: "EQ", eventid: 100, episodeid: 2, name: "Test earthquake",
      alertlevel: "Orange", alertscore: 1.7, country: "South Africa",
      // Real SEARCH-endpoint responses have no UTC offset on timestamps and
      // a structured url object rather than a flat string.
      fromdate: "2026-07-29T12:00:00", datemodified: "2026-07-29T13:30:00",
      severitydata: { severity: 5.2, severitytext: "Orange earthquake alert" },
      url: { report: "https://www.gdacs.org/report.aspx?eventid=100&episodeid=2&eventtype=EQ" },
    },
  }],
};

const coopsFixture = {
  stations: [{
    id: "1612340", name: "Honolulu", lat: 21.303333, lng: -157.86453,
    state: "HI", tidal: true, greatlakes: false, tideType: "Mixed", affiliations: "NWLON",
  }, {
    id: "9063020", name: "Buffalo", lat: 42.8774, lng: -78.8905,
    state: "NY", tidal: false, greatlakes: true,
  }],
};

for (const path of ["public/global-layers.js"]) {
  test(`${path} normalizes NASA EONET events`, async () => {
    const layers = loadGlobalLayers(path);
    const items = await layers.fetchNasaEvents(async (service, apiPath) => {
      assert.equal(service, "eonet");
      assert.equal(apiPath, "/api/v3/events");
      return eonetFixture;
    });
    const event = items.get("eonet-EONET_TEST");
    assert.equal(event.kind, "eonet");
    assert.equal(event.category, "Severe Storms");
    assert.equal(event.lat, -26.20);
    assert.equal(event.lon, 28.04);
  });

  test(`${path} normalizes GDACS impact alerts`, async () => {
    const layers = loadGlobalLayers(path);
    const items = await layers.fetchGdacs(async (service, apiPath) => {
      assert.equal(service, "gdacs");
      // EVENTS4APP hangs/never responds on GDACS's side; SEARCH is the
      // working equivalent endpoint.
      assert.match(apiPath, /geteventlist\/SEARCH/);
      return gdacsFixture;
    });
    const event = items.get("gdacs-EQ-100-2");
    assert.equal(event.alertLevel, "Orange");
    assert.equal(event.country, "South Africa");
    assert.equal(event.lat, -26.20);
    assert.equal(event.severity, "Orange earthquake alert");
    assert.equal(event.url, "https://www.gdacs.org/report.aspx?eventid=100&episodeid=2&eventtype=EQ");
    // fromdate/datemodified carry no UTC offset — must be parsed as UTC,
    // not the test runner's local timezone.
    assert.equal(event.time, Date.parse("2026-07-29T12:00:00Z"));
    assert.equal(event.updated, "2026-07-29T13:30:00");
  });

  test(`${path} normalizes NOAA CO-OPS stations and recent observations`, async () => {
    const layers = loadGlobalLayers(path);
    const stations = await layers.fetchCoopsStations(async () => coopsFixture);
    assert.equal(stations.get("coops-1612340").name, "Honolulu");
    assert.equal(stations.get("coops-9063020").greatLakes, true);
    let requestedDatum;
    const history = await layers.fetchCoopsHistory(async (_service, _path, params) => {
      requestedDatum = params.datum;
      return {
      data: [{ t: "2026-07-29 12:00", v: "0.42" }],
      };
    }, stations.get("coops-9063020"));
    assert.equal(history[0].v, 0.42);
    assert.equal(history.datum, "IGLD");
    assert.equal(requestedDatum, "IGLD");
    assert.ok(Number.isFinite(history[0].t));
  });

  test(`${path} requests regional earthquake history`, async () => {
    const layers = loadGlobalLayers(path);
    let request;
    const events = await layers.fetchRegionalQuakes(async (service, apiPath, params) => {
      request = { service, apiPath, params };
      return {
        features: [{
          id: "regional-test",
          geometry: { coordinates: [28.04, -26.2, 8.5] },
          properties: { mag: 3.2, time: "2026-07-29T12:00:00Z", place: "Test region" },
        }],
      };
    }, -26.2, 28.04, { days: 30, radiusKm: 150 });
    assert.equal(request.service, "earthquake");
    assert.equal(request.apiPath, "/fdsnws/event/1/query");
    assert.equal(request.params.maxradiuskm, 150);
    assert.equal(events[0].mag, 3.2);
  });

  test(`${path} fetchCyclones keeps one (earliest) point per storm from the Esri global feed`, async () => {
    const layers = loadGlobalLayers(path);
    const items = await layers.fetchCyclones(async () => ({
      features: [
        { attributes: { OBJECTID: 2, STORMNAME: "Dolphin", BASIN: "WP", STORMNUM: 12, LAT: 26.3, LON: 133.9, MAXWIND: 85, MSLP: 9999, TCDVLP: "Hurricane", ITCDVLP: "Very Strong Typhoon", TCDIR: 9999, TCSPD: 9999, FLDATELBL: "2026-08-06 12:00 AM Thu UTC" } },
        { attributes: { OBJECTID: 1, STORMNAME: "Dolphin", BASIN: "WP", STORMNUM: 12, LAT: 25.9, LON: 136.2, MAXWIND: 90, MSLP: 0, TCDVLP: "Hurricane", ITCDVLP: "Very Strong Typhoon", TCDIR: 0, TCSPD: 0, FLDATELBL: "2026-08-05 12:00 PM Wed UTC" } },
        { attributes: { OBJECTID: 3, STORMNAME: "Milton", BASIN: "AL", STORMNUM: 14, LAT: -12.5, LON: -45, MAXWIND: 60, MSLP: 995, TCDVLP: "Hurricane", ITCDVLP: "", TCDIR: 90, TCSPD: 10, FLDATELBL: "2026-08-05 06:00 AM Wed UTC" } },
      ],
    }));
    assert.equal(items.size, 2);
    const dolphin = items.get("cyclone-WP-12");
    assert.equal(dolphin.lat, 25.9);
    assert.equal(dolphin.lon, 136.2);
    assert.equal(dolphin.classification, "Very Strong Typhoon");
    assert.equal(dolphin.pressure, 0);
    assert.equal(dolphin.movementDir, 0);
    const milton = items.get("cyclone-AL-14");
    assert.equal(milton.lat, -12.5);
    assert.equal(milton.classification, "Hurricane");
    assert.equal(milton.movementDir, 90);
  });
}

test("Open-Meteo point bundle covers the documented variable families", () => {
  const om = loadOpenMeteo();
  assert.ok(om.FORECAST_HOURLY.split(",").length >= 65);
  assert.ok(om.FORECAST_PRESSURE_HOURLY.split(",").length >= 110);
  assert.match(om.FORECAST_HOURLY, /boundary_layer_height/);
  assert.match(om.FORECAST_HOURLY, /soil_moisture_27_to_81cm/);
  assert.match(om.AQ_HOURLY, /carbon_dioxide/);
  assert.match(om.AQ_HOURLY, /ragweed_pollen/);
  assert.match(om.MARINE_HOURLY, /tertiary_swell_wave_height/);
  assert.match(om.MARINE_HOURLY, /sea_level_height_msl/);
  assert.match(om.ARCHIVE_HOURLY, /soil_temperature_100_to_255cm/);
});

test("Open-Meteo ensemble mean requests mean and spread variables", async () => {
  const om = loadOpenMeteo();
  let request;
  await om.fetchEnsembleMean(async (service, path, params) => {
    request = { service, path, params };
    return { hourly: { time: [] } };
  }, -26.2, 28.04);
  assert.equal(request.service, "openmeteoEnsemble");
  assert.equal(request.path, "/v1/ensemble");
  assert.match(request.params.hourly, /temperature_2m_spread/);
  assert.match(request.params.models, /ensemble_mean/);
});

test("NDBC latest_obs.txt fields are read from the correct columns", async () => {
  const layers = loadGlobalLayers("public/global-layers.js");
  // Real column order: STN LAT LON YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
  const raw = [
    "#STN LAT LON YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE",
    "#text deg deg yr mo dy hr mn degT m/s m/s m sec sec degT hPa hPa degC degC degC nmi ft",
    "46042 36.79 -122.40 2026 08 02 10 00 270 8.5 10.2 2.1 9 7 275 1015.3 0.2 16.4 14.8 12.1 9.5 5.5",
  ].join("\n");
  const items = await layers.fetchBuoys(async () => ({ raw }));
  const buoy = items.get("buoy-46042");
  assert.equal(buoy.wdir, 270);
  assert.equal(buoy.wspd, 8.5);
  assert.equal(buoy.gst, 10.2);
  assert.equal(buoy.wvht, 2.1);
  assert.equal(buoy.dpd, 9);
  assert.equal(buoy.apd, 7);
  assert.equal(buoy.mwd, 275);
  assert.equal(buoy.pres, 1015.3);
  assert.equal(buoy.ptdy, 0.2);
  assert.equal(buoy.atmp, 16.4);
  assert.equal(buoy.wtmp, 14.8);
  assert.equal(buoy.dewp, 12.1);
  assert.equal(buoy.vis, 9.5);
  assert.equal(buoy.tide, 5.5);
});

test("NDBC recent history uses the provider header and exposes waves, SST and related series", () => {
  const layers = loadGlobalLayers("public/global-layers.js");
  const raw = [
    "#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE",
    "#yr mo dy hr mn degT m/s m/s m sec sec degT hPa degC degC degC nmi hPa ft",
    "2026 08 02 10 00 180 7.1 9.0 2.4 11 8 205 1014.2 18.5 21.7 15.1 8.0 -0.4 1.2",
    "2026 08 02 11 00 190 7.8 10.2 2.8 12 9 210 1013.8 19.0 22.1 15.4 7.5 -0.6 1.3",
  ].join("\n");
  const series = layers.parseNdbcHistorySeries(raw, ["WVHT", "WSPD", "PRES", "ATMP", "WTMP"]);
  assert.equal(series.WVHT[1].v, 2.8);
  assert.equal(series.WSPD[0].v, 7.1);
  assert.equal(series.PRES[0].v, 1014.2);
  assert.equal(series.ATMP[0].v, 18.5);
  assert.equal(series.WTMP[1].v, 22.1);
});
