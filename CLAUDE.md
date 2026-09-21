# gohometownland.com — working notes for Claude

Static marketing site. Nine pages assembled by `build.py` from `src/`.
No framework, no node build, no test suite.

## The one rule

**Edit `src/`. Never edit `site/`.** `site/` is generated output — `build.py`
overwrites it. An edit made there disappears on the next build, usually after
it has already been committed and forgotten.

## Every change is edit, commit, push

```bash
# edit files under src/
git add -A && git commit -m "..."
git push
```

The `.githooks/pre-commit` hook rebuilds `site/`, verifies it, and stages the
result into the same commit. You do not run `build.py` by hand and you cannot
forget it. If a check fails the commit is refused with the reason.

The hook is enabled per clone by `git config core.hooksPath .githooks`. A
`SessionStart` hook in `.claude/settings.json` runs that automatically, so a
fresh session is already set up. **If you have disabled hooks, or the commit
output does not say `pre-commit: rebuilding site/`, run `python3 build.py &&
python3 scripts/check.py` yourself before committing** — `src/` and the
regenerated `site/` must land in the same commit, or the commit deploys stale
HTML.

`scripts/check.py` fails on: a stale `site/` that does not match `src/`, any
placeholder text reaching production, a page that stopped building, or a
sitemap that lost a URL. CI runs it on every PR and every push to `main`, so a
clone that never enabled the hook is still caught.

## Deploying

**Deploy = `git push`.** Vercel is connected to this repo:

- push to `main` → production at gohometownland.com
- push to any other branch → a preview URL

Do **not** use the Vercel CLI or `scripts/deploy.sh`. They are a leftover from
the original manual setup, they are not needed, and they will not run in a
cloud session (the Vercel API is unreachable from the sandbox).

### One trap

**The live domain is unreachable from the sandbox** (egress proxy blocks it) and
the connected Vercel MCP account cannot see this project. A session cannot
confirm its own deploy went live. Verify the merge landed on `main`, then say
plainly that the Vercel build itself was not verified.

The default branch was `import-site` until 2026-09-08, which made new PRs target
a branch Vercel does not publish. It is now `main`, so a PR opened normally is
already correct. `import-site` still exists, caught up with `main` and unused.

## Content conventions

Page metadata is comments at the top of each `src/pages/*.html`:

```html
<!--title: How It Works-->
<!--desc: Sentence used for the meta description and social preview.-->
<!--nav: how-it-works-->
```

Two metadata comments are optional: `<!--robots: noindex-->` keeps a page out
of search *and* out of the sitemap, and `<!--script: stats-->` loads
`/assets/js/stats.js` on that page alone. `/stats` uses both.

`{{FORM}}` expands to the multi-step offer form. The state dropdown comes from
the `STATES` list in `build.py`. Shared chrome lives in `src/partials/` — a
footer edit changes all eight pages, so rebuild after touching it.

Contact details appear in several places at once. Changing the email or mailing
address means `src/partials/footer.html`, `src/pages/contact.html`,
`src/pages/privacy.html`, `src/pages/terms.html`, `src/pages/thank-you.html`,
and the error string in `src/assets/js/site.js`. Grep for the old value; do not
work from memory.

## Local preview

```bash
python3 build.py && python3 serve.py 8322
```

Resolves `/about` to `about.html` the way Vercel does, and stubs `/api/lead` so
the form's success path works — submissions print to the terminal.

## Secrets

Never commit them. `AIRTABLE_TOKEN` and the optional `AIRTABLE_BASE_ID` /
`AIRTABLE_TABLE` / `AIRTABLE_CONTACTS_TABLE` / `RESEND_API_KEY` /
`NOTIFY_EMAIL` / `NOTIFY_FROM` live in Vercel under Settings → Environment
Variables. **This repository is public.** Base and table IDs are not secrets —
they are in the Airtable URL and useless without the token — so `lead.js`
carries them as defaults; the token never appears anywhere in the repo.

`src/api/lead.js` skips whatever is not configured and still returns success,
logging the full submission to the Vercel function log, so a lead is never lost
while integrations are half-configured.

## Traffic

`/stats` is a private dashboard: visits, page views, offer requests, and where
visitors came from (referrer or campaign, country, state, city, device). It is
noindex, `Disallow`ed, unlinked, and gated on the `TRAFFIC_KEY` env var.

Every page beacons to `POST /api/track`, which increments fields in a per-day
Redis hash — **counters only**, no row per visitor, no IP, no cookie. Geography
comes from Vercel's `x-vercel-ip-*` headers. It uses the same Redis the Call
Desk relay uses and accepts the same variable names, so a project set up for
the desk needs nothing added. No store means nothing is recorded and the
dashboard says so rather than showing zeros.

Deliberately not counted, so do not treat any of these as a bug: crawlers,
browsers sending Do Not Track, the `/stats` page itself, and every host that is
not `gohometownland.com` — which is what keeps preview deploys out of the real
numbers, and also why the beacon appears to do nothing on a preview URL.

## The CRM

`/api/lead` writes into the sales base `appdd0mQPJU7ZPAtw`: a `Contacts` record
(reused when the email is already known) and a `Leads` record linked to it,
marked `Source` = `Website`. The exact field names live in the `LEAD` and
`CONTACT` maps at the top of `src/api/lead.js` — two of them really do end in a
space. `python scripts/setup-airtable.py` checks the live base against those
maps and adds any missing `Leads` field; run it if a lead ever arrives with
fields blank.

Do not link a website lead's `County`: that field points at `Mailers`, i.e. at a
mail campaign, and a web lead did not come from one. The county goes in
`Property County` as text.
