"""Assemble the Hometown Land site from src/ into site/.

Pages live in src/pages/ as body content only. Shared chrome lives in
src/partials/. This keeps the header, footer, and offer form in one place
instead of copied across six pages.

Each page starts with metadata comments:
    <!--title: Page Title-->
    <!--desc: Meta description sentence.-->
    <!--nav: how-it-works-->        (which nav item to mark active; optional)
    <!--robots: noindex-->          (keep it out of search and the sitemap; optional)
    <!--script: stats-->            (also load /assets/js/stats.js; optional)

Run:  python build.py
"""
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
OUT = ROOT / "site"

SITE_NAME = "Hometown Land"
BASE_URL = "https://www.gohometownland.com"

STATES = [
    "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
    "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
    "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
    "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
    "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
    "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
    "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
    "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
    "Washington", "West Virginia", "Wisconsin", "Wyoming",
]

SHELL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">{robots}
<link rel="canonical" href="{canonical}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:type" content="website">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{base}/assets/img/logo.png">
<meta name="theme-color" content="#22394A">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/assets/img/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
{header}
<main id="main">
{content}
</main>
{footer}
<script src="/assets/js/site.js" defer></script>{scripts}
</body>
</html>
"""

META = re.compile(r"<!--\s*(title|desc|nav|robots|script)\s*:\s*(.*?)\s*-->\s*", re.I)


def read(p):
    return (SRC / p).read_text(encoding="utf-8").strip()


def state_options():
    opts = ['<option value="">Select a state&hellip;</option>']
    opts += [f"<option>{s}</option>" for s in STATES]
    return "\n            ".join(opts)


def build():
    if not (SRC / "pages").is_dir():
        sys.exit("src/pages/ not found")

    header = read("partials/header.html")
    footer = read("partials/footer.html")
    form = read("partials/form.html").replace("{{STATES}}", state_options())

    # Overwrite in place rather than wiping the tree: on Windows a running dev
    # server holds a lock on site/ and rmtree fails with access denied.
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.html"):
        stale.unlink()

    # static assets, then anything that ships at the site root
    shutil.copytree(SRC / "assets", OUT / "assets", dirs_exist_ok=True)
    for extra in ("robots.txt", "vercel.json", "sitemap.xml", "package.json"):
        f = SRC / extra
        if f.exists():
            shutil.copy(f, OUT / extra)
    ico = SRC / "assets" / "favicon.ico"
    if ico.exists():
        shutil.copy(ico, OUT / "favicon.ico")
    api = SRC / "api"
    if api.is_dir():
        shutil.copytree(api, OUT / "api", dirs_exist_ok=True)

    pages = sorted((SRC / "pages").glob("*.html"))
    slugs = []
    listed = []          # slugs that belong in the sitemap
    for page in pages:
        raw = page.read_text(encoding="utf-8")
        meta = {k.lower(): v for k, v in META.findall(raw)}
        content = META.sub("", raw).strip()
        slug = page.stem

        title = meta.get("title", SITE_NAME)
        # only append the site name when the title does not already carry it
        full_title = title if SITE_NAME in title else f"{title} | {SITE_NAME}"
        canonical = BASE_URL + ("/" if slug == "index" else f"/{slug}")

        content = content.replace("{{FORM}}", form).replace("{{STATES}}", state_options())

        # A noindex page is asking not to be found: keep it out of the sitemap
        # too, or the sitemap invites the crawler the meta tag turns away.
        robots = meta.get("robots", "")
        robots_tag = f'\n<meta name="robots" content="{robots}">' if robots else ""
        scripts = "".join(
            f'\n<script src="/assets/js/{name.strip()}.js" defer></script>'
            for name in meta.get("script", "").split(",") if name.strip())

        nav_key = meta.get("nav", slug)
        if nav_key == "index":
            # matched on the full tag: the brand link is also href="/" and must not be marked
            hdr = header.replace('<a href="/">Home</a>', '<a href="/" class="on">Home</a>')
        else:
            hdr = header.replace(f'href="/{nav_key}"', f'href="/{nav_key}" class="on"')

        OUT.joinpath(f"{slug}.html").write_text(
            SHELL.format(title=full_title, desc=meta.get("desc", ""), canonical=canonical,
                         base=BASE_URL, header=hdr, footer=footer, content=content,
                         robots=robots_tag, scripts=scripts),
            encoding="utf-8")
        slugs.append(slug)
        if slug != "thank-you" and "noindex" not in robots:
            listed.append(slug)
        print(f"  {slug}.html")

    # sitemap
    urls = "".join(
        f"\n  <url><loc>{BASE_URL}{'/' if s == 'index' else '/' + s}</loc></url>"
        for s in listed)
    OUT.joinpath("sitemap.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}\n</urlset>\n',
        encoding="utf-8")

    print(f"\nBuilt {len(pages)} pages into {OUT}")


if __name__ == "__main__":
    build()
