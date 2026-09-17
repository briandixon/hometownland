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
import logging
import logging.handlers
import os
import pathlib
import re
import socketserver
import ssl
import sys
import threading
import time
import traceback
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

# Bumped whenever the shape of an /api reply changes. ui/app.js carries the
# same string and says so on screen when the two disagree, because the desk
# reads its HTML and JavaScript off disk on every request while the Python
# stays as it was when the window was opened. Pulling an update and not
# restarting therefore runs a new page against an old server, and the first
# symptom is a reply missing a field the page is sure is there.
DESK_VERSION = "2026.09.17"

# Land Portal returns a lot; these are the fields the card actually shows.
LP_FIELDS = (
    "flood_zone", "land_locked", "tax_amount", "zoning", "land_use_description",
    "municipality", "lot_size_acres", "calc_acres", "tlp_estimate", "road_frontage",
    "buildability_total_perc", "slope_average", "assessed_total_value",
    "market_total_value", "owner_full_name", "street_address", "city", "state",
    "zip_code", "county",
)


# --------------------------------------------------------------------------
# logging
# --------------------------------------------------------------------------

# The black window has always been the log, and stays exactly as readable.
# What it could not do is answer a question asked on Thursday about a call on
# Tuesday: the window had scrolled, or been closed. The same events now also
# go to a file, with timestamps, levels and full tracebacks -- including the
# ones the browser tab sees, which used to exist only in a devtools console
# nobody had open.
LOG_FILE = LOGS / "calldesk.log"
LOG_MAX_BYTES = 2_000_000
LOG_KEEP = 3

log = logging.getLogger("calldesk")


class ConsoleFormat(logging.Formatter):
    """Console lines keep the plain indented wording they have always had.

    A line is read over someone's shoulder while a phone is ringing, so the
    level is not spelled out unless it is one worth stopping at.
    """

    MARK = {logging.WARNING: "  ! ", logging.ERROR: "  !! ",
            logging.CRITICAL: "  !! "}

    def format(self, record):
        text = record.getMessage()
        if record.exc_info:
            text += "\n" + "".join(traceback.format_exception(*record.exc_info)).rstrip()
        return self.MARK.get(record.levelno, "  ") + text


def setup_logging(debug=False):
    """Wire up the window and the file. Returns the file path, or None.

    A log file that cannot be written is not a reason to refuse to answer the
    phone, so this degrades to the window alone and says so.
    """
    log.setLevel(logging.DEBUG)
    log.propagate = False
    for old in list(log.handlers):
        # Called again when config.json asks for debug, so the file handler
        # this replaces has to be closed, not just forgotten.
        log.removeHandler(old)
        if isinstance(old, logging.FileHandler):
            old.close()

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(logging.DEBUG if debug else logging.INFO)
    console.setFormatter(ConsoleFormat())
    log.addHandler(console)

    try:
        LOGS.mkdir(parents=True, exist_ok=True)
        rotating = logging.handlers.RotatingFileHandler(
            LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_KEEP,
            encoding="utf-8")
    except OSError as exc:
        log.warning(f"no log file ({exc}) — this window is the only record")
        return None

    rotating.setLevel(logging.DEBUG)
    rotating.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(rotating)
    return LOG_FILE


# What the browser is allowed to call things when it reports something.
BROWSER_LEVELS = {"debug": logging.DEBUG, "info": logging.INFO,
                  "warning": logging.WARNING, "warn": logging.WARNING,
                  "error": logging.ERROR}


def log_from_browser(payload):
    """Record something the page noticed, in the same file as everything else.

    The tab is where most of this desk actually runs, so a fault there was the
    one thing the log could not see. Kept to what the page chooses to send --
    an error, which screen it was on, which request failed -- and truncated,
    because this endpoint is reachable by anything running in that tab.
    """
    level = BROWSER_LEVELS.get(
        str(payload.get("level", "") or "").lower(), logging.INFO)
    message = " ".join(str(payload.get("message", "") or "").split())[:1000]
    if not message:
        return False

    detail = payload.get("detail")
    if detail not in (None, "", {}, []):
        try:
            message += " | " + json.dumps(detail, default=str)[:1000]
        except (TypeError, ValueError):
            pass
    log.log(level, f"browser: {message}")
    return True


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "relay_url": "https://www.gohometownland.com/api/call-relay",
    "relay_key": "",
    "land_portal_token": "",
    "port": DEFAULT_PORT,
    "debug": False,
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
        log.error(f"could not create config.json: {exc}")
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
            log.error(f"config.json is not valid JSON: {exc}")
            sys.exit(f"config.json is not valid JSON: {exc}")

    def pick(key, env, default=""):
        return str(cfg.get(key) or os.environ.get(env) or default).strip()

    return {
        "relay_url": pick("relay_url", "CALL_RELAY_URL"),
        "relay_key": pick("relay_key", "CALL_RELAY_KEY"),
        "land_portal_token": pick("land_portal_token", "LAND_PORTAL_TOKEN"),
        "port": int(cfg.get("port") or os.environ.get("CALLDESK_PORT") or DEFAULT_PORT),
        # Turns the window up to everything the log file already keeps: every
        # request, every reply. Off by default because it is noisy next to a
        # ringing phone, and the file has it either way.
        "debug": bool(cfg.get("debug") or os.environ.get("CALLDESK_DEBUG")),
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
            log.warning(f"land portal: {pid} failed ({exc})")
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
                log.error(f"could not write parcel cache: {exc}")
        left = slim.get("requests_left")
        log.info(f"land portal: fetched {pid}"
                 + (f" ({left} requests left)" if left is not None else ""))
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
        self._last_complaint = ""
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
                    self._last_complaint = ""
                    log.info("relay: listening")
            except urllib.error.HTTPError as exc:
                self.status = "error"
                self.detail = ("relay rejected the key" if exc.code == 401
                               else f"relay returned {exc.code}")
                self._complain(self.detail)
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
                self.status, self.detail = "error", f"cannot reach the relay ({exc})"
                self._complain(self.detail)
            time.sleep(POLL_SECONDS)

    def _complain(self, detail):
        """Say it once, not every two seconds.

        An unreachable relay is one fact, and a log that repeats it thirty
        times a minute buries whatever else happened that morning.
        """
        if detail != self._last_complaint:
            self._last_complaint = detail
            log.warning(f"relay: {detail}")

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
        log.info(f"ringing {number or '(no number)'} via {source}"
                 + (f" — matched {hit['lead'].get('ref') or 'a record'}" if hit
                    else " — no mailer match"))

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
            "version": DESK_VERSION,
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
        pass  # every request is logged below, with its status and its timing

    def log_error(self, fmt, *args):
        # Usually the tab being closed mid-poll. Worth keeping, not worth
        # putting in front of someone answering a phone.
        try:
            log.debug("http: " + (fmt % args if args else fmt))
        except (TypeError, ValueError):
            log.debug(f"http: {fmt} {args}")

    # -- request plumbing --
    def _handle(self, verb, route):
        """Run one route, and make sure something is always sent back.

        An exception used to leave the request unanswered and the traceback in
        a window that had scrolled: the tab showed "Call Desk stopped" with no
        way to find out why. Now the fault is logged with its traceback and
        the page is told plainly that there is one.
        """
        self._status = None
        started = time.perf_counter()
        try:
            route()
        except Exception:
            log.error(f"{verb} {self.path} failed", exc_info=True)
            if self._status is None:
                try:
                    self._send(500, {"error": "the desk hit an unexpected error — "
                                              f"see {LOG_FILE.name}"})
                except OSError:
                    pass
        finally:
            took = (time.perf_counter() - started) * 1000
            log.debug(f"{verb} {self.path} -> {self._status} in {took:.0f}ms")

    # -- helpers --
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self._status = code
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
        self._handle("GET", self._route_get)

    def do_POST(self):
        self._handle("POST", self._route_post)

    def _route_get(self):
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

        if route == "/api/log":
            try:
                limit = max(1, min(400, int(q.get("limit", ["60"])[0])))
            except ValueError:
                limit = 60
            return self._send(200, log_entries(
                q.get("ref", [""])[0], q.get("q", [""])[0], limit))

        if route == "/api/reload":
            self.library.load()
            log.info(f"reloaded {len(self.library.leads)} records "
                     f"from {len(self.library.files)} file(s)")
            return self._send(200, self.line.snapshot())

        log.warning(f"GET {self.path}: no such route")
        return self._send(404, {"error": "not found"})

    def _route_post(self):
        url = urllib.parse.urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, TypeError) as exc:
            log.warning(f"POST {url.path}: unreadable body ({exc})")
            return self._send(400, {"error": "bad json"})
        if not isinstance(payload, dict):
            log.warning(f"POST {url.path}: body was {type(payload).__name__}, not an object")
            return self._send(400, {"error": "bad json"})

        # Whatever the page reports about itself goes in before anything else,
        # so a tab that is failing can still say so.
        if url.path == "/api/client-log":
            return self._send(200, {"logged": log_from_browser(payload)})

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
            # Both saving a call and adding to one already saved: the payload
            # carries an id for the second.
            result = save_note(payload)
            if not result.get("saved"):
                log.warning(f"call log: refused a note — {result.get('error')}")
            return self._send(200 if result.get("saved") else 400, result)

        log.warning(f"POST {self.path}: no such route")
        return self._send(404, {"error": "not found"})


# --------------------------------------------------------------------------
# the call log
# --------------------------------------------------------------------------

# One row per call, in a CSV that still opens straight in Excel. `id` is what
# lets a call be topped up after it was first saved, and `updated` records when
# that last happened.
LOG_FIELDS = ["id", "when", "updated", "number", "reference", "owner",
              "parcel", "offer", "outcome", "notes"]
LOG_PATH = LOGS / "calls.csv"
LOG_LOCK = threading.Lock()


def _stamp():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _new_id(taken, when):
    """A readable id, unique within the log.

    Built from the time of the call, so a row stays recognisable to anyone
    reading the CSV by hand, with a counter for the rare second call saved
    inside the same second.
    """
    base = re.sub(r"\D", "", when) or time.strftime("%Y%m%d%H%M%S")
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def read_log():
    """Every saved call, oldest first, in the current shape.

    Rows written before the log grew its `id` and `updated` columns are
    upgraded as they are read: an existing calls.csv keeps working, and the
    older rows can be added to like any other.
    """
    if not LOG_PATH.exists():
        return [], False
    try:
        with LOG_PATH.open(encoding="utf-8-sig", newline="") as fh:
            raw = list(csv.DictReader(fh))
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        log.error(f"could not read the call log: {exc}")
        return [], False

    rows, taken, upgraded = [], set(), False
    for source in raw:
        row = {key: str(source.get(key, "") or "").strip() for key in LOG_FIELDS}
        if not row["id"]:
            row["id"] = _new_id(taken, row["when"])
            upgraded = True
        taken.add(row["id"])
        rows.append(row)
    return rows, upgraded


def write_log(rows):
    """Replace the log in one go, through a temporary file.

    The whole log is rewritten rather than appended to because a detail added
    later edits a row that is already there. Writing beside the file and
    renaming means a half-written log never replaces a good one.
    """
    LOGS.mkdir(parents=True, exist_ok=True)
    tmp = LOG_PATH.with_name(LOG_PATH.name + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=LOG_FIELDS)
            writer.writeheader()
            writer.writerows(rows)
        tmp.replace(LOG_PATH)
    except OSError as exc:
        log.error(f"could not write the call log: {exc}")
        return False
    return True


def _load_log():
    """The log, with any upgraded rows written back. Call holding LOG_LOCK.

    An id invented while reading has to survive to the next request, or the
    button that adds a detail would be pointing at a row that no longer
    answers to that name.
    """
    rows, upgraded = read_log()
    if upgraded:
        write_log(rows)
    return rows


def save_note(payload):
    """Save a call, or add more detail to one already in the log.

    Without an `id` this writes a new row. With one it tops that row up: the
    new text is appended under its own timestamp instead of replacing what was
    written on the call, so a record reads as a running account rather than
    whatever was typed last. The outcome is the one thing that is replaced --
    a caller who was Thinking on Monday and Accepted on Friday has one
    outcome, not two.
    """
    text = str(payload.get("notes", "") or "").strip()
    outcome = str(payload.get("outcome", "") or "").strip()
    entry_id = str(payload.get("id", "") or "").strip()

    with LOG_LOCK:
        rows = _load_log()

        if entry_id:
            for row in rows:
                if row["id"] != entry_id:
                    continue
                if not text and not outcome:
                    log.warning(f"call log: nothing to add to {entry_id}")
                    return {"saved": False, "error": "nothing to add"}
                if text:
                    row["notes"] = (row["notes"] + "\n" if row["notes"] else "") + \
                        f"[{_stamp()}] {text}"
                if outcome:
                    row["outcome"] = outcome
                row["updated"] = _stamp()
                if not write_log(rows):
                    return {"saved": False, "error": "could not write the log"}
                log.info(f"call log: added {len(text)} characters to {entry_id}"
                         + (f", outcome {outcome}" if outcome else ""))
                return {"saved": True, "entry": row}
            log.warning(f"call log: no entry {entry_id} to add to "
                        f"({len(rows)} in the log)")
            return {"saved": False, "error": "that call is no longer in the log"}

        row = {
            "id": _new_id({r["id"] for r in rows}, _stamp()),
            "when": _stamp(),
            "updated": "",
            "number": ten_digits(payload.get("number", "")),
            "reference": str(payload.get("ref", "") or "").strip(),
            "owner": str(payload.get("owner", "") or "").strip(),
            "parcel": str(payload.get("parcel", "") or "").strip(),
            "offer": str(payload.get("offer", "") if payload.get("offer") is not None else ""),
            "outcome": outcome,
            "notes": text,
        }
        rows.append(row)
        if not write_log(rows):
            return {"saved": False, "error": "could not write the log"}
        log.info(f"call log: saved {row['id']} for "
                 f"{row['reference'] or row['number'] or 'an unknown caller'}"
                 + (f" — {outcome}" if outcome else ""))
        return {"saved": True, "entry": row}


def log_entries(ref="", query="", limit=60):
    """The log newest first, optionally narrowed to one record or a search."""
    with LOG_LOCK:
        rows = _load_log()

    ref = str(ref or "").upper().replace(" ", "")
    if ref:
        rows = [r for r in rows if r["reference"].upper().replace(" ", "") == ref]

    query = str(query or "").strip().lower()
    if query:
        wanted = re.sub(r"\D", "", query)
        rows = [r for r in rows if query in " ".join(
            [r["when"], r["owner"], r["reference"], r["parcel"], r["outcome"],
             r["notes"], r["number"]]).lower()
            or (len(wanted) >= 3 and wanted in r["number"])]

    total = len(rows)
    rows.reverse()
    return {"entries": rows[:limit], "total": total}


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    debug = "--debug" in sys.argv
    print("Hometown Land Call Desk")
    print("-" * 46)

    log_file = setup_logging(debug)
    fresh = ensure_config()
    cfg = load_config()
    if cfg["debug"] and not debug:
        debug = True
        setup_logging(True)

    # First line in the file, every run: which code is answering, on what, and
    # since when. A log that cannot say which version produced it cannot
    # settle an argument about whether an update was ever picked up.
    log.debug(f"--- call desk {DESK_VERSION} starting, python "
              f"{sys.version.split()[0]} on {sys.platform} ---")

    if fresh:
        log.info(f"created {CONFIG.name} — open it to switch on live calls")

    library = Library().load()
    log.info(f"{len(library.leads)} records from {len(library.files)} mailer file(s) "
             f"in {MAILERS}")
    for f in library.files:
        note = f" — {f['error']}" if f.get("error") else ""
        log.info(f"  {f['name']}: {f['records']} records, {f['reachable']} reachable{note}")
        if f.get("error"):
            log.warning(f"{f['name']} did not load cleanly: {f['error']}")
    if not library.files:
        log.info("  (none yet — drop your mailer CSVs in that folder and restart)")

    saved, _ = read_log()
    if saved:
        log.info(f"{len(saved)} calls already in {LOG_PATH}")

    parcels = Parcels(cfg["land_portal_token"])
    if not cfg["land_portal_token"]:
        log.info("land portal: no token, parcel detail comes from the mailer file only")

    line = Line(cfg, library, parcels)
    line.start()
    if line.ready:
        log.info(f"watching the relay every {POLL_SECONDS:g}s for inbound calls")
    else:
        log.info("no relay key in config.json — look-ups work, but calls will not")
        log.info("  pop on their own. Add \"relay_key\" and start this again.")

    if log_file:
        log.info(f"logging to {log_file}" + (" (debug)" if debug else ""))

    Handler.line, Handler.library, Handler.parcels = line, library, parcels

    port = cfg["port"]
    try:
        server = Server(("127.0.0.1", port), Handler)
    except OSError as exc:
        log.error(f"cannot listen on port {port}: {exc}")
        sys.exit(f"\nCannot listen on port {port}: {exc}\n"
                 f"Something else is probably using it. Set a different one in config.json.")

    url = f"http://127.0.0.1:{port}/"
    print(f"\n  Call Desk is open at {url}")
    print("  Leave this window running. Press Ctrl+C to stop.\n")
    log.debug(f"serving {UI} on {url}")
    try:
        webbrowser.open(url)
    except webbrowser.Error:
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.debug("--- stopped from the keyboard ---")
        print("\nStopped.")
        server.shutdown()
    except Exception:
        log.critical("the desk stopped on an unexpected error", exc_info=True)
        raise


if __name__ == "__main__":
    main()
