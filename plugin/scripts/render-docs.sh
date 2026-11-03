#!/usr/bin/env bash
# Renders the README screenshots and checks that nothing draws past its frame at any width.
#   scripts/render-docs.sh [out dir]     screenshots go to docs/, the pages and a report to the out dir
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$(mktemp -d)}"
bun "$here/scripts/render-docs.ts" "$out"

failed=0
while IFS='|' read -r file columns kind docs; do
  agent-browser open "file://$out/$file" >/dev/null
  problems="$(agent-browser eval 'document.body.dataset.problems' | tr -d '"[:space:]')"
  if [ "$problems" != "0" ]; then
    echo "OVERFLOW  $file ($columns columns): $problems element(s) past the frame or wrapped in the band"
    failed=1
  fi
  if [ "$kind" != "check" ] && [ -n "$docs" ]; then
    agent-browser screenshot body "$here/docs/$docs" >/dev/null
    echo "wrote docs/$docs"
  fi
done < <(bun -e 'for (const m of await Bun.file(process.argv[1]).json()) console.log([m.file, m.columns, m.kind, m.docs ?? ""].join("|"))' "$out/manifest.json")

agent-browser close >/dev/null 2>&1 || true
[ "$failed" = 0 ] && echo "no overflow at any width" || exit 1
