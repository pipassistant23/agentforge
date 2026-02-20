#!/usr/bin/env bash
# AgentForge Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/pipassistant23/agentforge/main/install.sh | bash
set -euo pipefail

REPO_URL="https://github.com/pipassistant23/agentforge.git"
DEFAULT_INSTALL_DIR="$HOME/agentforge"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}▶${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✗${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${NC}"; }

# ── Prereq checks ─────────────────────────────────────────────────────────────
header "AgentForge Installer"
echo "──────────────────────────────────────────"

info "Checking prerequisites..."

if ! command -v git &>/dev/null; then
  error "git is not installed. Install it and re-run."
  exit 1
fi

if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Install Node.js 20+ and re-run."
  echo "  → https://nodejs.org  or  https://github.com/nvm-sh/nvm"
  exit 1
fi

NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  error "Node.js $(node --version) found, but 20+ is required."
  exit 1
fi

if ! command -v npm &>/dev/null; then
  error "npm is not installed."
  exit 1
fi

success "git $(git --version | awk '{print $3}'), node $(node --version), npm $(npm --version)"

# ── Install directory ─────────────────────────────────────────────────────────
header "Install location"

# When piped through bash, stdin is the script — read from /dev/tty for prompts
exec 3</dev/tty

read -u 3 -r -p "$(echo -e "Install directory [${DEFAULT_INSTALL_DIR}]: ")" INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"   # expand leading ~

if [ -d "$INSTALL_DIR" ]; then
  warn "Directory $INSTALL_DIR already exists."
  read -u 3 -r -p "$(echo -e "${YELLOW}Continue and update in place?${NC} [y/N] ")" CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

# ── Clone ─────────────────────────────────────────────────────────────────────
header "Cloning repository"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing clone..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

success "Repository at $INSTALL_DIR"

# ── Build ─────────────────────────────────────────────────────────────────────
header "Installing dependencies and building"

cd "$INSTALL_DIR"

info "Installing orchestrator dependencies..."
npm ci --silent

info "Installing agent-runner dependencies..."
npm ci --prefix agent-runner-src --silent

info "Building TypeScript..."
npm run build --silent

success "Build complete"

# ── Data directories ───────────────────────────────────────────────────────────
header "Setting up directories"

if [ ! -d /data ]; then
  info "Creating /data (requires sudo)..."
  sudo mkdir -p /data/qmd
  sudo chown -R "$USER:$(id -gn)" /data
elif [ ! -w /data ]; then
  info "Fixing /data permissions (requires sudo)..."
  sudo chown -R "$USER:$(id -gn)" /data
fi

mkdir -p /data/qmd store
success "Directories ready"

# ── .env configuration ────────────────────────────────────────────────────────
header "Configuration"

if [ -f "$INSTALL_DIR/.env" ]; then
  warn ".env already exists — skipping interactive setup."
  warn "Edit $INSTALL_DIR/.env to change settings."
else
  echo "Two values are required. Everything else has sensible defaults."
  echo "You can edit .env at any time to add optional features."
  echo ""

  # Telegram bot token
  while true; do
    read -u 3 -r -p "$(echo -e "${BOLD}Telegram bot token${NC} (from @BotFather): ")" TG_TOKEN
    [[ -n "$TG_TOKEN" ]] && break
    warn "Telegram bot token is required."
  done

  # API key — offer three options
  echo ""
  echo -e "${BOLD}Claude API authentication — choose one:${NC}"
  echo "  1) Anthropic API key     (pay-per-use, get from console.anthropic.com)"
  echo "  2) Claude Code OAuth     (if you have a Claude Max/Pro subscription)"
  echo "  3) Third-party provider  (OpenRouter, Together, local Ollama, etc.)"
  echo ""
  read -u 3 -r -p "Choice [1]: " AUTH_CHOICE
  AUTH_CHOICE="${AUTH_CHOICE:-1}"

  ANTHROPIC_KEY=""
  OAUTH_TOKEN=""
  CUSTOM_TOKEN=""
  CUSTOM_BASE_URL=""
  CUSTOM_MODEL=""

  if [[ "$AUTH_CHOICE" == "2" ]]; then
    while true; do
      read -u 3 -r -p "$(echo -e "${BOLD}Claude Code OAuth token${NC}: ")" OAUTH_TOKEN
      [[ -n "$OAUTH_TOKEN" ]] && break
      warn "Token is required."
    done
  elif [[ "$AUTH_CHOICE" == "3" ]]; then
    while true; do
      read -u 3 -r -p "$(echo -e "${BOLD}API base URL${NC} (e.g. https://openrouter.ai/api/v1): ")" CUSTOM_BASE_URL
      [[ -n "$CUSTOM_BASE_URL" ]] && break
      warn "Base URL is required."
    done
    while true; do
      read -u 3 -r -p "$(echo -e "${BOLD}API key / token${NC}: ")" CUSTOM_TOKEN
      [[ -n "$CUSTOM_TOKEN" ]] && break
      warn "API key is required."
    done
    read -u 3 -r -p "$(echo -e "${BOLD}Model name${NC} (e.g. anthropic/claude-sonnet-4-5, default: claude-sonnet-4-5-20250929): ")" CUSTOM_MODEL
    CUSTOM_MODEL="${CUSTOM_MODEL:-claude-sonnet-4-5-20250929}"
  else
    while true; do
      read -u 3 -r -p "$(echo -e "${BOLD}Anthropic API key${NC} (sk-ant-...): ")" ANTHROPIC_KEY
      [[ -n "$ANTHROPIC_KEY" ]] && break
      warn "API key is required."
    done
  fi

  # Optional: assistant name
  echo ""
  read -u 3 -r -p "$(echo -e "Assistant name [AgentForge]: ")" ASSISTANT_NAME
  ASSISTANT_NAME="${ASSISTANT_NAME:-AgentForge}"

  # Write .env
  {
    echo "# Generated by AgentForge installer — $(date)"
    echo "TELEGRAM_BOT_TOKEN=$TG_TOKEN"
    if [[ -n "$ANTHROPIC_KEY" ]]; then
      echo "ANTHROPIC_API_KEY=$ANTHROPIC_KEY"
    fi
    if [[ -n "$OAUTH_TOKEN" ]]; then
      echo "CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_TOKEN"
    fi
    if [[ -n "$CUSTOM_TOKEN" ]]; then
      echo "ANTHROPIC_AUTH_TOKEN=$CUSTOM_TOKEN"
      echo "ANTHROPIC_BASE_URL=$CUSTOM_BASE_URL"
      echo "ANTHROPIC_MODEL=$CUSTOM_MODEL"
    fi
    echo "ASSISTANT_NAME=$ASSISTANT_NAME"
    echo ""
    echo "# Optional — uncomment to configure"
    echo "# LOG_LEVEL=info"
    echo "# TELEGRAM_BOT_POOL=token1,token2,token3"
    echo "# QMD_MODELS_PATH=$INSTALL_DIR/data/qmd/models"
  } > "$INSTALL_DIR/.env"

  chmod 600 "$INSTALL_DIR/.env"
  success ".env written and locked to 600"
fi

# ── Systemd service ───────────────────────────────────────────────────────────
header "Systemd service"

if command -v systemctl &>/dev/null; then
  read -u 3 -r -p "$(echo -e "Install as a systemd service? [Y/n] ")" INSTALL_SVC
  if [[ ! "$INSTALL_SVC" =~ ^[Nn]$ ]]; then
    cd "$INSTALL_DIR"
    bash install-service.sh <&3
  else
    info "Skipped. Run ./install-service.sh later to set up the service."
  fi
else
  warn "systemctl not found — skipping service setup."
  info "To run manually: cd $INSTALL_DIR && npm start"
fi

exec 3<&-

# ── Done ──────────────────────────────────────────────────────────────────────
header "Done"
echo ""
echo -e "AgentForge is installed at ${BOLD}$INSTALL_DIR${NC}"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status agentforge.service    # Check status"
echo "  sudo systemctl restart agentforge.service   # Restart after .env changes"
echo "  sudo journalctl -u agentforge.service -f    # Follow logs"
echo "  $INSTALL_DIR/install-service.sh             # (Re)install systemd service"
echo ""
