"""Inline local image assets as data URIs so a mockup can be published standalone.

The Artifact viewer blocks external hosts, so relative asset paths would 404 there.
Reads mockups/*.html, rewrites ../assets/img/* references, writes build/*.html.
"""
import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "mockups"
OUT = ROOT / "build"
OUT.mkdir(exist_ok=True)

MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp"}

_cache = {}


def data_uri(rel_path):
    """Resolve a page-relative asset path to a base64 data URI."""
    target = (SRC / rel_path).resolve()
    if target in _cache:
        return _cache[target]
    if not target.exists():
        raise FileNotFoundError(f"asset not found: {rel_path} -> {target}")
    mime = MIME.get(target.suffix.lower())
    if mime is None:
        raise ValueError(f"unhandled asset type: {target.suffix}")
    uri = f"data:{mime};base64," + base64.b64encode(target.read_bytes()).decode("ascii")
    _cache[target] = uri
    return uri


# url(../assets/img/x.jpg) and url('../assets/img/x.jpg')
CSS_URL = re.compile(r"url\(\s*['\"]?(\.\./assets/[^'\")]+)['\"]?\s*\)")
# src="../assets/img/x.jpg"
SRC_ATTR = re.compile(r'(src=")(\.\./assets/[^"]+)(")')


def convert(page):
    html = page.read_text(encoding="utf-8")
    used = []

    def css_sub(m):
        used.append(m.group(1))
        return f"url({data_uri(m.group(1))})"

    def src_sub(m):
        used.append(m.group(2))
        return m.group(1) + data_uri(m.group(2)) + m.group(3)

    html = CSS_URL.sub(css_sub, html)
    html = SRC_ATTR.sub(src_sub, html)

    leftover = re.findall(r"\.\./assets/[^\s'\"()]+", html)
    if leftover:
        raise RuntimeError(f"{page.name}: unresolved asset refs {sorted(set(leftover))}")

    dest = OUT / page.name
    dest.write_text(html, encoding="utf-8")
    kb = dest.stat().st_size // 1024
    print(f"{page.name:>16}  ->  build/{page.name}  {kb:>5} KB  ({len(set(used))} assets inlined)")
    if kb > 15000:
        print(f"  WARNING: {page.name} exceeds the 16MB artifact limit", file=sys.stderr)


pages = sorted(SRC.glob("*.html"))
if not pages:
    sys.exit("no mockups found")
for p in pages:
    convert(p)
print(f"\n{len(pages)} page(s) built into {OUT}")
