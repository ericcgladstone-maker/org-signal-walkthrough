#!/bin/bash
# Copy the talk from the working site folder into public/ (what the Worker serves, GitHub holds,
# and the Graystone Talks page copies). The frozen app's security headers become a rule for /app/*.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../site"
rm -rf "$here/public"; mkdir -p "$here/public"
cp "$src/index.html" "$src/embed.js" "$src/player.css" "$src/player.js" "$src/timeline.js" "$here/public/"
[ -f "$src/og.png" ] && cp "$src/og.png" "$here/public/"
cp -R "$src/stage" "$src/app" "$here/public/"
# The app's own _headers apply to the app's folder here; the VERSION file keeps the commit only.
rm -f "$here/public/app/_headers"
head -2 "$src/app/VERSION" > "$here/public/app/VERSION"
{
  echo "/*"
  echo "  X-Content-Type-Options: nosniff"
  echo "  Referrer-Policy: strict-origin-when-cross-origin"
  echo "  Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()"
  echo ""
  echo "/app/*"
  grep -E '^\s+Content-Security-Policy:' "$src/app/_headers" | sed 's/frame-ancestors .self./frame-ancestors '"'"'self'"'"'/'
  echo ""
} > "$here/public/_headers"
find "$here/public" \( -name '.DS_Store' -o -name 'Icon?' \) -delete 2>/dev/null || true
echo "synced $(find "$here/public" -type f | wc -l | tr -d ' ') files"
