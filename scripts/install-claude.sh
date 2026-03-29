#!/usr/bin/env bash
# install-claude.sh — Install dev-browser and its Claude Code skill
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

# ── 1. Prerequisites ────────────────────────────────────────────────────────
step "Checking prerequisites..."
command -v node >/dev/null 2>&1 || die "Node.js is required. Install from https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm is required. Install from https://nodejs.org"

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js >= 18 is required (found v$(node -v | tr -d v))"
fi
ok "Node.js $(node -v) found"

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

# ── 4. Install the Claude Code skill ────────────────────────────────────────
SKILL_DIR="$HOME/.claude/skills/dev-browser"
step "Installing Claude Code skill to ${SKILL_DIR}..."

# --claude flag exists in builds after v0.2.4; fall back to the flag-less form
# which auto-installs to all targets when running non-interactively (no TTY).
if dev-browser install-skill --claude 2>/dev/null; then
  ok "Skill installed to ${SKILL_DIR}/SKILL.md"
else
  warn "--claude flag not available in this build; running install-skill without flags"
  mkdir -p "$SKILL_DIR"
  dev-browser install-skill
  ok "Skill installed (check ${SKILL_DIR}/SKILL.md)"
fi

# ── 5. Verify ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Installation complete!${NC}"
echo ""
echo "  Next steps:"
echo "  1. Restart Claude Code (the skill loads on startup)"
echo "  2. Ask Claude to automate a browser:"
echo "       \"Open https://example.com and tell me the page title\""
echo "  3. Or run a quick test yourself:"
echo "       dev-browser --headless <<'EOF'"
echo "       const page = await browser.getPage(\"main\");"
echo "       await page.goto(\"https://example.com\");"
echo "       console.log(await page.title());"
echo "       EOF"
echo ""
echo "  See CHEATSHEET.md or run: dev-browser --help"
