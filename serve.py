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


def sample_traffic(days):
    """Invented numbers for the dashboard, so the page can be looked at locally.

    Deterministic per day, so a reload does not reshuffle the chart and make a
    layout change look like a data change.
    """
    today = datetime.date.today()
    dates = [(today - datetime.timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    daily, views, visits, leads = [], 0, 0, 0
    for d in dates:
        rnd = random.Random(d)
        v = rnd.randint(8, 70)
        s = max(1, int(v / rnd.uniform(1.3, 2.4)))
        ld = 1 if rnd.random() < 0.18 else 0
        daily.append({"date": d, "views": v, "visits": s, "leads": ld})
        views, visits, leads = views + v, visits + s, leads + ld

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
            days = 30
            for part in self.path.partition("?")[2].split("&"):
                if part.startswith("days="):
                    try:
                        days = max(1, min(int(part[5:]), 120))
                    except ValueError:
                        pass
            return self.reply_json(sample_traffic(days))
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
