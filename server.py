"""Earth/Hazards Tracker — static server + multi-provider JSON API proxy."""

import json
import csv
import datetime
import io
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

API_BASES = {
    "waterservices": "https://waterservices.usgs.gov",
    "earthquake": "https://earthquake.usgs.gov",
    "volcanoes": "https://volcanoes.usgs.gov",
    "geomag": "https://geomag.usgs.gov",
    "nhc": "https://www.nhc.noaa.gov",
    "ndbc": "https://www.ndbc.noaa.gov",
    "cneos": "https://ssd-api.jpl.nasa.gov",
    "opensky": "https://opensky-network.org",
    "swpc": "https://services.swpc.noaa.gov",
    "ncei": "https://gis.ngdc.noaa.gov",
    "nws": "https://api.weather.gov",
    "aviation": "https://aviationweather.gov",
    "openmeteoAq": "https://air-quality-api.open-meteo.com",
    "earthsearch": "https://earth-search.aws.element84.com",
    "openmeteo": "https://api.open-meteo.com",
    "openmeteoMarine": "https://marine-api.open-meteo.com",
    "openmeteoArchive": "https://archive-api.open-meteo.com",
    "openmeteoFlood": "https://flood-api.open-meteo.com",
    "openmeteoEnsemble": "https://ensemble-api.open-meteo.com",
    "openmeteoGeocoding": "https://geocoding-api.open-meteo.com",
    "nominatim": "https://nominatim.openstreetmap.org",
    "eonet": "https://eonet.gsfc.nasa.gov",
    "metno": "https://api.met.no",
    "nasaPower": "https://power.larc.nasa.gov",
    "coops": "https://api.tidesandcurrents.noaa.gov",
    "gdacs": "https://www.gdacs.org",
    "geomet": "https://api.weather.gc.ca",
    "brightsky": "https://api.brightsky.dev",
    "arcgisCyclones": "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Active_Hurricanes_v1",
    "arcgisImagery": "https://server.arcgisonline.com",
    "waybackConfig": "https://s3-us-west-2.amazonaws.com",
}
# Mirrors the per-source userAgent overrides in worker/index.js's SOURCES table.
SOURCE_USER_AGENTS = {
    "eonet": "Mozilla/5.0 (compatible; EarthDataDashboard/1.0)",
    "earthquake": "Mozilla/5.0 (compatible; MetisWeatherFeeds/3.4; +https://metiscore.space)",
    "nominatim": "MetisWeatherFeeds/3.4 (+https://metiscore.space)",
    # api.weather.gov's Akamai bot manager 403s any custom domain-styled UA
    # for this host specifically (verified live) -- only a plain browser UA
    # gets through.
    "nws": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
}
DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
HOST = "127.0.0.1"
PREFERRED_PORTS = (19090, 18090, 9090, 8770)
HTTP_PORT = None

# Mirrors the per-service TTLs in worker/index.js's SOURCES table. The
# deployed worker gets this for free via Cloudflare's edge cache
# (cf.cacheTtl); this dev server talks to upstreams directly with nothing in
# between, so every request -- including the 6+ parallel Open-Meteo calls a
# single point click fires, or the same point clicked twice -- went all the
# way to the live API with no caching at all. A small in-memory cache keyed
# on the exact upstream URL closes that gap for local dev too.
TTL_BY_SERVICE = {
    "waterservices": 60, "earthquake": 60, "volcanoes": 300, "geomag": 60,
    "nhc": 120, "ndbc": 120, "cneos": 300, "opensky": 15, "swpc": 60,
    "ncei": 3600, "nws": 60, "aviation": 60,
    "openmeteo": 300, "openmeteoAq": 300, "openmeteoMarine": 300,
    "openmeteoArchive": 3600, "openmeteoFlood": 3600, "openmeteoEnsemble": 300,
    "openmeteoGeocoding": 86400,
    "nominatim": 86400, "earthsearch": 300, "eonet": 300, "metno": 300,
    "nasaPower": 3600, "coops": 60, "gdacs": 300, "geomet": 300,
    "brightsky": 300, "arcgisCyclones": 300, "arcgisImagery": 3600,
    "waybackConfig": 86400,
}
_PROXY_CACHE = {}
_PROXY_CACHE_LOCK = threading.Lock()
_PROXY_CACHE_MAX = 500


def _cache_get(key):
    with _PROXY_CACHE_LOCK:
        entry = _PROXY_CACHE.get(key)
        if not entry:
            return None
        expires, status, payload = entry
        if time.time() >= expires:
            del _PROXY_CACHE[key]
            return None
        return status, payload


def _cache_put(key, ttl, status, payload):
    with _PROXY_CACHE_LOCK:
        if len(_PROXY_CACHE) >= _PROXY_CACHE_MAX:
            # Cheap eviction for a dev-only cache -- drop whichever entry
            # happens to be oldest by insertion order rather than tracking
            # real LRU.
            _PROXY_CACHE.pop(next(iter(_PROXY_CACHE)), None)
        _PROXY_CACHE[key] = (time.time() + ttl, status, payload)


class _GdeltRateLimited(Exception):
    """Internal signal for a retryable GDELT rate-limit response."""


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def log_message(self, fmt, *args):
        print(f"[http] {fmt % args}")

    def end_headers(self):
        # This dev server sends no cache headers otherwise, so the browser's
        # own HTTP cache can silently keep serving an old copy of a file
        # after it's edited on disk -- confirmed to cause real, confusing
        # bugs (e.g. an updated api-key-manager.js not taking effect until a
        # hard refresh). Always fetch fresh instead.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def _redirect_legacy_dashboard(self):
        path = self.path.split("?", 1)[0]
        if path != "/global-cors" and not path.startswith("/global-cors/"):
            return False
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        self.send_response(308)
        self.send_header("Location", "/" + (f"?{query}" if query else ""))
        self.end_headers()
        return True

    def do_HEAD(self):
        if self._redirect_legacy_dashboard():
            return
        super().do_HEAD()

    def do_GET(self):
        if self._redirect_legacy_dashboard():
            return
        path = self.path.split("?", 1)[0]
        if path == "/config.json":
            payload = json.dumps({"httpPort": HTTP_PORT, "host": HOST}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/news":
            self._handle_news()
            return
        if path in ("/api/keyed/firms", "/api/keyed/airnow"):
            self._handle_keyed(path.rsplit("/", 1)[-1])
            return
        if path not in ("/api/proxy", "/api/data/proxy", "/api/usgs/proxy"):
            self.send_error(404, "Not found")
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        service = (body.get("service") or "waterservices").strip()
        api_path = body.get("path") or ""
        params = body.get("params") or {}
        want_text = bool(body.get("text"))
        base = API_BASES.get(service)
        if not base:
            self._json(400, {"error": {"message": f"Unknown service: {service}"}})
            return
        if service == "opensky":
            # OpenSky's states/all is a plain passthrough with no bbox cap of
            # its own -- a wide-open view can pull thousands of live aircraft
            # in one call, enough to freeze the map when each is rendered.
            try:
                lamin, lamax = float(params.get("lamin")), float(params.get("lamax"))
                lomin, lomax = float(params.get("lomin")), float(params.get("lomax"))
            except (TypeError, ValueError):
                self._json(400, {"error": {"message": "aircraft tracking requires a bounding box"}})
                return
            max_width, max_height = 25, 18
            if lamax - lamin > max_height or lomax - lomin > max_width:
                self._json(400, {"error": {"message": f"Zoom in: aircraft tracking accepts at most {max_width}° × {max_height}° per request"}})
                return
        if not api_path.startswith("/"):
            api_path = "/" + api_path

        qs = urllib.parse.urlencode(params, doseq=True)
        url = f"{base}{api_path}?{qs}" if qs else f"{base}{api_path}"
        ttl = TTL_BY_SERVICE.get(service, 0)
        cached = _cache_get(url) if ttl else None
        if cached:
            self._json(*cached)
            return
        headers = {
            "Accept": "application/json, text/plain, */*",
            "User-Agent": SOURCE_USER_AGENTS.get(
                service,
                os.getenv("WEATHER_USER_AGENT", "MetisWeatherFeeds/3.4 (+https://metiscore.space)"),
            ),
        }
        req = urllib.request.Request(url, headers=headers)
        # Mirrors the worker's retry for GDELT/generic 429s -- Open-Meteo in
        # particular throttles in short rolling windows, so a request that
        # lands ~1.5s later after a burst (e.g. the several sub-services one
        # point click fires at once) commonly succeeds instead of surfacing
        # a rate-limit error to the user.
        retry_delays = (0, 1.5)
        for attempt, delay in enumerate(retry_delays):
            if delay:
                time.sleep(delay)
            try:
                with urllib.request.urlopen(req, timeout=90) as resp:
                    raw = resp.read().decode(errors="replace")
                    if want_text or not raw.lstrip().startswith(("{", "[")):
                        payload = {"raw": raw}
                    else:
                        try:
                            payload = json.loads(raw)
                        except json.JSONDecodeError:
                            payload = {"raw": raw}
                    if ttl and 200 <= resp.status < 300:
                        _cache_put(url, ttl, resp.status, payload)
                    self._json(resp.status, payload)
                break
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < len(retry_delays) - 1:
                    continue
                raw = e.read().decode(errors="replace")
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    msg = e.reason or f"HTTP {e.code}"
                    m = re.search(r"<b>message</b>\s*([^<]+)", raw, re.I)
                    if m:
                        msg = m.group(1).strip()
                    payload = {"error": {"message": msg}}
                self._json(e.code, payload)
                break
            except urllib.error.URLError as e:
                self._json(502, {"error": {"message": str(e.reason)}})
                break

    def _handle_keyed(self, feed):
        secret_name = {
            "firms": "FIRMS_MAP_KEY",
            "airnow": "AIRNOW_API_KEY",
        }[feed]
        api_key = os.getenv(secret_name)
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            west, south, east, north = map(float, body.get("bbox", []))
            if west >= east or south >= north:
                raise ValueError
        except (ValueError, TypeError, json.JSONDecodeError):
            self._json(400, {"error": {"message": "bbox must be [west, south, east, north]"}})
            return
        api_key = str(body.get("apiKey") or api_key or "").strip()
        if not api_key:
            self._json(503, {"error": {"message": f"{feed.upper()} needs an API key. Enter one in the dashboard or set {secret_name}."}})
            return
        if not re.fullmatch(r"[A-Za-z0-9._-]{8,128}", api_key):
            self._json(400, {"error": {"message": f"{feed.upper()} API key format is invalid."}})
            return
        max_width, max_height = ((60, 40) if feed == "firms" else (80, 45))
        if east - west > max_width or north - south > max_height:
            self._json(400, {"error": {"message": f"Zoom in: this feed accepts at most {max_width}° × {max_height}° per request"}})
            return

        if feed == "firms":
            source = body.get("source", "VIIRS_SNPP_NRT")
            if source not in ("VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT"):
                source = "VIIRS_SNPP_NRT"
            days = min(5, max(1, int(body.get("days", 1))))
            area = ",".join(f"{v:.4f}" for v in (west, south, east, north))
            url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{urllib.parse.quote(api_key)}/{source}/{area}/{days}"
        elif feed == "airnow":
            end = datetime.datetime.now(datetime.timezone.utc).replace(minute=0, second=0, microsecond=0)
            start = end - datetime.timedelta(hours=2)
            params = {
                "startDate": start.strftime("%Y-%m-%dT%H"),
                "endDate": end.strftime("%Y-%m-%dT%H"),
                "parameters": "OZONE,PM25,PM10,CO,NO2,SO2",
                "BBOX": ",".join(f"{v:.4f}" for v in (west, south, east, north)),
                "dataType": "C", "format": "application/json", "verbose": "1",
                "monitorType": "0", "includerawconcentrations": "0", "API_KEY": api_key,
            }
            url = f"https://www.airnowapi.org/aq/data/?{urllib.parse.urlencode(params)}"
        try:
            headers = {"User-Agent": os.getenv("WEATHER_USER_AGENT", "MetisWeatherFeeds/3.4")}
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=90) as response:
                text = response.read().decode(errors="replace")
            if feed == "firms":
                items = self._normalize_firms(text)
                if not body.get("full"):
                    items = self._thin_firms(items)
            elif feed == "airnow":
                items = self._normalize_airnow(json.loads(text))
            self._json(200, {"feed": feed, "count": len(items), "items": items})
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as exc:
            self._json(502, {"error": {"message": str(exc)}})

    @staticmethod
    def _normalize_firms(text):
        items = []
        for index, row in enumerate(csv.DictReader(io.StringIO(text))):
            try:
                lat, lon = float(row["latitude"]), float(row["longitude"])
            except (KeyError, ValueError):
                continue
            hhmm = str(row.get("acq_time", "")).zfill(4)
            timestamp = None
            try:
                timestamp = int(datetime.datetime.fromisoformat(
                    f"{row.get('acq_date')}T{hhmm[:2]}:{hhmm[2:]}:00+00:00"
                ).timestamp() * 1000)
            except ValueError:
                pass
            def number(key):
                try:
                    return float(row.get(key, ""))
                except ValueError:
                    return None
            items.append({
                "kind": "firms", "id": f"firms-{row.get('acq_date')}-{row.get('acq_time')}-{lat}-{lon}-{index}",
                "name": f"{row.get('instrument') or row.get('satellite') or 'Satellite'} active fire",
                "lat": lat, "lon": lon, "time": timestamp, "satellite": row.get("satellite", ""),
                "instrument": row.get("instrument", ""), "confidence": row.get("confidence", ""),
                "frp": number("frp"), "brightness": number("bright_ti4") or number("brightness"),
                "daynight": row.get("daynight", ""), "scan": number("scan"), "track": number("track"),
            })
        return items

    @staticmethod
    def _thin_firms(items, cell_deg=0.05, max_items=800):
        by_cell = {}
        for item in items:
            key = (round(item["lat"] / cell_deg), round(item["lon"] / cell_deg))
            existing = by_cell.get(key)
            if existing is None or (item.get("frp") or 0) > (existing.get("frp") or 0):
                by_cell[key] = item
        thinned = list(by_cell.values())
        if len(thinned) <= max_items:
            return thinned
        thinned.sort(key=lambda item: item.get("frp") or 0, reverse=True)
        return thinned[:max_items]

    @staticmethod
    def _normalize_airnow(rows):
        sites = {}
        for row in rows if isinstance(rows, list) else []:
            try:
                lat, lon = float(row["Latitude"]), float(row["Longitude"])
            except (KeyError, ValueError, TypeError):
                continue
            site_code = row.get("FullAQSCode") or row.get("IntlAQSCode") or f"{lat:.4f}-{lon:.4f}"
            item_id = f"airnow-{site_code}"
            item = sites.setdefault(item_id, {
                "kind": "airnow", "id": item_id, "name": row.get("SiteName") or row.get("ReportingArea") or f"AirNow {site_code}",
                "lat": lat, "lon": lon, "time": None, "agency": row.get("AgencyName", ""),
                "siteCode": site_code, "aqi": None, "readings": {},
            })
            parameter = str(row.get("Parameter", "")).upper()
            try:
                value = float(row.get("Value"))
            except (ValueError, TypeError):
                value = None
            try:
                aqi = float(row.get("AQI"))
                if aqi < 0:
                    aqi = None
            except (ValueError, TypeError):
                aqi = None
            item["readings"][parameter] = {
                "value": value, "unit": row.get("Unit", ""), "aqi": aqi,
                "category": (row.get("Category") or {}).get("Name", "") if isinstance(row.get("Category"), dict) else row.get("Category", ""),
            }
            if aqi is not None:
                item["aqi"] = max(item["aqi"] or 0, aqi)
        return list(sites.values())

    def _handle_news(self):
        # Google News RSS returns 503 to Cloudflare Workers' shared egress
        # IPs no matter what -- verified live with a real Chrome User-Agent,
        # matching Accept/Accept-Language/Referer headers, and again with
        # Bot Fight Mode disabled on the account. It's an IP-reputation
        # block on Google's side, not fixable from the request shape, so
        # this dashboard uses GDELT's DOC 2.0 API instead: free, keyless,
        # and documented for automated querying. server.py mirrors the worker.
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            query = re.sub(r"[\x00-\x1f\x7f]", " ", str(body.get("query") or "weather OR disaster")).strip()[:420]
            if not query:
                raise ValueError("A news query is required")
            days = min(30, max(1, int(body.get("days", 3))))
            page_size = min(40, max(1, int(body.get("pageSize", 24))))
            language = str(body.get("language") or "en").lower()
            if not re.fullmatch(r"[a-z]{2}", language):
                language = "en"
            api_key = str(body.get("apiKey") or "")
            api_key = api_key if re.fullmatch(r"[A-Za-z0-9._-]{8,128}", api_key) else ""
            topics = [str(t) for t in (body.get("topics") or [])][:12]
            custom = str(body.get("custom") or "")[:120]
            locality = str(body.get("locality") or "")[:120]
            country = str(body.get("country") or "")[:120]
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self._json(400, {"error": {"message": str(exc) or "Invalid request parameters"}})
            return
        # A user-supplied Currents key is opt-in and gets priority (1,000
        # req/day, no rate-limit fragility); GDELT is the free/keyless
        # default and also the fallback if a configured Currents key fails.
        feed = items = None
        if api_key:
            try:
                feed, items = self._fetch_currents_news(api_key, topics, custom, locality, country, language, days, page_size)
            except (urllib.error.HTTPError, urllib.error.URLError, ValueError):
                pass
        if feed is None:
            try:
                feed, items = self._fetch_gdelt_news(query, days, page_size)
            except (urllib.error.HTTPError, urllib.error.URLError, ValueError) as exc:
                self._json(502, {"error": {"message": str(exc)}})
                return
        self._json(200, {"feed": feed, "count": len(items), "items": items})

    @staticmethod
    def _fetch_currents_news(api_key, topics, custom, locality, country, language, days, page_size):
        # Currents' `keywords` behaves like an AND-match across every word
        # given, not relevance-ranked OR search -- verified live: "weather
        # Johannesburg" (2 words) finds real relevant articles, but adding a
        # third word (even just one more topic term) reliably returns zero.
        # Every single upstream request stays capped to one topic term plus
        # one place term.
        #
        # A hyper-local place (a small town, not a capital) commonly comes
        # back empty for "weather" specifically even when it does have real
        # recent coverage under a different checked topic -- flooding, a
        # wildfire, a tremor. Only worth the extra upstream calls at the
        # tightest ("locality set") search tier -- the country/global
        # fallback tiers already succeed reliably on the first try -- and
        # capped at 3 topics so a location with every box checked doesn't
        # fire six sequential requests for one tier.
        place = locality or country or ""
        if custom:
            candidate_topics = [custom]
        elif locality and topics:
            candidate_topics = topics[:3]
        else:
            candidate_topics = [topics[0] if topics else "weather"]
        last_items = []
        for topic in candidate_topics:
            keywords = (f"{topic} {place}" if place else topic).strip()[:120] or "weather"
            now = datetime.datetime.now(datetime.timezone.utc)
            start = now - datetime.timedelta(days=days)
            fmt = "%Y-%m-%dT%H:%M:%S+00:00"
            params = {"apiKey": api_key, "keywords": keywords, "start_date": start.strftime(fmt), "end_date": now.strftime(fmt)}
            if re.fullmatch(r"[a-z]{2}", language):
                params["language"] = language
            request = urllib.request.Request(
                f"https://api.currentsapi.services/v1/search?{urllib.parse.urlencode(params)}",
                # Currents API sits behind Cloudflare's own WAF, which blocks
                # requests with no/default User-Agent (verified live: Cloudflare
                # error 1010 with Python's default urllib UA, 200 OK with this one).
                headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0 (compatible; MetisWeatherFeeds/3.4; +https://metiscore.space)"},
            )
            try:
                with urllib.request.urlopen(request, timeout=45) as response:
                    text = response.read().decode(errors="replace")
            except urllib.error.HTTPError as exc:
                raw = exc.read().decode(errors="replace")
                try:
                    message = json.loads(raw).get("msg") or json.loads(raw).get("message")
                except (json.JSONDecodeError, AttributeError):
                    message = None
                raise ValueError(message or f"Currents API returned HTTP {exc.code}")
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                raise ValueError("Currents API returned an unexpected response")
            last_items = Handler._normalize_currents(data.get("news"))[:page_size]
            if last_items:
                return "currents", last_items
        return "currents", last_items

    @staticmethod
    def _normalize_currents(news):
        items = []
        for index, article in enumerate(news if isinstance(news, list) else []):
            url = str(article.get("url") or "")
            published = str(article.get("published") or "")
            match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})", published)
            iso_published = f"{match[1]}T{match[2]}{match[3]}:{match[4]}" if match else None
            author = article.get("author")
            source = author if author and author != "None" else "Currents"
            items.append({
                "id": article.get("id") or url or f"currents-{index}",
                "title": str(article.get("title") or "Untitled report").strip(),
                "description": str(article.get("description") or "").strip(),
                "url": url if url.startswith(("http://", "https://")) else "",
                "published": iso_published,
                "source": source,
                "category": article.get("category") if isinstance(article.get("category"), list) else [],
            })
        return items

    @staticmethod
    def _gdelt_request_once(query, days, page_size):
        params = urllib.parse.urlencode({
            "query": query, "mode": "artlist", "maxrecords": page_size,
            "format": "json", "sort": "datedesc", "timespan": f"{days}d",
        })
        request = urllib.request.Request(
            f"https://api.gdeltproject.org/api/v2/doc/doc?{params}",
            headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; MetisWeatherFeeds/3.4; +https://metiscore.space)",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                text = response.read().decode(errors="replace")
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                raise _GdeltRateLimited(str(exc))
            raise
        # GDELT's anonymous rate limit shows up two different ways: a real
        # 429 status, or a 200 OK carrying its plain-text throttle notice
        # instead of JSON -- either is worth one short retry.
        if "limit requests" in text.lower():
            raise _GdeltRateLimited(text.strip()[:200])
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            raise ValueError(text.strip()[:200] or "GDELT returned an unexpected response")
        items = Handler._normalize_gdelt(data.get("articles"))[:page_size]
        return "gdelt", items

    @staticmethod
    def _fetch_gdelt_news(query, days, page_size):
        last_error = None
        for delay in (0, 1.5):
            if delay:
                time.sleep(delay)
            try:
                return Handler._gdelt_request_once(query, days, page_size)
            except _GdeltRateLimited as exc:
                last_error = exc
        raise ValueError(str(last_error))

    @staticmethod
    def _normalize_gdelt(articles):
        items = []
        for index, article in enumerate(articles if isinstance(articles, list) else []):
            url = str(article.get("url") or "")
            seendate = str(article.get("seendate") or "")
            match = re.fullmatch(r"(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z", seendate)
            published = f"{match[1]}-{match[2]}-{match[3]}T{match[4]}:{match[5]}:{match[6]}Z" if match else None
            source = article.get("domain") or article.get("sourcecountry") or "GDELT"
            items.append({
                "id": url or f"gdelt-{index}",
                "title": str(article.get("title") or "Untitled report").strip(),
                "description": "",
                "url": url if url.startswith(("http://", "https://")) else "",
                "published": published,
                "source": source,
                "category": [article["sourcecountry"]] if article.get("sourcecountry") else [],
            })
        return items

    def _json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def pick_port(preferred_ports):
    for port in preferred_ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((HOST, port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


def run_http(port):
    try:
        server = ThreadingHTTPServer((HOST, port), Handler)
    except OSError as exc:
        print(f"ERROR: Port {port} is already in use ({exc}).", flush=True)
        print("Close other Metis Weather Feeds windows or run: netstat -ano | findstr :19090", flush=True)
        raise SystemExit(1) from exc
    print(f"Web UI  -> http://{HOST}:{port}", flush=True)
    server.serve_forever()


def open_browser(port):
    url = f"http://{HOST}:{port}"
    threading.Timer(0.4, lambda: webbrowser.open(url)).start()


def main():
    global HTTP_PORT
    HTTP_PORT = pick_port(PREFERRED_PORTS)
    threading.Thread(target=run_http, args=(HTTP_PORT,), daemon=True).start()
    for _ in range(100):
        try:
            with socket.create_connection((HOST, HTTP_PORT), timeout=0.1):
                break
        except OSError:
            threading.Event().wait(0.05)
    print("Press Ctrl+C to stop", flush=True)
    open_browser(HTTP_PORT)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)


if __name__ == "__main__":
    main()
