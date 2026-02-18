#!/bin/bash
set -e

echo "🚀 AgentForge Setup"
echo "=================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check Node.js version
echo "📦 Checking Node.js version..."
NODE_VERSION=$(node --version 2>/dev/null || echo "not found")
if [[ "$NODE_VERSION" == "not found" ]]; then
  echo "❌ Node.js not found. Please install Node.js 20+ first."
  exit 1
fi

MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'.' -f1 | sed 's/v//')
if [ "$MAJOR_VERSION" -lt 20 ]; then
  echo "❌ Node.js $NODE_VERSION found, but version 20+ is required."
  exit 1
fi

echo -e "${GREEN}✅ Node.js $NODE_VERSION${NC}"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
echo "   - Installing orchestrator dependencies..."
npm install

echo "   - Installing agent-runner dependencies..."
cd agent-runner-src
npm install
cd ..

echo -e "${GREEN}✅ Dependencies installed${NC}"
echo ""

# Build both projects
echo "🔨 Building TypeScript..."
echo "   - Building orchestrator..."
npm run build

echo -e "${GREEN}✅ Build complete${NC}"
echo ""

# Create required directories
echo "📁 Creating required directories..."

# Create /data directory structure with proper permissions
if [ ! -d "/data" ]; then
  echo "   Creating /data directory..."
  sudo mkdir -p /data/qmd
  sudo chown -R $USER:$USER /data
  echo -e "${GREEN}✅ Created /data (owned by $USER)${NC}"
elif [ ! -w "/data" ]; then
  echo -e "${YELLOW}⚠️  /data exists but you don't have write permission${NC}"
  echo "   Fixing permissions..."
  sudo chown -R $USER:$USER /data
  echo -e "${GREEN}✅ Fixed /data permissions${NC}"
else
  echo -e "${GREEN}✅ /data directory exists with correct permissions${NC}"
fi

# Create /data/qmd subdirectory
mkdir -p /data/qmd
echo -e "${GREEN}✅ Created /data/qmd${NC}"

# Create store directory for SQLite database
mkdir -p store
echo -e "${GREEN}✅ Created store/ directory${NC}"

echo ""
echo "🔧 Next Steps:"
echo "=============="
echo ""
echo "1. Create your .env file:"
echo "   cp .env.example .env"
echo "   # Edit .env with your API keys and Telegram bot token"
echo ""
echo "2. Set up systemd service (optional but recommended):"
echo "   ./install-service.sh"
echo ""
echo "3. Or run directly for testing:"
echo "   npm start"
echo ""
echo "📖 For detailed setup instructions, see docs/INSTALLATION.md"
echo ""
