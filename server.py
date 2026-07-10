"""Earth/Hazards Tracker — static server + multi-provider JSON API proxy."""

import json
import os
import re
import socket
import threading
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
    "openmeteo": "https://air-quality-api.open-meteo.com",
    "earthsearch": "https://earth-search.aws.element84.com",
}
DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
HOST = "127.0.0.1"
PREFERRED_PORTS = (19090, 18090, 9090, 8770)
HTTP_PORT = None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def log_message(self, fmt, *args):
        print(f"[http] {fmt % args}")

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/config.json":
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
        if path not in ("/api/data/proxy", "/api/usgs/proxy"):
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
        if not api_path.startswith("/"):
            api_path = "/" + api_path

        qs = urllib.parse.urlencode(params, doseq=True)
        url = f"{base}{api_path}?{qs}" if qs else f"{base}{api_path}"
        headers = {"Accept": "application/json, text/plain, */*", "User-Agent": "HazardsTracker/1.0"}
        req = urllib.request.Request(url, headers=headers)
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
                self._json(resp.status, payload)
        except urllib.error.HTTPError as e:
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
        except urllib.error.URLError as e:
            self._json(502, {"error": {"message": str(e.reason)}})

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
        print("Close other USGS Tracker windows or run: netstat -ano | findstr :19090", flush=True)
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
