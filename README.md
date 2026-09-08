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
