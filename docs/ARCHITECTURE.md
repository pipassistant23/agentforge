# Architecture Overview

AgentForge is a single Node.js process that bridges Telegram and the Claude Agent SDK. It stores messages in SQLite, queues work per group, and spawns Claude as isolated baremetal Node.js processes.

---

## High-Level Architecture

```
                          ┌─────────────────────────────────────────────────────┐
                          │              AgentForge (single process)             │
                          │                                                       │
  Telegram ──────────────►│  TelegramChannel (grammy polling)                    │
  (users)                 │       │                                               │
                          │       ▼                                               │
                          │  SQLite DB ◄─── storeMessage()                       │
                          │  (messages,     storeChatMetadata()                   │
                          │   tasks,                                              │
                          │   sessions,                                           │
                          │   groups)                                             │
                          │       │                                               │
                          │       ▼                                               │
                          │  startMessageLoop()  ◄─── 2s poll                   │
                          │       │                                               │
                          │       ▼                                               │
                          │  GroupQueue (per-group serialization)                │
                          │       │  max 5 concurrent processes                   │
                          │       ▼                                               │
                          │  runContainerAgent()  ──────────────────────────────► │
                          │       │                                               │
                          └───────┼───────────────────────────────────────────── ┘
                                  │ spawn(node agent-runner)
                                  │ stdin: JSON config + secrets
                                  │
                          ┌───────▼───────────────────────────────────────────── ┐
                          │              Agent Process (per invocation)           │
                          │                                                       │
                          │  agent-runner-src/dist/index.js                       │
                          │       │                                               │
                          │       ▼                                               │
                          │  Claude Agent SDK (query loop)                        │
                          │       │  tools: Bash, Read/Write, WebSearch, etc.    │
                          │       │  MCP: agentforge (IPC), qmd (memory)         │
                          │       │                                               │
                          │  IPC polling (500ms) ◄──── /data/ipc/{group}/input/ │
                          │       │                                               │
                          └───────┼───────────────────────────────────────────── ┘
                                  │ stdout: OUTPUT_START...JSON...OUTPUT_END
                                  │
                          ┌───────▼───────────────────────────────────────────── ┐
                          │              AgentForge (back in main process)        │
                          │                                                       │
                          │  parseOutput()  ──► formatOutbound()  ──► Telegram   │
                          │                                                       │
                          │  IPC watcher (1s poll)                               │
                          │       /data/ipc/{group}/messages/ ──► sendMessage()  │
                          │       /data/ipc/{group}/tasks/    ──► DB operations  │
                          │                                                       │
                          └─────────────────────────────────────────────────────┘
```

---

## Components

### `src/index.ts` — Orchestrator

The entry point and main control loop. Responsibilities:

- **State management**: Loads and persists message cursors, session IDs, and registered groups from SQLite at startup.
- **Message loop**: Polls SQLite every 2 seconds (`POLL_INTERVAL`) for new messages in registered groups.
- **Trigger filtering**: For non-main groups, only dispatches when the message matches the trigger pattern (e.g., `@YourAgent`).
- **GroupQueue integration**: Enqueues work for each group and receives a callback (`processGroupMessages`) that the queue calls when it's the group's turn.
- **Streaming output**: Receives agent results via callback and forwards them to Telegram immediately.
- **Recovery**: On startup, checks for unprocessed messages that arrived during a crash and re-enqueues them.
- **Graceful shutdown**: Handles `SIGTERM`/`SIGINT` by waiting for active processes to finish before exiting.

### `src/channels/telegram.ts` — Telegram Channel

Wraps the [grammy](https://grammy.dev/) library and implements the `Channel` interface. Responsibilities:

- **Inbound messages**: Long-polls Telegram for new messages and stores them in SQLite via `onMessage`.
- **Outbound messages**: Sends text to a chat, splitting messages that exceed Telegram's 4096-character limit.
- **Typing indicator**: Calls `sendChatAction('typing')` while the agent is processing.
- **Trigger translation**: Translates Telegram `@bot_username` mentions into the internal trigger format.
- **Bot pool**: Manages additional send-only bot instances (`Api` objects) for Agent Swarms.
- **Commands**: Handles `/chatid` (returns the JID needed for group registration) and `/ping`.

### `src/bare-metal-runner.ts` — Agent Spawner

Spawns agent processes and manages their lifecycle:

- **Process spawn**: Calls `spawn('node', ['agent-runner-src/dist/index.js'])` with environment variables pointing to the group's workspace and IPC directories.
- **Secrets delivery**: Reads API keys from `.env` and passes them via `stdin` as JSON (never via environment variables, to prevent leaking to child processes).
- **Session management**: Sets up `.claude/settings.json` per group with SDK feature flags.
- **Skills sync**: Copies skill files from `skills/` into each group's session directory.
- **Streaming parse**: Reads the agent's stdout and parses `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` pairs in real time, calling `onOutput` for each complete JSON result.
- **Timeout handling**: Kills hung processes after the configured timeout. Distinguishes between "timed out with output" (treated as success) and "timed out with no output" (treated as error).
- **Log files**: Writes per-run logs to `groups/{folder}/logs/`.

### `src/ipc.ts` — IPC Watcher

Polls the file-based IPC directories every second (`IPC_POLL_INTERVAL`) and processes files written by the agent:

- **Message routing**: Reads `data/ipc/{group}/messages/*.json` and calls `sendMessage` to forward agent-initiated messages to Telegram. Supports `sender` field for bot pool routing.
- **Task operations**: Reads `data/ipc/{group}/tasks/*.json` and performs the requested database operation (schedule, pause, resume, cancel, register group).
- **Authorization**: Enforces that non-main groups can only send to their own JID and can only schedule tasks for themselves.
- **Error handling**: Moves unparseable files to `data/ipc/errors/` so they don't block the queue.

### `src/router.ts` — Message Formatting

Stateless utility functions:

- `formatMessages(messages)`: Formats an array of messages as XML for the agent prompt.
- `formatOutbound(channel, text)`: Strips `<internal>...</internal>` blocks and optionally prefixes with the assistant name.
- `findChannel(channels, jid)`: Finds the channel that owns a given JID.
- `escapeXml(s)`: Escapes XML special characters.

### `src/group-queue.ts` — Concurrency Manager

Serializes access per group and limits total concurrent agent processes:

- **Per-group serialization**: Each group can have at most one active agent process at a time.
- **Global concurrency limit**: Total active processes are capped at `MAX_CONCURRENT_PROCESSES` (default: 5).
- **Backpressure**: When a group is busy or the limit is reached, messages and tasks are queued and run after the current process finishes.
- **Priority**: Pending tasks run before pending messages when draining the queue.
- **Retry with backoff**: On agent failure, schedules a retry with exponential backoff (up to 5 retries).
- **IPC message passing**: `sendMessage(groupJid, text)` writes a JSON file to the group's IPC input directory, allowing a running agent to receive follow-up messages without spawning a new process.
- **Idle close**: `closeStdin(groupJid)` writes a `_close` sentinel file, signaling the running agent to wind down.

### `src/task-scheduler.ts` — Scheduled Task Runner

Polls SQLite every minute (`SCHEDULER_POLL_INTERVAL`) for tasks whose `next_run` timestamp has passed:

- Runs due tasks through the `GroupQueue` (same concurrency controls as message processing).
- Supports three schedule types: `cron`, `interval`, and `once`.
- Computes the next run time after each execution.
- Logs run results to `task_run_logs` in SQLite.

### `src/db.ts` — Database Layer

SQLite wrapper using [better-sqlite3](https://github.com/WiseLibs/better-sqlite3). Manages:

- `chats` — Known Telegram chats (JID, name, last activity)
- `messages` — Message history for registered groups
- `scheduled_tasks` — Recurring and one-time tasks
- `task_run_logs` — Execution history for each task run
- `router_state` — Persisted cursors (last message timestamp, last agent timestamp per group)
- `sessions` — Claude session IDs per group folder
- `registered_groups` — Active groups the agent responds to

### `agent-runner-src/src/index.ts` — Agent Runner

Runs as a child process, isolated from the orchestrator:

- **Input**: Reads a JSON configuration blob from stdin (including secrets, prompt, session ID, and group metadata).
- **SDK integration**: Calls the Claude Agent SDK's `query()` function in a loop.
- **Message stream**: Uses a push-based async iterable to keep the SDK session alive and pipe follow-up messages in without restarting.
- **IPC input polling**: During each query, polls `data/ipc/{group}/input/` for new messages dropped by the orchestrator and feeds them into the SDK stream.
- **Output protocol**: Wraps each result in `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` delimiters and writes to stdout.
- **Hooks**: Installs a `PreCompact` hook to archive conversations before SDK memory compaction, and a `PreToolUse` hook to strip secrets from Bash subcommand environments.
- **Memory flush**: After 40 messages in a session, injects a prompt asking the agent to save important facts to disk.

### `agent-runner-src/src/ipc-mcp-stdio.ts` — MCP Server

An MCP server process that the agent runner starts as a sidecar. Exposes tools the agent can call:

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to the user immediately |
| `schedule_task` | Create a recurring or one-time scheduled task |
| `list_tasks` | View scheduled tasks |
| `pause_task` | Pause a task |
| `resume_task` | Resume a task |
| `cancel_task` | Delete a task |
| `register_group` | Register a new Telegram group (main only) |

Each tool writes a JSON file to the appropriate IPC directory, which the orchestrator's IPC watcher picks up and processes.

---

## Data Flow

### Inbound Message Processing

```
User sends message in Telegram
    → grammy polls and delivers to TelegramChannel.on('message:text')
    → Message stored in SQLite via storeMessage()
    → startMessageLoop() detects new message (2s poll)
    → Trigger check (main group: always; others: requires @mention)
    → GroupQueue.enqueueMessageCheck(chatJid)
    → GroupQueue calls processGroupMessages(chatJid)
    → runContainerAgent() spawns agent process
    → Agent receives prompt via stdin
    → Agent calls Claude SDK
    → Agent writes OUTPUT_START...JSON...OUTPUT_END to stdout
    → bare-metal-runner parses and calls onOutput callback
    → onOutput calls channel.sendMessage() to reply in Telegram
```

### Follow-up Message (Process Already Running)

```
User sends second message while agent is still processing first
    → startMessageLoop() detects new message
    → GroupQueue.sendMessage(chatJid, text) — no new process spawned
    → Writes JSON file to data/ipc/{group}/input/
    → Agent runner's IPC poller reads the file
    → Feeds message into the SDK's message stream
    → Agent responds to both messages in the same session
```

### Agent-Initiated Message (via MCP Tool)

```
Agent calls mcp__agentforge__send_message(text)
    → ipc-mcp-stdio.ts writes JSON to data/ipc/{group}/messages/
    → IPC watcher (1s poll) reads the file
    → Calls channel.sendMessage() — message appears in Telegram
    → Agent continues processing (does not block)
```

### Scheduled Task Execution

```
startSchedulerLoop() polls SQLite every 60s
    → Finds tasks where next_run <= now
    → Enqueues via GroupQueue.enqueueTask()
    → runTask() calls runContainerAgent() with isScheduledTask=true
    → Agent receives task prompt prefixed with [SCHEDULED TASK]
    → Results forwarded to the group's Telegram chat
    → next_run updated in SQLite for recurring tasks
```

---

## IPC Mechanism

File-based IPC is used for bidirectional communication between the orchestrator and agent processes. The base directory is `data/ipc/{groupFolder}/`.

### Directory Structure

```
data/ipc/{groupFolder}/
├── input/          ← Orchestrator → Agent (follow-up messages)
│   ├── {ts}-{rand}.json    { type: "message", text: "..." }
│   └── _close              Empty sentinel: agent should exit
├── messages/       ← Agent → Orchestrator (send to Telegram)
│   └── {ts}-{rand}.json    { type: "message", chatJid, text, sender? }
└── tasks/          ← Agent → Orchestrator (DB operations)
    └── {ts}-{rand}.json    { type: "schedule_task" | "pause_task" | ... }
```

### Why File-Based IPC?

- **Process isolation**: Agent processes are separate from the orchestrator. Pipes or sockets would require tight coupling.
- **Crash safety**: Files persist if either side crashes. Unprocessed messages survive restarts.
- **Atomic writes**: Files are written to a `.tmp` path first and then renamed, preventing partial reads.
- **Introspectability**: You can inspect the IPC directories with standard filesystem tools to debug issues.

---

## Agent Execution Model

### Session Continuity

Each group maintains a Claude session ID in SQLite. When the group's agent process is spawned:

1. If a session ID exists, the agent resumes from the last assistant message in that session.
2. If no session ID exists, the SDK creates a new session.
3. The session ID is extracted from the first `system/init` message and persisted back to SQLite.

Sessions survive across agent process restarts. A session is a chain of user/assistant turns stored in Claude's session files under `data/sessions/{groupFolder}/.claude/`.

### Process Lifecycle

```
GroupQueue decides it's this group's turn
    → runContainerAgent() spawns Node.js process
    → Process reads stdin (config + secrets)
    → Process starts SDK query loop
    → Process idles, waiting for IPC messages (_close or new messages)
    → IDLE_TIMEOUT elapses without new messages
    → Orchestrator writes _close sentinel
    → Agent exits cleanly
    → GroupQueue marks group as inactive, drains next item
```

### Workspace Isolation

Each group gets its own working directory:

| Path | Purpose |
|------|---------|
| `groups/{folder}/` | Agent's working directory (cwd) |
| `groups/{folder}/AGENTS.md` | Group-specific operational guidelines (primary instruction file) |
| `groups/{folder}/SOUL.md` | Identity and behavioral boundaries (synced from global) |
| `groups/{folder}/TOOLS.md` | Environment and tool reference (synced from global) |
| `groups/{folder}/USER.md` | User preferences for this group |
| `groups/{folder}/memory.md` | Long-term facts and patterns |
| `groups/{folder}/memory/` | Daily conversation logs (`YYYY-MM-DD.md`) |
| `groups/{folder}/logs/` | Per-run agent execution logs |
| `groups/global/AGENTS.md` | Shared operational guidelines (non-main groups) |
| `groups/global/SOUL.md` | Shared identity template |
| `groups/global/TOOLS.md` | Shared tool reference template |
| `data/ipc/{folder}/` | IPC directories |
| `data/sessions/{folder}/.claude/` | SDK session files and settings |

---

## Security Considerations

- **Secrets are never in the environment**: API keys are read from `.env` and passed via stdin, then deleted from the input object. Child processes spawned by the agent cannot inherit them.
- **Bash hook strips secrets**: A `PreToolUse` hook prepends `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN` to every Bash command run by the agent.
- **IPC authorization**: The IPC watcher verifies that messages from a group directory can only be sent to that group's JID. Only the main group can register new groups or send to arbitrary JIDs.
- **No container isolation**: Unlike NanoClaw, AgentForge runs agents without containers. The agent process has the same filesystem access as the agentforge user. Use a dedicated non-root user for the service.
