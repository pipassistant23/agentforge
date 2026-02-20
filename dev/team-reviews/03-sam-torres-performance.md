# Performance Review — AgentForge Codebase

**Reviewer:** Sam Torres, Performance Engineer
**Date:** 2026-02-19
**Branch:** fix/agent-memory-autoload
**Scope:** Full codebase — orchestrator, IPC watcher, database layer, agent runner, queue, output parsing

---

## Executive Summary

AgentForge is a personal-scale assistant. At one to three registered groups with a single human operator, the current implementation handles its workload without visible problems. That said, the codebase carries several structural choices that will degrade gracefully — until they don't. The dominant risk profile is not throughput collapse, but event-loop stalls, unbounded memory growth, and per-invocation I/O waste that compounds as group count grows.

The most significant finding is the per-spawn filesystem work in `setupGroupSession`. On every agent invocation, the orchestrator performs up to ~20 synchronous filesystem operations — directory creates, stat calls, file copies, and writes — regardless of whether any files have changed. This is pure overhead at steady state. The second finding of note is the dual stdout accumulation pattern in `bare-metal-runner.ts`: both a logging buffer (`stdout`) and a parse buffer (`parseBuffer`) grow without bound until process exit, which creates a real risk of multi-hundred-megabyte heap allocations for long-lived agent processes.

The rest of the issues are lower severity but worth addressing before the system is shared or scaled.

**Overall verdict:** Sound architecture for its target scale. Three issues need fixing before they cause real problems. The rest are quality improvements.

---

## Strengths

**1. Polling intervals are sensible for a personal assistant.**
POLL_INTERVAL=2000ms and IPC_POLL_INTERVAL=1000ms land well for human-paced Telegram conversations. No user notices 2-second polling latency in a chat assistant. The SCHEDULER_POLL_INTERVAL=60000ms for cron is exactly appropriate — cron resolution is inherently minute-grained.

**2. better-sqlite3 is the right library for this access pattern.**
Despite the "synchronous" concern often raised against it, better-sqlite3 is faster than async SQLite wrappers for single-process use because it eliminates serialization overhead. The queries here are simple point lookups and small range scans. At this scale, the synchronous nature is a feature: predictable, not a hazard.

**3. The outputChain Promise-chain pattern is correct.**
Serializing `onOutput` callbacks through a Promise chain rather than parallelizing them is the right call. If `sendMessage` is slow (network round-trip to Telegram), overlapping calls would produce out-of-order delivery. The chain makes ordering a guarantee at the cost of throughput — acceptable given the message-by-message nature of Telegram conversations.

**4. exponential backoff in GroupQueue.scheduleRetry is correct.**
`BASE_RETRY_MS * 2^(retryCount-1)` with a cap at MAX_RETRIES=5 gives a worst-case retry window of 5 + 10 + 20 + 40 + 80 = 155 seconds. Sensible for agent process failures.

**5. Timeout reset on streaming output is architecturally correct.**
Resetting the hard kill timer (`resetTimeout`) on each output event means long-running multi-step agents are not killed mid-task just because they take a while. The distinction between "idle timeout" (IDLE_TIMEOUT, closes stdin) and "hard timeout" (AGENT_TIMEOUT, kills process) is well-designed.

**6. Per-process isolation for memory safety.**
Each agent invocation gets its own Node.js heap. A memory leak or runaway string accumulation in an agent process does not affect the orchestrator's heap. This is the correct architecture for a system running untrusted (LLM-generated) workloads.

**7. The MessageStream async iterable design in agent-runner is clean.**
The push/end pattern keeps the SDK's async iterator alive for multi-turn sessions without spin-looping. The `waiting` callback resolver avoids any polling inside the iterator itself. This is correct and efficient.

---

## Issues Found

---

### `[HIGH]` Dual stdout buffering creates unbounded heap growth in bare-metal-runner.ts

**Location:** `src/bare-metal-runner.ts` lines 286–367

**Problem:** Every stdout chunk is appended to two separate string buffers: `stdout` (capped at AGENT_MAX_OUTPUT_SIZE=10MB) and `parseBuffer` (uncapped until markers are consumed). `stdout` is bounded by the truncation guard, but `parseBuffer` is only drained when a complete START/END marker pair is found. If the agent emits a large volume of non-marker text between pairs — or if a marker pair spans many chunks — `parseBuffer` can grow arbitrarily.

More critically: string concatenation in JavaScript with `+=` on a large string does not amortize. Each append allocates a new string of length `oldLen + chunkLen`. For a busy agent that emits 500KB of non-marker debug text, the GC pressure from repeated large-string allocation is measurable.

**Measurement:** With AGENT_MAX_OUTPUT_SIZE=10MB, both `stdout` and `parseBuffer` can independently reach 10MB before the truncation guard fires on `stdout`. If `parseBuffer` holds the 9.9MB tail of an incomplete marker pair, total allocation for one agent is ~20MB of live strings plus GC churn from intermediate allocations.

**Fix:** Replace string concatenation on `parseBuffer` with a `Buffer[]` array, joined only when a marker is located. Replace `indexOf` scanning with a purpose-built scanner that tracks position:

```typescript
// Instead of:
parseBuffer += chunk;

// Use a chunk list with lazy join:
const parseChunks: Buffer[] = [];

agentProcess.stdout!.on('data', (data: Buffer) => {
  parseChunks.push(data);
  const combined = Buffer.concat(parseChunks).toString('utf8');
  // ... scan for markers, then reset parseChunks to the remainder
});
```

For the `stdout` logging buffer, the current truncation guard is correct but can be made allocation-free by switching to a counter-only approach — track `bytesLogged` without ever building the full string unless needed for error log output.

---

### `[HIGH]` setupGroupSession performs full filesystem I/O on every agent spawn

**Location:** `src/bare-metal-runner.ts` lines 93–212 (`setupGroupSession`)

**Problem:** This function is called unconditionally in `runContainerAgent` before every agent process spawn. It performs:

- `fs.mkdirSync` (recursive) for the session directory
- `fs.existsSync` + optional `fs.writeFileSync` for settings.json
- `fs.existsSync` for skillsSrc, then if present: `fs.readdirSync(skillsSrc)`, `fs.statSync` per entry, inner `fs.readdirSync` per skill directory, `fs.copyFileSync` per file
- 5x `fs.existsSync` + `fs.copyFileSync` for shared template files (SOUL.md, TOOLS.md, IDENTITY.md, BOOTSTRAP.md, HEARTBEAT.md)
- 3x `fs.existsSync` + optional `fs.writeFileSync` for group template files
- `fs.mkdirSync` for memory directory
- `fs.existsSync` + optional `fs.writeFileSync` for today's daily log
- `fs.existsSync` + optional `fs.writeFileSync` for heartbeat-state.json

At steady state (files already exist, day unchanged), every `existsSync` returns true and no writes occur — but every `existsSync` is still a `stat(2)` syscall. If there are 3 skill directories with 4 files each, that's 12 `copyFileSync` calls (each a `read(2)` + `write(2)` pair) on every single invocation.

**Big-O:** O(S * F) syscalls per spawn, where S = number of skill directories and F = average files per skill. With 3 skills and 4 files each: 12 `copyFileSync` calls + 5 template `copyFileSync` + ~15 `existsSync` = ~32 synchronous syscalls before the agent even starts.

**Real impact:** On an SSD, each syscall is ~10-50µs. 32 syscalls = ~1ms of blocking synchronous time per spawn. Not catastrophic for a personal assistant with one active group. But this runs on the main thread, blocking the event loop, and scales linearly with skill count.

**Fix (approach 1 — mtime guard):** Cache the mtime of source files and skip `copyFileSync` when destination exists and has the same or newer mtime:

```typescript
function needsCopy(src: string, dst: string): boolean {
  try {
    const srcStat = fs.statSync(src);
    const dstStat = fs.statSync(dst);
    return srcStat.mtimeMs > dstStat.mtimeMs;
  } catch {
    return true; // dst doesn't exist
  }
}
```

**Fix (approach 2 — call setupGroupSession lazily):** Move `setupGroupSession` out of the hot path. Call it once on group registration and once on service startup (to catch template updates), not on every spawn. A version sentinel file (e.g., `.setup-version`) can guard re-runs:

```typescript
const SETUP_VERSION = '2026-02-19-v1';
const versionFile = path.join(groupSessionsDir, '.setup-version');
const currentVersion = fs.existsSync(versionFile)
  ? fs.readFileSync(versionFile, 'utf-8').trim()
  : '';
if (currentVersion === SETUP_VERSION) return groupSessionsDir; // skip
// ... run setup ...
fs.writeFileSync(versionFile, SETUP_VERSION);
```

---

### `[MEDIUM]` getNewMessages re-queries SQLite on every 2-second tick even when idle

**Location:** `src/db.ts` lines 244–271, `src/index.ts` lines 427–501 (`startMessageLoop`)

**Problem:** The message loop calls `getNewMessages` every 2 seconds regardless of whether any messages have been stored since the last call. On a quiet system this is a DB query returning zero rows 99%+ of the time. The query itself is cheap (uses `idx_timestamp`), but the pattern prevents future event-driven improvements.

Additionally, within a single loop tick that finds new messages, `getMessagesSince` is called per group as a second DB query (line 472 in index.ts). For N groups with new messages in the same tick, that's 1 + N queries per tick.

**Combined query cost per busy tick:** `getNewMessages` (1) + `getMessagesSince` per triggered group (N) + `getMessagesSince` in `processGroupMessages` after queue dispatch (1 per group with trigger) = up to 1 + 2N queries in the worst case.

**Big-O:** O(N) DB queries per tick per triggered group. With 5 registered groups each receiving a trigger simultaneously: 1 + 10 = 11 DB queries in a 2-second window. Still fast for better-sqlite3 on SSD, but the pattern is wasteful.

**Recommendation:** Two complementary approaches:
1. Track whether `storeMessage` has been called since the last `getNewMessages`. A simple dirty flag (`let messageStoredSinceLastPoll = false`) set in `storeMessage` and cleared in the loop prevents the DB query entirely on idle ticks.
2. Merge the two `getMessagesSince` calls in the hot path. Currently `startMessageLoop` calls it once for context, then `processGroupMessages` calls it again for the same data. Pass the already-fetched messages down rather than re-querying.

---

### `[MEDIUM]` waitingGroups.includes() is O(n) in GroupQueue

**Location:** `src/group-queue.ts` lines 70, 102

**Problem:** `waitingGroups` is a plain `string[]`. Both `enqueueMessageCheck` and `enqueueTask` call `this.waitingGroups.includes(groupJid)` to avoid double-queuing a group. `Array.includes` is O(n). With MAX_CONCURRENT_PROCESSES=5 and many groups waiting, `includes` is called on every new message or task arrival, scanning the full waiting list each time.

**Big-O:** O(W) per enqueue call, where W = length of `waitingGroups`. With 20 waiting groups and bursts of incoming messages, this is 20 comparisons per call. Trivial today, but the fix is one line.

**Fix:** Replace `waitingGroups: string[]` with `waitingGroups: Set<string>` for O(1) membership checks. Maintain a separate ordered queue (`waitingQueue: string[]`) for the FIFO drain order, only appending to it when the Set-has check is false:

```typescript
private waitingGroups = new Set<string>();
private waitingQueue: string[] = [];

// On enqueue:
if (!this.waitingGroups.has(groupJid)) {
  this.waitingGroups.add(groupJid);
  this.waitingQueue.push(groupJid);
}

// On drain:
const nextJid = this.waitingQueue.shift()!;
this.waitingGroups.delete(nextJid);
```

---

### `[MEDIUM]` IPC watcher uses synchronous fs operations in an async function

**Location:** `src/ipc.ts` lines 74–198

**Problem:** `processIpcFiles` is an `async` function but all its I/O is synchronous: `fs.readdirSync`, `fs.statSync`, `fs.existsSync`, `fs.readFileSync`, `fs.unlinkSync`, `fs.mkdirSync`, `fs.renameSync`. Each of these blocks the event loop for the duration of the syscall.

For a typical run with 2 groups, 0 pending messages, and 0 pending tasks, `processIpcFiles` makes approximately:
- 1x `readdirSync(ipcBaseDir)` — scans the IPC root
- 2x `statSync` per entry — to filter to directories
- 2x `existsSync(messagesDir)` — both return true
- 2x `readdirSync(messagesDir)` — likely empty, O(1) directory read
- 2x `existsSync(tasksDir)` — both return true
- 2x `readdirSync(tasksDir)` — likely empty

= ~11 synchronous syscalls every 1000ms, on the main thread, regardless of whether anything is pending.

**Scaling analysis:** With G groups, the idle cost is O(4G) syscalls per second. At G=10 and ~25µs per syscall: 40 syscalls * 25µs = 1ms of blocking per second. Not a crisis, but it blocks anything else the event loop needs to do, including the message loop and Telegram callbacks.

**Recommendation:** Convert to `fs.promises` (`fs/promises`) API throughout `processIpcFiles`. Since the function is already `async`, this is a mechanical change. Use `await fs.promises.readdir()` instead of `fs.readdirSync()` etc. This yields back to the event loop during each syscall.

For a further improvement: use a short-circuit at the top of each loop iteration. If the directory read returns 0 files, skip the per-file processing entirely without a stat call:

```typescript
const messageFiles = await fsp.readdir(messagesDir).catch(() => []);
if (messageFiles.length === 0) continue;
```

---

### `[MEDIUM]` IPC watcher creates errors/ directory on every failure, every tick

**Location:** `src/ipc.ts` lines 146–147, 180–181

**Problem:** Every failed IPC file processing call does `fs.mkdirSync(errorDir, { recursive: true })`. If the errors directory already exists (the common case after the first failure), `mkdirSync` with `recursive: true` still performs a `stat(2)` to check existence before returning. This is a no-op stat on every retry — minor but pointless.

**Fix:** Create the errors directory once at watcher startup alongside the base IPC directory, then remove the per-failure `mkdirSync` call.

---

### `[MEDIUM]` getAllTasks() fetches all tasks on every agent invocation (runAgent + task runner)

**Location:** `src/index.ts` lines 335–348 (`runAgent`), `src/task-scheduler.ts` lines 107–120

**Problem:** Both `runAgent` (called for every user message that triggers an agent) and `runTask` (called for every scheduled task) call `getAllTasks()` to build the tasks snapshot. `getAllTasks` is an unbounded `SELECT *` with no LIMIT. As the task list grows, this query returns more rows each time, and the result is serialized to JSON and written to disk on every invocation.

For a personal assistant with 5 tasks this is negligible. But the pattern — fetching all tasks unconditionally for a snapshot that may not have changed — is worth noting. The snapshot file is overwritten even if nothing changed.

**Fix:** Track a tasks-dirty flag that is set whenever `createTask`, `updateTask`, or `deleteTask` is called. Only call `getAllTasks` and rewrite the snapshot when the flag is set:

```typescript
let tasksDirty = true; // force first write

export function markTasksDirty(): void { tasksDirty = true; }

function writeTasksIfDirty(groupFolder: string, isMain: boolean): void {
  if (!tasksDirty) return;
  tasksDirty = false;
  const tasks = getAllTasks();
  writeTasksSnapshot(groupFolder, isMain, tasks.map(...));
}
```

---

### `[MEDIUM]` Timeout timer churn: create/clearTimeout on every stdout chunk

**Location:** `src/bare-metal-runner.ts` lines 388–390 (`resetTimeout`)

**Problem:** `resetTimeout` is called on every parsed output marker from the agent. For a verbose agent that emits 100 result events, that is 100 `clearTimeout` + 100 `setTimeout` calls. Each `setTimeout` allocates a timer object. While Node's timer implementation is efficient (min-heap with O(log n) insert/remove), unnecessary churn is unnecessary.

This is low severity because agent output events are relatively infrequent (seconds apart), not microsecond-level. But it is trivially improvable.

**Fix:** Debounce the timeout reset: only reset if the timer has less than half its duration remaining. Or use a timestamp comparison:

```typescript
let lastOutputTime = Date.now();
let timeout = setTimeout(killOnTimeout, timeoutMs);

const resetTimeout = () => {
  const now = Date.now();
  // Only reschedule if we've consumed more than 10% of the timeout window
  if (now - lastOutputTime > timeoutMs * 0.1) {
    clearTimeout(timeout);
    timeout = setTimeout(killOnTimeout, timeoutMs);
  }
  lastOutputTime = now;
};
```

---

### `[MEDIUM]` runQuery re-reads AGENTS.md and memory files on every query in a session

**Location:** `agent-runner-src/src/index.ts` lines 562–617

**Problem:** `runQuery` is called in a loop: initial message, then once per follow-up IPC message within the same process lifetime. On every call, it reads:
- `WORKSPACE_GLOBAL/AGENTS.md` (if non-main and exists)
- `WORKSPACE_GROUP/AGENTS.md` (if exists)
- `WORKSPACE_GROUP/memory.md`
- `WORKSPACE_GROUP/memory/YYYY-MM-DD.md` (yesterday)
- `WORKSPACE_GROUP/memory/YYYY-MM-DD.md` (today)

For a session with 10 follow-up messages, this is 10 * (up to 5 file reads) = 50 `readFileSync` calls, all synchronous. The system prompt built from these files is then passed to the SDK on every query call. If the files have not changed mid-session (the common case), these reads return the same content each time.

**Fix:** Cache the file contents and their mtime at first read. Re-read only if the mtime has changed:

```typescript
const systemPromptCache = {
  content: '',
  mtimes: {} as Record<string, number>,
};

function readIfChanged(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const mtime = fs.statSync(filePath).mtimeMs;
  if (systemPromptCache.mtimes[filePath] === mtime) {
    return null; // unchanged
  }
  systemPromptCache.mtimes[filePath] = mtime;
  return fs.readFileSync(filePath, 'utf-8');
}
```

---

### `[LOW]` saveState() writes two DB rows on every cursor advancement

**Location:** `src/index.ts` lines 117–120 (`saveState`)

**Problem:** `saveState` calls `setRouterState` twice — once for `last_timestamp` and once for `last_agent_timestamp`. Each call is a separate SQLite `INSERT OR REPLACE` statement. They are not wrapped in a transaction. On a busy system with multiple groups triggering in the same 2-second window, `saveState` can be called 3-4 times per tick, each time doing 2 writes.

**Fix:** Wrap both writes in an explicit transaction:

```typescript
function saveState(): void {
  db.transaction(() => {
    setRouterState('last_timestamp', lastTimestamp);
    setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  })();
}
```

This reduces 2 individual writes to 1 transaction round-trip, which matters for WAL-mode SQLite where each commit is a fsync.

---

### `[LOW]` Queue restart loses all pending state

**Location:** `src/group-queue.ts` lines 28–31

**Problem:** `GroupQueue` is a pure in-memory structure. On service restart (e.g., after `npm run build`), all `pendingMessages` flags, `waitingGroups`, and `retryCount` values are lost. `recoverPendingMessages()` in `index.ts` partially compensates by re-queuing groups that have unprocessed messages, but pending tasks in `pendingTasks[]` arrays are not recovered.

This is explicitly called out in comments, but it means scheduled tasks that were queued but not yet started at restart time will miss their scheduled fire window and only run on the next 60-second scheduler tick.

**Severity clarification:** For a personal assistant with minute-granularity tasks and fast restarts, this is acceptable. Flagging as LOW rather than ignoring because the recovery gap can be hours if the service crashes between scheduler ticks.

**Fix:** On `startSchedulerLoop` startup, run `getDueTasks` immediately (not just after the first 60-second interval) to catch any tasks that fired during downtime. The current code calls `loop()` immediately, which already calls `getDueTasks` — so this is already partially addressed. The gap is tasks queued in `pendingTasks[]` that haven't been run yet. These are re-catchable through the scheduler on next tick, so in practice the issue self-heals within 60 seconds.

---

### `[LOW]` `drainWaiting` can skip groups with no pending work after a restart

**Location:** `src/group-queue.ts` lines 271–288

**Problem:** `drainWaiting` pops a JID from `waitingGroups`, checks `state.pendingTasks` and `state.pendingMessages`, and silently skips the group if both are empty (this can happen if the work was already picked up by another path). The slot consumed by that pop is immediately available for the next iteration. This is correct, but the comment "If neither pending, skip this group" could cause confusion if `waitingGroups` becomes stale (entries that should have been pruned weren't). This is a logic-correctness observation more than a performance concern.

---

### `[LOW]` No index on messages(chat_jid, timestamp) — composite index would be faster

**Location:** `src/db.ts` line 55

**Problem:** The current index is:
```sql
CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
```

The `getMessagesSince` query filters by `chat_jid = ?` AND `timestamp > ?`. With only the timestamp index, SQLite scans by timestamp first, then filters by `chat_jid`. For a system with many messages across many groups, rows matching the timestamp range but belonging to other groups must be visited and discarded.

**Fix:** Add a composite index:
```sql
CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON messages(chat_jid, timestamp);
```

This allows SQLite to seek directly to the chat_jid + timestamp position, making `getMessagesSince` a tight range scan. The existing `idx_timestamp` can be dropped after this is added since the composite index covers single-column timestamp queries (though the planner may still prefer it for `getNewMessages` which scans multiple JIDs — so retain both until profiled).

This is covered more thoroughly in Jordan Kim's database review.

---

### `[IDEA]` Replace polling loop with Telegram webhook mode for event-driven message delivery

**Location:** `src/index.ts` `startMessageLoop`, `src/channels/telegram.ts`

**Current:** The message loop polls SQLite every 2000ms for new messages. The Telegram bot uses long-polling (grammy's default `bot.start()`), which keeps an open HTTP connection to Telegram's servers and receives updates pushed by Telegram. Messages arrive in the grammy callback in near-real-time, are stored to SQLite, and then sit in the DB until the next 2-second poll tick picks them up.

**Observation:** The 2-second poll interval is not the latency bottleneck — grammy's long-poll already delivers messages within ~1 second. The SQLite poll is a secondary hop. The actual message latency is: Telegram delivers → grammy callback fires → `storeMessage` → up to 2000ms of poll wait → agent invocation. So response latency is 0ms to 2000ms of additional wait after the message arrives.

**Idea:** Eliminate the poll-and-discover pattern by triggering agent invocation directly from the Telegram message callback, bypassing the SQLite poll loop for the "new message" signal. The DB still stores messages for context, but the queue trigger comes from the callback rather than the poll.

```typescript
// In telegram.ts onMessage handler:
this.opts.onMessage(chatJid, msg);  // stores to DB as now
this.opts.onNewMessageTrigger?.(chatJid);  // new: signals queue directly
```

This reduces message-to-agent latency by up to 2 seconds and eliminates one DB query per tick on the hot path. The poll loop could then run at a lower frequency (e.g., 30s) purely as a recovery mechanism for missed callbacks.

---

### `[IDEA]` Use `fs.watch` on IPC directories instead of polling

**Location:** `src/ipc.ts`

**Current:** The IPC watcher polls all group IPC directories every 1000ms with synchronous reads.

**Idea:** Replace the polling loop with `fs.watch` (or `chokidar` for reliability) on each group's `messages/` and `tasks/` subdirectories. File system events fire within milliseconds of a file being created, reducing IPC latency from 0-1000ms to near-zero and eliminating idle CPU/syscall overhead.

```typescript
import { watch } from 'fs';

const watcher = watch(messagesDir, (event, filename) => {
  if (event === 'rename' && filename?.endsWith('.json')) {
    processMessageFile(path.join(messagesDir, filename));
  }
});
```

**Caveats:** `fs.watch` has known reliability issues on Linux (inotify event coalescing, missed events under high load). The current polling fallback should be retained as a secondary recovery mechanism. A hybrid approach — `fs.watch` for primary delivery, 5s poll as heartbeat — gives both latency and reliability.

---

### `[IDEA]` Structured stdout framing instead of string-searched sentinel markers

**Location:** `src/bare-metal-runner.ts` lines 372–406, `agent-runner-src/src/index.ts` lines 155–160

**Current:** Output is framed with `---AGENTFORGE_OUTPUT_START---` / `---AGENTFORGE_OUTPUT_END---` text markers, and the parent process scans the accumulated `parseBuffer` string with `indexOf` on every chunk.

**Idea:** Replace with length-prefixed binary framing. Each output frame is prefixed with a 4-byte big-endian length field, followed by the JSON payload. The parent reads exactly N bytes per frame without string scanning:

```typescript
// Agent side:
function writeOutput(output: ContainerOutput): void {
  const json = JSON.stringify(output);
  const buf = Buffer.alloc(4 + json.length);
  buf.writeUInt32BE(json.length, 0);
  buf.write(json, 4);
  process.stdout.write(buf);
}

// Host side:
// Maintain a Buffer, read 4-byte length header, then read exactly that many bytes.
```

This eliminates all string scanning on every chunk, makes parseBuffer O(1) to process (known length), and prevents any ambiguity if JSON output happens to contain the marker string. The tradeoff is a breaking change to the IPC protocol — both sides must be updated simultaneously.

---

### `[IDEA]` Agent process warm pool for faster response time

**Location:** `src/bare-metal-runner.ts` `runContainerAgent`

**Current:** Every agent invocation spawns a fresh `node` process (~100-200ms startup per the CLAUDE.md note), reads secrets from disk, initializes QMD, and starts the SDK.

**Idea:** Maintain a small pool of pre-warmed agent processes (1-2 per registered group) that have already loaded Node.js, initialized QMD, and are blocked at `await readStdin()`. When a new invocation arrives, the orchestrator picks an idle process from the pool, writes the prompt to its stdin, and reuses it. This eliminates the 100-200ms cold-start cost and the per-spawn filesystem setup work.

**Implementation sketch:**
```typescript
// Pool entry: a pre-spawned process waiting for its first prompt
interface WarmProcess {
  proc: ChildProcess;
  resolve: (prompt: AgentInput) => void;
}
const warmPool = new Map<string, WarmProcess[]>();

async function getWarmProcess(group: RegisteredGroup): Promise<ChildProcess> {
  const pool = warmPool.get(group.folder) || [];
  if (pool.length > 0) return pool.shift()!.proc;
  return spawnFreshProcess(group);
}
```

**Complexity:** The agent-runner's `main()` would need to support a "wait for prompt" mode before the query loop. This is a significant refactor of the IPC protocol but would be the single highest-impact latency improvement available.

---

## Recommendations (Priority Order)

1. **Fix the parseBuffer unbounded growth** (HIGH): Switch from string concatenation to a `Buffer[]` chunk list. This prevents potential OOM on long agent runs. One-day fix, high safety impact.

2. **Cache setupGroupSession** (HIGH): Add a version-sentinel guard to skip re-running the full filesystem setup on every spawn. The easiest form is a single `existsSync` check on a `.setup-version` file. Half-day fix.

3. **Convert IPC watcher to async fs operations** (MEDIUM): Swap `fs.readdirSync` etc. for `await fsp.readdir` etc. This returns event-loop time during the ~11 idle syscalls per second. Mechanical change, one day.

4. **Add composite index on messages(chat_jid, timestamp)** (LOW/MEDIUM): One SQL statement, backward-compatible addition. Makes `getMessagesSince` a tight seek rather than a filtered scan. Coordinate with Jordan Kim's DB review.

5. **Fix waitingGroups to use a Set** (MEDIUM): One-line data structure change. No behavior change. Thirty-minute fix.

6. **Add tasks-dirty flag** (MEDIUM): Avoid `getAllTasks()` + `writeTasksSnapshot` on every invocation. Two-hour fix.

7. **Add Telegram-triggered queue dispatch** (IDEA → MEDIUM): Wire `onMessage` callback to directly enqueue without waiting for the poll loop. Reduces worst-case latency by 2 seconds. Half-day fix.

---

## Appendix: Syscall Inventory for setupGroupSession (Steady State)

The following table documents the synchronous syscalls made by `setupGroupSession` when called at steady state (all files exist, same day as last call). This represents pure overhead on every agent invocation.

| Operation | Syscall | Count | Notes |
|---|---|---|---|
| `mkdirSync(groupSessionsDir, recursive)` | `stat` + no-op | 1 | Dir exists, does nothing |
| `existsSync(settingsFile)` | `stat` | 1 | Returns true |
| `existsSync(skillsSrc)` | `stat` | 1 | Returns true |
| `readdirSync(skillsSrc)` | `getdents` | 1 | Lists skill dirs |
| `statSync(srcDir)` per skill | `stat` | S | S = skill count |
| `mkdirSync(dstDir, recursive)` per skill | `stat` | S | Dirs exist |
| `readdirSync(srcDir)` per skill | `getdents` | S | Lists skill files |
| `copyFileSync` per skill file | `open`+`read`+`write` | S*F | F = files per skill |
| `existsSync(srcFile)` per template | `stat` | 5 | Template files |
| `copyFileSync` per template | `open`+`read`+`write` | 5 | Copies even if unchanged |
| `existsSync` per group template | `stat` | 3 | Returns true |
| `mkdirSync(memoryDir, recursive)` | `stat` | 1 | Dir exists |
| `existsSync(todayLogPath)` | `stat` | 1 | Returns true |
| `existsSync(heartbeatStatePath)` | `stat` | 1 | Returns true |
| **Total (3 skills, 4 files each)** | | **~32** | **~0.8ms blocking** |

All of these run synchronously on the main thread before the agent process is spawned. A version-sentinel guard would reduce this to 2 syscalls: `existsSync(versionFile)` + `readFileSync(versionFile)`.

---

*Review completed by Sam Torres, Performance Engineer — AgentForge Dev Team*
*For related findings, see Jordan Kim's database review (#04) and Chris Wu's concurrency review (#05).*
