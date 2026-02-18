# Changelog

All notable changes to AgentForge are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). See [docs/VERSIONING.md](docs/VERSIONING.md) for the project's versioning policy.

---

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

---

## [1.0.0] - 2026-02-18

First stable release of AgentForge. Forked from NanoClaw and rebranded with expanded platform support, baremetal execution, and Agent Swarm capabilities.

### Added

- Telegram channel support via the `/add-telegram` skill, replacing the original WhatsApp-only architecture.
- Agent Swarm support: a pool of bot identities allows sub-agents to respond with unique Telegram personas.
- Baremetal execution mode: agents spawn as native Node.js processes instead of Apple Containers, giving faster startup (~100-200ms) and removing the macOS-only container dependency.
- Systemd service management (`agentforge.service`) replacing the macOS launchd plist, enabling Linux deployment.
- File-based IPC under `/data/ipc/{groupFolder}/` for bidirectional host-agent communication.
- Per-group queue with configurable global concurrency limit to prevent resource exhaustion under load.
- SQLite-backed state for registered groups, sessions, scheduled tasks, and router state, replacing earlier JSON file storage.
- Built-in task scheduler with support for `cron`, `interval`, and `once` schedule types.
- `context_mode` option for scheduled tasks (agent can run silently or send a message on completion).
- Per-group isolated workspaces under `/data/groups/{groupFolder}/` with dedicated `CLAUDE.md` memory.
- Global memory via `groups/global/CLAUDE.md`, readable by all groups.
- Native memory management via Claude's built-in memory tools (replaces the earlier PreCompact hook for archiving).
- Agent Swarm skill (`/add-telegram` variant) allowing concurrent agent responses with distinct identities.
- `/setup` skill for scripted first-time installation.
- `is_bot_message` column in the messages table and support for dedicated phone numbers.
- `requiresTrigger` option per group; the main channel responds to all messages without a trigger prefix.
- Typing indicator shown throughout agent processing, not only on the first message.
- Token count badge and GitHub Action (`repo-tokens`) for tracking context window usage.
- `agent-runner-src/` source tree (compiled to `agent-runner-src/dist/`) for the baremetal agent entry point.
- CODEOWNERS entries for `/groups/` and `/launchd/`.
- Chinese README (`README.zh-CN.md`).

### Changed

- Project renamed from NanoClaw to AgentForge.
- Execution model changed from Apple Container (macOS-only Linux VMs) to baremetal Node.js processes.
- Service management moved from launchd (`com.agentforge.plist`) to systemd (`agentforge.service`).
- Environment variables for the agent are now passed via the SDK `env` option; the temporary env file is deleted immediately after use.
- Agent Bash subprocesses no longer inherit host environment variables (secrets sanitized at spawn time).
- IPC directories are namespaced per group to prevent privilege escalation between groups.
- `lastAgentTimestamp` is only updated when the agent completes successfully, preventing message loss on failure.
- Orphan container cleanup improved: containers from previous crashed runs are killed on startup.
- Agent output schema, tool descriptions, and shutdown robustness improved.
- Session mount paths standardized to `/home/node/.claude/` (container user `node`, not `root`).
- Message formatting simplified: trigger word is retained in the prompt; timestamps use `MMM DD h:mm A` format.

### Fixed

- Infinite message replay when a container timed out (guard added to prevent reprocessing).
- Auth variables were being fully exposed to agent containers via `.env`; now only `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are forwarded.
- Hardcoded home directory fallback in the container runner.
- Message loss when `processMessage` threw an unhandled exception.
- IPC authentication gap allowing one group to read another group's task results.
- WhatsApp auth improvements including LID translation for direct messages.
- Typing indicator was only sent once per session; now sent on every triggered message.
- `fix: use available` presence sent on connect so typing indicators function consistently.
- Task deletion foreign key constraint error in SQLite.
- git pull race in the token count CI workflow.

### Security

- Secrets are now passed to the agent SDK via the `env` option; the temporary env file is written and immediately deleted, never persisted to disk across agent runs.
- Agent Bash subprocesses have host environment variables sanitized before spawn to prevent credential leakage.
- IPC directories are namespaced per group, preventing cross-group privilege escalation.
- Message content removed from `info`-level logs; only metadata is logged at that level.

---

## Migration Notes

### Migrating from NanoClaw (Apple Container / macOS)

AgentForge 1.0.0 is a significant departure from the NanoClaw architecture. A direct upgrade path does not exist; treat this as a fresh installation.

Key differences:

| Area | NanoClaw | AgentForge 1.0.0 |
|------|----------|-----------------|
| Platform | macOS only | Linux (systemd) |
| Execution | Apple Container (VM) | Baremetal Node.js |
| Messaging | WhatsApp (Baileys) | Telegram (grammY) |
| Service | launchd plist | systemd unit |
| Agent entry point | `container/agent-runner/` | `agent-runner-src/` |

To migrate:

1. Back up your `groups/` directory (contains all per-group and global memory).
2. Run a fresh `git clone` of AgentForge.
3. Copy your `groups/` directory into the new clone.
4. Follow the `/setup` skill to configure Telegram and the systemd service.
5. Register your groups using the Telegram main channel.

Your `CLAUDE.md` memory files are portable and will be picked up automatically once the groups are registered.

---

[Unreleased]: https://github.com/your-org/agentforge/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/your-org/agentforge/releases/tag/v1.0.0
