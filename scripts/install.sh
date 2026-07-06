#!/usr/bin/env bash
# Aletheia one-line installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/nimaedelkhani/aletheia/main/scripts/install.sh | bash
#
# What it does (in order):
#   1. Verify Node.js >= 20.
#   2. Enable pnpm via corepack.
#   3. Clone the repo into ./aletheia (or reuse the current dir if it IS the repo).
#   4. pnpm install.
#   5. Run pnpm setup, which drops you into the interactive first-run wizard.
#
# Idempotent — safe to rerun. Never touches an existing .env.

set -euo pipefail

REPO_URL="${ALETHEIA_REPO_URL:-https://github.com/nimaedelkhani/aletheia.git}"
TARGET_DIR="${ALETHEIA_DIR:-aletheia}"

bold()   { printf "\033[1m%s\033[22m" "$1"; }
dim()    { printf "\033[2m%s\033[22m" "$1"; }
green()  { printf "\033[32m%s\033[39m" "$1"; }
yellow() { printf "\033[33m%s\033[39m" "$1"; }
red()    { printf "\033[31m%s\033[39m" "$1"; }
cyan()   { printf "\033[36m%s\033[39m" "$1"; }

echo
bold "Aletheia — install"
echo
dim "─────────────────"
echo

# ── 1. Node.js check ─────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  red "✗ Node.js not found."; echo
  echo "  Install Node 20+ first:"
  echo "    macOS:   brew install node"
  echo "    Linux:   https://github.com/nvm-sh/nvm#installing-and-updating"
  echo "    Windows: https://nodejs.org/en/download"
  exit 1
fi

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "✗ Node.js 20+ required (found $(node -v))."; echo
  echo "  Upgrade Node and re-run this installer."
  exit 1
fi
green "✓"; echo " Node $(node -v) detected."

# ── 2. pnpm via corepack ─────────────────────────────────────────────────
if ! command -v pnpm >/dev/null 2>&1; then
  if ! command -v corepack >/dev/null 2>&1; then
    red "✗ corepack not available."; echo
    echo "  Node 20+ ships corepack. Enable it with:"
    echo "    npm install -g corepack"
    exit 1
  fi
  echo "· Enabling pnpm via corepack…"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
fi
if ! command -v pnpm >/dev/null 2>&1; then
  red "✗ pnpm not on PATH after corepack activation."; echo
  echo "  Try: npm install -g pnpm"
  exit 1
fi
green "✓"; echo " pnpm $(pnpm -v) ready."

# ── 3. Clone (or reuse current dir) ──────────────────────────────────────
if [ -f "package.json" ] && grep -q '"name": *"aletheia"' package.json 2>/dev/null; then
  echo "· Detected existing Aletheia checkout in current directory — reusing."
  REPO_DIR="."
else
  if [ -d "$TARGET_DIR" ]; then
    yellow "! Directory $TARGET_DIR already exists — reusing it."; echo
    REPO_DIR="$TARGET_DIR"
  else
    if ! command -v git >/dev/null 2>&1; then
      red "✗ git not found."; echo
      echo "  Install git and re-run this installer."
      exit 1
    fi
    echo "· Cloning $REPO_URL into $TARGET_DIR…"
    git clone --quiet "$REPO_URL" "$TARGET_DIR"
    REPO_DIR="$TARGET_DIR"
    green "✓"; echo " Cloned."
  fi
fi
cd "$REPO_DIR"

# ── 4. Install dependencies ──────────────────────────────────────────────
echo "· Installing dependencies (pnpm install)…"
pnpm install --silent
green "✓"; echo " Dependencies installed."
echo

# ── 5. Run setup wizard ──────────────────────────────────────────────────
# When invoked via `curl … | bash`, stdin is the pipe, so the setup wizard's
# interactive step won't be reachable. Detect that and fall through to
# printed next-steps instead of hanging waiting for Enter.
if [ -t 0 ]; then
  pnpm setup
else
  bold "Almost done."
  echo
  echo
  echo "  1. cd $REPO_DIR"
  echo "  2. Add your Anthropic API key to .env:"
  cyan "       ANTHROPIC_API_KEY=sk-ant-your-key-here"; echo
  dim  "       (get one at https://console.anthropic.com/settings/keys)"; echo
  echo
  echo "  3. Verify + open the web UI:"
  cyan "       pnpm setup"; echo
  echo
fi
