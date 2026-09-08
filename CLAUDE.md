# gohometownland.com — working notes for Claude

Static marketing site. Eight pages assembled by `build.py` from `src/`.
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

Never commit them. `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE`, and
the optional `RESEND_API_KEY` / `NOTIFY_EMAIL` / `NOTIFY_FROM` live in Vercel
under Settings → Environment Variables. **This repository is public.**

`src/api/lead.js` skips whatever is not configured and still returns success,
logging the full submission to the Vercel function log, so a lead is never lost
while integrations are half-configured.
