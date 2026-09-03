#!/usr/bin/env bash
# Deploy gohometownland.com to Vercel production and attach the domain.
#
# Prerequisite (interactive, run it yourself once):
#     vercel login
#
# Then:
#     bash scripts/deploy.sh
#
# Safe to re-run. Linking and domain attachment are idempotent.

set -euo pipefail

SCOPE="${VERCEL_SCOPE:-hometown-land}"      # team slug from vercel.com/<slug>
PROJECT="${VERCEL_PROJECT:-hometown-land}"  # project slug
APEX="gohometownland.com"
WWW="www.${APEX}"

cd "$(dirname "$0")/.."

export NO_UPDATE_NOTIFIER=1 VERCEL_TELEMETRY_DISABLED=1

echo "==> Checking authentication"
if ! vercel whoami --scope "$SCOPE" >/dev/null 2>&1; then
  echo "Not logged in. Run 'vercel login' first, then re-run this script." >&2
  exit 1
fi
echo "    authenticated as $(vercel whoami 2>/dev/null | tail -1)"

echo "==> Rebuilding site/ from src/"
python build.py

echo "==> Linking to project '$PROJECT' in scope '$SCOPE'"
cd site
vercel link --yes --scope "$SCOPE" --project "$PROJECT"

echo "==> Deploying to production"
vercel deploy --prod --yes --scope "$SCOPE"

echo "==> Attaching domains"
# 'already in use by this project' is success for our purposes
vercel domains add "$APEX"  "$PROJECT" --scope "$SCOPE" 2>&1 | sed 's/^/    /' || true
vercel domains add "$WWW"   "$PROJECT" --scope "$SCOPE" 2>&1 | sed 's/^/    /' || true

echo
echo "==> Domain status"
vercel domains inspect "$APEX" --scope "$SCOPE" 2>&1 | sed 's/^/    /' || true

cat <<'NOTE'

Next, at Namecheap (Domain List > Manage > Advanced DNS), add whatever records
the output above asked for. Vercel currently uses:

    A      @      76.76.21.21
    CNAME  www    cname.vercel-dns.com

Or switch Namecheap to Custom DNS and point it at the nameservers Vercel shows.
Namecheap's default parking records must be removed or they will conflict.

HTTPS is issued automatically once DNS resolves; it usually takes a few minutes
but can take up to an hour.
NOTE
