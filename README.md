# Hometown Land — gohometownland.com

Static site, hand-written, no framework. Eight pages built from shared partials.

## Layout

```
src/                 edit these
  pages/             one file per page, body content only
  partials/          header, footer, offer form — shared across all pages
  assets/            css, js, images
  api/lead.js        serverless endpoint the form posts to
  vercel.json        clean URLs, cache and security headers
build.py             src/ -> site/
serve.py             local preview with Vercel-style clean URLs
site/                GENERATED — never edit by hand, it is overwritten
```

## Working on it

```bash
python build.py && python serve.py 8322
```

Then open http://localhost:8322. The dev server resolves `/about` to `about.html`
the way Vercel does, and stubs `/api/lead` so the form's success path works
locally — submissions print to the terminal.

Page metadata lives in comments at the top of each file in `src/pages/`:

```html
<!--title: How It Works-->
<!--desc: Sentence used for the meta description and social preview.-->
<!--nav: how-it-works-->
```

`{{FORM}}` in a page expands to the full multi-step offer form. The state
dropdown is generated from the `STATES` list in `build.py`.

## Before launch

Everything still needing real content is wrapped in `<span class="ph">` and
renders with a dashed underline, so it is visible on the page rather than
hidden in the source. Find it all with:

```bash
grep -o 'class="ph">[^<]*' site/*.html | sort -u
```

Currently outstanding:

- `offers@gohometownland.com` — confirm this mailbox exists and is monitored
- `PO Box 000, City, ST 00000` — real mailing address
- `Brian Dixon` — confirm the name is right
- `[DATE]` in privacy.html and terms.html
- `[STATE]` in the governing-law section of terms.html
- Testimonial stubs on the homepage, tagged "Replace before launch"
- Both legal pages carry a `[REVIEW BEFORE LAUNCH]` note and need an attorney's eyes

## Deploying

The CLI is installed. Log in once — this step is interactive and cannot be
scripted:

```bash
vercel login
```

Then:

```bash
bash scripts/deploy.sh
```

That rebuilds, links to the `hometown-land` project, deploys to production, and
attaches both `gohometownland.com` and `www.gohometownland.com`. Override the
target with `VERCEL_SCOPE` / `VERCEL_PROJECT` if the slugs differ.

## Airtable

The `Website Leads` table does not exist yet — the connected token is read-only
on the base. Once your user has creator access:

```bash
python scripts/setup-airtable.py
```

That creates the table with the exact field names `api/lead.js` writes to. The
existing `Leads` table is deliberately not reused: it is shaped for mailer and
cold-call leads, and its `County` field is a linked record a web form cannot
populate.

## Environment variables

Set these in Vercel under Settings > Environment Variables. Each integration is
optional and the endpoint skips whatever is not configured:

| Variable | Purpose |
|---|---|
| `AIRTABLE_TOKEN` | Personal access token with `data.records:write` |
| `AIRTABLE_BASE_ID` | e.g. `appXXXXXXXXXXXXXX` |
| `AIRTABLE_TABLE` | Table name, e.g. `Website Leads` |
| `RESEND_API_KEY` | Optional — enables the email notification |
| `NOTIFY_EMAIL` | Where notifications are sent |
| `NOTIFY_FROM` | Verified sender address |

With nothing configured the endpoint still returns success and logs the full
submission to the Vercel function log, so a lead is never silently lost while
the integrations are being set up.

## Domain

Registered at Namecheap. In Vercel, add both `gohometownland.com` and
`www.gohometownland.com` to the project, then at Namecheap set Custom DNS to the
nameservers Vercel provides, or add the A / CNAME records it shows. HTTPS is
issued automatically once DNS resolves.

## Photography

Unsplash, downloaded locally rather than hotlinked. Swapping in your own photos
means dropping files into `src/assets/img/` and rebuilding.
