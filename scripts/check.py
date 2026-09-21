"""Pre-flight check for gohometownland.com. Run before every push.

    python3 scripts/check.py
    python3 scripts/check.py --skip-drift   # for the pre-commit hook

Four things go wrong here, and all four are silent:

  1. site/ drifts from src/ because someone edited src/ and forgot to run
     build.py. The stale page deploys and nobody notices for a week.
  2. A placeholder ships to production.
  3. A page stops building and the sitemap quietly loses a URL.
  4. The Call Desk's two halves disagree about which version they are, which
     switches off the check that catches a desk running old code.

This rebuilds, then fails loudly on any of the four. Exit code 0 means the
tree is safe to push.
"""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Text that must never reach production. Checked against .html and .js only:
# site.css still legitimately defines .ph and .stubtag rules for the
# testimonials block, which returns once there are real quotes.
FORBIDDEN = [
    ('class="ph"', "placeholder styling span"),
    ("offers@", "retired contact address (use brian@gohometownland.com)"),
    ("PO Box 000", "placeholder mailing address"),
    ("[STATE]", "unset governing-law state"),
    ("[DATE]", "unset legal date"),
    ("REVIEW BEFORE LAUNCH", "attorney-review banner"),
    ("Replace before launch", "stub content tag"),
    ("Placeholder for", "stub copy"),
    ("Lorem ipsum", "filler copy"),
]

EXPECTED_PAGES = {
    "about", "contact", "faq", "how-it-works",
    "index", "privacy", "terms", "thank-you", "stats",
}

# Pages deliberately kept out of the sitemap: the confirmation page nobody
# should land on cold, and the private traffic dashboard.
UNLISTED_PAGES = {"thank-you", "stats"}


def scanned_files(base):
    for pat in ("**/*.html", "**/*.js"):
        yield from (base / "" ).glob(pat)


def check_placeholders():
    problems = []
    for base in (ROOT / "src", ROOT / "site"):
        if not base.is_dir():
            continue
        for f in scanned_files(base):
            text = f.read_text(encoding="utf-8", errors="replace")
            for token, why in FORBIDDEN:
                if token in text:
                    line = next((i for i, l in enumerate(text.splitlines(), 1)
                                 if token in l), 0)
                    rel = f.relative_to(ROOT)
                    problems.append(f"{rel}:{line}  {token!r} — {why}")
    return problems


def check_pages():
    built = {p.stem for p in (ROOT / "site").glob("*.html")}
    problems = []
    missing = EXPECTED_PAGES - built
    extra = built - EXPECTED_PAGES
    if missing:
        problems.append(f"pages failed to build: {', '.join(sorted(missing))}")
    if extra:
        problems.append(f"unexpected pages in site/: {', '.join(sorted(extra))}"
                        " — add them to EXPECTED_PAGES if intentional")
    sitemap = (ROOT / "site" / "sitemap.xml").read_text(encoding="utf-8")
    urls = len(re.findall(r"<loc>", sitemap))
    expected = len(EXPECTED_PAGES - UNLISTED_PAGES)
    if urls != expected:
        problems.append(f"sitemap has {urls} urls, expected {expected}")
    return problems


def check_desk_version():
    """calldesk.py and app.js must claim the same version.

    The desk serves its HTML and JavaScript off disk but keeps running the
    Python it started with, so a pulled update that has not been restarted
    runs a new page against an old server. The two compare versions at
    runtime and say so on screen -- which only works while the matching pair
    genuinely matches. Letting them drift here would leave that warning
    showing permanently, and a warning that is always on is no warning.
    """
    pairs = [
        (ROOT / "desk" / "calldesk.py", r'^DESK_VERSION = "([^"]+)"'),
        (ROOT / "desk" / "ui" / "app.js", r'^\s*var UI_VERSION = "([^"]+)";'),
    ]
    found = {}
    for path, pattern in pairs:
        if not path.is_file():
            return [f"{path.relative_to(ROOT)} is missing"]
        m = re.search(pattern, path.read_text(encoding="utf-8"), re.M)
        if not m:
            return [f"{path.relative_to(ROOT)} has no version line matching {pattern!r}"]
        found[path.relative_to(ROOT).as_posix()] = m.group(1)

    if len(set(found.values())) > 1:
        return ["Call Desk versions disagree: "
                + ", ".join(f"{k} says {v}" for k, v in found.items())
                + " — set both to the same string."]
    return []


def check_drift():
    """site/ must be exactly what build.py just produced."""
    out = subprocess.run(
        ["git", "status", "--porcelain", "--", "site"],
        cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if not out:
        return []
    files = [l.split()[-1] for l in out.splitlines()]
    return ["site/ is out of date with src/ — build.py changed these files:"] + \
           [f"    {f}" for f in files] + \
           ["  Commit the rebuilt site/ along with your src/ edit."]


def main():
    skip_drift = "--skip-drift" in sys.argv

    print("==> Rebuilding site/ from src/")
    build = subprocess.run([sys.executable, "build.py"], cwd=ROOT,
                           capture_output=True, text=True)
    if build.returncode != 0:
        print(build.stdout + build.stderr)
        sys.exit("build.py failed")

    checks = [("pages", check_pages), ("placeholders", check_placeholders),
              ("call desk version", check_desk_version)]
    if not skip_drift:
        checks.append(("src/site drift", check_drift))

    failures = []
    for label, fn in checks:
        problems = fn()
        status = "FAIL" if problems else "ok"
        print(f"  [{status:>4}] {label}")
        failures += problems

    if failures:
        print("\n" + "\n".join(failures))
        sys.exit(f"\n{len(failures)} problem(s). Not safe to push.")
    print("\nAll checks passed — safe to push.")


if __name__ == "__main__":
    main()
