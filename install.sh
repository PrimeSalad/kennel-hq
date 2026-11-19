#!/usr/bin/env bash
# Kennel HQ installer for macOS, Linux and Git Bash/WSL.
#   curl -fsSL https://raw.githubusercontent.com/PrimeSalad/kennel-hq/main/install.sh | bash
set -euo pipefail

REPO="PrimeSalad/kennel-hq"
PKG="kennel-hq"
TARBALL="https://codeload.github.com/${REPO}/tar.gz/main"

amber=$'\033[38;2;255;179;71m'; pink=$'\033[38;2;255;143;192m'; red=$'\033[38;2;255;107;107m'; dim=$'\033[2m'; off=$'\033[0m'
say()  { printf '%s\n' "$*"; }
fail() { printf '%s✗ %s%s\n' "$red" "$*" "$off" >&2; exit 1; }

say ""
say "${pink}✻ Kennel HQ${off} ${dim}· an AI dev team of pixel-art dogs, powered by Claude Code${off}"
say ""

# 1. Node.js 22+
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is needed. Get it from https://nodejs.org (or: nvm install 22), then run this again."
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || fail "Node.js $(node -v) is too old. Kennel needs 22 or newer: https://nodejs.org (or: nvm install 22)."
command -v npm >/dev/null 2>&1 || fail "npm wasn't found. It comes with Node.js: https://nodejs.org"
say "  ${dim}node${off} $(node -v)"

# 2. Install: from npm if it's published there, otherwise straight from GitHub.
if npm view "$PKG" version >/dev/null 2>&1; then src="$PKG"; else src="$TARBALL"; fi
say "  ${dim}installing${off} ${src}"
if ! npm install -g "$src" --no-fund --no-audit --loglevel=error; then
  say ""
  say "${amber}!${off} Global install failed (often a permissions issue)."
  say "  Fix npm's global folder once, then run this again:"
  say "    mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global"
  say "    echo 'export PATH=\$HOME/.npm-global/bin:\$PATH' >> ~/.bashrc   ${dim}(or ~/.zshrc)${off}"
  exit 1
fi

# 3. Claude Code (the dogs run on your own Claude login, no API key)
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  say "  ${dim}claude code${off} found"
else
  say ""
  say "${amber}!${off} Claude Code isn't installed yet. The dogs need it:"
  say "    curl -fsSL https://claude.ai/install.sh | bash"
  say "  then run ${dim}claude${off} once to log in."
fi

say ""
say "${pink}✓ Kennel HQ is installed.${off}"
say ""
say "  cd your-project"
say "  kennel                 ${dim}# opens the pack in the terminal + the office in your browser${off}"
say "  kennel install-skill   ${dim}# optional: use the pack from inside Claude Code (/kennel)${off}"
say ""
command -v kennel >/dev/null 2>&1 || say "${amber}!${off} Open a new terminal if ${dim}kennel${off} isn't found yet."
