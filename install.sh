#!/usr/bin/env bash
# Development install: builds the extension, installs it in VS Code, links the `lreview` CLI and the Claude skill
# to this checkout. End users install from the Marketplace and use the extension's install commands instead.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${LREVIEW_BIN_DIR:-$HOME/.local/bin}"
skill_dir="${LREVIEW_SKILL_DIR:-$HOME/.claude/skills/local-merge-request}"

cd "$here"
[ -d node_modules ] || npm ci
npm test
npm run package

# Pre-release id of this extension.
code --uninstall-extension local.local-review >/dev/null 2>&1 || true
code --install-extension "$here/local-merge-request.vsix" --force

mkdir -p "$bin_dir"
ln -sfn "$here/dist/cli.js" "$bin_dir/lreview"

mkdir -p "$(dirname "$skill_dir")"
if [ -e "$skill_dir" ] && [ ! -L "$skill_dir" ]; then
  echo "error: $skill_dir exists and is not a symlink, remove it first" >&2
  exit 1
fi
ln -sfn "$here/skill" "$skill_dir"
old_skill="$HOME/.claude/skills/local-review"
if [ -L "$old_skill" ] && [ "$(readlink "$old_skill")" = "$here/skill" ]; then rm "$old_skill"; fi

echo
echo "Installed:"
echo "  extension  $(node -p "require('./package.json').publisher").local-merge-request (reload VS Code windows)"
echo "  CLI        $bin_dir/lreview -> $here/dist/cli.js"
echo "  skill      $skill_dir -> $here/skill"
