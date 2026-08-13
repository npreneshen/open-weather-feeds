# Cloudflare Worker setup

This guide deploys the complete dashboard to one Cloudflare Worker. The Worker
serves the files in `public/` and handles only `/api/*` before static assets.

## 1. Requirements

- A Cloudflare account with Workers enabled.
- Node.js 22 or newer.
- A terminal opened in this project directory.

No API key is required for the core dashboard or Google News RSS. NASA FIRMS and
EPA AirNow are optional.

## 2. Install and preview

```sh
npm install
npm run dev
```

Wrangler prints a local preview URL. Test location search, a map click, Google
News, and at least one ordinary layer before deploying.

## 3. Identify the deployment

Edit the `[vars]` value in `wrangler.toml`:

```toml
WEATHER_USER_AGENT = "MetisWeatherFeeds/3.4 (+https://your-domain.example)"
```

Use a real project URL or contact address. MET Norway requires an identifying
User-Agent. NASA EONET uses its own provider-compatible header in the code.

Change `name = "metis-weather-feeds"` only if you want a different Worker name.

## 4. Deploy

```sh
npm run deploy
```

Authenticate when Wrangler asks. After deployment, open the URL it reports and
check `/api/health`; it should return JSON with `"ok": true`.

For a custom hostname, add a Workers Custom Domain in the Cloudflare dashboard
after the first successful deployment.

## 5. API-key choices

### Portable browser-key mode (default)

Do nothing. When a user enables FIRMS or AirNow, the dashboard requests the key
and stores it in that browser's local storage. The key is sent only to the
same-origin Worker for that provider request. It is never returned in a response
or written to a project file.

This is the best mode for a downloadable, self-hosted project. Users should not
store keys on shared computers.

### Site-wide secret mode (optional)

To let visitors use a layer without entering their own key:

```sh
npx wrangler secret put FIRMS_MAP_KEY
npx wrangler secret put AIRNOW_API_KEY
npm run deploy
```

The browser key, when supplied, takes precedence over the corresponding site
secret. Secrets must never be placed in `wrangler.toml`, JavaScript or Git.

To remove a site-wide key:

```sh
npx wrangler secret delete FIRMS_MAP_KEY
npx wrangler secret delete AIRNOW_API_KEY
```

## 6. Free-tier operating guidance

The code already reduces avoidable Worker use:

- static assets are served by Cloudflare's asset binding;
- only `/api/*` runs Worker code first;
- upstream calls are allow-listed and cached;
- Google News RSS is cached for ten minutes;
- reverse geocoding runs only after a deliberate map click, waits briefly for
  repeated clicks to settle, and is cached for one day;
- FIRMS and AirNow are cached for five minutes and bounded by map extent;
- GIBS and MRMS imagery bypass the Worker;
- Open-Meteo charts load only after a map click or location selection;
- there are no scheduled jobs, queues, databases or background aggregations.

For a public deployment:

- keep polling intervals at 60 seconds or longer;
- prefer visible-map USGS requests over nationwide requests;
- avoid enabling every high-volume layer by default;
- review usage in Cloudflare's Worker analytics after sharing the URL.

Cloudflare can change plan allowances. Check the current
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
before a high-traffic launch.

## 7. Configuration reference

`wrangler.toml` uses:

```toml
[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = ["/api/*"]
not_found_handling = "404-page"
html_handling = "auto-trailing-slash"
```

The Worker exposes:

| Route | Purpose |
|---|---|
| `/api/proxy` | Allow-listed provider gateway |
| `/api/keyed/firms` | FIRMS regional fire detections |
| `/api/keyed/airnow` | AirNow regional observations |
| `/api/news` | Cached Google News RSS search |
| `/api/health` | Lightweight deployment health check |
| `/api/sources` | Gateway source names and cache durations |

Legacy `/api/data/proxy` and `/api/usgs/proxy` aliases remain for compatibility.
Legacy `/global-cors/` links redirect to the unified dashboard.

## 8. Troubleshooting

- **A feed returns 403:** confirm `WEATHER_USER_AGENT` is identifying and that a
  keyed layer has a valid key. EONET has a provider-specific fallback header;
  USGS earthquakes use direct browser CORS first and the Worker only as fallback.
- **FIRMS says to zoom in:** reduce the visible map to 60° × 40° or less.
- **AirNow returns no stations:** check that the view intersects the US, Canada or
  Mexico and is no larger than 80° × 45°.
- **News does not load:** verify `/api/news` is reaching the Worker and that the
  deployment can access Google News RSS.
- **News shows the wrong place:** reverse geocoding returns the nearest suitable
  OpenStreetMap feature, which can differ near borders or in sparsely mapped
  areas. Choose a named search result or another nearby point.
- **CO-OPS returns 400:** update to version 3.1 or newer; it selects IGLD for
  Great Lakes stations and MLLW for tidal stations.
- **Local preview works but deployment does not:** run
  `npx wrangler deploy --dry-run`, then inspect the first failing `/api/*`
  request in browser developer tools.

## 9. Update workflow

Replace the project files with a newer version, then run:

```sh
npm install
npm test
npx wrangler deploy --dry-run
npm run deploy
```

Reinstalling dependencies keeps the lockfile authoritative. Existing Worker
secrets remain attached to the Worker unless you delete or rename it.
