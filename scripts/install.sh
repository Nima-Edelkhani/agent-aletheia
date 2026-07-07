#!/usr/bin/env bash
# Aletheia one-line installer.
#
# Usage:
#   mkdir my-aletheia && cd my-aletheia
#   curl -fsSL https://raw.githubusercontent.com/Nima-Edelkhani/agent-aletheia/main/scripts/install.sh | bash
#   pnpm start
#
# The installer clones into the CURRENT directory (no subdirectory). Refuses
# to run if the current directory is not empty, to avoid clobbering.

set -euo pipefail

REPO_URL="${ALETHEIA_REPO_URL:-https://github.com/Nima-Edelkhani/agent-aletheia.git}"

bold()   { printf "\033[1m%s\033[22m" "$1"; }
dim()    { printf "\033[2m%s\033[22m" "$1"; }
green()  { printf "\033[32m%s\033[39m" "$1"; }
yellow() { printf "\033[33m%s\033[39m" "$1"; }
red()    { printf "\033[31m%s\033[39m" "$1"; }
cyan()   { printf "\033[36m%s\033[39m" "$1"; }

echo
bold "Aletheia -- install"
echo
dim "-------------------"
echo

# -- 1. Node.js check --------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  red "x Node.js not found."; echo
  echo "  Install Node 20+ first:"
  echo "    macOS:   brew install node"
  echo "    Linux:   https://github.com/nvm-sh/nvm#installing-and-updating"
  echo "    Windows: https://nodejs.org/en/download"
  exit 1
fi
NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "x Node.js 20+ required (found $(node -v))."; echo
  echo "  Upgrade Node and re-run this installer."
  exit 1
fi
green "OK"; echo " Node $(node -v) detected."

# -- 2. pnpm via corepack ---------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  if ! command -v corepack >/dev/null 2>&1; then
    red "x corepack not available."; echo
    echo "  Node 20+ ships corepack. Enable it with:"
    echo "    npm install -g corepack"
    exit 1
  fi
  echo "- Enabling pnpm via corepack..."
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
fi
if ! command -v pnpm >/dev/null 2>&1; then
  red "x pnpm not on PATH after corepack activation."; echo
  echo "  Try: npm install -g pnpm"
  exit 1
fi
green "OK"; echo " pnpm $(pnpm -v) ready."

# -- 3. git check -----------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  red "x git not found."; echo
  echo "  Install git and re-run this installer."
  exit 1
fi

# -- 4. Current directory must be empty -------------------------------
# We clone into '.' so files land beside the user in their chosen dir.
# git clone . refuses if the dir has any file at all -- check first for
# a clear error message.
if [ -n "$(ls -A . 2>/dev/null)" ]; then
  red "x Current directory is not empty:"; echo
  echo "    $(pwd)"
  echo
  echo "  Aletheia installs into the CURRENT directory (no subdir)."
  echo "  Please cd into an empty directory and re-run:"
  echo
  cyan "    mkdir my-aletheia && cd my-aletheia"; echo
  cyan "    curl -fsSL $REPO_URL/../scripts/install.sh | bash"; echo
  echo
  exit 1
fi

# -- 5. Clone into current dir ----------------------------------------
echo "- Cloning $REPO_URL into $(pwd)..."
git clone --quiet "$REPO_URL" .
green "OK"; echo " Cloned."

# -- 6. Install dependencies ------------------------------------------
echo "- Installing dependencies (pnpm install)..."
pnpm install --silent
green "OK"; echo " Dependencies installed."

# -- 7. Print next step -----------------------------------------------
echo
bold "Aletheia is installed."; echo
echo
echo "  Next: run the interactive setup wizard"
cyan "    pnpm start"; echo
echo
dim  "  (Copies .env.example, seeds the Voxly corpus, and prompts you to"; echo
dim  "  add your Anthropic API key to .env before verifying it.)"; echo
echo
