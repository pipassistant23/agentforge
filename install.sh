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

# ── Banner ────────────────────────────────────────────────────────────────────
cat << 'BANNER'

 █████╗  ██████╗ ███████╗███╗   ██╗████████╗███████╗ ██████╗ ██████╗  ██████╗ ███████╗
██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   █████╗  ██║   ██║██████╔╝██║  ███╗█████╗  
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  
██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝

BANNER

# ── Prereq checks ─────────────────────────────────────────────────────────────

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
    read -u 3 -r -s -p "$(echo -e "${BOLD}Telegram bot token${NC} (from @BotFather): ")" TG_TOKEN
    echo ""
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
      read -u 3 -r -s -p "$(echo -e "${BOLD}Claude Code OAuth token${NC}: ")" OAUTH_TOKEN
      echo ""
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
      read -u 3 -r -s -p "$(echo -e "${BOLD}API key / token${NC}: ")" CUSTOM_TOKEN
      echo ""
      [[ -n "$CUSTOM_TOKEN" ]] && break
      warn "API key is required."
    done
    read -u 3 -r -p "$(echo -e "${BOLD}Model name${NC} (e.g. anthropic/claude-sonnet-4-5, default: claude-sonnet-4-5-20250929): ")" CUSTOM_MODEL
    CUSTOM_MODEL="${CUSTOM_MODEL:-claude-sonnet-4-5-20250929}"
  else
    while true; do
      read -u 3 -r -s -p "$(echo -e "${BOLD}Anthropic API key${NC} (sk-ant-...): ")" ANTHROPIC_KEY
      echo ""
      [[ -n "$ANTHROPIC_KEY" ]] && break
      warn "API key is required."
    done
  fi

  # Optional: assistant name
  echo ""
  read -u 3 -r -p "$(echo -e "Assistant name [AgentForge]: ")" ASSISTANT_NAME
  ASSISTANT_NAME="${ASSISTANT_NAME:-AgentForge}"

  # Write .env — umask 077 ensures the file is created 600 from the start,
  # with no window where it is world-readable before chmod runs.
  (
    umask 077
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
  )
  success ".env written and locked to 600"
fi

# ── Systemd service ───────────────────────────────────────────────────────────
header "Systemd service"

if command -v systemctl &>/dev/null; then
  read -u 3 -r -p "$(echo -e "Install as a systemd service? [Y/n] ")" INSTALL_SVC
  if [[ ! "$INSTALL_SVC" =~ ^[Nn]$ ]]; then
    cd "$INSTALL_DIR"

    NODE_PATH=$(which node)
    NODE_BIN_DIR=$(dirname "$NODE_PATH")
    SERVICE_FILE="/tmp/agentforge.service"

    cp agentforge.service.template "$SERVICE_FILE"
    sed -i "s|{{USER}}|$USER|g"             "$SERVICE_FILE"
    sed -i "s|{{WORKING_DIR}}|$INSTALL_DIR|g" "$SERVICE_FILE"
    sed -i "s|{{NODE_PATH}}|$NODE_PATH|g"   "$SERVICE_FILE"
    sed -i "s|{{NODE_BIN_DIR}}|$NODE_BIN_DIR|g" "$SERVICE_FILE"

    sudo cp "$SERVICE_FILE" /etc/systemd/system/agentforge.service
    sudo systemctl daemon-reload
    rm "$SERVICE_FILE"
    success "Service file installed"

    sudo systemctl enable --now agentforge.service
    success "Service enabled and started"

    echo ""
    sudo systemctl status agentforge.service --no-pager || true

    # ── Register your Telegram chat ──────────────────────────────────────────
    echo ""
    header "Register your Telegram chat"
    echo ""
    echo "While AgentForge starts up, register your chat:"
    echo "  1. Open Telegram and find your bot"
    echo "  2. Send it:  /chatid"
    echo "  3. Copy the Chat ID from the reply (e.g. tg:123456789)"
    echo ""
    read -u 3 -r -p "$(echo -e "Paste Chat ID here (or Enter to skip): ")" CHAT_ID
    echo ""

    if [[ -n "$CHAT_ID" ]]; then
      CHAT_ID_NUM="${CHAT_ID#tg:}"
      if [[ "$CHAT_ID_NUM" =~ ^-?[0-9]+$ ]]; then
        CHAT_JID="tg:$CHAT_ID_NUM"
        DB_PATH="$INSTALL_DIR/store/messages.db"
        NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

        # Wait for the service to create the database (up to 15s)
        if [ ! -f "$DB_PATH" ]; then
          info "Waiting for database to initialise..."
          for _i in $(seq 1 15); do
            sleep 1
            [ -f "$DB_PATH" ] && break
          done
        fi

        if [ -f "$DB_PATH" ]; then
          mkdir -p "$INSTALL_DIR/groups/main/logs"
          sudo systemctl stop agentforge.service

          if command -v sqlite3 &>/dev/null; then
            sqlite3 "$DB_PATH" \
              "INSERT OR REPLACE INTO registered_groups
               (jid, name, folder, trigger_pattern, added_at, agent_config, requires_trigger)
               VALUES ('$CHAT_JID', 'Main', 'main', '', '$NOW', NULL, 1);"
          else
            # Fallback: use the bundled better-sqlite3 via node
            _TMPSCRIPT=$(mktemp /tmp/af-register-XXXXXX.cjs)
            cat > "$_TMPSCRIPT" << 'REGJS'
const Database = require('better-sqlite3');
const db = new Database(process.argv[2]);
db.prepare(
  "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, agent_config, requires_trigger) VALUES (?, ?, ?, ?, ?, ?, ?)"
).run(process.argv[3], 'Main', 'main', '', process.argv[4], null, 1);
db.close();
REGJS
            (NODE_PATH="$INSTALL_DIR/node_modules" node "$_TMPSCRIPT" "$DB_PATH" "$CHAT_JID" "$NOW")
            rm -f "$_TMPSCRIPT"
          fi

          # Seed BOOTSTRAP.md into the main group so the agent has it for the first conversation
          if [ -f "$INSTALL_DIR/groups/global/BOOTSTRAP.md" ] && [ ! -f "$INSTALL_DIR/groups/main/BOOTSTRAP.md" ]; then
            cp "$INSTALL_DIR/groups/global/BOOTSTRAP.md" "$INSTALL_DIR/groups/main/BOOTSTRAP.md"
          fi

          sudo systemctl start agentforge.service
          success "Registered $CHAT_JID — you can now message the bot!"
        else
          warn "Database not found after waiting — skipping registration."
          warn "Check service logs: sudo journalctl -u agentforge.service -n 50"
        fi
      else
        warn "Chat ID '$CHAT_ID' doesn't look valid — skipping."
        info "Re-run /chatid in Telegram and paste the full reply (e.g. tg:123456789)."
      fi
    else
      info "Skipped. You can register later — see the README for instructions."
    fi
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
echo "To uninstall:"
echo "  curl -fsSL https://raw.githubusercontent.com/pipassistant23/agentforge/main/uninstall.sh | bash"
echo ""
