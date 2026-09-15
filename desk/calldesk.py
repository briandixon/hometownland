"""Hometown Land Call Desk — a screen pop for inbound seller calls.

Runs on your own machine. Mailer files are read from desk/mailers/ and never
leave the computer; the only thing that crosses the network is the caller's
phone number, coming in from the relay.

    python3 calldesk.py

Then leave the browser tab open. When someone calls your Quo line, their card
appears on its own.

Standard library only, so there is nothing to install.
"""
import csv
import http.server
import json
import os
import pathlib
import re
import socketserver
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

HERE = pathlib.Path(__file__).resolve().parent
UI = HERE / "ui"
MAILERS = HERE / "mailers"
CACHE = HERE / "cache"
LOGS = HERE / "logs"
CONFIG = HERE / "config.json"

DEFAULT_PORT = 8322
POLL_SECONDS = 2.0

# Land Portal returns a lot; these are the fields the card actually shows.
LP_FIELDS = (
    "flood_zone", "land_locked", "tax_amount", "zoning", "land_use_description",
    "municipality", "lot_size_acres", "calc_acres", "tlp_estimate", "road_frontage",
    "buildability_total_perc", "slope_average", "assessed_total_value",
    "market_total_value", "owner_full_name", "street_address", "city", "state",
    "zip_code", "county",
)


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "relay_url": "https://www.gohometownland.com/api/call-relay",
    "relay_key": "",
    "land_portal_token": "",
    "port": DEFAULT_PORT,
}


def ensure_config():
    """Write a starter config.json on first run.

    Asking someone to duplicate and rename a file before the app will start is
    a step that gets skipped or done wrong -- on Windows especially, where
    hidden extensions turn config.json into config.json.txt. Writing it here
    means a first double-click always works.
    """
    if CONFIG.exists():
        return False
    try:
        CONFIG.write_text(json.dumps(DEFAULT_CONFIG, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"  could not create config.json: {exc}")
        return False
    return True


def load_config():
    """Settings come from config.json, falling back to environment variables.

    config.json is gitignored. Keep the relay key and the Land Portal token
    there rather than pasting them into a terminal every morning.
    """
    cfg = {}
    if CONFIG.exists():
        try:
            cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            sys.exit(f"config.json is not valid JSON: {exc}")

    def pick(key, env, default=""):
        return str(cfg.get(key) or os.environ.get(env) or default).strip()

    return {
        "relay_url": pick("relay_url", "CALL_RELAY_URL"),
        "relay_key": pick("relay_key", "CALL_RELAY_KEY"),
        "land_portal_token": pick("land_portal_token", "LAND_PORTAL_TOKEN"),
        "port": int(cfg.get("port") or os.environ.get("CALLDESK_PORT") or DEFAULT_PORT),
    }


# --------------------------------------------------------------------------
# mailer files
# --------------------------------------------------------------------------

def _money(v):
    try:
        return round(float(re.sub(r"[$,\s]", "", str(v or ""))), 2)
    except ValueError:
        return None


def _num(v):
    try:
        return float(str(v or "").strip())
    except ValueError:
        return None


def ten_digits(raw):
    d = re.sub(r"\D", "", str(raw or ""))
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    return d if len(d) == 10 else ""


# --------------------------------------------------------------------------
# search
# --------------------------------------------------------------------------

# This county's exports spell the same road both ways -- "653 Cr" and
# "45341 County Road 653" -- and directionals and street types come through
# either long or short. Both the query and the record are folded to the short
# form so "22 s main st" and "22 South Main Street" meet in the middle.
PHRASES = [
    ("county road", "cr"),
    ("county rd", "cr"),
    ("state highway", "hwy"),
    ("state route", "hwy"),
    ("post office box", "po box"),
]

WORDS = {
    "north": "n", "south": "s", "east": "e", "west": "w",
    "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
    "street": "st", "avenue": "ave", "av": "ave", "road": "rd", "drive": "dr",
    "lane": "ln", "court": "ct", "circle": "cir", "boulevard": "blvd",
    "highway": "hwy", "place": "pl", "terrace": "ter", "parkway": "pkwy",
    "trail": "trl", "route": "rt", "square": "sq", "point": "pt",
    "township": "twp", "county": "co", "saint": "st", "mount": "mt",
    "apartment": "apt", "suite": "ste", "unit": "apt",
}


def normalize(text):
    """Fold an address or name to comparable tokens."""
    low = " " + re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip() + " "
    for long_form, short in PHRASES:
        low = low.replace(f" {long_form} ", f" {short} ")
    return [WORDS.get(tok, tok) for tok in low.split()]


PHONE_COLUMNS = [
    ("Primary", "Phone"),
    ("Alt 1", "Alt Phone 1"),
    ("Alt 2", "Alt Phone 2"),
    ("Alt 3", "Alt Phone 3"),
    ("Alt 4", "Alt Phone 4"),
    ("Alt 5", "Alt Phone 5"),
]


def map_row(row, source):
    """One mailer row to the shape the card renders.

    Headers are matched after stripping whitespace: the export ships some
    columns padded (" Real PPA ", " TLP Estimate "), and matching the padded
    spelling silently yields nothing.
    """
    g = lambda name: str(row.get(name, "") or "").strip()  # noqa: E731

    phones = []
    for label, col in PHONE_COLUMNS:
        num = ten_digits(g(col))
        if num:
            phones.append({
                "label": label,
                "num": num,
                "type": g(f"{col} (Line Type)"),
                "dnc": bool(g(f"{col} (DNC)")),
            })

    return {
        "ref": g("Reference"), "mailer": g("Mailer #"), "source": source,
        "owner": g("Owner Name(s)"), "greet": g("Mail Names"),
        "phones": phones, "email": g("Email"),
        "offer": _money(g("Offer Price")), "offerPPA": _money(g("Offer PPA")),
        "realPPA": _money(g("Real PPA")), "retail": _money(g("Retail Value- 90%")),
        "profit": _money(g("Profit")), "tlp": _money(g("TLP Estimate")),
        "acres": _num(g("Lot Acres")), "calcAcres": _num(g("Calc Acreage")),
        "apn": g("APN"), "pid": g("propertyID"), "fips": g("Parcel FIPS"),
        "pAddr": g("Parcel Full Address"), "pCity": g("Parcel City"),
        "pState": g("Parcel State"), "pCounty": g("Parcel County"), "pZip": g("Parcel Zip"),
        "mAddr": g("Mail Full Address"), "mCity": g("Mail City"),
        "mState": g("Mail State"), "mZip": g("Mail Zip"), "mCounty": g("Mail County"),
        "lat": _num(g("Latitude")), "lon": _num(g("Longitude")), "link": g("Hyperlink"),
        "use": g("Land Use"), "zoning": g("Zoning"), "roadFt": _num(g("Road Frontage")),
        "wetlands": _num(g("Wetlands Coverage")), "flood": _num(g("FEMA Flood Coverage")),
        "slope": _num(g("Slope AVG")), "build": _num(g("Buildability total (%)")),
        "school": g("School District"), "muni": g("Municipality"),
        "assessed": _money(g("Total Assessed Value")), "market": _money(g("Total Market Value")),
        "offerDate": g("Date"), "closeDate": g("Closing Date"),
    }


# Each field carries its own weight: the parcel is what a caller rings about,
# so a hit there should outrank the same word appearing in a mailing address.
FIELD_WEIGHTS = (
    ("parcel", 6.0),
    ("owner", 4.0),
    ("ref", 5.0),
    ("mail", 2.0),
    ("apn", 3.0),
)


def build_entry(lead):
    """Pre-tokenize one lead so typing stays responsive."""
    parcel = " ".join(filter(None, [
        lead["pAddr"], lead["pCity"], lead["pState"], lead["pZip"], lead["pCounty"]]))
    mail = " ".join(filter(None, [
        lead["mAddr"], lead["mCity"], lead["mState"], lead["mZip"]]))
    return {
        "lead": lead,
        "fields": {
            "parcel": normalize(parcel),
            "owner": normalize(f'{lead["owner"]} {lead["greet"]}'),
            "ref": normalize(lead["ref"]),
            "mail": normalize(mail),
            "apn": normalize(lead["apn"]),
        },
        "digits": [re.sub(r"\D", "", p["num"]) for p in lead["phones"]],
        "apn_digits": re.sub(r"\D", "", lead["apn"]),
    }


def term_score(entry, term):
    """Best hit for one word across the record, or 0."""
    best = 0.0
    for field, weight in FIELD_WEIGHTS:
        for position, token in enumerate(entry["fields"][field]):
            if token == term:
                hit = weight * 2.0
            elif token.startswith(term):
                hit = weight * 1.4
            elif len(term) >= 4 and term in token:
                hit = weight * 0.8
            else:
                continue
            # earlier words carry more signal: a house number leads an address
            best = max(best, hit + max(0.0, 1.5 - position * 0.15))
    return best


def phone_score(entry, query_digits):
    best = 0.0
    for digits in entry["digits"]:
        if not digits:
            continue
        if digits == query_digits:
            best = max(best, 120.0)
        elif digits.startswith(query_digits):
            best = max(best, 95.0)
        elif digits.endswith(query_digits):
            best = max(best, 90.0)
        elif query_digits in digits:
            best = max(best, 70.0)
    return best


def score_entry(entry, terms, query_digits):
    """How well one record answers the query, or None if it does not.

    A query of digits alone is ambiguous -- "388" is both a house number and
    part of a phone number -- so it is scored against both and the better one
    wins. A query with any letters in it is text only, and then every word has
    to land somewhere: narrowing the query must narrow the results.
    """
    if query_digits:
        parcel = entry["fields"]["parcel"]
        street = 0.0
        if query_digits in parcel:
            # An exact street number outranks digits buried inside a phone,
            # but not a phone that genuinely starts or ends with them.
            street = 92.0 if parcel and parcel[0] == query_digits else 88.0
        best = max(
            phone_score(entry, query_digits),
            street,
            term_score(entry, query_digits),
            40.0 if query_digits in entry["apn_digits"] else 0.0,
        )
        return best or None

    total = 0.0
    for term in terms:
        hit = term_score(entry, term)
        if not hit:
            return None          # this word matched nothing: not a result
        total += hit
    return total


class Library:
    """Every mailer file, indexed by phone number and by reference."""

    def __init__(self):
        self.files = []
        self.leads = []
        self.by_phone = {}
        self.by_ref = {}
        self.index = []
        self.loaded_at = 0.0

    def load(self):
        MAILERS.mkdir(parents=True, exist_ok=True)
        # Oldest first, so a re-mailed owner ends up pointing at the newest
        # campaign — the offer actually on their letter.
        paths = sorted(MAILERS.glob("*.csv"), key=lambda p: p.stat().st_mtime)

        files, leads, by_phone, by_ref, index = [], [], {}, {}, []
        for path in paths:
            try:
                with path.open(encoding="utf-8-sig", newline="") as fh:
                    rows = list(csv.DictReader(fh))
            except (OSError, UnicodeDecodeError, csv.Error) as exc:
                files.append({"name": path.name, "records": 0, "reachable": 0,
                              "error": str(exc)})
                continue

            reachable = 0
            for raw in rows:
                if not raw.get("Reference") and not raw.get("Owner Name(s)"):
                    continue
                lead = map_row(raw, path.name)
                leads.append(lead)
                index.append(build_entry(lead))
                if lead["phones"]:
                    reachable += 1
                for ph in lead["phones"]:
                    by_phone[ph["num"]] = (lead, ph)
                ref = lead["ref"].upper().replace(" ", "")
                if ref:
                    by_ref[ref] = lead

            files.append({"name": path.name, "records": len(rows), "reachable": reachable})

        self.files, self.leads = files, leads
        self.by_phone, self.by_ref = by_phone, by_ref
        self.index = index
        self.loaded_at = time.time()
        return self

    def by_number(self, raw):
        hit = self.by_phone.get(ten_digits(raw))
        if not hit:
            return None
        lead, phone = hit
        return {"lead": lead, "phone": phone}

    def rank(self, query, limit=60):
        """Best matches for a free-text query, highest score first.

        Handles a reference, a phone number in any punctuation, an owner name,
        an APN, or a loosely typed address.
        """
        raw = str(query or "").strip()
        if not raw:
            return []

        exact = self.by_ref.get(raw.upper().replace(" ", ""))
        if exact:
            return [exact]

        digits = re.sub(r"\D", "", raw)
        # Digits with no letters around them are scored as both a phone number
        # and a street number, so an area code and a house number both work.
        query_digits = digits if len(digits) >= 3 and not re.search(r"[a-zA-Z]", raw) else ""
        terms = [] if query_digits else normalize(raw)
        if not terms and not query_digits:
            return []

        scored = []
        for entry in self.index:
            value = score_entry(entry, terms, query_digits)
            if value is not None:
                scored.append((value, entry["lead"]))

        scored.sort(key=lambda pair: -pair[0])
        return [lead for _, lead in scored[:limit]]

    def search(self, query):
        return self.rank(query)

    def suggest(self, query, limit=8):
        """Compact rows for the type-ahead list."""
        out = []
        for lead in self.rank(query, limit):
            phone = lead["phones"][0]["num"] if lead["phones"] else ""
            out.append({
                "ref": lead["ref"],
                "name": lead["greet"] or lead["owner"],
                "parcel": ", ".join(filter(None, [lead["pAddr"], lead["pCity"], lead["pState"]])),
                "phone": phone,
                "acres": lead["calcAcres"] or lead["acres"],
                "offer": lead["offer"],
                "source": lead["source"],
            })
        return out


# --------------------------------------------------------------------------
# Land Portal enrichment (cached, because the quota is small)
# --------------------------------------------------------------------------

class Parcels:
    """Land Portal detail, cached on disk so a repeat caller is free."""

    def __init__(self, token):
        self.token = token
        self.path = CACHE / "parcels.json"
        self.lock = threading.Lock()
        CACHE.mkdir(parents=True, exist_ok=True)
        try:
            self.cache = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self.cache = {}

    def cached(self, pid):
        return self.cache.get(str(pid))

    def fetch(self, pid, fips=""):
        pid = str(pid or "").strip()
        if not pid:
            return None
        hit = self.cache.get(pid)
        if hit is not None:
            return hit
        if not self.token:
            return None

        url = f"https://api.landportal.com/v2/properties/{urllib.parse.quote(pid)}"
        if fips:
            url += "?" + urllib.parse.urlencode({"fips": fips})
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=12,
                                        context=ssl.create_default_context()) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
            print(f"  land portal: {pid} failed ({exc})")
            return None

        feature = body.get("data") or {}
        props = feature.get("properties") or {}
        slim = {
            "geometry": feature.get("geometry"),
            "requests_left": (body.get("meta") or {}).get("requests_left"),
        }
        for key in LP_FIELDS:
            if key in props:
                slim[key] = props[key]

        with self.lock:
            self.cache[pid] = slim
            try:
                self.path.write_text(json.dumps(self.cache), encoding="utf-8")
            except OSError as exc:
                print(f"  could not write parcel cache: {exc}")
        left = slim.get("requests_left")
        print(f"  land portal: fetched {pid}" + (f" ({left} requests left)" if left is not None else ""))
        return slim


# --------------------------------------------------------------------------
# relay poller
# --------------------------------------------------------------------------

class Line:
    """Watches the relay for a ringing call."""

    def __init__(self, cfg, library, parcels):
        self.cfg = cfg
        self.library = library
        self.parcels = parcels
        self.current = None       # the call on screen right now
        self.last_call_id = None
        self.store = ""           # which shared store the relay is using
        self.ready = bool(cfg["relay_url"] and cfg["relay_key"])
        self.status = "starting" if self.ready else "off"
        self.detail = "" if self.ready else "no relay key — manual lookup only"
        self.lock = threading.Lock()

    def start(self):
        if not self.ready:
            return
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                self._poll()
                if self.status != "listening":
                    self.status, self.detail = "listening", ""
            except urllib.error.HTTPError as exc:
                self.status = "error"
                self.detail = ("relay rejected the key" if exc.code == 401
                               else f"relay returned {exc.code}")
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
                self.status, self.detail = "error", f"cannot reach the relay ({exc})"
            time.sleep(POLL_SECONDS)

    def _poll(self):
        url = self.cfg["relay_url"] + ("&" if "?" in self.cfg["relay_url"] else "?") + \
            urllib.parse.urlencode({"key": self.cfg["relay_key"]})
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10,
                                    context=ssl.create_default_context()) as resp:
            body = json.loads(resp.read().decode("utf-8"))

        self.store = str(body.get("store") or "")
        call = body.get("call")
        if not call or call.get("callId") == self.last_call_id:
            return
        self.last_call_id = call.get("callId")
        self.ring(call.get("caller", ""), source="quo", at=call.get("at"))

    def ring(self, number, source="manual", at=None):
        """Put a caller on screen. Also used by the test button in the UI."""
        number = ten_digits(number)
        hit = self.library.by_number(number)
        card = None
        if hit:
            card = {"lead": hit["lead"], "phone": hit["phone"]}
            # Enrichment must never delay the card, so it happens after.
            threading.Thread(target=self._enrich, args=(hit["lead"],), daemon=True).start()
        with self.lock:
            self.current = {
                "number": number, "source": source,
                "at": at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "matched": bool(hit), "card": card, "seq": time.time(),
            }
        print(f"  ringing {number}" + (" — matched" if hit else " — no mailer match"))

    def _enrich(self, lead):
        parcel = self.parcels.fetch(lead.get("pid"), lead.get("fips"))
        if not parcel:
            return
        with self.lock:
            if self.current and self.current.get("card"):
                self.current["card"]["parcel"] = parcel
                self.current["seq"] = time.time()

    def snapshot(self):
        with self.lock:
            current = json.loads(json.dumps(self.current)) if self.current else None
        return {
            "status": self.status,
            "detail": self.detail,
            "store": self.store,
            "call": current,
            "files": self.library.files,
            "records": len(self.library.leads),
            "reachable": sum(f.get("reachable", 0) for f in self.library.files),
        }

    def clear(self):
        with self.lock:
            self.current = None


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "CallDesk"
    line = None
    library = None
    parcels = None

    def log_message(self, fmt, *args):
        pass  # the useful events print themselves

    # -- helpers --
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def _file(self, name):
        path = (UI / name).resolve()
        if not path.is_file() or UI.resolve() not in path.parents:
            return self._send(404, {"error": "not found"})
        types = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}
        self._send(200, path.read_bytes(), types.get(path.suffix, "application/octet-stream"))

    # -- routes --
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        route = url.path

        if route == "/":
            return self._file("index.html")
        if route in ("/app.js", "/app.css"):
            return self._file(route.lstrip("/"))

        if route == "/api/state":
            return self._send(200, self.line.snapshot())

        if route == "/api/search":
            hits = self.library.search(q.get("q", [""])[0])
            for lead in hits[:1]:
                cached = self.parcels.cached(lead.get("pid"))
                if cached:
                    lead = dict(lead)
            return self._send(200, {"hits": [
                {"lead": h, "parcel": self.parcels.cached(h.get("pid"))} for h in hits]})

        if route == "/api/suggest":
            try:
                limit = max(1, min(12, int(q.get("limit", ["8"])[0])))
            except ValueError:
                limit = 8
            return self._send(200, {"hits": self.library.suggest(q.get("q", [""])[0], limit)})

        if route == "/api/reload":
            self.library.load()
            print(f"  reloaded {len(self.library.leads)} records "
                  f"from {len(self.library.files)} file(s)")
            return self._send(200, self.line.snapshot())

        return self._send(404, {"error": "not found"})

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, TypeError):
            return self._send(400, {"error": "bad json"})

        if url.path == "/api/ring":           # the test button
            self.line.ring(payload.get("number", ""), source="test")
            return self._send(200, self.line.snapshot())

        if url.path == "/api/show":           # open a record found by reference
            hits = self.library.search(payload.get("q", ""))
            if not hits:
                return self._send(404, {"error": "no match"})
            lead = hits[0]
            threading.Thread(target=self.line._enrich, args=(lead,), daemon=True).start()
            return self._send(200, {"lead": lead, "parcel": self.parcels.cached(lead.get("pid"))})

        if url.path == "/api/clear":
            self.line.clear()
            return self._send(200, self.line.snapshot())

        if url.path == "/api/note":
            return self._send(200, {"saved": save_note(payload)})

        return self._send(404, {"error": "not found"})


def save_note(payload):
    """Append one call outcome to a CSV that opens straight in Excel."""
    LOGS.mkdir(parents=True, exist_ok=True)
    path = LOGS / "calls.csv"
    new = not path.exists()
    row = {
        "when": time.strftime("%Y-%m-%d %H:%M:%S"),
        "number": payload.get("number", ""),
        "reference": payload.get("ref", ""),
        "owner": payload.get("owner", ""),
        "parcel": payload.get("parcel", ""),
        "offer": payload.get("offer", ""),
        "outcome": payload.get("outcome", ""),
        "notes": payload.get("notes", ""),
    }
    try:
        with path.open("a", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(row))
            if new:
                writer.writeheader()
            writer.writerow(row)
    except OSError as exc:
        print(f"  could not write call log: {exc}")
        return False
    return True


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    fresh = ensure_config()
    cfg = load_config()
    print("Hometown Land Call Desk")
    print("-" * 46)
    if fresh:
        print(f"  created {CONFIG.name} — open it to switch on live calls")

    library = Library().load()
    print(f"  {len(library.leads)} records from {len(library.files)} mailer file(s) "
          f"in {MAILERS}")
    for f in library.files:
        note = f" — {f['error']}" if f.get("error") else ""
        print(f"    {f['name']}: {f['records']} records, {f['reachable']} reachable{note}")
    if not library.files:
        print("    (none yet — drop your mailer CSVs in that folder and restart)")

    parcels = Parcels(cfg["land_portal_token"])
    if not cfg["land_portal_token"]:
        print("  land portal: no token, parcel detail comes from the mailer file only")

    line = Line(cfg, library, parcels)
    line.start()
    if line.ready:
        print(f"  watching the relay every {POLL_SECONDS:g}s for inbound calls")
    else:
        print("  no relay key in config.json — look-ups work, but calls will not")
        print("    pop on their own. Add \"relay_key\" and start this again.")

    Handler.line, Handler.library, Handler.parcels = line, library, parcels

    port = cfg["port"]
    try:
        server = Server(("127.0.0.1", port), Handler)
    except OSError as exc:
        sys.exit(f"\nCannot listen on port {port}: {exc}\n"
                 f"Something else is probably using it. Set a different one in config.json.")

    url = f"http://127.0.0.1:{port}/"
    print(f"\n  Call Desk is open at {url}")
    print("  Leave this window running. Press Ctrl+C to stop.\n")
    try:
        webbrowser.open(url)
    except webbrowser.Error:
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.shutdown()


if __name__ == "__main__":
    main()
