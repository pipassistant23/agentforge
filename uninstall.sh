#!/usr/bin/env bash
# AgentForge Uninstaller
# Usage: curl -fsSL https://raw.githubusercontent.com/pipassistant23/agentforge/main/uninstall.sh | bash
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}▶${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✗${NC} $*" >&2; }

# ── Banner ────────────────────────────────────────────────────────────────────
cat << 'BANNER'

 /$$$                                   /$      /$$$$
| $__  $                               | $     | $_____/
| $  \ $  /$$$   /$$$ /$$$  /$$$    | $      /$$$   /$$$   /$$$   /$$$
| $$$$/| $__  $/$__  $| $__  $|_  $_/   | $$$  /$__  $/$__  $/$__  $/$__  $
| $__  $| $  \ $| $$$$| $  \ $  | $     | $__/ | $  \ $| $  \__/| $  \ $| $$$$
| $  | $| $  | $| $_____/| $  | $  | $ /$ | $    | $  | $| $      | $  | $| $_____/
| $  | $|  $$$$|  $$$$| $  | $  |  $$/ | $    |  $$$/  | $      |  $$$$|  $$$$
|__/  |__/ \____  $\_______/|__/  |__/  \___/  |__/   \______/ |__/      \____  $\_______/
            /$  \ $                                                          /$  \ $
           |  $$$/                                                          |  $$$/
            \______/                                                         \______/

BANNER

echo -e "${BOLD}Uninstaller${NC}"
echo "──────────────────────────────────────────"
echo ""

# ── Read from TTY (works when piped through bash) ─────────────────────────────
exec 3</dev/tty

# ── Detect install directory from service file ────────────────────────────────
SERVICE_FILE="/etc/systemd/system/agentforge.service"
INSTALL_DIR=""

if [ -f "$SERVICE_FILE" ]; then
  INSTALL_DIR=$(grep -oP '(?<=WorkingDirectory=).*' "$SERVICE_FILE" || true)
fi

if [ -n "$INSTALL_DIR" ]; then
  info "Detected install directory: $INSTALL_DIR"
else
  warn "Could not detect install directory from service file."
  read -u 3 -r -p "$(echo -e "Enter install directory to remove (or leave blank to skip): ")" INSTALL_DIR
fi

echo ""

# ── Stop and remove service ───────────────────────────────────────────────────
if [ -f "$SERVICE_FILE" ]; then
  info "Stopping and disabling agentforge.service..."
  sudo systemctl stop agentforge.service 2>/dev/null || true
  sudo systemctl disable agentforge.service 2>/dev/null || true
  sudo rm "$SERVICE_FILE"
  sudo systemctl daemon-reload
  success "Service removed"
else
  warn "No systemd service file found at $SERVICE_FILE — skipping"
fi

# ── Remove install directory ──────────────────────────────────────────────────
if [ -n "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR" ]; then
  echo ""
  read -u 3 -r -p "$(echo -e "Remove install directory ${BOLD}$INSTALL_DIR${NC}? [Y/n] ")" CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Nn]$ ]]; then
    rm -rf "$INSTALL_DIR"
    success "Removed $INSTALL_DIR"
  else
    info "Kept $INSTALL_DIR"
  fi
fi

# ── Remove /data ──────────────────────────────────────────────────────────────
if [ -d /data ]; then
  echo ""
  warn "/data contains agent memory, conversation logs, and the database."
  read -u 3 -r -p "$(echo -e "Remove ${BOLD}/data${NC} (all agent data)? [y/N] ")" CONFIRM_DATA
  if [[ "$CONFIRM_DATA" =~ ^[Yy]$ ]]; then
    sudo rm -rf /data
    success "Removed /data"
  else
    info "Kept /data — your agent data is preserved"
  fi
fi

exec 3<&-

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}✓${NC} AgentForge uninstalled."
echo ""
