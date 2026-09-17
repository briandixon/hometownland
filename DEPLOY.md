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

## One-time setup, per clone

```bash
git config core.hooksPath .githooks
```

That enables the pre-commit hook. Claude Code sessions run it automatically via
`.claude/settings.json`, so this is only for your own checkouts.

---

## The everyday change

A wording fix, a new FAQ answer, a phone number:

```bash
# edit whatever you need under src/
git add -A && git commit -m "Fix the pricing sentence on How It Works"
git push                   # live in ~1 minute
```

That is the whole process. The rebuild and the safety checks happen inside
`git commit`:

```
pre-commit: rebuilding site/ from src/
  [  ok] pages
  [  ok] placeholders
```

If a check fails, the commit is refused and tells you why. Nothing half-built
reaches a branch.

One wrinkle: a refused commit leaves `site/` already rebuilt from the `src/`
you were trying to commit. Fix `src/` and commit again and it sorts itself out.
If you instead abandon the edit, run `python3 build.py` to put `site/` back in
step — and if you forget, CI catches it before it can deploy.

### Why the hook exists

`site/` is generated from `src/` and committed to the repo — Vercel serves it
directly. So an edit to `src/` that is never rebuilt produces a commit that
looks correct in the diff and deploys the **old** page. Nothing errors. You
find out days later.

The hook makes that impossible. It rebuilds `site/` and stages it into the same
commit, then runs `scripts/check.py`, which fails on:

- **stale `site/`** — `src/` was edited without a rebuild
- **placeholder text** — `class="ph"`, `offers@`, `PO Box 000`, `[STATE]`,
  `[DATE]`, `REVIEW BEFORE LAUNCH`, stub copy
- **a page that stopped building**, or a sitemap that lost a URL

The same check runs in GitHub Actions on every PR and every push to `main`, so
a clone that never enabled the hook — or an edit made in GitHub's web editor —
is still caught before it can deploy.

Run it by hand any time with `python3 scripts/check.py`.

---

## The careful change

For anything you want to look at before the public does — layout, a new page,
legal copy, anything on the homepage:

```bash
git checkout -b tweak-hero
# edit under src/
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
git revert <bad-commit>
git push
```

The revert touches `src/`, so the hook rebuilds `site/` to match as part of the
revert commit. Without the hook you would have to rebuild by hand — reverting
`src/` alone leaves `site/` stale, which is the same trap in reverse.

---

## Worth doing once

These retire recurring friction rather than fixing a single change:

1. **Set `AIRTABLE_TOKEN` in Vercel** so leads actually reach the CRM. It is
   the only variable the integration needs — base and table names default to
   the CRM's `Leads` and `Contacts`. The token needs `data.records:read` and
   `data.records:write`, granted on base `appdd0mQPJU7ZPAtw`. Until it is set
   the form returns success and logs to the Vercel function log — leads are
   recoverable but nobody is alerted.
   Then turn on the **Website Lead — Email Notification** automation in
   Airtable, which is set up but saved switched off. See the README for the
   Resend alternative and the full variable list.
2. **Confirm Vercel's production branch is `main`**, under the project's
   Settings → Git. Vercel stores this separately from GitHub's default branch,
   so changing the default does not necessarily change it. If it still reads
   `import-site`, pushes to `main` are building previews and production is
   frozen.
3. **Optional: move the build to Vercel** — Build Command `python3 build.py`,
   Output Directory `site`, Root Directory back to the repo root. `site/` would
   then not be committed at all.

   With the pre-commit hook in place this is now **cosmetic** — it removes diff
   noise, not a step or a risk. It also is not free: `/api/lead` is detected
   today only because Root Directory is `site`, so `src/api/lead.js` would have
   to move to `api/` at the repo root, and the whole thing needs proving on a
   preview branch with a real test submission before production. Worth doing
   only if the `site/` diffs genuinely bother you.
