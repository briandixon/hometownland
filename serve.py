"""Local preview for site/ that mirrors Vercel's cleanUrls behaviour.

Vercel serves /how-it-works from how-it-works.html. Plain http.server does not,
so links would 404 locally and the check would be meaningless. Also stubs
/api/lead so the form's success path can be exercised end to end.

Run:  python serve.py [port]
"""
import json
import pathlib
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).parent / "site"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8322


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def do_POST(self):
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
        body = json.dumps({"ok": True}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
    print(f"serving {ROOT} on http://localhost:{PORT} (clean URLs, /api/lead stubbed)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
