# AgentForge

Personal Claude assistant running on Linux. Forked from NanoClaw with baremetal execution and multi-channel support.

## Template System

AgentForge uses **AGENTS.md** as the primary instruction file for agents (not CLAUDE.md). This follows the emerging standard used by other AI coding tools.

**File structure:**

- `groups/{name}/AGENTS.md` - Main instruction file (capabilities, guidelines)
- `groups/{name}/SOUL.md` - Identity and behavioral boundaries
- `groups/{name}/TOOLS.md` - Environment and tool reference
- `groups/{name}/USER.md` - User preferences
- `groups/{name}/memory.md` - Long-term memory
- `groups/{name}/memory/YYYY-MM-DD.md` - Daily logs

See `docs/TEMPLATE_SYSTEM.md` for details.

## Quick Context

Single Node.js process that connects to Telegram, routes messages to Claude Agent SDK running as baremetal processes. Each group has isolated filesystem and memory.

## Key Files

| File                             | Purpose                                                   |
| -------------------------------- | --------------------------------------------------------- |
| `src/index.ts`                   | Orchestrator: state, message loop, agent invocation       |
| `src/channels/telegram.ts`       | Telegram connection, bot pool for Agent Swarms            |
| `src/bare-metal-runner.ts`       | Spawns agent as baremetal Node.js processes               |
| `src/ipc.ts`                     | IPC watcher, task processing, pool message routing        |
| `src/router.ts`                  | Message formatting and routing                            |
| `src/config.ts`                  | Trigger pattern, paths, intervals                         |
| `src/task-scheduler.ts`          | Runs scheduled tasks                                      |
| `src/db.ts`                      | SQLite operations                                         |
| `groups/{name}/AGENTS.md`        | Per-group instructions (isolated)                         |
| `groups/global/AGENTS.md`        | Agent Teams instructions and global settings              |
| `agent-runner-src/dist/index.js` | Baremetal agent entry point (source in agent-runner-src/) |

## Features

**Current Setup:**

- ✅ Telegram-only (simplified from multi-channel)
- ✅ Agent Swarm support via bot pool (sub-agents get unique bot identities)
- ✅ Baremetal execution (no containers)
- ✅ Systemd service management
- ✅ File-based IPC for bidirectional communication
- ✅ Per-group isolation with dedicated workspaces

## Git Practices

This is a public repository. `main` is always stable and reflects what the running service is on.

### Branching

- `main` is protected — never commit directly, no force pushes
- All work happens on a short-lived branch, merged via PR
- Branch naming mirrors the commit type:
  - `feat/short-description`
  - `fix/short-description`
  - `chore/short-description`
  - `refactor/short-description`
  - `docs/short-description`

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

| Type | When to use |
|------|-------------|
| `feat:` | New functionality |
| `fix:` | Bug fixes |
| `refactor:` | Code changes with no behavior change |
| `chore:` | Tooling, deps, config, CI |
| `docs:` | Documentation only |
| `test:` | Tests only |
| `style:` | Formatting only |

Keep the subject line under 72 characters. Use the body for the "why" when it isn't obvious.

### Pull Requests

- Open a PR to merge any branch into `main`, even when working solo
- PR title follows the same Conventional Commits format
- Squash trivial fixup commits before merging; preserve meaningful history

### Versioning

No formal release process. Tag meaningful milestones manually:

- Format: `vMAJOR.MINOR.PATCH`
- Increment **minor** for significant new features
- Increment **patch** for fixes and small improvements
- Tag from `main` after merging, with a short annotation describing the milestone

```bash
git tag -a v0.2.0 -m "Add IPC task snapshot refresh"
git push origin v0.2.0
```

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run build        # Compile TypeScript to dist/
npm test            # Run tests
```

**Important:** Always restart the service after building - the running process doesn't auto-reload!
Check process start time vs dist build time to verify you're running fresh code.

## Service Management

AgentForge runs as a systemd service: `agentforge.service`

```bash
sudo systemctl restart agentforge.service   # Restart after npm run build
sudo systemctl status agentforge.service    # Check if running
sudo journalctl -u agentforge.service -f    # Follow logs
sudo systemctl enable agentforge.service    # Enable on boot
```

Environment variables loaded from the project root `.env` file via EnvironmentFile directive.

## Agent Execution

Agents spawn as baremetal Node.js processes via `node agent-runner-src/dist/index.js`:

- Isolated `/data/groups/{groupFolder}/` directories
- File-based IPC in `/data/ipc/{groupFolder}/`
- Per-group AGENTS.md instructions and memory system
- Environment-based workspace paths
- Fast startup (~100-200ms)
- Source code in `agent-runner-src/`, compiled to `agent-runner-src/dist/`
