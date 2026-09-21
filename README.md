# Hometown Land — gohometownland.com

Static site, hand-written, no framework. Nine pages built from shared partials.

## Layout

```
src/                 edit these
  pages/             one file per page, body content only
  partials/          header, footer, offer form — shared across all pages
  assets/            css, js, images
  api/lead.js        serverless endpoint the form posts to
  api/track.js       traffic counters in, /stats numbers out
  vercel.json        clean URLs, cache and security headers
build.py             src/ -> site/
serve.py             local preview with Vercel-style clean URLs
scripts/check.py     pre-flight: rebuild, catch drift and placeholders
.githooks/pre-commit rebuilds and verifies automatically on commit
site/                GENERATED — never edit by hand, it is overwritten
DEPLOY.md            how to ship a change
CLAUDE.md            working notes for Claude Code sessions
```

## Working on it

```bash
python build.py && python serve.py 8322
```

Then open http://localhost:8322. The dev server resolves `/about` to `about.html`
the way Vercel does, and stubs `/api/lead` and `/api/track` so both the form's
success path and the `/stats` dashboard work
locally — submissions print to the terminal.

Page metadata lives in comments at the top of each file in `src/pages/`:

```html
<!--title: How It Works-->
<!--desc: Sentence used for the meta description and social preview.-->
<!--nav: how-it-works-->
```

`{{FORM}}` in a page expands to the full multi-step offer form. The state
dropdown is generated from the `STATES` list in `build.py`.

## Placeholders

The site launched on 2026-09-08; every pre-launch placeholder is now filled in.
Anything still unfinished is wrapped in `<span class="ph">` so it renders with a
dashed underline on the page rather than hiding in the source.

`scripts/check.py` fails the build if any placeholder — or a stale `site/` —
reaches a push, so this stays true without anyone remembering to look.

Still outstanding, deliberately:

- **Real testimonials.** The homepage testimonials section was deleted rather
  than shipped with stub quotes. Re-add it with real ones.
- **Lead delivery.** The Vercel environment variables below are not set yet, so
  submissions are logged to the Vercel function log instead of reaching
  Airtable. See `DEPLOY.md`.

## Deploying

**Deploy = `git push`.** Vercel is connected to this repo: push to `main` and
production updates in about a minute; push any other branch for a preview URL.

```bash
git config core.hooksPath .githooks    # once per clone
# edit under src/, then:
git add -A && git commit -m "..." && git push
```

The pre-commit hook rebuilds `site/`, verifies it, and stages it into the same
commit — so you never run `build.py` by hand and cannot forget it. It refuses
the commit on a placeholder or a page that stopped building. The same checks
run in CI on every PR and push to `main`.

Full guide, including the branch traps and rollback: **[DEPLOY.md](DEPLOY.md)**.

`scripts/deploy.sh` and the `vercel` CLI are leftovers from the original manual
setup. They are no longer the deploy path and cannot run in a cloud session.

## Airtable

The form files straight into the sales CRM
(base `appdd0mQPJU7ZPAtw`) — no separate website table to reconcile later:

- **Contacts** — the seller, reused if that email is already in the CRM, so a
  second submission does not become a second contact.
- **Leads** — the submission itself, linked to that contact, `Source` =
  `Website`, `Sales Stage` = `1.0 New Lead`, `Reference Number` = `WEB`.

`Leads` gained ten fields for the answers the form collects that the CRM had
nowhere to put: `Source`, `Property State`, `Property County`, `Parcel / APN`,
`Ownership`, `Road Access`, `Timeline`, `Best Time`, `SMS Consent` and
`SMS Consent At`. Everything else writes to fields the sales team already uses.

`Leads.County` is a link to **Mailers**, i.e. to a mail campaign. A website
lead did not come from a mailer, so that link is left empty and the county is
written as text into `Property County` instead — crediting a campaign for a
lead it did not produce would quietly corrupt the mailer numbers.

To confirm the base still matches what `api/lead.js` writes (after a field
rename, say):

```bash
python scripts/setup-airtable.py            # report only
python scripts/setup-airtable.py --create   # add any missing Leads field
```

## Email notification

Two ways; you only need one.

**Airtable automation (set up, needs turning on).** *Website Lead — Email
Notification* in the base watches for `Source` = `Website` and emails the
submission with a link to the record. Airtable saves new automations switched
off, so open
[the automation](https://airtable.com/appdd0mQPJU7ZPAtw/wflUWRuEhWUlBxzvH),
check the recipient in the **Send email** step, and turn it on. Nothing to
configure on the website side.

**Resend from `/api/lead`.** Set `RESEND_API_KEY`, `NOTIFY_EMAIL` and
`NOTIFY_FROM` and the endpoint sends the mail itself, including when the
Airtable write is the thing that failed — which the Airtable automation cannot
do by definition. Leave them unset to use only the automation, or set them and
turn the automation off; with both on you get two emails per lead.

## Traffic

`/stats` is a private dashboard showing visits, page views, submitted offer
requests, and where visitors came from — referring site or campaign, country,
state, city and device. It is `noindex`, disallowed in `robots.txt`, linked
from nowhere, and asks for `TRAFFIC_KEY` before it shows anything.

Every page beacons to `POST /api/track`, which adds 1 to a handful of fields in
a per-day Redis hash. **Counters only**: no row per visitor, no IP address, no
cookie, no identifier outliving the tab. Geography comes from Vercel's own
`x-vercel-ip-*` edge headers, so it is accurate to the city at best and wrong
for anyone on a VPN. Known crawlers, `Do Not Track` browsers, the dashboard
itself and every preview deployment are all left out, which means the true
figures run slightly above what is shown.

Two things switch it on:

1. **Storage.** Vercel dashboard > Storage > add Redis. Any of the variable
   pairs the Call Desk already accepts works, and if the desk is set up the
   analytics needs nothing added: `KV_REST_API_URL` + `KV_REST_API_TOKEN`,
   `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `REDIS_URL` /
   `KV_URL`. With no store the endpoint records nothing and `/stats` says so.
2. **`TRAFFIC_KEY`.** Any long random string; it is the dashboard password.
   Generate one with `python3 -c "import secrets; print(secrets.token_urlsafe(24))"`.

Roughly 3 Redis commands per page view, 10 on the first page of a visit — a few
thousand views a day fits inside a free Upstash plan. Days expire after 400
days on their own.

Tag your own links to see what a campaign brought in: `?utm_source=postcard`
and `?utm_campaign=spring-mailer` show up under **Where visits came from** and
**Campaigns**.

## Environment variables

Set these in Vercel under Settings > Environment Variables. Each integration is
optional and the endpoint skips whatever is not configured:

| Variable | Purpose |
|---|---|
| `AIRTABLE_TOKEN` | **The only one actually required.** Personal access token with `data.records:read` and `data.records:write`, granted on the CRM base |
| `AIRTABLE_BASE_ID` | Optional — defaults to the CRM base |
| `AIRTABLE_TABLE` | Optional — defaults to `Leads` |
| `AIRTABLE_CONTACTS_TABLE` | Optional — defaults to `Contacts` |
| `RESEND_API_KEY` | Optional — enables the email notification from the endpoint |
| `NOTIFY_EMAIL` | Where those notifications are sent |
| `NOTIFY_FROM` | Verified sender address |
| `TRAFFIC_KEY` | The `/stats` dashboard password. Unset means the dashboard is off; recording still happens |
| `KV_REST_API_*` / `UPSTASH_REDIS_REST_*` / `REDIS_URL` | Where traffic counters are kept. Shared with the Call Desk relay |

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
