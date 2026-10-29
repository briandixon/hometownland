"""Local preview for site/ that mirrors Vercel's cleanUrls behaviour.

Vercel serves /how-it-works from how-it-works.html. Plain http.server does not,
so links would 404 locally and the check would be meaningless. Also stubs
/api/lead so the form's success path can be exercised end to end, and
/api/track so the /stats dashboard has something to draw -- invented numbers,
clearly labelled as such, since there is no Redis here.

Run:  python serve.py [port]
"""
import datetime
import json
import pathlib
import random
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).parent / "site"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8322


SAMPLE_PAGES = ["/", "/how-it-works", "/faq", "/about", "/contact", "/sell"]
SAMPLE_PLACES = [("Sanford", "NC"), ("Charlotte", "NC"), ("Raleigh", "NC"),
                 ("Dallas", "TX"), ("Greenville", "SC"), ("Walpole", "MA")]
SAMPLE_SOURCES = ["Google", "Direct / typed in", "Facebook", "Bing", "landwatch.com"]


def sample_visits(date, count, bots, rnd):
    """Invented visit-log rows for one day, in the shape /api/track returns."""
    out = []
    for i in range(count + bots):
        bot = i >= count
        minute = rnd.randint(0, 24 * 60 - 1)
        city, region = ("Ashburn", "VA") if bot else rnd.choice(SAMPLE_PLACES)
        pages = ["/"] + rnd.sample(SAMPLE_PAGES[1:], rnd.randint(0, 3))
        form = "" if bot else rnd.choice(["", "", "", "", "Started", "Reached step 2", "Sent"])
        y, m, d = map(int, date.split("-"))
        at = int(datetime.datetime(y, m, d, minute // 60, minute % 60).timestamp() * 1000)
        out.append({
            "at": at, "date": date,
            "time": datetime.time(minute // 60, minute % 60).strftime("%I:%M %p").lstrip("0"),
            "pages": pages, "source": rnd.choice(SAMPLE_SOURCES), "campaign": "",
            "city": city, "region": region, "country": "US",
            "device": rnd.choice(["Phone", "Phone", "Desktop", "Tablet"]),
            "form": form, "bot": bot, "score": rnd.choice([60, 80, 100]) if bot else rnd.choice([0, 10, 20]),
            "botReason": "Data-center city" if bot else "", "mine": city == "Walpole",
        })
    return out


def sample_range(query):
    """The from/to (or days) a dashboard request asks for, as a list of dates."""
    today = datetime.date.today()
    params = dict(part.partition("=")[::2] for part in query.split("&") if part)
    try:
        start = datetime.date.fromisoformat(params["from"])
        end = min(datetime.date.fromisoformat(params["to"]), today)
        if start > end:
            start, end = end, start
    except (KeyError, ValueError):
        try:
            days = max(1, min(int(params.get("days", 30)), 400))
        except ValueError:
            days = 30
        start, end = today - datetime.timedelta(days=days - 1), today
    start = max(start, end - datetime.timedelta(days=399))
    return [(start + datetime.timedelta(days=i)).isoformat()
            for i in range((end - start).days + 1)], params


def sample_traffic(dates, params):
    """Invented numbers for the dashboard, so the page can be looked at locally.

    Deterministic per day, so a reload does not reshuffle the chart and make a
    layout change look like a data change.
    """
    days = len(dates)
    log_start = (datetime.date.today() - datetime.timedelta(days=60)).isoformat()
    daily, views, visits, leads, log = [], 0, 0, 0, []
    for d in dates:
        rnd = random.Random(d)
        v = rnd.randint(8, 70)
        s = max(1, int(v / rnd.uniform(1.3, 2.4)))
        ld = 1 if rnd.random() < 0.18 else 0
        bv = rnd.randint(5, 60)
        daily.append({"date": d, "views": v, "visits": s, "leads": ld,
                      "botViews": bv, "botVisits": max(1, bv // 2)})
        views, visits, leads = views + v, visits + s, leads + ld
        if d >= log_start:
            log += sample_visits(d, s, max(1, bv // 2) if params.get("bots") == "1" else 0, rnd)
    # The real endpoint leaves bots and the owner out of the visit list.
    log = [r for r in log if not r["bot"] and not r["mine"]]
    log.sort(key=lambda r: -r["at"])

    def rows(pairs):
        return [{"name": n, "count": c} for n, c in pairs]

    share = max(1, visits)
    return {
        "ok": True,
        "store": "local preview",
        "days": days,
        "from": dates[0],
        "to": dates[-1],
        "totals": {"views": views, "visits": visits, "leads": leads},
        "daily": daily,
        "logStart": log_start,
        "owner": {"towns": ["Walpole, MA"], "included": params.get("mine") == "include",
                  "hidden": {"views": 0, "visits": 0, "leads": 0}},
        "botLog": params.get("bots") == "1",
        "visitCount": len(log),
        "visits": log[:5000],
        "bots": {"views": sum(d["botViews"] for d in daily),
                 "visits": sum(d["botVisits"] for d in daily)},
        "funnel": {"starts": leads * 4 + 2, "step2": leads * 3 + 1,
                   "step3": leads * 2 + 1, "submits": leads},
        "threshold": 50,
        "scores": rows([(str(k * 10), c) for k, c in
                        enumerate([visits, 40, 12, 9, 3, 30, 8, 14, 5, 2, 25])]),
        "botReasons": rows([("Data-center city", 44), ("Known crawler", 25),
                            ("Left in under a second", 12), ("Country outside the market", 7)]),
        "botCities": rows([("Ashburn, VA, US", 31), ("Council Bluffs, IA, US", 13),
                           ("Moscow, MOW, RU", 5)]),
        "botCountries": rows([("US", 70), ("RU", 5), ("CN", 2)]),
        "botPages": rows([("/", 60), ("/faq", 9), ("/about", 6)]),
        "botSources": rows([("Direct / typed in", 70)]),
        "sources": rows([("Google", int(share * .42)), ("Direct / typed in", int(share * .31)),
                         ("Facebook", int(share * .12)), ("Bing", int(share * .08)),
                         ("landwatch.com", int(share * .04))]),
        "pages": rows([("/", int(views * .55)), ("/how-it-works", int(views * .17)),
                       ("/faq", int(views * .12)), ("/about", int(views * .09)),
                       ("/contact", int(views * .07))]),
        "regions": rows([("US-NC", int(share * .28)), ("US-SC", int(share * .14)),
                         ("US-TX", int(share * .11)), ("US-FL", int(share * .09))]),
        "cities": rows([("Sanford, NC, US", int(share * .09)),
                        ("Charlotte, NC, US", int(share * .08)),
                        ("Raleigh, NC, US", int(share * .07)),
                        ("Dallas, TX, US", int(share * .05))]),
        "countries": rows([("US", int(share * .94)), ("CA", int(share * .04))]),
        "devices": rows([("Phone", int(share * .61)), ("Desktop", int(share * .34)),
                         ("Tablet", int(share * .05))]),
        "campaigns": rows([("spring-mailer", int(share * .06))]),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def reply_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0].rstrip("/") == "/api/track":
            dates, params = sample_range(self.path.partition("?")[2])
            return self.reply_json(sample_traffic(dates, params))
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") == "/api/track":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8", "replace")
            print(f"  /api/track {raw}")
            self.send_response(204)
            self.end_headers()
            return
        if self.path.rstrip("/") != "/api/lead":
            return self.send_error(404)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {"_unparsed": raw}
        print("\n--- /api/lead received ---")
        for k, v in payload.items():
            print(f"  {k}: {v}")
        print("--------------------------\n")
        self.reply_json({"ok": True})

    def translate_path(self, path):
        local = pathlib.Path(super().translate_path(path))
        if local.is_dir() and (local / "index.html").exists():
            return str(local / "index.html")
        if not local.exists() and not local.suffix:
            candidate = local.with_suffix(".html")
            if candidate.exists():
                return str(candidate)
        return str(local)


if __name__ == "__main__":
    if not ROOT.is_dir():
        sys.exit("site/ not built yet — run python build.py first")
    print(f"serving {ROOT} on http://localhost:{PORT} "
          "(clean URLs; /api/lead and /api/track stubbed)")
    print(f"  dashboard: http://localhost:{PORT}/stats — any key will do locally")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
