#!/usr/bin/env bash
# Deploys the COMMITTED state of the current branch to Vercel: a clean export of HEAD, never half-edited files.
#   bash tools/deploy.sh          a preview deployment
#   bash tools/deploy.sh --prod   the live site (https://coconuts-foley.vercel.app)
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "exporting $(git -C "$ROOT" log --oneline -1)"
git -C "$ROOT" archive HEAD | tar -x -C "$TMP"
cp -r "$ROOT/.vercel" "$TMP/.vercel"
cd "$TMP"
npx -y vercel@latest deploy "$@" --yes --archive=tgz --scope lack-toes
