# Deploying gohometownland.com

**Deploy = `git push`.** Vercel watches this repository. Push to `main` and
production updates in about a minute. There is no deploy command to run, no
CLI to log into, and no dashboard step.

| You push to | You get |
|---|---|
| `main` | production — gohometownland.com |
| any other branch | a private preview URL, posted on the commit and PR |

Ignore `scripts/deploy.sh` and the `vercel` CLI. Both are leftovers from the
original manual setup. They still work from a laptop but they are no longer the
path, and they cannot run in a cloud session at all.

---

## The everyday change

A wording fix, a new FAQ answer, a phone number. Four commands:

```bash
# 1. edit whatever you need under src/
python3 build.py           # regenerate site/
python3 scripts/check.py   # verify — refuses to pass if anything is wrong
git add -A && git commit -m "Fix the pricing sentence on How It Works"
git push -u origin main    # live in ~1 minute
```

That is the whole process. The two middle commands are what keep it safe to
move this fast.

### Why the two middle commands matter

`site/` is generated from `src/` and committed to the repo — Vercel serves it
directly. So an edit to `src/` that is never rebuilt produces a commit that
looks correct in the diff and deploys the **old** page. Nothing errors. You
find out days later.

`python3 scripts/check.py` makes that impossible to miss. It rebuilds, then
fails on:

- **stale `site/`** — `src/` was edited without a rebuild
- **placeholder text** — `class="ph"`, `offers@`, `PO Box 000`, `[STATE]`,
  `[DATE]`, `REVIEW BEFORE LAUNCH`, stub copy
- **a page that stopped building**, or a sitemap that lost a URL

Exit 0 means safe to push. The same check runs in GitHub Actions on every PR
and every push to `main`, so a forgotten rebuild gets caught even if you skip
it locally.

---

## The careful change

For anything you want to look at before the public does — layout, a new page,
legal copy, anything on the homepage:

```bash
git checkout -b tweak-hero
# edit, build, check as above
git commit -am "Rework the hero headline"
git push -u origin tweak-hero
```

Vercel posts a preview URL on the branch within a minute. Open it, click
around, then merge:

```bash
git checkout main && git merge tweak-hero && git push
```

Or open a PR and merge it in the GitHub UI — **but check the base branch
first**, see the trap below.

---

## Common changes, and where they live

| Change | File |
|---|---|
| Text on one page | `src/pages/<page>.html` |
| Page title / meta description | the `<!--title:-->` / `<!--desc:-->` comments at the top of that page |
| Footer, header, nav | `src/partials/` — changes all eight pages |
| The offer form | `src/partials/form.html` |
| Colors, spacing, type | `src/assets/css/site.css` |
| Form behaviour, validation, error text | `src/assets/js/site.js` |
| Where leads go | `src/api/lead.js` |
| A photo | drop the file in `src/assets/img/`, reference it, rebuild |
| Add a page | new `src/pages/<slug>.html` with the metadata comments, add a nav link in `src/partials/header.html`, add the slug to `EXPECTED_PAGES` in `scripts/check.py` |

Contact details appear in **six** files at once — the footer partial, contact,
privacy, terms, thank-you, and an error string in `site.js`. Grep for the old
value rather than working from memory:

```bash
grep -rn "old@example.com" src/
```

---

## The trap that remains

**Nothing in a cloud session can confirm the site went live.**
The sandbox egress proxy blocks gohometownland.com, and the connected Vercel
account cannot see this project. A session can verify the merge landed on
`main` and stop there. Confirming the deploy itself means opening the Vercel
dashboard or the site in a browser.

---

## Fixed on 2026-09-08

The GitHub default branch was `import-site`, so every new PR targeted a branch
Vercel does not publish and merging one deployed nothing. It nearly shipped a
no-op during the pre-launch change. **The default branch is now `main`**, so a
PR opened normally is already correct. `import-site` still exists, caught up
with `main` and unused — safe to delete whenever.

---

## If a deploy goes wrong

Vercel keeps every previous deployment. Fastest fix is **Instant Rollback** in
the Vercel dashboard: Deployments → the last good one → Promote to Production.
No git needed, takes seconds.

To undo it in git as well:

```bash
git revert <bad-commit> && python3 build.py && python3 scripts/check.py
git commit --amend --no-edit && git push
```

The revert needs its own rebuild — reverting `src/` alone leaves `site/` stale,
which is the same trap in reverse.

---

## Worth doing once

These retire recurring friction rather than fixing a single change:

1. **Set the Vercel environment variables** so leads actually reach Airtable:
   `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE`, and optionally
   `RESEND_API_KEY` / `NOTIFY_EMAIL` / `NOTIFY_FROM`. Until then the form
   returns success and logs to the Vercel function log — leads are recoverable
   but nobody is alerted.
2. **Confirm Vercel's production branch is `main`**, under the project's
   Settings → Git. Vercel stores this separately from GitHub's default branch,
   so changing the default does not necessarily change it. If it still reads
   `import-site`, pushes to `main` are building previews and production is
   frozen.
3. **Move the build to Vercel** — Build Command `python3 build.py`, Output
   Directory `site` — so `site/` no longer needs committing at all. This
   removes the rebuild step and the drift trap entirely, and is the single
   biggest simplification available. Test it on a preview branch first: the
   `/api/lead` function is currently detected because Root Directory is set to
   `site`, and that detection has to keep working.
