<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.png">
    <img src="assets/logo-light.png" alt="AgentForge Logo" width="400">
  </picture>

  <br/>

[![CI](https://github.com/pipassistant23/agentforge/actions/workflows/ci.yml/badge.svg)](https://github.com/pipassistant23/agentforge/actions/workflows/ci.yml)
[![Security Scan](https://github.com/pipassistant23/agentforge/actions/workflows/security-scan.yml/badge.svg)](https://github.com/pipassistant23/agentforge/actions/workflows/security-scan.yml)
![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-linux-lightgrey)
![Telegram](https://img.shields.io/badge/telegram-bot-blue?logo=telegram)
![Claude](https://img.shields.io/badge/Claude-AI-orange)
![Tokens](repo-tokens/badge.svg)

  <!-- token-count --><a href="https://github.com/pipassistant23/agentforge/tree/main/repo-tokens">42.3k tokens · 21% of context window</a><!-- /token-count -->

# AgentForge

**Self-hosted Claude agents on Linux — persistent, multi-group, and extensible via Telegram.**

A personal AI assistant platform that runs the Anthropic Claude Agent SDK as baremetal Node.js processes, managed by systemd, with per-group memory isolation and Agent Swarm support.

**Forked from [NanoClaw](https://github.com/gavrielc/nanoclaw).** AgentForge replaces container isolation with baremetal execution, targeting dedicated servers where full system access is the goal.

  <br/>

[Quick Start](#quick-start) · [Documentation](#documentation) · [Architecture](#architecture) · [Contributing](#contributing)

</div>

---

## What is AgentForge?

AgentForge turns a Linux server into a persistent, multi-tenant Claude AI assistant accessible through Telegram. Each Telegram group gets its own isolated workspace, persistent memory, and dedicated agent process — conversations stay separate and context survives restarts.

The project is intentionally minimal. Its philosophy: **capabilities belong in skills** (markdown instruction files that extend your fork), not in source code. The core does one thing: route Telegram messages to Claude agents and keep them running reliably.

```
User → Telegram → AgentForge (SQLite + message loop) → Claude Agent SDK → Response → Telegram
```

---

## ✨ Key Features

### Core Capabilities

- **⚡ Baremetal execution** — Agents start in ~100-200ms as native Node.js processes (no container overhead)
- **🔒 Per-group isolation** — Dedicated filesystem workspace and memory file per chat; context never bleeds between groups
- **💾 Persistent sessions** — Conversations resume across restarts; full Claude Agent SDK session system
- **🤝 Agent Swarms** — Spawn coordinated teams of sub-agents with unique Telegram bot identities
- **⏰ Scheduled tasks** — Natural-language task scheduling (cron, interval, one-time) with per-group authorization
- **📁 File operations** — Read/write files in group workspaces, persist data across conversations

### Infrastructure

- **🔄 Systemd service** — Runs persistently as managed system service; auto-restarts on failure
- **🔐 Secure secrets** — Delivered via stdin; not in child process env or written to disk
- **📡 File-based IPC** — Crash-safe bidirectional communication using atomic file writes
- **🚀 Follow-up messages** — New messages pipe into running sessions without spawning new processes
- **🎯 Skill-based extensibility** — Add capabilities via `.claude/skills/` without modifying source
- **🛡️ Security automation** — Weekly Dependabot updates, CodeQL analysis, and `npm audit` scans

---

## 🔐 Security Model

AgentForge is designed for **dedicated servers** where the operator trusts themselves. It does not sandbox agents.

| Feature                 | AgentForge                                   | [NanoClaw](https://github.com/gavrielc/nanoclaw) |
| ----------------------- | -------------------------------------------- | ------------------------------------------------ |
| Container isolation     | ❌ Removed by design                         | ✅ Yes                                           |
| Intended environment    | Dedicated / single-operator                  | General / multi-tenant                           |
| Agent filesystem access | Full (baremetal)                             | Sandboxed                                        |
| Secrets delivery        | Via stdin (not in child process env or disk) | Container environment                            |

**Security guarantees:**

- Secrets never written to disk or inherited by child processes
- Agent processes receive sanitized environment (explicit allowlist)
- Bash commands auto-unset API keys before execution
- Per-group authorization for IPC operations (messages, tasks, registration)

See [Architecture](#architecture) for complete security model details.

---

## 🚀 Quick Start

Get AgentForge running in about five minutes.

### Prerequisites

| Requirement                                      | Notes                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| 🐧 Linux (Ubuntu 22.04+)                         | Any modern distribution                                                   |
| 📦 Node.js 20+                                   | Check with `node --version`                                               |
| 🤖 [Claude Code CLI](https://claude.ai/download) | Installed and authenticated on the host                                   |
| 💬 Telegram bot token                            | From [@BotFather](https://t.me/BotFather) — free                          |
| 🔑 AI Provider API access                        | Anthropic API key, Claude Code OAuth token, or OpenAI-compatible provider |

### 1. Clone and run setup

```bash
git clone https://github.com/pipassistant23/agentforge.git
cd agentforge
./setup.sh
```

The setup script will:
- Install all dependencies (orchestrator + agent-runner)
- Build both TypeScript projects
- Create required directories (`/data/qmd`, `store/`)
- Set proper permissions

### 2. Configure your environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

**Minimum required variables:**

```ini
# Telegram
TELEGRAM_BOT_TOKEN=123456789:AABBccDDeeFFggHH...

# Authentication — use ONE of these options:

# Option 1: Anthropic API (pay-per-use)
ANTHROPIC_API_KEY=sk-ant-api03-...

# Option 2: Claude Code OAuth (subscription)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Option 3: Custom Anthropic-compatible provider
ANTHROPIC_AUTH_TOKEN=your-api-key
ANTHROPIC_BASE_URL=https://your-provider.example.com
ANTHROPIC_MODEL=claude-sonnet-4-20250514  # or your model identifier
```

**Optional settings:**

```ini
# Change the trigger name (default: Andy)
ASSISTANT_NAME=MyBot

# Additional bots for Agent Swarm support
TELEGRAM_BOT_POOL=token1,token2,token3
```

### 3. Install as a systemd service

Use the automated installer:

```bash
./install-service.sh
```

The script will:
- Auto-detect your Node.js path
- Generate a service file with correct paths
- Install to `/etc/systemd/system/agentforge.service`
- Optionally enable and start the service

**Or manually create the service:**

```bash
sudo nano /etc/systemd/system/agentforge.service
```

Paste the following, substituting your values:

```ini
[Unit]
Description=AgentForge - Personal Claude Assistant
After=network.target

[Service]
Type=simple
User=your_username
WorkingDirectory=/home/your_username/agentforge
EnvironmentFile=/home/your_username/agentforge/.env
Environment="PATH=/path/to/node/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/path/to/node dist/index.js
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Important:** Replace `/path/to/node` with your actual Node.js path (`which node`). If using nvm, use the full path like `/home/user/.nvm/versions/node/v20.20.0/bin/node`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable agentforge.service
sudo systemctl start agentforge.service
sudo systemctl status agentforge.service   # Should show: active (running)
```

### 4. Register your first group

Send `/chatid` to your bot in Telegram. It replies with something like:

```
Chat ID: tg:-1001234567890
Name: My Chat
Type: private
```

Register that chat as the main group:

```bash
sqlite3 store/messages.db "
INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
VALUES ('tg:-1001234567890', 'My Chat', 'main', '@YourAgent', datetime('now'), 0);
"
sudo systemctl restart agentforge.service
```

**⚠️ Important:** The chat ID must include the `tg:` prefix. This prefix identifies it as a Telegram chat.

### 5. Talk to your bot

Send any message to your registered chat. For the main group with `requires_trigger=0`, every message receives a response. For additional groups, prefix messages with the trigger word:

```
@YourAgent what's the weather like today?
@YourAgent help me write a bash script to monitor disk usage
@YourAgent summarize what we discussed this week
```

---

## ⚙️ Configuration

All configuration uses environment variables loaded from `.env`. Full reference in `src/config.ts`.

### Core Settings

| Variable             | Default | Description                                                                        |
| -------------------- | ------- | ---------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | —       | **Required.** Primary Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `ASSISTANT_NAME`     | `Andy`  | Trigger word — messages start with `@Name` (case-insensitive)                      |
| `TELEGRAM_BOT_POOL`  | —       | Comma-separated bot tokens for Agent Swarm sub-agent personas                      |

### Authentication (Choose One)

| Variable                             | Type            | Description                                  |
| ------------------------------------ | --------------- | -------------------------------------------- |
| `ANTHROPIC_API_KEY`                  | Pay-per-use     | Anthropic API key (`sk-ant-api03-...`)       |
| `CLAUDE_CODE_OAUTH_TOKEN`            | Subscription    | Claude Code OAuth token (`sk-ant-oat01-...`) |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` | Custom provider | OpenAI-compatible API endpoint               |

### Advanced Settings

| Variable                   | Default   | Description                                            |
| -------------------------- | --------- | ------------------------------------------------------ |
| `POLL_INTERVAL`            | `2000`    | Message poll interval (milliseconds)                   |
| `SCHEDULER_POLL_INTERVAL`  | `60000`   | Task scheduler check interval (milliseconds)           |
| `AGENT_TIMEOUT`            | `1800000` | Max agent runtime per invocation (30 min)              |
| `IDLE_TIMEOUT`             | `1800000` | How long to keep idle agent processes alive (30 min)   |
| `MAX_CONCURRENT_PROCESSES` | `5`       | Maximum simultaneous agent processes across all groups |
| `TZ`                       | System    | Timezone for cron expressions                          |

### Changing the assistant name

```ini
ASSISTANT_NAME=Aria
```

Messages now trigger on `@Aria ...` (case-insensitive). Restart the service after changing.

### Using custom API providers

AgentForge supports OpenAI-compatible API endpoints through the Claude Code CLI's provider configuration. This allows you to use alternative providers, self-hosted models, or proxy services.

**Configure via environment variables in `.env`:**

```ini
# Custom OpenAI-compatible endpoint
OPENAI_API_KEY=your-api-key-here
OPENAI_BASE_URL=https://your-provider.example.com/v1

# Model selection (optional, provider-dependent)
OPENAI_MODEL=gpt-4
```

**Note:** When using a custom provider:

- Remove or comment out `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`
- The provider must support the OpenAI Messages API format
- Model availability and capabilities depend on your provider
- Some Claude Code features may have limited support depending on the provider's API compatibility

After changing providers, restart the service:

```bash
sudo systemctl restart agentforge.service
```

### Registering additional groups

From your main chat, ask the agent directly:

```
@YourAgent register this group: tg:-9876543210 as "Team Chat"
```

Or insert directly into SQLite and restart. Set `requires_trigger=1` for group chats so the agent only responds when explicitly addressed.

---

## 💬 Usage

### Basic Conversation

```
@YourAgent what are the top Hacker News stories today?
@YourAgent explain the difference between TCP and UDP
@YourAgent help me draft a reply to this email: [paste email]
```

### File Operations

Read and write files in your group's workspace at `groups/{groupName}/`:

```
@YourAgent save these meeting notes to a file called meeting-2026-02-18.md
@YourAgent show me all files in my workspace
@YourAgent read back the notes from last week's meeting
```

### Scheduled Tasks

Natural language scheduling — tasks persist across restarts:

```
@YourAgent every weekday at 9am, check Hacker News and send me the top 5 AI stories
@YourAgent every Monday at 8am, remind me to review open pull requests
@YourAgent at 5pm today, send me a summary of what we discussed
```

**Managing tasks:**

```
@YourAgent list my scheduled tasks
@YourAgent pause task 3
@YourAgent cancel task 5
@YourAgent resume task 3
```

### Agent Swarms (Teams)

Configure `TELEGRAM_BOT_POOL` to spawn coordinated teams. Each sub-agent gets its own bot identity:

```
@YourAgent assemble a team: a marine biologist, a physicist, and a science writer
to collaborate on explaining bioluminescence to a general audience
```

The chat shows three distinct bots — "Marine Biologist," "Physicist," and "Science Writer" — posting independently and collaborating in real-time.

---

## 🏗️ Architecture

AgentForge is a **single Node.js orchestrator** with three concurrent polling loops.

```
                     ┌─────────────────────────────────────────┐
                     │        AgentForge (main process)         │
                     │                                          │
Telegram ───────────►│  TelegramChannel (grammy polling)        │
(users)              │       │                                  │
                     │       ▼                                  │
                     │  SQLite DB  ◄─── storeMessage()         │
                     │       │                                  │
                     │       ▼                                  │
                     │  Message Loop (2s poll)                  │
                     │       │                                  │
                     │       ▼                                  │
                     │  GroupQueue (per-group serialization)    │
                     │       │  max 5 concurrent processes      │
                     └───────┼──────────────────────────────────┘
                             │ spawn(node agent-runner-src/dist/index.js)
                             │ stdin: JSON config + secrets
                             │
                     ┌───────▼──────────────────────────────────┐
                     │      Agent Process (per invocation)       │
                     │                                           │
                     │  Claude Agent SDK (query loop)            │
                     │    tools: Bash, Read/Write, WebSearch     │
                     │    MCP: agentforge (IPC), qmd (memory)   │
                     │                                           │
                     │  IPC polling ◄── /data/ipc/{group}/input/│
                     └───────┬──────────────────────────────────┘
                             │ stdout: OUTPUT_START...JSON...OUTPUT_END
                             │
                     ┌───────▼──────────────────────────────────┐
                     │      AgentForge (back in main process)    │
                     │                                           │
                     │  parseOutput() → formatOutbound() → Telegram
                     │  IPC watcher (1s poll)                    │
                     │    /data/ipc/{group}/messages/ → sendMessage()
                     │    /data/ipc/{group}/tasks/    → DB ops  │
                     └──────────────────────────────────────────┘
```

### Concurrent loops

| Loop           | File                    | Interval | Purpose                                       |
| -------------- | ----------------------- | -------- | --------------------------------------------- |
| Message loop   | `src/index.ts`          | 2s       | Poll SQLite for new messages, route to agents |
| Scheduler loop | `src/task-scheduler.ts` | 60s      | Fire scheduled tasks when due                 |
| IPC watcher    | `src/ipc.ts`            | 1s       | Read agent output files, forward to Telegram  |

### Per-group isolation

| Resource          | Location                  |
| ----------------- | ------------------------- |
| Working directory | `groups/{name}/`          |
| Group memory      | `groups/{name}/CLAUDE.md` |
| Global memory     | `groups/global/CLAUDE.md` |
| IPC directories   | `data/ipc/{name}/`        |
| Session files     | `data/sessions/{name}/`   |

### File-based IPC

All communication between the orchestrator and agent processes uses atomic file writes in structured directories — no sockets or pipes. This design survives crashes on either side: unprocessed files are picked up automatically on restart.

```
data/ipc/{group}/
├── input/      ← Orchestrator → Agent (follow-up messages, close signal)
├── messages/   ← Agent → Orchestrator (send to Telegram)
└── tasks/      ← Agent → Orchestrator (schedule/pause/cancel tasks)
```

For the complete architecture reference, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 📂 File Structure

```
agentforge/
├── src/                          # TypeScript orchestrator source
│   ├── index.ts                  # Main entry: state, message loop, agent invocation
│   ├── channels/telegram.ts      # Telegram bot + bot pool for Agent Swarms
│   ├── bare-metal-runner.ts      # Spawns and manages agent processes
│   ├── ipc.ts                    # File-based IPC watcher
│   ├── router.ts                 # Message formatting and routing
│   ├── task-scheduler.ts         # Cron/scheduled task runner
│   ├── config.ts                 # Configuration constants
│   └── db.ts                     # SQLite operations
│
├── agent-runner-src/             # Agent runtime (spawned as child process)
│   └── src/
│       ├── index.ts              # Agent entry point, SDK integration, IPC polling
│       └── ipc-mcp-stdio.ts      # MCP server exposing task/message tools to Claude
│
├── groups/                       # Per-group workspaces (checked into git)
│   ├── global/
│   │   ├── AGENTS.md             # Global agent instructions (all groups)
│   │   ├── SOUL.md               # Identity and behavioral boundaries
│   │   └── TOOLS.md              # Environment and tool reference
│   └── {groupName}/
│       ├── AGENTS.md             # Group-specific instructions
│       ├── memory.md             # Long-term memory
│       └── memory/YYYY-MM-DD.md  # Daily logs
│
├── .claude/skills/               # Skill-based extensions (not in source)
├── docs/                         # Extended documentation
├── .github/workflows/            # CI/CD automation
│
├── data/                         # Runtime state (gitignored)
│   ├── ipc/{group}/              # File-based IPC directories
│   └── sessions/{group}/         # Claude Agent SDK session transcripts
│
└── store/                        # SQLite database (gitignored)
    └── messages.db               # Messages, groups, tasks, sessions
```

---

## 🛠️ Development

### Build Commands

```bash
npm run build        # Compile TypeScript (orchestrator + agent runner)
npm run dev          # Run directly with tsx (no build, verbose logs)
npm test             # Run Vitest test suite
npm run typecheck    # Type-check without emitting
npm run format       # Format with Prettier
npm run format:check # Check formatting (CI)
```

### Development Workflow

**After source changes:**

```bash
npm run build
cd agent-runner-src && npm run build && cd ..
sudo systemctl restart agentforge.service
```

**Verify fresh code:**

```bash
ls -lh dist/index.js                       # Build timestamp
sudo systemctl status agentforge.service   # Process start time
```

**Live logs:**

```bash
sudo journalctl -u agentforge.service -f
```

**Local debugging:**

```bash
npm run dev  # Runs with tsx, no build step, full terminal output
```

---

## 🔧 Troubleshooting

### Service Won't Start

Check recent logs:

```bash
sudo journalctl -u agentforge.service -n 50 --no-pager
```

**Common issues:**

- `TELEGRAM_BOT_TOKEN` and one auth method must be set in `.env`
- Verify node path in service file matches `which node`
- Check `.env` file permissions and syntax

### Agent Doesn't Respond

**Checklist:**

1. Confirm group is registered: `sqlite3 store/messages.db "SELECT jid, name FROM registered_groups;"`
2. Verify message starts with trigger: `@YourAgent ...`
3. Check live logs: `sudo journalctl -u agentforge.service -f`
4. Ensure bot is admin in group chats (Telegram requirement)

### Running Old Code After Changes

The service doesn't auto-reload. Always restart after building:

```bash
npm run build
cd agent-runner-src && npm run build && cd ..
sudo systemctl restart agentforge.service
```

### Local Debugging

Run without systemd for full output:

```bash
npm run dev
```

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for comprehensive debugging guide.

---

## 🚢 CI/CD & Releases

### Automated Workflows

| Workflow            | Trigger             | Purpose                                            |
| ------------------- | ------------------- | -------------------------------------------------- |
| `ci.yml`            | PRs, `main` pushes  | Type check, format, tests, build verification      |
| `security-scan.yml` | PRs, `main`, weekly | `npm audit` (high/critical CVEs), CodeQL analysis  |
| `test.yml`          | PRs to `main`       | Pre-merge gate: type check + Vitest                |
| `release.yml`       | `v*.*.*` tags       | Build, test, publish GitHub Release with changelog |
| `skills-only.yml`   | PRs to `main`       | Prevents skill PRs from touching source code       |

### Creating a Release

Tag a commit to trigger automated release:

```bash
git tag -a v1.2.3 -m "Release v1.2.3: description"
git push origin v1.2.3
```

The workflow builds, tests, and publishes with auto-generated changelog. Pre-release tags (`v1.2.3-beta.1`) are marked as pre-releases automatically.

📖 See [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md) and [docs/VERSIONING.md](docs/VERSIONING.md) for full policy.

### Dependency Updates

Dependabot opens weekly PRs (Mondays) for:

- Root npm packages
- `agent-runner-src/` packages
- GitHub Actions versions

Minor/patch updates are grouped; major updates are individual PRs.

---

## 📚 Documentation

### Core Documentation

| Document                                          | Description                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| [**ARCHITECTURE.md**](docs/ARCHITECTURE.md)       | Complete system architecture, component reference, data flow, IPC mechanism |
| [**INSTALLATION.md**](docs/INSTALLATION.md)       | Step-by-step installation, systemd setup, first-run configuration           |
| [**TROUBLESHOOTING.md**](docs/TROUBLESHOOTING.md) | Common issues, debugging techniques, log analysis                           |
| [**TEMPLATE_SYSTEM.md**](docs/TEMPLATE_SYSTEM.md) | AGENTS.md template system, variable substitution, per-group configuration   |

### Development & Release

| Document                                          | Description                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| [**DEVELOPMENT.md**](docs/DEVELOPMENT.md)         | Development workflow, testing, debugging                                  |
| [**VERSIONING.md**](docs/VERSIONING.md)           | Semantic versioning policy, backward compatibility                        |
| [**RELEASE_PROCESS.md**](docs/RELEASE_PROCESS.md) | Release checklist, tagging, rollback procedure                            |
| [**CONTRIBUTING.md**](CONTRIBUTING.md)            | Contribution guidelines, skills vs source changes, changelog requirements |
| [**CHANGELOG.md**](CHANGELOG.md)                  | Version history and migration notes                                       |

### Reference

| Document                                                | Description                                      |
| ------------------------------------------------------- | ------------------------------------------------ |
| [**API.md**](docs/API.md)                               | MCP server tools, IPC protocol, data structures  |
| [**TEMPLATE_VARIABLES.md**](docs/TEMPLATE_VARIABLES.md) | Available template variables for AGENTS.md files |

---

## 🤝 Contributing

AgentForge welcomes contributions. The project has a deliberate philosophy: **capabilities belong in skills, not source code**.

### Source Code Changes

✅ **Accepted:**

- Bug fixes
- Security fixes
- Simplifications that reduce code

❌ **Not accepted:**

- New features or capabilities
- Compatibility shims
- Enhancements

### Skills

New capabilities belong in **skills** — markdown files in `.claude/skills/` that teach Claude Code how to transform a fork. Skills keep the core minimal while letting individuals add exactly what they need.

**Examples:** `/convert-to-docker`, `/add-telegram`, `/add-gmail`

### How to Contribute

1. **Fork** the repository
2. **Create branch:** `git checkout -b fix/describe-the-fix`
3. **Make changes:**
   - Add entry to `CHANGELOG.md` under `[Unreleased]` (source changes only)
   - Follow [Conventional Commits](https://www.conventionalcommits.org/): `fix: prevent duplicate messages`
4. **Open PR** — CI runs automatically (type check, tests, security scans)

📖 Full guidelines: [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 🙏 Credits & License

### Based On

- [**NanoClaw**](https://github.com/gavrielc/nanoclaw) by [@gavrielc](https://github.com/gavrielc) — Core architecture, Claude Agent SDK integration, file-based IPC design

### Inspired By

- [**OpenClaw**](https://github.com/openclaw/openclaw) — Memory structure and workspace organization patterns
- [**Ray Fernando**](https://github.com/RayFernando1337) — Dream cycle and memory consolidation system ([video](https://youtu.be/AuofNgImNhk))

### License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">
  <sub>Built with ❤️ for the Claude Agent SDK community</sub>
</div>
