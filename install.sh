#!/usr/bin/env bash
# Kennel HQ installer for macOS, Linux and WSL. One command, nothing else needed first:
#   curl -fsSL https://raw.githubusercontent.com/PrimeSalad/kennel-hq/main/install.sh | bash
# Installs Node.js (a private copy, no sudo) if yours is missing or too old, Claude Code if it's missing,
# and the `kennel` command. Run it again any time to update.
set -euo pipefail

REPO="PrimeSalad/kennel-hq"
PKG="kennel-hq"
TARBALL="https://codeload.github.com/${REPO}/tar.gz/main"
KENNEL_HOME="${KENNEL_HOME:-$HOME/.kennel}"
NODE_DIR="$KENNEL_HOME/node"

amber=$'\033[38;2;255;179;71m'; pink=$'\033[38;2;255;143;192m'; red=$'\033[38;2;255;107;107m'; dim=$'\033[2m'; off=$'\033[0m'
say()  { printf '%s\n' "$*"; }
fail() { printf '%s✗ %s%s\n' "$red" "$*" "$off" >&2; exit 1; }
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }

# Put a folder on PATH for future terminals (bash, zsh and login shells).
add_path() {
  [ -n "${KENNEL_NO_PATH:-}" ] && return 0
  local line="export PATH=\"$1:\$PATH\""
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    { [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ]; } || continue
    grep -qsF "$1" "$rc" || printf '\n# Kennel HQ\n%s\n' "$line" >> "$rc"
  done
}

install_private_node() {
  say "  ${dim}getting Node.js 22 (a private copy for Kennel, no sudo needed)…${off}"
  local os arch ver name tmp
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "Unsupported system $(uname -s). On Windows, use PowerShell: irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail "Unsupported CPU $(uname -m). Install Node.js 22 from https://nodejs.org and run this again." ;; esac
  ver=$(fetch https://nodejs.org/dist/index.json | grep -o '"version":"v22\.[0-9.]*"' | head -1 | cut -d'"' -f4)
  [ -n "$ver" ] || fail "Couldn't find a Node.js 22 download. Install it from https://nodejs.org and run this again."
  name="node-$ver-$os-$arch"
  tmp=$(mktemp -d)
  fetch "https://nodejs.org/dist/$ver/$name.tar.gz" | tar -xz -C "$tmp" || fail "Couldn't download Node.js. Check your internet connection."
  rm -rf "$NODE_DIR"; mkdir -p "$KENNEL_HOME"; mv "$tmp/$name" "$NODE_DIR"; rm -rf "$tmp"
  export PATH="$NODE_DIR/bin:$PATH"
  add_path "$NODE_DIR/bin"
}

say ""
say "${pink}✻ Kennel HQ${off} ${dim}· an AI dev team of pixel-art dogs, powered by Claude Code${off}"
say ""

# 1. Node.js 22+: use yours if it's new enough, otherwise a private copy in ~/.kennel/node.
[ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
if [ -n "${KENNEL_FORCE_PORTABLE:-}" ] || [ "$(node_major)" -lt 22 ]; then install_private_node; fi
say "  ${dim}node${off} $(node -v)"

# 2. Kennel itself: from npm if it's published there, otherwise straight from GitHub.
if npm view "$PKG" version >/dev/null 2>&1; then src="$PKG"; where=npm; else src="$TARBALL"; where=GitHub; fi
say "  ${dim}installing kennel from $where…${off}"
if ! npm install -g "$src" --no-fund --no-audit --loglevel=error 2>/dev/null; then
  # Usually a system Node whose global folder needs sudo: use a private Node instead.
  case "$(command -v node)" in "$NODE_DIR"/*) fail "Installing kennel failed. Check your internet connection and run this again." ;; esac
  say "  ${dim}no permission for the system's global npm folder; using a private Node.js instead${off}"
  install_private_node
  npm install -g "$src" --no-fund --no-audit --loglevel=error || fail "Installing kennel failed. Check your internet connection and run this again."
fi

# 3. Claude Code: the dogs run on your own Claude login (no API key).
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  say "  ${dim}claude code found${off}"
elif [ -n "${KENNEL_NO_CLAUDE:-}" ]; then
  say "  ${dim}skipping Claude Code (KENNEL_NO_CLAUDE is set)${off}"
else
  say "  ${dim}installing Claude Code (official installer)…${off}"
  fetch https://claude.ai/install.sh | bash || say "${amber}!${off} Couldn't install Claude Code. Get it from https://claude.com/claude-code"
fi

say ""
say "${pink}✓ Kennel HQ is installed.${off}"
say ""
say "  Open a NEW terminal, then:"
say "  claude                 ${dim}# first time only: log in to your Claude account${off}"
say "  cd your-project"
say "  kennel                 ${dim}# the pack in the terminal + the office in your browser${off}"
say "  kennel install-skill   ${dim}# optional: use the pack from inside Claude Code (/kennel)${off}"
say ""
