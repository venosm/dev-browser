#!/usr/bin/env bash
# install-codex.sh — Install dev-browser and its Codex CLI skill
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "${BOLD}▶ $*${NC}"; }
ok()    { echo -e "${GREEN}✓ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠  $*${NC}"; }
die()   { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

# Codex CLI looks in ~/.codex/skills/
# The generic agents protocol uses  ~/.agents/skills/
# This script installs to both so it works regardless of which path your CLI checks.
CODEX_SKILL_DIR="$HOME/.codex/skills/dev-browser"
AGENTS_SKILL_DIR="$HOME/.agents/skills/dev-browser"

# ── 1. Prerequisites ────────────────────────────────────────────────────────
step "Checking prerequisites..."
command -v node >/dev/null 2>&1 || die "Node.js is required. Install from https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm is required. Install from https://nodejs.org"

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js >= 18 is required (found v$(node -v | tr -d v))"
fi

# Check that Codex CLI is installed
if ! command -v codex >/dev/null 2>&1; then
  warn "Codex CLI not found in PATH."
  warn "Install it first: npm install -g @openai/codex"
  warn "Continuing anyway — skill files will be written for when you install it."
fi

ok "Prerequisites OK"

# ── 2. Install dev-browser ───────────────────────────────────────────────────
step "Installing dev-browser globally..."
if command -v dev-browser >/dev/null 2>&1; then
  CURRENT=$(dev-browser --version 2>/dev/null || echo "unknown")
  warn "dev-browser is already installed (${CURRENT}). Upgrading..."
fi

# Use sudo for global npm install if the prefix isn't writable by the current user
NPM_PREFIX=$(npm prefix -g 2>/dev/null)
if [ -w "$NPM_PREFIX/lib" ] 2>/dev/null; then
  npm install -g dev-browser
else
  warn "Global npm prefix ($NPM_PREFIX) is not writable — using sudo for npm install"
  sudo npm install -g dev-browser
fi
ok "dev-browser $(dev-browser --version 2>/dev/null || echo '') installed"

# ── 3. Install Playwright + Chromium ────────────────────────────────────────
step "Installing Playwright + Chromium browser..."
echo "   (This downloads ~150 MB — may take a minute)"
dev-browser install
ok "Playwright + Chromium ready"

# ── 4. Install the skill ────────────────────────────────────────────────────
step "Installing skill files..."

# --agents flag exists in builds after v0.2.4; fall back to flag-less form
# which auto-installs to all targets when running non-interactively.
dev-browser install-skill --agents 2>/dev/null || dev-browser install-skill 2>/dev/null || {
  warn "install-skill failed; skill files will be downloaded from GitHub instead"
}

# Also copy to ~/.codex/skills/ for Codex CLI
mkdir -p "$CODEX_SKILL_DIR"
if [ -f "$AGENTS_SKILL_DIR/SKILL.md" ]; then
  cp "$AGENTS_SKILL_DIR/SKILL.md" "$CODEX_SKILL_DIR/SKILL.md"
  ok "Skill copied to ${CODEX_SKILL_DIR}/SKILL.md"
else
  # Fall back: download directly from GitHub
  warn "Local skill file not found; downloading from GitHub..."
  SKILL_URL="https://raw.githubusercontent.com/SawyerHood/dev-browser/main/skills/dev-browser/SKILL.md"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$SKILL_URL" -o "$CODEX_SKILL_DIR/SKILL.md"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$CODEX_SKILL_DIR/SKILL.md" "$SKILL_URL"
  else
    die "Neither curl nor wget found. Download manually:\n  $SKILL_URL\n  → $CODEX_SKILL_DIR/SKILL.md"
  fi
  ok "Skill downloaded to ${CODEX_SKILL_DIR}/SKILL.md"
fi

# ── 5. Summary ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Installation complete!${NC}"
echo ""
echo "  Skill installed to:"
echo "    ~/.codex/skills/dev-browser/SKILL.md"
echo "    ~/.agents/skills/dev-browser/SKILL.md"
echo ""
echo "  Next steps:"
echo "  1. Restart Codex CLI (skills load on startup)"
echo "  2. Try a quick test:"
echo "       codex \"Open https://example.com and return the page title\""
echo "  3. Or run dev-browser directly:"
echo "       dev-browser --headless <<'EOF'"
echo "       const page = await browser.getPage(\"main\");"
echo "       await page.goto(\"https://example.com\");"
echo "       console.log(await page.title());"
echo "       EOF"
echo ""
echo "  See CHEATSHEET.md or run: dev-browser --help"
