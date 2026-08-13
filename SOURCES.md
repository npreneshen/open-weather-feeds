# Source catalogue

## Integrated feeds

| Source | Coverage | Access | Dashboard use |
|---|---|---|---|
| USGS Water Services | United States | No key | Stream gauges and history |
| USGS Earthquake Hazards | Global | No key | Earthquakes and regional FDSN queries |
| USGS / Smithsonian volcano data | Global catalogue; detailed US status | No key | Volcano locations and alerts |
| NOAA NHC | Atlantic and eastern/central Pacific | No key; gateway | Active tropical cyclones |
| NASA EONET | Global | No key | Open storms, floods, fires, drought, dust, ice and landslide events |
| GDACS / JRC | Global | No key; gateway | Multi-hazard impact alerts with severity, exposure and vulnerability context |
| NASA FIRMS | Global | Free map key; browser entry or optional Worker secret | Near-real-time VIIRS active-fire thermal anomalies for the visible map |
| NOAA/NWS | United States | No key | Active weather and tsunami alerts |
| NOAA NCEI GIS | Global archive | No key | Historical tsunami events |
| NOAA NDBC | Global buoy network | No key; gateway | Latest waves, wind, pressure, air/sea temperature and recent station histories (up to 45 days where reported) |
| NOAA CO-OPS | United States coasts | No key; gateway | Tide-gauge catalogue and recent observed water levels |
| NOAA Aviation Weather | Global aviation | No key; gateway; rate limited | METAR and volcanic-ash SIGMET |
| Open-Meteo Forecast | Global | No key; non-commercial public tier | Surface, 15-minute and pressure-level forecasts |
| Open-Meteo Air Quality | Global | No key; non-commercial public tier | AQI, pollutants, dust, UV and pollen |
| EPA AirNow | United States, Canada and Mexico | Free account key; browser entry or optional Worker secret | Monitoring-site AQI and pollutant concentrations |
| Google News RSS | Global; edition and language filters | No key; cached gateway | Weather/disaster reporting with topic, time and selected-location filters |
| Open-Meteo Marine | Global oceans | No key; non-commercial public tier | Waves, swell, SST and currents |
| Open-Meteo Historical | Global | No key; non-commercial public tier | Point history and reanalysis |
| Open-Meteo Ensemble Mean | Global | No key; non-commercial public tier | Mean and spread for probabilistic point forecasts |
| NOAA SWPC | Global impacts | No key | Kp, solar wind, X-rays and aurora |
| Earth Search STAC | Global | No key | Recent Sentinel/Landsat scene discovery |
| NASA GIBS | Global | No key; direct WMTS | Daily true-colour: MODIS Terra, MODIS Aqua, VIIRS SNPP; GOES-East/West GeoColor. Playback can fill inter-orbit swath gaps from the sibling sensors, and GOES sector gaps from earlier 10-minute scans |
| Esri World Imagery / Wayback | Global | No key; direct tiles; release list via gateway | High-zoom imagery; playback resolves distinct releases for the current view |
| EOX s2cloudless | Global | No key; direct WMTS | Annual cloud-free Sentinel-2 mosaics (2017–2025) |
| Copernicus Sentinel Hub | Global | Free instance ID | Sentinel-2 WMS; live view and playback use identical dated tile settings. Gap fill re-requests only the empty pixels with a 20/40/60-day scene window, then with the cloud cap lifted |
| NOAA MRMS | United States | No key; direct WMS | Radar-derived precipitation type |
| NASA/JPL CNEOS | Global | No key; gateway | Fireballs and near-earth objects |
| OpenSky | Global | Anonymous access is constrained | Aircraft context |

## Available through the gateway for future UI adapters

These services are allow-listed but are not presented as standalone layers yet:

- Open-Meteo Flood — GloFAS river-discharge history and forecast.
- MET Norway — independent global forecast plus Nordic alerts and nowcasting.
- NASA POWER — analysis-ready meteorological and solar history.
- Environment Canada GeoMet — OGC weather, climate, water, radar and model data.
- Bright Sky — accessible JSON over German DWD observations and forecasts.
- Open-Meteo Geocoding — global place search.

## Bulk sources requiring a separate ingestion pipeline

- ECMWF Open Data: free CC BY 4.0 IFS/AIFS GRIB forecast subset.
- NOAA NOMADS: GFS, GEFS, HRRR and other operational GRIB products.
- DWD Open Data: ICON, radar, observations and climate archives.
- NASA GIBS product catalogue beyond the integrated MODIS true-colour layer.
- Copernicus Climate Data Store: ERA5 and other large GRIB/NetCDF datasets.
- EUMETSAT Data Store: operational satellite product catalogues and downloads.

## Known gaps

- There is no credible unrestricted, no-key, global real-time lightning API.
- NHC is not a complete global tropical-cyclone authority. NASA EONET adds
  global context but is curated and should not replace basin warning centres.
- EONET event geometry is approximate and intended for visualization.
- Radar and national warning coverage remain fragmented by country.
- Model forecasts, observations, warnings and satellite-derived estimates must
  retain provider, run/observation time, valid time, units and licence metadata.
