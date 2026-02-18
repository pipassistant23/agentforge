<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.png">
    <img src="assets/logo-light.png" alt="AgentForge Logo" width="400">
  </picture>

  <br/>

  [![CI](https://github.com/pipassistant23/agentforge/actions/workflows/ci.yml/badge.svg)](https://github.com/pipassistant23/agentforge/actions/workflows/ci.yml)
  [![Security Scan](https://github.com/pipassistant23/agentforge/actions/workflows/security-scan.yml/badge.svg)](https://github.com/pipassistant23/agentforge/actions/workflows/security-scan.yml)
  ![Version](https://img.shields.io/github/v/release/pipassistant23/agentforge)
  ![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)
  ![License](https://img.shields.io/badge/license-MIT-blue)
  ![Platform](https://img.shields.io/badge/platform-linux-lightgrey)
  ![Telegram](https://img.shields.io/badge/telegram-bot-blue?logo=telegram)
  ![Claude](https://img.shields.io/badge/Claude-AI-orange)
  ![Tokens](repo-tokens/badge.svg)

  <!-- token-count --><!-- /token-count -->

  # AgentForge

  **Self-hosted Claude agents on Linux — persistent, multi-group, and extensible via Telegram.**

  A personal AI assistant platform that runs the Anthropic Claude Agent SDK as baremetal Node.js processes, managed by systemd, with per-group memory isolation and Agent Swarm support.

  **Forked from [NanoClaw](https://github.com/gavrielc/nanoclaw).** AgentForge replaces container isolation with baremetal execution, targeting dedicated servers where full system access is the goal.

  <br/>

  [Quick Start](#quick-start) · [Documentation](#documentation) · [Architecture](#architecture) · [Contributing](#contributing)

</div>

---

## What is AgentForge?

AgentForge turns a Linux server into a persistent, multi-tenant Claude AI assistant accessible through Telegram. Each Telegram group gets its own isolated workspace, its own persistent memory (`CLAUDE.md`), and its own agent process — conversations stay separate and context survives restarts.

The project is intentionally minimal. Its philosophy is that **capabilities belong in skills** — markdown instruction files that tell Claude Code how to extend your fork — not in source code. The core does one thing: route Telegram messages to Claude agents and keep them running reliably.

```
User → Telegram → AgentForge (SQLite + message loop) → Claude Agent SDK → Response → Telegram
```

---

## Key Features

- **Baremetal execution** — Agents start in ~100-200ms as native Node.js processes with no container overhead
- **Per-group isolation** — Each chat group has a dedicated filesystem workspace and `CLAUDE.md` memory file; context never bleeds between groups
- **Persistent sessions** — Conversations resume across restarts; Claude remembers prior context via the Claude Agent SDK session system
- **Agent Swarms** — Spawn a coordinated team of sub-agents, each with its own Telegram bot identity and display name
- **Scheduled tasks** — Natural-language task scheduling (cron, interval, or one-time) with per-group authorization
- **Systemd service** — Runs persistently as a managed system service; auto-restarts on failure and loads secrets from `.env`
- **File-based IPC** — Crash-safe bidirectional communication between orchestrator and agent processes using atomic file writes
- **Follow-up messages** — Messages sent while an agent is still processing are piped into the running session without spawning a new process
- **Two-level memory** — Global instructions (`groups/global/CLAUDE.md`) plus per-group memory (`groups/{name}/CLAUDE.md`)
- **Skill-based extensibility** — Add capabilities by contributing skills, not by modifying source code
- **Weekly automated releases** — Dependabot, CodeQL static analysis, and `npm audit` keep dependencies secure

---

## Security Model

AgentForge is designed for **dedicated servers** where the operator trusts themselves. It does not sandbox agents.

| | AgentForge | [NanoClaw](https://github.com/gavrielc/nanoclaw) |
|---|---|---|
| Container isolation | No — removed by design | Yes |
| Intended environment | Dedicated / single-operator server | General / multi-tenant |
| Agent filesystem access | Full (baremetal) | Sandboxed |
| Secrets delivery | Via stdin, never environment variables | Via container env |

Secrets are never written to disk or inherited by child processes. See [Architecture](#architecture) for details.

---

## Quick Start

Get AgentForge running in about five minutes.

### Prerequisites

| Requirement | Notes |
|---|---|
| Linux (Ubuntu 22.04+ recommended) | Any modern distribution |
| Node.js 20+ | Check with `node --version` |
| [Claude Code CLI](https://claude.ai/download) | Installed and authenticated on the host |
| Telegram bot token | From [@BotFather](https://t.me/BotFather) — free |
| Anthropic API key **or** Claude Code OAuth token | One is required; not both |

### 1. Clone and install

```bash
git clone https://github.com/pipassistant23/agentforge.git
cd agentforge
npm install
cd agent-runner-src && npm install && cd ..
```

### 2. Configure your environment

```bash
cp .env.example .env   # or create from scratch
```

Minimum required variables:

```ini
# Telegram
TELEGRAM_BOT_TOKEN=123456789:AABBccDDeeFFggHH...

# Authentication — use one of these two:
ANTHROPIC_API_KEY=sk-ant-api03-...
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Optional: change the trigger name (default: Andy)
# ASSISTANT_NAME=MyBot

# Optional: additional bots for Agent Swarm support
# TELEGRAM_BOT_POOL=token1,token2,token3
```

### 3. Build

```bash
npm run build
cd agent-runner-src && npm run build && cd ..
```

### 4. Install as a systemd service

```bash
sudo nano /etc/systemd/system/agentforge.service
```

Paste the following, substituting your username and path:

```ini
[Unit]
Description=AgentForge - Personal Claude Assistant
After=network.target

[Service]
Type=simple
User=your_username
WorkingDirectory=/home/your_username/agentforge
EnvironmentFile=/home/your_username/agentforge/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable agentforge.service
sudo systemctl start agentforge.service
sudo systemctl status agentforge.service   # Should show: active (running)
```

### 5. Register your first group

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
VALUES ('tg:-1001234567890', 'My Chat', 'main', 'your agent', datetime('now'), 0);
"
sudo systemctl restart agentforge.service
```

### 6. Talk to your bot

Send any message to your registered chat. For the main group with `requires_trigger=0`, every message receives a response. For additional groups, prefix messages with the trigger word:

```
your agent what's the weather like today?
your agent help me write a bash script to monitor disk usage
your agent summarize what we discussed this week
```

---

## Configuration

All configuration is environment variables loaded from `.env`. The full reference lives in `src/config.ts`.

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | **Required.** Primary Telegram bot token |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (pay-per-use). One of this or the OAuth token is required. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude subscription OAuth token (alternative to API key) |
| `ASSISTANT_NAME` | `Andy` | Trigger word — messages must start with `@Name` (case-insensitive) |
| `TELEGRAM_BOT_POOL` | — | Comma-separated extra bot tokens for Agent Swarm personas |
| `POLL_INTERVAL` | `2000` | Message poll interval in milliseconds |
| `SCHEDULER_POLL_INTERVAL` | `60000` | Scheduler check interval in milliseconds |
| `AGENT_TIMEOUT` | `1800000` | Maximum agent runtime per invocation (30 min) |
| `IDLE_TIMEOUT` | `1800000` | How long to keep an idle agent process alive (30 min) |
| `MAX_CONCURRENT_PROCESSES` | `5` | Maximum simultaneous agent processes across all groups |
| `TZ` | System timezone | Timezone for cron expressions |

### Changing the assistant name

```ini
ASSISTANT_NAME=Aria
```

Messages now trigger on `@Aria ...` (case-insensitive). Restart the service after changing.

### Registering additional groups

From your main chat, ask the agent directly:

```
your agent register this group: tg:-9876543210 as "Team Chat"
```

Or insert directly into SQLite and restart. Set `requires_trigger=1` for group chats so the agent only responds when explicitly addressed.

---

## Usage

### Basic conversation

```
your agent what are the top Hacker News stories today?
your agent explain the difference between TCP and UDP
your agent help me draft a reply to this email: [paste email]
```

### File operations

Claude can read and write files in your group's workspace at `groups/{groupName}/`:

```
your agent save these meeting notes to a file called meeting-2026-02-18.md
your agent show me all files in my workspace
your agent read back the notes from last week's meeting
```

### Scheduled tasks

Claude understands natural language scheduling. Tasks persist across restarts.

```
your agent every weekday at 9am, check Hacker News and send me the top 5 AI stories
your agent every Monday at 8am, remind me to review open pull requests
your agent at 5pm today, send me a summary of what we discussed
```

Managing tasks:

```
your agent list my scheduled tasks
your agent pause task 3
your agent cancel task 5
your agent resume task 3
```

### Agent Swarms

When `TELEGRAM_BOT_POOL` is configured with additional bot tokens, Claude can spin up a named team of sub-agents. Each sub-agent gets its own Telegram bot identity:

```
your agent assemble a team: a marine biologist, a physicist, and a science writer to collaborate on explaining bioluminescence to a general audience
```

The group chat shows three distinct bots — "Marine Biologist," "Physicist," and "Science Writer" — posting independently and building on each other's contributions.

---

## Architecture

AgentForge is a **single Node.js process** with three concurrent polling loops.

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

| Loop | File | Interval | Purpose |
|---|---|---|---|
| Message loop | `src/index.ts` | 2s | Poll SQLite for new messages, route to agents |
| Scheduler loop | `src/task-scheduler.ts` | 60s | Fire scheduled tasks when due |
| IPC watcher | `src/ipc.ts` | 1s | Read agent output files, forward to Telegram |

### Per-group isolation

| Resource | Location |
|---|---|
| Working directory | `groups/{name}/` |
| Group memory | `groups/{name}/CLAUDE.md` |
| Global memory | `groups/global/CLAUDE.md` |
| IPC directories | `data/ipc/{name}/` |
| Session files | `data/sessions/{name}/` |

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

## File Structure

```
agentforge/
├── src/                          # TypeScript orchestrator source
│   ├── index.ts                  # Main entry: state, message loop, agent invocation
│   ├── channels/
│   │   └── telegram.ts           # Telegram bot + bot pool for Agent Swarms
│   ├── bare-metal-runner.ts      # Spawns and manages agent processes
│   ├── ipc.ts                    # File-based IPC watcher
│   ├── router.ts                 # Message formatting and routing
│   ├── task-scheduler.ts         # Cron/scheduled task runner
│   ├── config.ts                 # Configuration constants
│   └── db.ts                     # SQLite operations
├── agent-runner-src/             # Agent runtime (isolated child process)
│   └── src/
│       ├── index.ts              # Agent entry point, SDK integration, IPC polling
│       └── ipc-mcp-stdio.ts      # MCP server exposing task/message tools to Claude
├── groups/                       # Per-group workspaces (checked in)
│   ├── global/
│   │   └── CLAUDE.md             # Shared agent instructions (all groups)
│   └── {groupName}/
│       └── CLAUDE.md             # Group-specific memory and instructions
├── docs/                         # Extended documentation
├── .github/workflows/            # CI/CD pipelines
├── data/                         # Runtime state — gitignored
│   ├── ipc/{group}/              # Agent IPC directories
│   └── sessions/{group}/         # Claude session transcripts
└── store/                        # SQLite database — gitignored
```

---

## Development

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Run directly with tsx (no build step, verbose output)
npm test             # Run Vitest test suite
npm run typecheck    # Type-check without emitting files
npm run format       # Format source with Prettier
npm run format:check # Check formatting (used in CI)
```

After any source change, rebuild and restart:

```bash
npm run build && sudo systemctl restart agentforge.service
```

Verify you are running fresh code by comparing timestamps:

```bash
ls -lh dist/index.js                       # Build time
sudo systemctl status agentforge.service   # Process start time
```

Follow live logs:

```bash
sudo journalctl -u agentforge.service -f
```

---

## Troubleshooting

### Service will not start

```bash
sudo journalctl -u agentforge.service -n 50 --no-pager
```

Check that `TELEGRAM_BOT_TOKEN` and one authentication variable are set in `.env`. Verify the `node` binary path in the service file matches `which node`.

### Agent does not respond

- Confirm the group is registered: `sqlite3 store/messages.db "SELECT jid, name FROM registered_groups;"`
- Confirm your message starts with the trigger word: `your agent ...`
- Follow live logs: `sudo journalctl -u agentforge.service -f`

### Running old code after a change

The running service does not auto-reload. Always restart after rebuilding:

```bash
npm run build && sudo systemctl restart agentforge.service
```

### Debugging locally

```bash
npm run dev
```

Runs the orchestrator directly with `tsx` — no build step, full output in the terminal.

---

## CI / CD

All workflows live in `.github/workflows/`.

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | PRs and `main` pushes | Type check, format check, tests, build verification |
| `lint.yml` | PRs and `main` pushes | Prettier format check with PR comments, TypeScript strict check |
| `security-scan.yml` | PRs, `main` pushes, weekly | `npm audit` for high/critical CVEs; CodeQL static analysis |
| `release.yml` | `v*.*.*` tags | Full build and test, then GitHub Release with auto-generated changelog |
| `test.yml` | PRs to `main` | Lightweight pre-merge gate: type check and Vitest |
| `skills-only.yml` | PRs to `main` | Prevents skill PRs from accidentally touching source files |

### Releases

Tag a commit to trigger an automated GitHub Release:

```bash
git tag -a v1.2.3 -m "Release v1.2.3: brief description"
git push origin v1.2.3
```

The release workflow runs the full build and test suite, then publishes a release with a changelog generated from commits since the previous tag. Pre-release tags (`v1.2.3-beta.1`) are automatically marked as pre-releases.

See [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md) and [docs/VERSIONING.md](docs/VERSIONING.md) for the full release policy.

### Dependency updates

Dependabot opens weekly PRs (Mondays) for root npm packages, `agent-runner-src/` packages, and GitHub Actions versions. Minor and patch updates are grouped to reduce noise; major updates are individual PRs.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full system architecture, component reference, data flow diagrams, IPC mechanism |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Step-by-step installation guide, systemd setup, first-run group registration |
| [docs/VERSIONING.md](docs/VERSIONING.md) | Semantic versioning policy, backward compatibility guarantees |
| [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md) | Release checklist, tagging, rollback procedure |
| [docs/SPEC.md](docs/SPEC.md) | Full system specification and message flow |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guidelines, skill vs. source change policy, changelog requirements |
| [CHANGELOG.md](CHANGELOG.md) | Version history and migration notes |

---

## Contributing

AgentForge welcomes contributions. The project has a deliberate philosophy about what belongs in source code vs. skills.

**Accepted as source changes:**
- Bug fixes
- Security fixes
- Simplifications that reduce code

**Not accepted as source changes:**
- New features or capabilities
- Compatibility shims
- Enhancements

**New capabilities belong in skills** — markdown files in `.claude/skills/` that instruct Claude Code how to transform a fork. A skill PR should touch only skill files, not source. This keeps the core clean for everyone while letting individuals add exactly the features they need.

### How to contribute

1. Fork the repository
2. Create a branch: `git checkout -b fix/describe-the-fix`
3. Make your change and add a `CHANGELOG.md` entry under `[Unreleased]` (required for source changes)
4. Follow [Conventional Commits](https://www.conventionalcommits.org/): `fix: prevent duplicate messages on restart`
5. Open a pull request — CI will run type checking, tests, and security scans automatically

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete guidelines including changelog requirements and commit message conventions.

---

## Credits

**Based on:**
- [NanoClaw](https://github.com/gavrielc/nanoclaw) by [@gavrielc](https://github.com/gavrielc) — core architecture, Claude Agent SDK integration, and file-based IPC design

**Inspired by:**
- [OpenClaw](https://github.com/openclaw/openclaw) — memory structure and workspace organization patterns
- [Ray Fernando](https://github.com/RayFernando1337) — dream cycle and memory consolidation system ([video](https://youtu.be/AuofNgImNhk))

---

## License

MIT — see [LICENSE](LICENSE) for details.
