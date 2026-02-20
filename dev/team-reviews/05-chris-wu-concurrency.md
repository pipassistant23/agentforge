# Concurrency & IPC Review — AgentForge

**Reviewer:** Chris Wu, Concurrency Specialist
**Date:** 2026-02-19
**Branch:** fix/agent-memory-autoload
**Files reviewed:** src/group-queue.ts, src/bare-metal-runner.ts, src/ipc.ts, src/index.ts, src/task-scheduler.ts, src/db.ts, src/config.ts

---

## Executive Summary

AgentForge runs as a single-threaded Node.js event loop that spawns multiple baremetal child processes and coordinates them through a combination of file-based IPC and an in-process queue abstraction. The architecture is fundamentally sound: the single event loop eliminates the classic shared-mutable-state races found in multi-threaded systems, and the `GroupQueue` correctly serializes per-group work. File-based IPC with atomic rename is a well-established pattern that holds up on Linux ext4/xfs filesystems.

That said, there are genuine hazards buried in the async/await interactions, the `waitingGroups` data structure, the `closeStdin` sentinel ordering, and several less obvious edge cases around the outputChain memory model and cursor advancement under partial failure. None of these are showstoppers at a single-group scale, but several will cause user-visible data loss or duplicated messages as group count grows.

**Severity distribution:** 0 CRITICAL | 4 HIGH | 5 MEDIUM | 4 LOW | 3 IDEAS

---

## Strengths

### Single-threaded event loop eliminates most concurrency hazards
The entire orchestrator — GroupQueue, cursor state, registeredGroups, sessions — lives in one V8 isolate. There are no shared-memory race conditions between event loop iterations because JavaScript is non-preemptive: no two callbacks run simultaneously. This eliminates whole categories of bugs (lock inversions, torn reads, ABA problems) that would require mutexes in a multi-threaded design.

### GroupQueue correctly serializes per-group execution
The `state.active` flag and the finally-block cleanup in `runForGroup` and `runTask` guarantee that only one agent process runs per group at a time, even if `enqueueMessageCheck` is called multiple times while a process is running. The sequential nature of the event loop means these flag reads and writes are effectively atomic — no interleaving can occur between the check and the set.

### Atomic IPC writes via rename
`sendMessage` writes to a `.tmp` file first and then renames it into place. On Linux, `rename(2)` is atomic when source and destination are on the same filesystem (guaranteed here since they share `DATA_DIR`). An agent polling the input directory will either see the complete file or not see it at all — there is no partial-read window.

### outputChain correctly serializes async callbacks
The `outputChain` promise chain in `bare-metal-runner.ts` sequences every `onOutput` call, so streaming chunks are delivered to the caller in order even though each chunk involves async work (Telegram API calls, DB writes). This is the right pattern — without it, a slow Telegram send on chunk N could interleave with chunk N+1.

### ipcWatcherRunning / messageLoopRunning / schedulerRunning guards
All three long-running loops have a module-level boolean guard preventing duplicate starts. Because these run in the event loop and the flags are set synchronously before any await, a second call will always see the flag already set. This is correct and safe.

### IPC authorization is derived from directory path, not payload
The IPC watcher determines the sending group's identity from the filesystem directory it found the file in, not from a `groupFolder` field inside the JSON payload. This makes it impossible for a compromised or buggy agent to spoof a different group's identity. The folder regex validation on `register_group` prevents path traversal.

### Duplicate-task prevention in enqueueTask
`state.pendingTasks.some(t => t.id === taskId)` prevents the scheduler from queuing the same task twice if the scheduler loop fires again before the task has started. The `pendingTasks` array is checked synchronously and the scheduler runs in the event loop, so there is no TOCTOU gap.

### Startup recovery for crashed cursors
`recoverPendingMessages()` on startup catches the case where `lastAgentTimestamp` was advanced but the agent process never completed. Messages that fell into that window are re-queued, preventing silent drops after a crash.

---

## Issues Found

### [HIGH] `waitingGroups` array allows duplicate JID entries

**File:** `src/group-queue.ts`, lines 68–110

`enqueueMessageCheck` and `enqueueTask` both guard against duplicates with `this.waitingGroups.includes(groupJid)`, which is O(n). This guard is correct in isolation, but the two methods are independent code paths. Consider this sequence:

1. Group A hits the concurrency limit from `enqueueMessageCheck` → pushed to `waitingGroups`.
2. Before drainWaiting runs, a scheduled task arrives for Group A via `enqueueTask` → `includes` check passes (A is already there) → not pushed again. So far correct.
3. However, if the timing is reversed — task enqueued first, then message — and there is an intermediate `drainWaiting()` call that pops A off but A's slot is immediately consumed by another group reaching its limit again, A can be re-pushed via `enqueueTask` while a residual entry still exists from a prior `enqueueMessageCheck` path.

More critically: `includes` is O(n). With MAX_CONCURRENT_PROCESSES=5 and many groups this is fine today, but it is a latent O(n²) in the drain hot path.

**The real bug:** `drainWaiting` pops the JID but then checks `state.pendingTasks` and `state.pendingMessages` — if neither is true (the work finished while waiting), it skips the group and continues. This is correct. But there is no cleanup of duplicates if both `enqueueMessageCheck` and `enqueueTask` raced to push the same JID before either saw the other's `includes` guard, because both branches read `waitingGroups` from the same synchronous frame but the deduplication logic in the two methods is not shared.

**Fix:** Replace `waitingGroups: string[]` with `waitingGroups: Set<string>`. `Set.has` is O(1), `Set.add` is idempotent, and `Set` can be iterated with shift-equivalent semantics using an iterator plus delete. Or use an array but deduplicate at the single push site with a shared helper.

```typescript
// Replace
private waitingGroups: string[] = [];
// With
private waitingGroupsSet = new Set<string>();
private waitingGroupsQueue: string[] = []; // maintains FIFO order
```

Or more simply, accept that Set doesn't have O(1) FIFO, but keep the insert-dedup responsibility in one place:

```typescript
private addToWaiting(groupJid: string): void {
  if (!this.waitingGroupsSet.has(groupJid)) {
    this.waitingGroupsSet.add(groupJid);
    this.waitingGroupsQueue.push(groupJid);
  }
}
```

---

### [HIGH] `closeStdin` sentinel has no ordering guarantee relative to pending input files

**File:** `src/group-queue.ts`, lines 153–164; `src/index.ts`, lines 239–248

The idle timer in `processGroupMessages` calls `queue.closeStdin(chatJid)` after `IDLE_TIMEOUT` (default 30 minutes) of no output. This writes a `_close` sentinel file to `ipc/{groupFolder}/input/`. The agent reads the `input/` directory and is expected to exit when it sees `_close`.

The ordering problem: the orchestrator can call `sendMessage` (which writes `{timestamp}-{random}.json`) and then have the idle timer fire and write `_close` within the same event loop turn, or across two turns in rapid succession. The agent polls its input directory with `readdir`, which returns entries in filesystem order (on Linux ext4: hash-tree order, not creation order). There is no guarantee `_close` will appear after the message file in `readdir` output.

If the agent reads `_close` first, it exits before processing the message file. That message is then orphaned in the input directory forever — it will not be reprocessed because the agent process is gone and the orchestrator does not re-scan the agent's input directory.

**Concrete scenario:**
1. User sends message while agent is running → `sendMessage` writes `1708000000-abc1.json`.
2. Agent is slow to respond → idle timer fires → `closeStdin` writes `_close`.
3. Agent's next poll picks up `_close` before `1708000000-abc1.json` → exits.
4. Message is silently dropped.

**Fix options:**
- Name the sentinel with a timestamp far in the future so lexicographic sort puts it last: `_close-99999999999` vs `{timestamp}-{random}.json`. Agent sorts readdir output before processing.
- Have the agent process all non-sentinel files before acting on `_close`.
- Have `closeStdin` check for pending files in the input directory before writing the sentinel, with a small delay.

The most robust fix is in the agent runner: always drain all non-sentinel files from the input directory before honoring `_close`. This keeps the sentinel semantics simple and makes the protocol resilient to any ordering.

---

### [HIGH] `sendMessage` returns false and silently drops the message when `state.groupFolder` is null

**File:** `src/group-queue.ts`, lines 132–148; `src/index.ts`, lines 481–495

In `startMessageLoop`, when a new message arrives for a group with an active process, the orchestrator calls `queue.sendMessage(chatJid, formatted)`. If this returns `true`, the cursor is advanced and the message is considered delivered to the agent. If it returns `false`, `enqueueMessageCheck` is called to start a new process.

`sendMessage` returns `false` when `!state.active || !state.groupFolder`. The `state.active` check is correct. But `state.groupFolder` is set by `registerProcess`, which is called from the `onProcess` callback in `runContainerAgent`:

```typescript
// In runContainerAgent (bare-metal-runner.ts line 284):
onProcess(agentProcess, processName);
// This calls:
queue.registerProcess(chatJid, proc, processName, group.folder);
```

This callback fires synchronously immediately after `spawn()`. However, between `runForGroup` setting `state.active = true` (line 172) and `runContainerAgent` calling `onProcess` (line 284 of bare-metal-runner), there is an `await` chain:

```
runForGroup → await processMessagesFn(groupJid)
           → processGroupMessages → runAgent → runContainerAgent
```

Inside `runContainerAgent`, `onProcess` is called synchronously right after `spawn()`, which happens before the Promise is returned. So in practice `state.groupFolder` should be set by the time any `sendMessage` call could race against it.

However, there is still a real null window. `state.groupFolder` is cleared to `null` in the `finally` block of `runForGroup` (line 196) after the process exits. The `drainGroup` call in the same finally block can trigger a new `runForGroup`, which sets `state.active = true` again — but `state.groupFolder` is `null` until `registerProcess` is called from within the new invocation. If a message arrives in the event loop turn between `state.active = true` in the new `runForGroup` and the `registerProcess` call, `sendMessage` returns `false` even though `state.active` is `true`. The caller then queues a second message check, which queues up behind the already-running process — so the message is not dropped in this path, but the false return causes unnecessary work.

More importantly: the `state.active` check in `sendMessage` is evaluated before `state.groupFolder` is populated. The comment "Returns false if no active process" is misleading — it can return false even when a process is active and running.

**Fix:** Initialize `state.groupFolder` from the group configuration before setting `state.active = true`, or restructure `runForGroup` to accept `groupFolder` and set it before the await.

---

### [HIGH] `lastAgentTimestamp` cursor advancement before agent completes creates a drop window

**File:** `src/index.ts`, lines 220–224

In `processGroupMessages`:

```typescript
// Advance cursor before the agent runs
lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
saveState();
// ... then run the agent (may take minutes)
const output = await runAgent(group, prompt, chatJid, ...);
// Only roll back on error without prior output
```

The advance-then-rollback design is intentional — it prevents the message loop from re-fetching these messages while the agent is running. But there is a gap: if the process crashes (SIGKILL from OS, OOM, hardware fault) after the cursor advances but before the agent outputs anything, the messages are lost. On restart, `recoverPendingMessages` would catch this since the cursor is ahead of what the agent confirmed.

Wait — `recoverPendingMessages` calls `getMessagesSince(chatJid, lastAgentTimestamp[chatJid])`. If the cursor was advanced and persisted before the crash, `lastAgentTimestamp` will be at the new position after restart, and `getMessagesSince` will return nothing. The messages are dropped.

The rollback only happens in the normal error path (`output === 'error'`) within the same process run. A hard crash bypasses the rollback entirely.

**This is the most serious data-integrity hazard in the codebase.** For a personal assistant with 30-minute agent runs, this is a realistic crash window.

**Fix options:**
- Use a two-phase commit pattern: write `pendingCursor` to DB separately from `lastAgentTimestamp`. On startup, if `pendingCursor > lastAgentTimestamp`, treat messages in that range as unprocessed. Promote `pendingCursor` to `lastAgentTimestamp` only after confirmed agent output.
- Alternatively, do not advance the cursor optimistically. Use a per-run "in-flight" marker in the DB (e.g., a `status = 'running'` row in a small `agent_runs` table). On startup, any `running` row whose group has messages after the pre-run cursor is re-queued.
- At minimum, document this window clearly and ensure `recoverPendingMessages` is correct. (It is currently not — see analysis above.)

---

### [MEDIUM] `outputChain` grows unboundedly for long-running agents

**File:** `src/bare-metal-runner.ts`, lines 348–399

The `outputChain` pattern:

```typescript
let outputChain = Promise.resolve();
outputChain = outputChain.then(() => onOutput(parsed)).catch(...);
```

Each `.then()` creates a new Promise that retains a reference to the previous one in the chain. For a 30-minute agent session with Claude streaming hundreds of tool-use steps, this chain can grow to thousands of Promise objects. Each holds a closure over `onOutput`, `parsed`, the group name, and the logger reference. V8 cannot GC earlier chain links until the entire chain resolves.

In practice, for a personal assistant the memory impact is modest (a few MB for hundreds of outputs). But if an agent runs in a tight tool-use loop (e.g., agentic file-processing tasks), the chain can become very long.

**Fix:** Reset the chain at natural checkpoints — e.g., after each confirmed output delivery, replace `outputChain` with the already-resolved tail:

```typescript
// After each .then(), reassign to the settled tail to allow GC
outputChain = outputChain.then(() => onOutput(parsed)).catch(...);
// outputChain is now the latest Promise; prior links can be GC'd
// once they settle (V8 does this automatically for non-circular chains)
```

Actually, V8 does GC settled Promise links that are no longer referenced from any live root. The current pattern re-assigns `outputChain` to the new tail each time, so the prior links are only referenced by the new Promise's internal `[[PromiseFulfillReactions]]` list until they settle. In practice, V8 clears these quickly. This is LOW severity, not MEDIUM, but warrants monitoring on high-throughput groups.

Revised severity: **[LOW]** — the current pattern is safe in practice for this use case. Document it.

---

### [MEDIUM] `drainGroup` calls `runTask` / `runForGroup` synchronously from a `finally` block

**File:** `src/group-queue.ts`, lines 192–198, 249–268

```typescript
// In runForGroup finally:
state.active = false;
this.activeCount--;
this.drainGroup(groupJid);
```

`drainGroup` may call `runTask` or `runForGroup`, which are `async` functions. They are called without `await`, so their Promises are fire-and-forget. This is intentional — the queue is designed this way. But the implication is:

1. The call to `drainGroup` returns synchronously.
2. `runTask`/`runForGroup` begin executing (synchronously up to their first `await`), then yield.
3. The `finally` block in the parent `runForGroup` completes.
4. The outer `await this.processMessagesFn(groupJid)` in `runForGroup` resolves.

The `state.active = true` in the new `runTask`/`runForGroup` is set synchronously (before any await) in those methods. So by the time the parent's finally block finishes, `state.active` is already `true` again for the next run. This is correct.

However, it means that if `drainGroup` calls both `runTask` (which exits quickly) and the task's finally calls `drainGroup` again, which calls `runForGroup` — there is a recursive drain chain happening across multiple event loop turns with no explicit depth tracking. This is safe because Node.js tail-calls are not recursive in the V8 sense (each is a separate Promise microtask), but it makes the call chain difficult to trace in profiling output.

**Impact:** Low. The behavior is correct. Annotate with a comment explaining the fire-and-forget intent.

---

### [MEDIUM] Scheduler does not update `next_run` before enqueuing — duplicate runs possible across scheduler ticks

**File:** `src/task-scheduler.ts`, lines 245–263

`getDueTasks()` returns all tasks with `next_run <= now`. The scheduler loop fires every 60 seconds. If a task's `next_run` is 10 seconds ago and the task takes 70 seconds to run (longer than the scheduler interval), the next scheduler tick fires while the task is still running.

The deduplication guard is `enqueueTask`'s `state.pendingTasks.some(t => t.id === taskId)`. This prevents double-queuing of a task that is already in `pendingTasks`. But a task that is actively running is not in `pendingTasks` — it was popped out by `runTask`. `state.active` is `true` while it runs, so `enqueueTask` will push the new invocation to `pendingTasks` correctly (lines 94–98). So the task will queue up a second run, and when the first run finishes and calls `updateTaskAfterRun`, it advances `next_run` to the future. The second run then executes with the old prompt, which is correct, but it runs against a `next_run` that has already been advanced.

The net effect: if a task consistently takes longer than the scheduler interval, it will run twice in quick succession on each period. `updateTaskAfterRun` is called after each run and advances `next_run` correctly, so the task won't accumulate infinitely. But two runs in rapid succession is unexpected user behavior.

**Fix:** Mark tasks as `in-progress` in the DB before enqueueing, and filter `in-progress` tasks from `getDueTasks`. Reset to `active` after the run (success or failure). This adds one DB write per task execution but prevents the double-run.

---

### [MEDIUM] IPC poll loop reads message files while agent may still be writing

**File:** `src/ipc.ts`, lines 96–103

The IPC watcher reads all `.json` files from the messages directory with `readdirSync` and immediately reads each one with `readFileSync`. The agent writes files atomically using the `.tmp`-then-rename pattern — so any `.json` file that appears in the directory is already complete. This is correct.

However, the watcher calls `fs.existsSync(messagesDir)` then `fs.readdirSync(messagesDir)` — two separate syscalls with a TOCTOU gap. If the agent deletes the messages directory between these two calls (unlikely but possible if the agent cleans up its workspace), the `readdirSync` will throw and be caught by the outer try/catch. This is fine — the error is logged and the loop continues.

More interesting: the watcher's outer loop processes `groupFolders` returned from `readdirSync(ipcBaseDir)` at the start of the tick. If an agent creates a new IPC directory mid-tick (e.g., a group registers while the tick is processing), the new directory is missed until the next tick. This is expected and not a bug — just confirm it matches the design intent. It does.

**The real concern** is file rename from messagesDir to errorDir:

```typescript
fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
```

If two different messages from the same group happen to have the same filename (extremely unlikely given the timestamp + random suffix format, but possible under clock skew), and both fail processing, the second rename would overwrite the first error file. The first error file is silently lost.

**Fix:** Append a random suffix to the error filename:

```typescript
const errorName = `${sourceGroup}-${Date.now()}-${file}`;
```

---

### [MEDIUM] `processGroupMessages` and `startMessageLoop` both advance `lastAgentTimestamp` — interleaved updates

**File:** `src/index.ts`, lines 481–495

`startMessageLoop` advances `lastAgentTimestamp[chatJid]` when `queue.sendMessage` succeeds (piping a message to an active process). `processGroupMessages` also advances `lastAgentTimestamp[chatJid]` at the start of a new agent run.

These two paths can interleave as follows:

1. Agent A is running for group G.
2. A new message arrives → `sendMessage` succeeds → `lastAgentTimestamp[G]` advanced to T1, saved.
3. Agent A finishes → `drainGroup` → `runForGroup` → `processGroupMessages` starts.
4. `processGroupMessages` calls `getMessagesSince(G, lastAgentTimestamp[G])` — this is now T1.
5. If T1 is the timestamp of the piped message, `getMessagesSince` returns nothing, and `processGroupMessages` returns early with `true` (line 207).

This is actually the **intended behavior**: the message was already delivered by the pipe path. But the comment "Advance cursor so the piping path in startMessageLoop won't re-fetch these messages" (line 219) implies only processGroupMessages advances it, when in fact `startMessageLoop` also advances it. The two advances can create a situation where `processGroupMessages` sees an empty message list and returns a false-positive success even if the piped message was never processed by the agent (e.g., if the agent exited before reading the piped file).

This compounds with the `_close` sentinel ordering issue (#2 above): if the sentinel raced the piped message file and the agent exited without processing it, the cursor is already advanced past that message, and there is no recovery path.

**This is not a standalone bug** but is an amplifier for Issue #2. Fix Issue #2 and this concern largely resolves.

---

### [LOW] `shutdown` does not wait for `runForGroup`/`runTask` Promises to settle

**File:** `src/group-queue.ts`, lines 290–307

`shutdown()` sets `this.shuttingDown = true` and logs active processes, but does not await their completion. The `runForGroup` and `runTask` Promises continue running after `shutdown` returns. In `main()`:

```typescript
const shutdown = async (signal: string) => {
  await queue.shutdown(10000); // resolves immediately
  for (const ch of channels) await ch.disconnect();
  process.exit(0);          // ← kills the process while agents may still run
};
```

The comment "processes detached, not killed" is intentional — the design choice is to let agents finish naturally via their own idle timeout. But `process.exit(0)` after `ch.disconnect()` will terminate the Node.js process immediately, killing all outstanding Promises including in-flight `runForGroup` calls.

This means:
- Any `onOutput` callback that hasn't fired yet is dropped.
- Any `saveState()` call in the finally block of `runForGroup` that hasn't executed is skipped.
- The cursor rollback path (`lastAgentTimestamp[chatJid] = previousCursor`) is skipped.

**In practice**, systemd's `KillMode` and the `TimeoutStopSec` setting determine how long the process gets. But the shutdown code itself makes no attempt to drain in-flight promises.

**Fix:** Return a Promise from `shutdown` that resolves when all active `runForGroup`/`runTask` invocations complete (up to the grace period). This requires tracking the active Promise objects, not just the count. The `_gracePeriodMs` parameter exists but is unused.

```typescript
private activePromises = new Set<Promise<void>>();
// In runForGroup/runTask: add to set, remove in finally
async shutdown(gracePeriodMs: number): Promise<void> {
  this.shuttingDown = true;
  const timeout = new Promise<void>(r => setTimeout(r, gracePeriodMs));
  await Promise.race([Promise.all([...this.activePromises]), timeout]);
}
```

---

### [LOW] `_close` sentinel is written with `writeFileSync` (not atomic)

**File:** `src/group-queue.ts`, lines 158–163

`sendMessage` uses the atomic `.tmp`-then-rename pattern. `closeStdin` does not:

```typescript
fs.writeFileSync(path.join(inputDir, '_close'), '');
```

Since the file content is empty (zero bytes), a partial write is impossible — the file either exists or it doesn't. On Linux, `open()` + `write()` + `close()` for a zero-byte file is effectively atomic at the filesystem level. So this is not a real bug in practice, but it is inconsistent with the explicit atomic-rename pattern used by `sendMessage`. If someone later adds content to `_close` (e.g., a shutdown reason), the non-atomic write becomes a real hazard.

**Fix:** Use the same `.tmp`-then-rename pattern for consistency and future-safety.

---

### [LOW] `ipcWatcherRunning` is a module-level singleton but could be reset by test teardown

**File:** `src/ipc.ts`, line 49

```typescript
let ipcWatcherRunning = false;
```

This module-level variable persists for the lifetime of the module. In tests that `vi.resetModules()` between runs, this is fine. But if a test imports `startIpcWatcher` and calls it, then re-imports the module (e.g., via `vi.resetModules()`), the variable resets and a second watcher can be started. The test suite in `ipc-auth.test.ts` should be checked to ensure it properly isolates the watcher. (This is a test-hygiene concern, not a production bug.)

Similarly, `messageLoopRunning` and `schedulerRunning` in `src/index.ts` and `src/task-scheduler.ts` have the same property.

---

## Recommendations

### R1: Replace `waitingGroups: string[]` with a Set-backed FIFO queue [HIGH]

The current O(n) `includes` check is not broken but will become a hot path. A simple refactor:

```typescript
// src/group-queue.ts
private waitingGroupsSet = new Set<string>();
private waitingGroupsQueue: string[] = [];

private addToWaiting(groupJid: string): void {
  if (!this.waitingGroupsSet.has(groupJid)) {
    this.waitingGroupsSet.add(groupJid);
    this.waitingGroupsQueue.push(groupJid);
  }
}

private shiftWaiting(): string | undefined {
  const jid = this.waitingGroupsQueue.shift();
  if (jid !== undefined) this.waitingGroupsSet.delete(jid);
  return jid;
}
```

Replace all `this.waitingGroups.includes(...)` with `this.waitingGroupsSet.has(...)`, all `this.waitingGroups.push(...)` with `this.addToWaiting(...)`, and all `this.waitingGroups.shift()` with `this.shiftWaiting()`. This also fixes the theoretical duplicate-push race between `enqueueMessageCheck` and `enqueueTask`.

### R2: Fix agent input draining before honoring `_close` sentinel [HIGH]

In the agent runner (`agent-runner-src/`), change the input directory processing to:

1. Read all files from input directory.
2. Sort lexicographically (or by creation timestamp embedded in filename).
3. Process all non-sentinel files first, in order.
4. Only then check for and honor `_close`.

This is a one-line change in the sort/filter logic of the agent's input poll loop and makes the entire IPC protocol ordering-safe regardless of filesystem readdir behavior.

### R3: Implement two-phase cursor commit to close the crash-drop window [HIGH]

Add a `pending_agent_cursors` key to the `router_state` table (or a separate `agent_runs` table with `status`). Before advancing `lastAgentTimestamp` at the start of `processGroupMessages`, write the old cursor as a recovery point. After the agent produces confirmed output, promote the new cursor. On startup, `recoverPendingMessages` compares the pending and committed cursors and re-queues accordingly.

This is the most impactful data-integrity improvement available.

### R4: Drain active Promises in `shutdown` [LOW]

Implement the `activePromises` Set pattern described in Issue #6. The `_gracePeriodMs` parameter already signals the design intent — it just needs the implementation. For a service that restarts frequently (Telegram reconnections), this prevents mid-flight cursor advances from being stranded.

### R5: Add a task `in-progress` status to prevent double-runs [MEDIUM]

Add `'in-progress'` as a valid `status` value for `scheduled_tasks`. Before calling `enqueueTask`, set the task status to `in-progress` in the DB. `getDueTasks` already filters by `status = 'active'`, so the task won't be picked up again. Reset to `active` on error, or advance `next_run` and reset on success.

### R6: Unify the IPC write pattern — use atomic rename everywhere [LOW]

Move the `.tmp`-then-rename logic into a shared helper function in `group-queue.ts` (or a new `ipc-utils.ts`) and use it for both `sendMessage` and `closeStdin`. This enforces consistency and guards against future content additions to the sentinel.

```typescript
function atomicWrite(filepath: string, content: string): void {
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filepath);
}
```

---

## Ideas & Proposals

### [IDEA] Structured input directory ordering via sequence numbers

Instead of relying on `Date.now()` in filenames (which can collide under NTP clock adjustments), use a monotonic per-group sequence counter for IPC input file names:

```
{groupFolder}/input/{sequenceNumber:010d}-{type}.json
```

The orchestrator maintains the counter in memory (reset on restart is fine — the agent processes whatever is in the directory). This makes the ordering of `sendMessage` and `closeStdin` files deterministic by name rather than depending on filesystem readdir order or timestamp monotonicity.

### [IDEA] IPC output acknowledgment for critical messages

Currently the orchestrator has no way to know whether the agent actually read and processed a file from its input directory. The files are polled by the agent and deleted by the agent after processing. For high-stakes messages (e.g., piped follow-ups that advance the cursor), an acknowledgment file written by the agent to `ipc/{groupFolder}/ack/` would allow the orchestrator to confirm delivery before advancing the cursor. This is heavier protocol but would completely close the drop window.

### [IDEA] Convert IPC poll loop to `fs.watch` with a fallback poll

`fs.watch` on Linux uses inotify, which delivers directory change events with ~1ms latency vs. the current 1000ms poll interval. For interactive Telegram conversations, this would make the agent's outbound message delivery noticeably faster. The poll interval is a safety net — keep it, but add inotify as the primary trigger:

```typescript
fs.watch(ipcBaseDir, { recursive: true }, (_event, filename) => {
  if (filename?.endsWith('.json')) {
    scheduleImmediateProcess(); // debounced
  }
});
```

The fallback poll catches any events missed due to inotify queue overflow (which can happen under heavy load). This is a quality-of-life enhancement for interactive sessions.

---

## Summary Table

| # | Severity | Location | Description |
|---|----------|----------|-------------|
| 1 | HIGH | group-queue.ts:68–110 | `waitingGroups` O(n) includes, theoretical duplicate-push race |
| 2 | HIGH | group-queue.ts:153–164, index.ts:239–248 | `_close` sentinel has no ordering guarantee vs. pending input files |
| 3 | HIGH | group-queue.ts:132–148 | `sendMessage` returns false in active-but-no-folder window |
| 4 | HIGH | index.ts:220–224 | Cursor advanced before agent confirms; crash drops messages permanently |
| 5 | MEDIUM | bare-metal-runner.ts:348 | `outputChain` grows for long sessions (monitor; low practical risk) |
| 6 | MEDIUM | group-queue.ts:192–198 | `drainGroup` fire-and-forget from finally; correct but hard to trace |
| 7 | MEDIUM | task-scheduler.ts:245–263 | Long tasks can double-run across scheduler ticks |
| 8 | MEDIUM | ipc.ts:96–103 | Error file rename can silently overwrite on filename collision |
| 9 | MEDIUM | index.ts:481–495 | `lastAgentTimestamp` advanced by two code paths; compounds Issue #2 |
| 10 | LOW | group-queue.ts:290–307 | `shutdown` doesn't await in-flight promises; cursor rollbacks skipped |
| 11 | LOW | group-queue.ts:158–163 | `closeStdin` uses non-atomic write; inconsistent with `sendMessage` |
| 12 | LOW | ipc.ts:49, index.ts:84, task-scheduler.ts:225 | Singleton guards reset on module re-import; test hygiene |

**Priority order for fixes:** Issue #4 (cursor crash drop) → Issue #2 (sentinel ordering) → Issue #1 (waitingGroups Set) → Issue #7 (double task run) → Issue #3 (sendMessage false) → Issue #10 (shutdown drain) → remaining LOW items.
