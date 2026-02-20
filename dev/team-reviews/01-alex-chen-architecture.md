# Architecture Review: AgentForge
**Reviewer:** Alex Chen, Chief Architect
**Date:** 2026-02-19
**Branch:** `fix/agent-memory-autoload`

---

## Executive Summary

AgentForge is a well-scoped personal assistant platform with a clear architectural philosophy: run Claude agents as isolated bare-metal Node.js processes, communicate through file-based IPC, and persist everything through SQLite. The design is correct for what it is — a single-tenant, single-host system where simplicity and crash recoverability matter more than horizontal scale.

The overall structure holds up well. Separation between the orchestrator, the runner, and the agent is clean. The IPC authorization model is sound. The dual-cursor system, while complex on first read, is actually solving a real problem (crash recovery between "seen" and "processed") and the solution is coherent.

That said, several specific design decisions introduce fragility that is not obvious until things go wrong in production. The orchestrator (`src/index.ts`) accumulates logic that belongs in more focused modules. The polling architecture creates a latency floor that may be felt in interactive conversations. The shutdown path is underspecified. And several edge cases in the dual-cursor and GroupQueue state machine can lead to silent message loss.

This review focuses on what will actually bite you, ordered by severity.

---

## Strengths

**1. Process isolation by default.**
Spawning each agent invocation as a fresh Node.js process is the right call. Crashes, memory leaks, and SDK state corruption are fully contained. The 100–200ms spawn cost is negligible for conversational workloads. This is architecturally superior to long-lived agent threads sharing the orchestrator's event loop.

**2. Secrets-via-stdin pattern.**
Passing API credentials through stdin and immediately deleting them from the in-memory input object (`delete input.secrets`) is a legitimate security practice. It keeps secrets out of `/proc`, out of environment variable inspection, and out of logs. The `createSanitizeBashHook` that prepends `unset` to all Bash commands closes the remaining exposure vector inside the agent. This is unusually careful thinking for a personal project.

**3. Atomic IPC writes.**
The write-to-`.tmp`-then-rename pattern in both `ipc-mcp-stdio.ts` and `group-queue.ts`'s `sendMessage` is exactly right. It prevents the orchestrator's polling loop from reading a partially-written file. This is one of the few places where concurrency is handled correctly without being over-engineered.

**4. Directory-based IPC authorization.**
In `ipc.ts`, the source group identity comes from which directory the file was found in (`sourceGroup = groupFolders[...]`), not from anything inside the file payload. This means a compromised agent cannot forge another group's identity by writing a different `groupFolder` into its IPC file. The design correctly separates "what the file says" from "where the file came from."

**5. Dual-cursor crash recovery is purposeful.**
`lastTimestamp` (seen) and `lastAgentTimestamp` (processed) solve a real problem: a crash between advancing the seen cursor and finishing the agent run would silently drop messages. The recovery path in `recoverPendingMessages()` is correct — on startup, it compares the two cursors and re-enqueues anything in the gap. This is more sophisticated than it looks.

**6. GroupQueue task-before-messages drain priority.**
In `drainGroup()`, pending tasks are drained before pending messages. The comment explains why: tasks cannot be re-discovered from SQLite the way messages can (they're held in memory). This priority inversion is correct and the reasoning is sound.

**7. Output chain serialization.**
In `bare-metal-runner.ts`, `outputChain = outputChain.then(() => onOutput(parsed))` correctly serializes async output callbacks even as chunks arrive out of order from the streaming parser. This prevents interleaved Telegram sends for a single agent response. The approach is idiomatic and correct.

**8. Module decoupling via dependency injection.**
`startIpcWatcher(deps)`, `startSchedulerLoop(deps)`, and the channel callback pattern in `main()` all use explicit dependency injection. This makes tests possible without a running Telegram bot, and it's what allows `processGroupMessages` to be set late via `queue.setProcessMessagesFn()`. The design is testable by construction.

---

## Issues Found

### [HIGH] Dual-cursor rollback is broken when output was partially sent

**Location:** `src/index.ts:288–307`, `processGroupMessages()`

When an agent produces some output and then errors, the code correctly avoids rolling back the cursor to prevent duplicate sends:

```ts
if (outputSentToUser) {
  logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback');
  return true; // treated as success
}
```

The problem: `outputSentToUser` is set to `true` on the *first* `result.result` that contains a non-empty string. If the agent sends three messages and crashes after the second, the cursor is left at "end of message batch" (already advanced before the run), the GroupQueue sees `return true` and clears `retryCount`, and the user receives a partial response with no indication anything went wrong.

This is the correct trade-off for preventing duplicates, but the behavior is undocumented and the user experience is silent truncation. At minimum, a "response may be incomplete" note should be sent to the channel.

---

### [HIGH] GroupQueue `waitingGroups` can contain stale JIDs

**Location:** `src/group-queue.ts:68–78`, `enqueueMessageCheck()`

When a group is added to `waitingGroups` because the concurrency limit is hit, it stays in the array until `drainWaiting()` pops it. But `drainWaiting()` only drains when another group finishes — it does not check whether the waiting group still has work. If `processGroupMessages()` returns `true` (no-op, zero messages) for a group that was queued during the concurrency limit, the slot is consumed, the group is popped from `waitingGroups`, but no actual work was done.

More importantly: there is no deduplication guarantee for `waitingGroups`. The code does check `!this.waitingGroups.includes(groupJid)` before pushing, but this is an O(n) linear scan, and more critically, a group can be in `waitingGroups` while its `pendingMessages` flag is false (set to false in `runForGroup()` before the group is actually processed). This creates a window where `drainWaiting()` pops the JID, checks `state.pendingMessages`, finds it false, and skips it — eating the slot without doing work.

**Concrete scenario:** Group A is active. Group B sends two rapid messages. First enqueue: B is at concurrency limit, added to `waitingGroups`, `pendingMessages=true`. Second enqueue: B is already in `waitingGroups` (dedup passes), `pendingMessages` stays `true`. Group A finishes, `drainWaiting()` pops B, starts `runForGroup(B)` which sets `pendingMessages=false`. The second message's work was correctly captured by `pendingMessages=true`, so B will re-drain after finishing. This specific case actually works. But the logic is fragile enough that adding any new state mutation could break it.

---

### [HIGH] The orchestrator does not track cursor advancement atomicity

**Location:** `src/index.ts:481–495`, `startMessageLoop()`

In `startMessageLoop()`, when messages are piped to an active process via `queue.sendMessage()`, the agent cursor is advanced immediately:

```ts
if (queue.sendMessage(chatJid, formatted)) {
  lastAgentTimestamp[chatJid] = messagesToSend[messagesToSend.length - 1].timestamp;
  saveState();
}
```

But `queue.sendMessage()` only writes a JSON file to the IPC input directory. Whether the agent actually reads that file and processes those messages is not confirmed. If the agent process crashes between the file write and the read, the cursor has been advanced but the messages were never delivered. The file sits in the IPC input directory unread, but the orchestrator has moved on. There is no retry path for this case.

This is distinct from the crash-recovery path in `recoverPendingMessages()`, which only runs at startup. An agent crash mid-session (not a restart) leaves these piped messages permanently lost.

---

### [HIGH] IPC watcher has no backpressure for large error directories

**Location:** `src/ipc.ts:74–198`, `processIpcFiles()`

Every failed IPC file is moved to `errors/`, but nothing ever cleans `errors/`. The watcher correctly filters `f !== 'errors'` when scanning group directories, so the error directory is never processed — it only accumulates. In a malfunctioning agent scenario (bad JSON output, unauthorized attempts), the errors directory can grow unboundedly and eventually fill the disk.

There is also no alerting on error accumulation. A sustained error storm is silent from the operator's perspective.

---

### [MEDIUM] The orchestrator module is doing too much

**Location:** `src/index.ts`

`src/index.ts` is the orchestrator, but it also owns:
- Application startup and shutdown lifecycle
- Channel connection management
- State hydration and persistence (`loadState`, `saveState`)
- Group registration logic (`registerGroup`)
- IPC dependency wiring
- Scheduler dependency wiring
- The message loop itself
- The agent invocation pipeline (`processGroupMessages`, `runAgent`)

This is 650 lines of deeply intertwined concerns. The `runAgent()` function — which writes snapshots, manages session IDs, and wraps process callbacks — belongs in `bare-metal-runner.ts` or a dedicated `agent-lifecycle.ts`. Group registration, which creates filesystem directories, belongs closer to the group management layer. The message loop is a proper module of its own.

The practical consequence: adding a new channel (e.g., Slack) requires understanding and modifying the orchestrator, the IPC watcher dependencies, the scheduler dependencies, and the channel callback wiring — all in one file. The dependency injection pattern already exists (see `startIpcWatcher(deps)`); it should be applied to the orchestrator itself.

---

### [MEDIUM] `lastAgentTimestamp` is serialized as a JSON string stored in a key-value table

**Location:** `src/index.ts:119`, `src/db.ts:500–504`

```ts
setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
```

`lastAgentTimestamp` is a `Record<string, string>` that maps group JID to an ISO timestamp. It is serialized to JSON and stored as a single value in the `router_state` table. This means:

1. Every cursor save — which happens after every message batch — re-serializes and re-writes the entire object, even if only one group's cursor changed.
2. A crash during the write corrupts all cursors for all groups at once. The `try/catch` in `loadState()` resets all agent timestamps to empty if parsing fails, which causes every group to replay all stored messages on next startup.
3. The data naturally belongs as per-group rows (one row per group JID), which would make individual cursor updates atomic and single-row.

The fix is straightforward: add a `group_cursors` table with `(jid TEXT PRIMARY KEY, agent_timestamp TEXT)` and update one row per cursor change.

---

### [MEDIUM] Idle timer vs. hard timeout interaction creates silent success on timeout

**Location:** `src/bare-metal-runner.ts:431–523`

The comment says: "A timeout that fires after streaming output has started is treated as an idle cleanup (success), not a failure." When `timedOut=true` and `hadStreamingOutput=true`, the runner resolves with `status: 'success'`. The orchestrator then treats this as a complete run and does not roll back the cursor.

The problem: the IDLE_TIMEOUT (30 minutes by default) is added to AGENT_TIMEOUT before the hard kill fires. If the agent is legitimately long-running and the hard timeout kills it mid-response, the run is classified as success because `hadStreamingOutput` was set by earlier output. The user receives a partial response with no indication the agent was killed.

Additionally, the grace period calculation `Math.max(configTimeout, IDLE_TIMEOUT + TIMEOUT_GRACE_PERIOD)` means the effective hard timeout is always at least `IDLE_TIMEOUT + 30s = 30.5 minutes`, regardless of `configTimeout` if `configTimeout < IDLE_TIMEOUT`. This makes the per-group `agentConfig.timeout` setting ineffective for any timeout shorter than the idle timeout.

---

### [MEDIUM] `setupGroupSession()` is called on every agent invocation

**Location:** `src/bare-metal-runner.ts:252`

`setupGroupSession()` performs file existence checks and copies for all shared template files (`SOUL.md`, `TOOLS.md`, etc.) on every single agent invocation. For a busy group, this means redundant filesystem operations on every message. The skill sync inner loop (`fs.readdirSync(skillsSrc)` → copy each file) runs unconditionally, overwriting skill files on every run even when they haven't changed.

This is not a correctness issue but it adds latency to every agent spawn and introduces a race condition if skills are being updated during an agent startup.

---

### [MEDIUM] No message retention policy / database growth is unbounded

**Location:** `src/db.ts:217–230`, `storeMessage()`

Every message from every registered group is stored permanently. There is no TTL, no archival, and no `DELETE` anywhere in the codebase. For a long-running personal assistant, the messages table will grow without bound. SQLite handles this gracefully up to a point, but `getMessagesSince()` does a full table scan filtered by `chat_jid` and `timestamp` — as the table grows, these queries will get slower.

The index on `timestamp` helps, but a composite index `(chat_jid, timestamp)` would be substantially more efficient for the actual query pattern.

---

### [LOW] `formatOutbound()` has a deprecated two-signature API

**Location:** `src/router.ts:71–94`

`formatOutbound` accepts either `(rawText: string)` or `(channel: Channel, rawText: string)`. The single-argument form is described as "backwards compatibility" in a comment. Both call paths exist in the codebase but only `processGroupMessages` uses the two-argument form with a real channel. The single-argument form strips internal tags but never adds the channel prefix, which means callers using the old form silently get different formatting behavior. This should be collapsed into a single signature.

---

### [LOW] Bot pool name assignment races with message delivery

**Location:** `src/channels/telegram.ts:296–310`, `sendPoolMessage()`

When a sender is first assigned a pool bot, the code:
1. Assigns the bot index
2. Calls `api.setMyName(sender)` to rename it
3. Waits `NAME_PROPAGATION_DELAY` (default 2 seconds)
4. Then sends the message

The propagation delay is a hardcoded best-effort wait. If Telegram's name update has not propagated by the time the message is delivered, the message will appear under the bot's old name. More importantly, this entire 2-second sleep blocks the `sendPoolMessage()` Promise chain, which blocks the IPC watcher's `processIpcFiles` loop for that duration. If multiple first-assignment sends happen in the same IPC poll cycle, they serialize and the delay compounds.

---

### [LOW] Email channel `processedIds` set is unbounded in memory

**Location:** `src/channels/email.ts:53`

```ts
private processedIds = new Set<string>(); // Dedup across poll cycles
```

The processedIds set grows monotonically with every processed email message ID. For a long-running service, this is a slow memory leak. The comment says "Dedup across poll cycles" but the dedup only needs to cover a window (e.g., last 24 hours), not the full lifetime of the process.

---

### [LOW] Shutdown does not kill agent processes

**Location:** `src/group-queue.ts:290–307`, `shutdown()`

On SIGTERM, `queue.shutdown()` logs the active processes but explicitly does not kill them: "processes detached, not killed." The rationale is reasonable (avoid killing working agents on reconnect restarts), but on a true service stop, these orphaned processes will continue running against the Anthropic API with no parent to receive their output. They will eventually time out and exit, but the output is lost and there is no accounting for this.

The `gracePeriodMs` parameter to `shutdown()` is accepted but completely unused (named `_gracePeriodMs`). It was presumably intended to kill processes that outlast the grace period, but was never implemented.

---

## Recommendations

**R1: Extract agent lifecycle into a dedicated module.**
Move `runAgent()` from `src/index.ts` into `src/bare-metal-runner.ts` or a new `src/agent-lifecycle.ts`. The current placement means `index.ts` knows about session ID management, snapshot writing, and process registration — concerns that belong with the runner. The refactor would reduce `index.ts` by ~80 lines and make the agent lifecycle unit-testable in isolation.

**R2: Migrate `lastAgentTimestamp` to per-row storage.**
Add a `group_cursors` table: `CREATE TABLE group_cursors (jid TEXT PRIMARY KEY, agent_timestamp TEXT NOT NULL)`. Replace the single JSON blob serialization with targeted single-row updates. This makes cursor persistence O(1) per group instead of O(groups), eliminates the all-or-nothing corruption risk, and aligns with how sessions are already stored.

**R3: Add a composite index on `(chat_jid, timestamp)` for messages.**
```sql
CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON messages(chat_jid, timestamp);
```
Both `getMessagesSince()` and `getNewMessages()` filter by `chat_jid` and order/filter by `timestamp`. The current `idx_timestamp` index is on `timestamp` alone, which means SQLite must still scan all rows for a given chat. The composite index would make these queries O(log n) in the number of messages for that chat.

**R4: Implement an error directory cleanup policy.**
Add a periodic job (or hook into the existing IPC poll loop) that counts files in `errors/`, logs a warning above a threshold (e.g., 50 files), and deletes files older than N days (e.g., 7). This prevents the silent disk-fill failure mode.

**R5: Implement the grace period in `GroupQueue.shutdown()`.**
The `gracePeriodMs` parameter exists but is unused. Use it: after setting `shuttingDown=true`, wait up to `gracePeriodMs` for `activeCount` to reach zero, then SIGKILL any remaining processes. This makes the shutdown contract explicit and prevents orphaned processes on service stop.

**R6: Gate `setupGroupSession()` with a per-run-per-group dirty flag.**
Add a simple in-memory set in `bare-metal-runner.ts` that tracks which groups have had their session setup run in the current process lifetime. On second and subsequent invocations, skip the template file copies unless a `forceRefresh` flag is set (e.g., for skills updates). This eliminates redundant filesystem churn on every message.

**R7: Add a message retention policy.**
Add a `pruneMessages(olderThanDays: number)` function to `db.ts` and call it on startup or periodically via the scheduler loop. A rolling 90-day window is appropriate for a personal assistant. This prevents unbounded table growth and keeps the timestamp index efficient.

---

## Ideas and Proposals

**[IDEA] Replace the message polling loop with a push notification system.**
The 2-second `POLL_INTERVAL` is the dominant source of interactive latency. When a user sends a message, the Telegram webhook has already delivered it to the bot and stored it in SQLite — but the orchestrator won't see it for up to 2 seconds. A better model: the channel's `onMessage` callback, currently used only for storage, could also enqueue the group directly by calling `queue.enqueueMessageCheck(chatJid)` immediately. The message loop would then only serve as a safety net for missed events, running at a much longer interval (e.g., 30 seconds). This could halve interactive latency with minimal code change.

**[IDEA] Make the dual-cursor system self-describing.**
The gap between `lastTimestamp` and `lastAgentTimestamp` is meaningful state, but it's only computed implicitly by the recovery function. Consider adding a named concept — call it `pendingWindow` — that is logged on startup and visible in metrics. Currently, if the gap is non-zero after a crash, only the recovery log message captures it. Making this observable would help debug silent message drops.

**[IDEA] Streaming IPC via a named pipe instead of file polling.**
The agent writes IPC files; the orchestrator polls every `IPC_POLL_INTERVAL` (1 second). For the message-to-agent path, this adds up to 1 second of additional latency on top of the message loop's 2-second poll — for a worst case of 3 seconds from user message to agent receipt. A named FIFO (`mkfifo`) per group would give true push semantics with no polling overhead, while keeping the file-based model that makes authorization straightforward. The `errors/` directory approach works well with pipes (just don't pipe errors) and the rename-for-atomicity pattern still applies to the control channel.

**[IDEA] Add a process manifest for orphan detection.**
When the orchestrator spawns a process, write its PID and group folder to a manifest file (e.g., `/data/pids/{groupFolder}.json`). On startup, read this manifest and check which PIDs are still alive. Any alive PIDs from a previous run are orphans — they can be killed or waited on gracefully. This would give the service a clear picture of what was running before a crash and allow the graceful shutdown it currently lacks.

**[IDEA] Typed IPC protocol with schema validation.**
The IPC file format (`{type, chatJid, text, ...}`) is an informal protocol. Both sides (agent MCP server and orchestrator IPC watcher) implement it independently. A shared TypeScript type file (or Zod schema) that both the orchestrator and `agent-runner-src` import would prevent the protocol from drifting as new actions are added. Currently, adding a new IPC action requires coordinating changes in `ipc-mcp-stdio.ts`, `ipc.ts`, and potentially `task-scheduler.ts` with no compile-time verification that the shapes match.

**[IDEA] Consider SQLite WAL mode for the main database.**
The orchestrator makes synchronous SQLite writes (via `better-sqlite3`) on the main thread while Telegram webhook handlers also call `storeMessage()`. Both are synchronous. In WAL mode, readers do not block writers and vice versa, which would reduce contention if the IPC watcher or scheduler polls trigger reads during an active write. This is a one-line configuration change: `db.pragma('journal_mode = WAL')` in `initDatabase()`.

---

## Summary Table

| Issue | Severity | Location | Impact |
|---|---|---|---|
| Partial-output cursor not rolled back, user gets silent truncation | HIGH | `index.ts:288–307` | UX, correctness |
| `waitingGroups` can eat concurrency slots without doing work | HIGH | `group-queue.ts:68–78` | Message loss |
| Piped IPC messages lost on mid-session agent crash | HIGH | `index.ts:481–495` | Message loss |
| Error directory grows without bound | HIGH | `ipc.ts` | Disk fill |
| Orchestrator owns too many concerns | MEDIUM | `index.ts` | Maintainability |
| `lastAgentTimestamp` JSON blob corruption loses all cursors | MEDIUM | `index.ts:119`, `db.ts` | Data loss on crash |
| Hard timeout treated as success after partial output | MEDIUM | `bare-metal-runner.ts:468–510` | Silent truncation |
| `setupGroupSession()` runs full copy on every invocation | MEDIUM | `bare-metal-runner.ts:252` | Latency, race condition |
| No message retention / index not optimal for query pattern | MEDIUM | `db.ts` | Long-term perf |
| `formatOutbound()` dual-signature API | LOW | `router.ts` | Confusion |
| Bot pool rename blocks IPC watcher | LOW | `telegram.ts:296` | IPC latency |
| Email `processedIds` set is unbounded | LOW | `email.ts:53` | Memory leak |
| `shutdown()` grace period parameter unused | LOW | `group-queue.ts:290` | Orphaned processes |
