<div align="center">
  <img src="assets/logo.png" alt="AgentForge Logo" width="400">

  <br/>

  ![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)
  ![License](https://img.shields.io/badge/license-MIT-blue)
  ![Platform](https://img.shields.io/badge/platform-linux-lightgrey)
  ![Telegram](https://img.shields.io/badge/telegram-bot-blue?logo=telegram)
  ![Claude](https://img.shields.io/badge/Claude-AI-orange)
  ![Tokens](repo-tokens/badge.svg)

  <!-- token-count --><!-- /token-count -->

  # AgentForge

  Personal Claude assistant running on Linux via Telegram. Forked from [NanoClaw](https://github.com/gavrielc/nanoclaw) with simplified architecture: **Telegram-only, baremetal-only**.

  ---

  > **⚠️ SECURITY DISCLAIMER**
  >
  > **AgentForge is NOT a secure fork of NanoClaw.** This fork was intentionally modified to give the AI agent **full root access** to a dedicated Linux server. The original NanoClaw container isolation has been removed.
  >
  > **This is designed for a single-user deployment on a dedicated machine where you want to see what an AI agent can do with unrestricted system access.**
  >
  > **USE AT YOUR OWN RISK.** Only run this if you:
  > - Have a dedicated server you're willing to let the agent control
  > - Understand the security implications of giving an AI full system access
  > - Are comfortable with the agent potentially modifying/deleting files, installing software, changing configurations, etc.
  >
  > **Do NOT run this on:**
  > - A production server
  > - A machine with sensitive data
  > - A shared system
  > - Your primary workstation
  >
  > If you want the secure, containerized version, use the original [NanoClaw](https://github.com/gavrielc/nanoclaw) instead.

  ---
</div>

## What is AgentForge?

AgentForge is a personal AI assistant that:
- Runs Claude Agent SDK as baremetal Node.js processes (no containers)
- Connects only to Telegram
- Isolates each chat group with dedicated workspaces
- Supports Agent Swarms via bot pools (subagents get unique bot identities)
- Runs as a systemd service on Linux

## Quick Start

**Requirements:**
- Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- Telegram bot token

**Setup:**

1. Clone and install:
```bash
cd /path/to/agentforge
npm install
npm run build
```

2. Configure `.env`:
```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_BOT_POOL=pool_token1,pool_token2  # Optional: for agent swarms
ANTHROPIC_API_KEY=your_key_here
```

3. Set up systemd service (example at `/etc/systemd/system/agentforge.service`):
```ini
[Unit]
Description=AgentForge - Personal Claude Assistant
After=network.target

[Service]
Type=simple
User=your_username
WorkingDirectory=/path/to/agentforge
EnvironmentFile=/path/to/agentforge/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

4. Start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable agentforge.service
sudo systemctl start agentforge.service
sudo journalctl -u agentforge.service -f  # Watch logs
```

## Architecture

```
Telegram (Grammy) --> SQLite --> Polling loop --> Baremetal agent (Claude SDK) --> Response
```

**Single Node.js process:**
- `src/index.ts` - Main orchestrator
- `src/channels/telegram.ts` - Telegram bot with pool support
- `src/bare-metal-runner.ts` - Spawns agents as Node processes
- `src/ipc.ts` - File-based IPC for bidirectional communication

**Per-group isolation:**
- Each chat gets `/data/groups/{groupFolder}/` directory
- Each agent runs in its own process with environment-based workspace paths
- IPC directory: `/data/ipc/{groupFolder}/`
- Claude memory: `groups/{name}/CLAUDE.md`

## Features

- ✅ **Telegram-only** - Simplified from multi-channel
- ✅ **Agent Swarms** - Bot pool assigns unique identities to subagents
- ✅ **Baremetal execution** - Fast startup (~100-200ms vs 3-5s containers)
- ✅ **Per-group isolation** - Dedicated workspaces, isolated memory
- ✅ **Systemd service** - Runs persistently, auto-restarts
- ✅ **File-based IPC** - Bidirectional communication between orchestrator and agents

## Development

```bash
npm run build        # Compile TypeScript to dist/
npm test            # Run tests
npm run dev         # Run directly with tsx (no build)
```

**Important:** Always restart the service after building - the running process doesn't auto-reload!

Check process start time vs dist build time to verify you're running fresh code:
```bash
sudo systemctl status agentforge.service  # Check start time
ls -lh dist/index.js               # Check build time
```

## Usage

Talk to your bot in Telegram using the trigger word (default: `@Andy`):

```
@Andy what's the weather?
@Andy summarize this article: https://...
@Andy schedule a reminder for tomorrow at 9am
```

From your main chat (1:1 with the bot), you can manage groups and tasks:
```
@Andy list all scheduled tasks
@Andy pause the morning briefing task
```

## Scheduled Tasks

Create recurring tasks that run Claude and message you back:

```
@Andy every weekday at 9am, check my calendar and send me a summary
@Andy every Monday at 8am, compile AI news from Hacker News and message me
```

## Agent Swarms

If you configure `TELEGRAM_BOT_POOL` in your `.env`, AgentForge supports Agent Teams/Swarms:
- Each subagent gets assigned a unique bot from the pool
- Bots are renamed to match the subagent's role (e.g., "Marine Biologist", "Physicist")
- Users see which agent is speaking in the chat

Example:
```
You: @Andy I need help researching ocean life and physics

Andy spawns:
- Subagent "Marine Biologist" → assigned bot token #1 → renamed to "Marine Biologist"
- Subagent "Physicist" → assigned bot token #2 → renamed to "Physicist"

Chat shows messages from different bots with different names!
```

## File Structure

```
agentforge/
├── src/                        # TypeScript source
│   ├── index.ts               # Main orchestrator
│   ├── channels/
│   │   └── telegram.ts        # Telegram bot + pool
│   ├── bare-metal-runner.ts   # Agent spawner
│   ├── ipc.ts                 # IPC watcher
│   ├── router.ts              # Message routing
│   ├── task-scheduler.ts      # Cron/scheduled tasks
│   └── db.ts                  # SQLite operations
├── dist/                       # Compiled JavaScript
├── groups/                     # Per-group workspaces
│   ├── global/                # Shared across all groups
│   │   └── CLAUDE.md          # Agent Teams instructions
│   └── {groupName}/           # Per-group isolation
│       ├── CLAUDE.md          # Group-specific memory
│       └── logs/              # Agent execution logs
├── data/
│   ├── ipc/                   # File-based IPC
│   │   └── {groupFolder}/
│   │       ├── input/         # Inbound messages
│   │       ├── messages/      # Outbound messages
│   │       └── tasks/         # Task operations
│   └── sessions/              # Claude sessions per group
├── agent-runner-src/           # Agent runtime source code
│   ├── src/                   # TypeScript source
│   └── dist/                  # Compiled agent runtime
├── skills/                     # Claude Code skills
└── store/                      # SQLite database

```

## Troubleshooting

**Service won't start:**
```bash
sudo journalctl -u agentforge.service -n 50  # Check last 50 log lines
```

**Agent won't respond:**
- Check `TELEGRAM_BOT_TOKEN` is set
- Check `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set
- Check logs: `sudo journalctl -u agentforge.service -f`

**Build errors:**
```bash
npm install          # Reinstall dependencies
npm run build        # Rebuild
```

**Process still running old code:**
```bash
sudo systemctl restart agentforge.service
ps aux | grep "node.*agentforge"  # Verify only one instance
```

## Differences from NanoClaw

AgentForge is a simplified fork of NanoClaw with:
- ❌ **No WhatsApp** - Removed Baileys, QR auth, 86 fewer npm packages
- ❌ **No containers** - Removed Apple Container/Docker, ~1,500 lines of code deleted
- ✅ **Telegram-only** - Single messaging platform
- ✅ **Baremetal-only** - Node.js processes, no containerization
- ✅ **Linux-focused** - Systemd service, optimized for Linux servers

## License

MIT (inherited from NanoClaw)

## Credits

Forked from [NanoClaw](https://github.com/gavrielc/nanoclaw) by [@gavrielc](https://github.com/gavrielc)
