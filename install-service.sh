#!/bin/bash
set -e

echo "🔧 AgentForge Systemd Service Installer"
echo "======================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Detect current directory
WORKING_DIR=$(pwd)
USER=$(whoami)

# Detect Node.js path
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
  echo -e "${RED}❌ Node.js not found in PATH${NC}"
  exit 1
fi

NODE_BIN_DIR=$(dirname "$NODE_PATH")

echo "Detected configuration:"
echo "  User: $USER"
echo "  Working directory: $WORKING_DIR"
echo "  Node.js path: $NODE_PATH"
echo "  Node.js bin directory: $NODE_BIN_DIR"
echo ""

# Check if .env exists
if [ ! -f "$WORKING_DIR/.env" ]; then
  echo -e "${YELLOW}⚠️  Warning: .env file not found${NC}"
  echo "   The service needs a .env file with your credentials."
  echo "   Copy .env.example to .env and configure it before starting the service."
  echo ""
else
  chmod 600 "$WORKING_DIR/.env"
  echo -e "${GREEN}✅ .env permissions set to 600 (owner read/write only)${NC}"
  echo ""
fi

# Check if dist/index.js exists
if [ ! -f "$WORKING_DIR/dist/index.js" ]; then
  echo -e "${RED}❌ dist/index.js not found${NC}"
  echo "   Run 'npm run build' first to compile the TypeScript code."
  exit 1
fi

# Generate service file from template
echo "📝 Generating service file..."
SERVICE_FILE="/tmp/agentforge.service"
cp agentforge.service.template "$SERVICE_FILE"

# Replace placeholders
sed -i "s|{{USER}}|$USER|g" "$SERVICE_FILE"
sed -i "s|{{WORKING_DIR}}|$WORKING_DIR|g" "$SERVICE_FILE"
sed -i "s|{{NODE_PATH}}|$NODE_PATH|g" "$SERVICE_FILE"
sed -i "s|{{NODE_BIN_DIR}}|$NODE_BIN_DIR|g" "$SERVICE_FILE"

echo -e "${GREEN}✅ Service file generated${NC}"
echo ""

# Show the generated file
echo "Generated service file:"
echo "======================="
cat "$SERVICE_FILE"
echo "======================="
echo ""

# Ask for confirmation
read -p "Install this service to /etc/systemd/system/agentforge.service? [y/N] " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Installation cancelled."
  rm "$SERVICE_FILE"
  exit 0
fi

# Install service
echo "📦 Installing service..."
sudo cp "$SERVICE_FILE" /etc/systemd/system/agentforge.service
sudo systemctl daemon-reload
rm "$SERVICE_FILE"

echo -e "${GREEN}✅ Service installed${NC}"
echo ""

# Ask to enable and start
read -p "Enable and start the service now? [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  sudo systemctl enable agentforge.service
  sudo systemctl start agentforge.service

  echo ""
  echo -e "${GREEN}✅ Service enabled and started${NC}"
  echo ""
  echo "Service status:"
  sudo systemctl status agentforge.service --no-pager
else
  echo ""
  echo "Service installed but not enabled."
  echo ""
  echo "To enable and start later:"
  echo "  sudo systemctl enable agentforge.service"
  echo "  sudo systemctl start agentforge.service"
fi

echo ""
echo "📖 Useful commands:"
echo "   sudo systemctl status agentforge.service    # Check status"
echo "   sudo systemctl restart agentforge.service   # Restart"
echo "   sudo systemctl stop agentforge.service      # Stop"
echo "   sudo journalctl -u agentforge.service -f    # Follow logs"
echo ""
