# AgentForge

Personal Claude assistant running on Linux. Forked from NanoClaw with baremetal execution and multi-channel support.

## Quick Context

Single Node.js process that connects to Telegram, routes messages to Claude Agent SDK running as baremetal processes. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/telegram.ts` | Telegram connection, bot pool for Agent Swarms |
| `src/bare-metal-runner.ts` | Spawns agent as baremetal Node.js processes |
| `src/ipc.ts` | IPC watcher, task processing, pool message routing |
| `src/router.ts` | Message formatting and routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `groups/global/CLAUDE.md` | Agent Teams instructions and global settings |
| `agent-runner-src/dist/index.js` | Baremetal agent entry point (source in agent-runner-src/) |

## Features

**Current Setup:**
- ✅ Telegram-only (simplified from multi-channel)
- ✅ Agent Swarm support via bot pool (sub-agents get unique bot identities)
- ✅ Baremetal execution (no containers)
- ✅ Systemd service management
- ✅ File-based IPC for bidirectional communication
- ✅ Per-group isolation with dedicated workspaces

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

Environment variables loaded from `/home/dustin/agentforge/.env` via EnvironmentFile directive.

## Agent Execution

Agents spawn as baremetal Node.js processes via `node agent-runner-src/dist/index.js`:
- Isolated `/data/groups/{groupFolder}/` directories
- File-based IPC in `/data/ipc/{groupFolder}/`
- Per-group CLAUDE.md memory
- Environment-based workspace paths
- Fast startup (~100-200ms)
- Source code in `agent-runner-src/`, compiled to `agent-runner-src/dist/`
