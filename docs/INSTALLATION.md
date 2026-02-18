# Installation Guide

This guide walks you through setting up AgentForge from scratch on a Linux system.

## System Requirements

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| OS | Linux | Any modern distribution |
| Node.js | 20.x or later | Check with `node --version` |
| npm | 9.x or later | Included with Node.js |
| Disk space | 500 MB | For dependencies, database, and logs |
| RAM | 512 MB | More recommended if running multiple concurrent groups |

AgentForge does not use containers. All agents run as baremetal Node.js processes on the host.

## Prerequisites

### 1. Install Node.js

If Node.js is not already installed, install it via your package manager or [nvm](https://github.com/nvm-sh/nvm):

```bash
# Using nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Verify
node --version   # Should print v20.x.x or later
npm --version
```

### 2. Install Claude Code

AgentForge uses the Claude Agent SDK, which is distributed as part of [Claude Code](https://claude.ai/download). Install it on the host machine.

### 3. Obtain a Telegram Bot Token

1. Open Telegram and start a conversation with [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token — it looks like `123456789:ABCDefGhIjKlmNoPQRsTUVwxyz`

### 4. Obtain an Anthropic API Key

Either:
- **ANTHROPIC_API_KEY**: Get an API key from [console.anthropic.com](https://console.anthropic.com)
- **CLAUDE_CODE_OAUTH_TOKEN**: Use the OAuth token from your Claude Code installation (check `~/.claude/.credentials.json`)

---

## Installation Steps

### Step 1: Clone the Repository

```bash
git clone https://github.com/your-username/agentforge.git
cd agentforge
```

Or if you already have the source:

```bash
cd /path/to/agentforge
```

### Step 2: Install Dependencies

```bash
npm install
```

This installs the main orchestrator dependencies. The agent runner has its own dependencies:

```bash
cd agent-runner-src
npm install
cd ..
```

### Step 3: Build the TypeScript Source

Build the main orchestrator:

```bash
npm run build
```

Build the agent runner:

```bash
cd agent-runner-src
npm run build
cd ..
```

After building, verify the output exists:

```bash
ls dist/index.js               # Main orchestrator
ls agent/agent-runner/dist/index.js   # Agent runner
```

### Step 4: Create the Environment File

Create a `.env` file in the project root:

```bash
cp .env.example .env   # If an example exists
# or create it from scratch:
nano .env
```

At minimum, the `.env` file must contain:

```ini
# Required: Telegram bot token
TELEGRAM_BOT_TOKEN=your_bot_token_here

# Required: One of these two
ANTHROPIC_API_KEY=your_anthropic_api_key
# CLAUDE_CODE_OAUTH_TOKEN=your_claude_oauth_token

# Optional: Your assistant's name (default: Andy)
ASSISTANT_NAME=YourAgent
```

Do not commit this file to version control. It contains secrets.

### Step 5: Create Required Directories

AgentForge creates most directories automatically, but the main group workspace must exist:

```bash
mkdir -p groups/main
mkdir -p groups/global
mkdir -p data/ipc
mkdir -p store
```

### Step 6: Set Up the Global Agent Instructions

The file `groups/global/CLAUDE.md` contains instructions shared across all agent groups. A default version is included in the repository. Review it and customize as needed:

```bash
nano groups/global/CLAUDE.md
```

If it contains template variables like `{{ASSISTANT_NAME}}`, they are substituted automatically at runtime using the value from your `.env` file.

---

## Systemd Service Setup

Running AgentForge as a systemd service ensures it starts on boot and restarts on failure.

### Step 1: Create the Service File

Create `/etc/systemd/system/agentforge.service`:

```bash
sudo nano /etc/systemd/system/agentforge.service
```

Paste the following, replacing the placeholders:

```ini
[Unit]
Description=AgentForge - Personal Claude Assistant
After=network.target

[Service]
Type=simple
User=your_username
WorkingDirectory=/absolute/path/to/agentforge
EnvironmentFile=/absolute/path/to/agentforge/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Make sure:
- `User=` is the Linux user that owns the agentforge directory
- `WorkingDirectory=` is the absolute path to the agentforge directory
- `EnvironmentFile=` points to the `.env` file (also absolute path)
- The path to `node` is correct — check with `which node`

### Step 2: Enable and Start the Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable agentforge.service
sudo systemctl start agentforge.service
```

### Step 3: Verify It Is Running

```bash
sudo systemctl status agentforge.service
```

You should see `Active: active (running)`. To follow live logs:

```bash
sudo journalctl -u agentforge.service -f
```

---

## First-Time Setup: Registering a Group

After starting the service, you need to register at least one Telegram chat so the agent will respond to messages from it.

### Step 1: Get Your Chat ID

In Telegram, send `/chatid` to your bot. It will reply with something like:

```
Chat ID: tg:-1001234567890
Name: My Group
Type: group
```

Copy the `tg:...` value — this is the JID used for registration.

### Step 2: Register the Main Group

Add the chat to the database as the "main" group by inserting a record directly. The main group is special — it has full access to manage other groups and schedule tasks.

The simplest way is to add it directly to the SQLite database:

```bash
sqlite3 store/messages.db "
INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
VALUES ('tg:YOUR_CHAT_ID', 'My Chat', 'main', '@YourAgent', datetime('now'), 0);
"
```

Replace:
- `tg:YOUR_CHAT_ID` with the JID from `/chatid`
- `'My Chat'` with a display name
- `@YourAgent` with your trigger word (must match `ASSISTANT_NAME`)
- `requires_trigger` is `0` for solo/DM chats (always responds) or `1` for group chats (responds only when triggered)

Restart the service to load the new registration:

```bash
sudo systemctl restart agentforge.service
```

### Step 3: Test the Bot

Send a message in the registered chat. For the main group (when `requires_trigger=0`), any message triggers a response. For other groups, prefix with `@YourAgent`.

---

## Verification Steps

After setup, run these checks:

```bash
# 1. Service is active
sudo systemctl is-active agentforge.service

# 2. No errors in logs
sudo journalctl -u agentforge.service -n 50 --no-pager

# 3. Database was created
ls -lh store/messages.db

# 4. Built files are fresh (compare timestamps)
ls -lh dist/index.js
sudo systemctl status agentforge.service | grep "Active:"

# 5. Registered groups exist
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups;"
```

---

## Optional: Agent Swarm Bot Pool

To enable Agent Swarms (where subagents get unique Telegram bot identities), create additional Telegram bots via BotFather and add their tokens to `.env`:

```ini
TELEGRAM_BOT_POOL=token1,token2,token3
```

Each pool bot is send-only (no polling). They are renamed dynamically to match subagent role names. See [CONFIGURATION.md](CONFIGURATION.md) for details.

---

## Updating AgentForge

After pulling new code:

```bash
git pull
npm install           # In case dependencies changed
npm run build

cd agent-runner-src
npm install
npm run build
cd ..

sudo systemctl restart agentforge.service
```

Always restart the service after rebuilding — the running process does not auto-reload.
