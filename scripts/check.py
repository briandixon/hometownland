"""Pre-flight check for gohometownland.com. Run before every push.

    python3 scripts/check.py
    python3 scripts/check.py --skip-drift   # for the pre-commit hook

Three things go wrong on this site, and all three are silent:

  1. site/ drifts from src/ because someone edited src/ and forgot to run
     build.py. The stale page deploys and nobody notices for a week.
  2. A placeholder ships to production.
  3. A page stops building and the sitemap quietly loses a URL.

This rebuilds, then fails loudly on any of the three. Exit code 0 means the
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
    "index", "privacy", "terms", "thank-you",
}


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
    # thank-you is deliberately excluded from the sitemap
    if urls != len(EXPECTED_PAGES) - 1:
        problems.append(f"sitemap has {urls} urls, expected {len(EXPECTED_PAGES) - 1}")
    return problems


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

    checks = [("pages", check_pages), ("placeholders", check_placeholders)]
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
