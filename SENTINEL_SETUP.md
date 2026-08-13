# Sentinel Hub setup

The Sentinel layer streams Sentinel-2 (and other Copernicus) satellite imagery
straight into the dashboard — true colour, false colour, NDVI, burn scars and
more — at up to ~10 m resolution with a roughly 5-day revisit. It works with a
free Copernicus Data Space account; no card is required and the free tier
(50,000 requests / 10,000 processing units per month) comfortably covers
personal or small-scale use.

## 1. Create a Copernicus Data Space account

1. Go to <https://dataspace.copernicus.eu/> and register (email + password is
   enough).
2. Confirm your email, then sign in.

## 2. Create a Sentinel Hub configuration

1. Open the Sentinel Hub Dashboard's Configuration Utility:
   <https://shapps.dataspace.copernicus.eu/dashboard/#/configurations>
2. Click **New configuration**.
3. Pick the **"Full WMS template"** starting point, not "Simple WMS Instance".
   The dashboard's layer picker (True colour, False colour, NDVI, NDWI,
   Moisture index, SWIR, Agriculture, Bathymetric, Geology, BAI) matches the
   layer IDs that template ships with — a Simple WMS Instance only has
   `TRUE_COLOR`, so picking anything else in the dashboard will just fail to
   render.
4. Save the configuration. You'll see an **Instance ID** — a UUID like
   `9dd46043-3e7f-427d-898d-3d88e9fdbd7c` — at the top of the configuration
   page. That's the only value this dashboard needs.

## 3. Enter the instance ID in the dashboard

1. Enable the **Sentinel** layer (Satellite rail). The first time, a dialog
   asks for the instance ID — paste it in and save.
2. To change it later, or to switch between multiple configurations, use
   **manage keys** or the layer's ⚙ configure button.

Entering or clearing a key always overrides the site default in that browser,
so switching accounts later is just pasting a new instance ID over the old
one.

## 4. Pick a layer, cloud cover and resampling

Opening the Sentinel layer's ⚙ button (or toggling it on for the first time)
opens a picker with:

- **Layer** — a dropdown of common layers on a Full WMS template
  configuration (True colour, False colour, False colour urban, NDVI, NDWI,
  Moisture index, SWIR, Agriculture, Bathymetric, Geology, BAI), or a free-text
  **custom layer ID** field if your own configuration defines something else
  (a different band combination, a non-default evalscript, etc.) — leave the
  dropdown alone and type the exact layer ID from your configuration instead.
- **Cloud coverage** — caps how cloudy the picked scene is allowed to be
  (defaults to 30%); the dashboard always requests the *least* cloudy scene
  within that cap inside its search window, not simply the most recent one.
  Lower it for a cleaner image in a slow-moving area, raise it if nothing in
  the window is that clear (see below).
- **Resampling** — how a tile is interpolated when the request scales it:
  nearest (sharp pixel edges, fastest), bilinear (smoother) or bicubic
  (smoothest, default).

## 5. Reading the live layer and the playback tool

- Sentinel-2's own revisit cadence is close to 5 days, so an exact requested
  date usually has no scene at all — every request searches a trailing window
  ending on that date (10 days by default) and returns the least-cloudy scene
  found. The live layer and the Imagery Lab's playback/GIF tool share this
  exact search logic, so a dated playback frame is the same image you'd see
  live on that date.
- The point-click Charts panel and the playback frame label both show the
  *resolved* scene date and cloud percentage actually used — useful for
  telling an old, hazy retry apart from a fresh, clear one.
- Sentinel Hub needs a reasonably zoomed-in view (below the built-in minimum,
  it declines the request rather than serving a giant, expensive tile) —
  toggling the layer on auto-zooms in if you're currently too far out.

## 6. Troubleshooting

- **Nothing renders / a WMS error tile appears** — almost always a layer ID
  that doesn't exist on your configuration. Confirm you started from the
  "Full WMS template" (step 2), or check your configuration's own layer list
  in the dashboard.
- **A visibly stale or very cloudy image** — widen the search window or raise
  the cloud-coverage cap; a slow-moving region under persistent cloud can
  need more than 10 days to find a clear pass.
- **429 / quota errors** — the free tier's monthly cap has been hit for that
  instance ID; either wait for the next monthly reset or create a new
  configuration under a different account.

See the main [README](README.md#optional-api-keys) for the other optional
keys (FIRMS, AirNow, Currents) and [SOURCES.md](SOURCES.md) for the full
provider catalogue.
