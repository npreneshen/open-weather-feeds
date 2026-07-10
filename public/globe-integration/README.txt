Globe Live Feeds integration
============================

Copy this entire folder next to your offline globe HTML as:

  globe-integration/

Or open the globe HTML from Downloads — it will auto-load scripts from:

  C:\Users\P\PycharmProjects\Weather\usgs-tracker\public\globe-integration\

Files:
  openmeteo.js       — Open-Meteo API (weather, marine, bbox)
  global-layers.js   — USGS earthquakes, weather cities, marine
  charts.js          — Canvas chart helpers
  globe-plot-expand.js — Expandable NC plot windows
  globe-feeds.js     — Globe adapter (markers, popups, Earth Systems UI)

Usage in globe:
  Earth Systems tab → "Live data feeds (CORS)"
  - Toggle earthquakes / weather / marine / bbox grid
  - Click globe for Ocean Pro-style point popup
  - Click markers for detail panel with charts
  - NC overlays: time series + vertical profile when multi-time/level data loaded
