# AgentForge Codebase Review — Master Synthesis

**Date:** 2026-02-19
**Branch reviewed:** `fix/agent-memory-autoload`
**Synthesized from:** 12 individual engineer reviews

---

## The Team

Twelve reviewers examined AgentForge from different angles: architecture (Alex Chen), security (Morgan Blake), performance (Sam Torres), database (Jordan Kim), concurrency (Chris Wu), runtime (Taylor Reyes), TypeScript quality (Riley Park), testing (Casey Nguyen), DevOps (Drew Martinez), channel integration (Avery Johnson), cognitive architecture (Dr. Sage Winters), and research/futures (Dr. Eli Stone). Their specialties rarely overlapped, yet they converged on the same issues repeatedly — which is where you should pay attention.

---

## TL;DR Executive Summary

- **The architecture is genuinely good.** Process isolation by default, atomic IPC writes, directory-based authorization, dependency injection, dual-cursor crash recovery — these are correct, non-obvious choices. The codebase was not written by someone who doesn't think about these things.

- **There is a cluster of data-integrity bugs that can silently drop messages.** The `_close` sentinel race, the pre-emptive cursor advancement, and the mid-session agent crash scenario are three independent paths to silent message loss. None require unusual conditions to trigger.

- **The database layer has four one-line fixes that should be done before anything else.** Missing composite index, no WAL mode, no FK enforcement, and a `try/catch` that eats real migration errors. All of them are high-impact, low-effort, and three reviewers flagged them independently.

- **Operations is the biggest gap between "works" and "runs reliably for months."** No log rotation, no IPC error cleanup, `pino-pretty` in production, no resource limits, no DB backup, no `.env.example`. The service will degrade silently without manual intervention.

- **The cognitive architecture aspirations are real but mostly unbuilt.** The QMD semantic search infrastructure, heartbeat scheduler, conversation archiving, and template system are all in place but only loosely connected. The "memory" system is an append-only file with no retrieval, no consolidation, and no forgetting. That is a slow-motion correctness problem.

---

## Cross-Cutting Themes

These issues were flagged independently by multiple reviewers, making them the highest-confidence findings in the report.

### Theme 1: Unbounded Growth Everywhere (Alex Chen, Jordan Kim, Morgan Blake, Drew Martinez, Sam Torres)

Five reviewers found the same class of bug in five different places:
- `ipc/errors/` directory never cleaned (Alex, Morgan, Drew)
- `messages` table grows forever, no retention policy (Alex, Jordan, Sam)
- `task_run_logs` grows forever (Jordan)
- Agent `logs/` directory never rotated (Drew)
- `processedIds` Set in email channel grows unbounded (Alex, Morgan)
- `parseBuffer` in bare-metal-runner has no size cap (Morgan, Sam)
- `pendingReplies` Map in email channel grows unbounded (Avery)

The pattern: when the code stores something, it usually remembers to write the entry but never writes the deletion. This is systemic, not incidental.

### Theme 2: `setupGroupSession` Runs Unconditional Full File Copies on Every Spawn (Sam Torres, Taylor Reyes, Casey Nguyen)

Three reviewers independently flagged the same function in `src/bare-metal-runner.ts`. It performs ~32 synchronous syscalls including `copyFileSync` for every skill file and every shared template on every single agent invocation, whether or not anything has changed. All three reviewers proposed the same fix: an mtime-based skip guard.

### Theme 3: The IPC Error Directory Is a Silent Failure Mode (Alex Chen, Morgan Blake, Drew Martinez)

Three reviewers noted that failed IPC files accumulate in `errors/` indefinitely, there is no alerting, and a runaway agent can fill the disk without the operator ever knowing. This is not just a cleanup problem — it is a DoS vector.

### Theme 4: WAL Mode and the Composite Index Are Missing (Jordan Kim, Sam Torres, Drew Martinez, Alex Chen)

Four reviewers independently recommended enabling SQLite WAL mode. Three independently flagged the missing composite index on `messages(chat_jid, timestamp)`. These are the same two lines in `db.ts` and they fix a query that runs 30 times per minute.

### Theme 5: The Dual-Cursor Message Drop Window (Alex Chen, Chris Wu)

Two reviewers independently traced the same data-integrity hazard: `lastAgentTimestamp` is advanced before the agent confirms delivery, and a hard crash during that window permanently drops messages (the startup recovery logic does not catch this case because the cursor was already persisted at the new position). Chris Wu's review identifies this as the most serious data-integrity hazard in the codebase.

### Theme 6: Untyped IPC Payloads (Riley Park, Casey Nguyen)

Two reviewers flagged that `JSON.parse` in `ipc.ts` returns `any` and every field access downstream is unchecked. Zod is already in the project and used correctly in `ipc-mcp-stdio.ts`. The fix is to apply the same pattern to the orchestrator-side IPC parser.

### Theme 7: The Memory System Is Architecturally Incomplete (Dr. Sage Winters, Dr. Eli Stone)

Both the cognitive scientist and the research scientist converged on the same diagnosis: the memory system is an append-only file with no retrieval filtering, no consolidation, and no forgetting. The QMD semantic search infrastructure exists and is initialized but is never used for retrieval. The conversation archive hook writes files that nothing ever reads back. Over months of use, this degrades response quality without any visible error signal.

---

## Critical Issues (CRITICAL / HIGH Priority)

### Data Integrity

**[CRITICAL-1] Cursor advanced before agent confirms delivery — crash drops messages permanently**
`src/index.ts:220–224`, `src/group-queue.ts`. Both Alex Chen and Chris Wu flagged this independently. `lastAgentTimestamp[chatJid]` is advanced and persisted before the agent process has confirmed it processed those messages. A hard crash (OOM, SIGKILL, hardware fault) during this window means messages are permanently dropped — the startup recovery function `recoverPendingMessages()` does not catch this because the cursor is already at the new position.
Fix: two-phase cursor commit (write `pendingCursor` separately from `lastAgentTimestamp`; promote only after confirmed output).

**[CRITICAL-2] `_close` sentinel has no ordering guarantee vs. pending input files**
`src/group-queue.ts:153–164`. Chris Wu. The orchestrator can write a message file and then the idle timer fires and writes `_close` in rapid succession. The agent's `readdir` returns files in filesystem hash-tree order, not creation order. If `_close` is read first, the agent exits before processing the message file. The message is permanently orphaned in the input directory with no recovery path. This compounds with the cursor advancement issue above.
Fix: agent runner should drain all non-sentinel files before honoring `_close`.

**[CRITICAL-3] Test suite fails to import in CI (broken CI)**
Casey Nguyen. `routing.test.ts` imports from `index.ts` which transitively imports `channels/email.ts` which requires `nodemailer` and `imapflow` — not installed as devDependencies. Every PR runs against a broken test suite.
Fix (fast): `npm install --save-dev nodemailer imapflow`.

### Security

**[HIGH-S1] `.env` file is world-readable (permissions 0664)**
Morgan Blake. The `.env` file containing `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` has mode `0664`. Fix: `chmod 600 .env` and enforce in `install-service.sh`.

**[HIGH-S2] Systemd hardening directives are all commented out**
Morgan Blake. `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem` are all commented out in `agentforge.service.template`. At minimum, `NoNewPrivileges=true` and `PrivateTmp=true` are safe to enable unconditionally.

**[HIGH-S3] Email channel auto-registers any sender, including spammers**
Morgan Blake, Avery Johnson. Any email to the configured address is auto-registered as a new group with `requiresTrigger: false`. A spammer who finds the address can generate unlimited agent invocations and Telegram messages.
Fix: add `GMAIL_ALLOWED_SENDERS` allowlist, or at minimum set `requiresTrigger: true` for auto-registered senders.

**[HIGH-S4] No rate limiting on agent IPC writes**
Morgan Blake. An agent (or a compromised sub-agent) can write IPC files in a tight loop, causing unbounded Telegram API calls, disk fill, and event-loop stalls. No per-group rate limit exists in `ipc.ts`.

### Performance / Reliability

**[HIGH-P1] `setupGroupSession` runs ~32 synchronous syscalls including full file copies on every agent spawn**
Sam Torres, Taylor Reyes, Casey Nguyen. Flagged by three reviewers. `copyFileSync` runs unconditionally for every skill file and shared template on every invocation. An mtime guard would reduce this to 2 syscalls at steady state.

**[HIGH-P2] Dual stdout buffering — `parseBuffer` has no size cap**
Sam Torres, Morgan Blake. `stdout` is capped at `AGENT_MAX_OUTPUT_SIZE` (10MB). `parseBuffer` is not capped. A pathological agent that emits megabytes of non-marker output causes unbounded heap growth in the orchestrator process. At worst, both buffers hit 10MB simultaneously for ~20MB of live string allocations.

**[HIGH-P3] `pino-pretty` used in production**
Drew Martinez. `pino-pretty` runs in a worker thread for every log line, outputs ANSI escape codes that pollute `journalctl`, and is significantly slower than raw JSON. The structured fields that make Pino useful are discarded.

**[HIGH-P4] No agent log rotation**
Drew Martinez. Every agent invocation writes to `groups/{folder}/logs/agent-{timestamp}.log` with no TTL or cleanup. At 20-50 invocations/day, this generates 600-1,500 files/month/group. A single verbose or erroring run can write a 10MB file.

### Database

**[HIGH-DB1] Missing composite index on `messages(chat_jid, timestamp)`**
Jordan Kim, Sam Torres, Alex Chen. The hot-path query `getNewMessages` runs every 2 seconds and filters by both `chat_jid` and `timestamp`. The current single-column `idx_timestamp` index forces a post-cursor scan across all chats. Fix: one SQL statement: `CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp)`.

**[HIGH-DB2] WAL mode not enabled**
Jordan Kim, Sam Torres, Drew Martinez. Default DELETE journal mode blocks concurrent reads during writes. `storeMessage` (triggered by incoming Telegram messages) and the 2-second polling reads contend on the same lock.
Fix: `db.pragma('journal_mode = WAL')` in `initDatabase()`.

**[HIGH-DB3] Foreign key enforcement disabled**
Jordan Kim. SQLite does not enforce FK constraints without `PRAGMA foreign_keys = ON`. The existing manual cascade in `deleteTask()` works, but only because the developer remembered. Future code will not be caught by the DB layer.
Fix: `db.pragma('foreign_keys = ON')` in `initDatabase()`.

**[HIGH-DB4] `content NOT LIKE` predicate cannot use any index**
Jordan Kim. Both hot-path queries include `AND content NOT LIKE ?` to filter pre-migration bot messages. This predicate is evaluated on every row that passes the timestamp/jid filter — it cannot use an index. The migration it guards completed at startup; the backstop adds per-query full-content scan overhead for zero benefit.
Fix: verify backfill is complete (startup assertion), then remove the `NOT LIKE` clause from `getNewMessages` and `getMessagesSince`.

---

## Medium Priority Issues

### Concurrency / Correctness

**[MED-C1] Scheduler can double-run tasks that take longer than 60 seconds**
Chris Wu. `getDueTasks()` runs every 60 seconds. A task that takes 70 seconds to run will be enqueued a second time before the first run finishes. The dedup guard only covers `pendingTasks` (pre-execution queue), not actively running tasks.
Fix: add `'in-progress'` status to `scheduled_tasks`; filter from `getDueTasks`.

**[MED-C2] `waitingGroups` uses O(n) linear scan for deduplication**
Chris Wu, Sam Torres. `Array.includes()` is called on `waitingGroups` on every message/task enqueue. With many groups and a burst of incoming messages, this is an unnecessary hot-path cost.
Fix: replace `waitingGroups: string[]` with a Set-backed FIFO (a `Set` for O(1) membership checks + an array for drain order).

**[MED-C3] `sendMessage` returns false in the `active-but-no-groupFolder` window**
Chris Wu. There is a brief window between `state.active = true` being set and `registerProcess()` setting `state.groupFolder` where `sendMessage()` returns false even though an agent process is running. Callers interpret `false` as "no active process" and enqueue unnecessary retries.

**[MED-C4] `lastAgentTimestamp` stored as a single JSON blob**
Alex Chen, Jordan Kim. A write-all-or-nothing blob serialized on every cursor advance means (a) a write corruption loses all groups' cursors simultaneously, and (b) every single-group cursor advance re-writes the entire multi-group map.
Fix: new `agent_cursors` table with `(chat_jid TEXT PRIMARY KEY, last_timestamp TEXT)`.

**[MED-C5] `shutdown()` grace period parameter exists but is unused**
Alex Chen, Chris Wu, Riley Park. `GroupQueue.shutdown(_gracePeriodMs)` logs active processes but does not wait for them. `process.exit(0)` in the shutdown handler then kills in-flight `runForGroup` Promises before their `finally` blocks (which contain cursor rollbacks and state saves) can execute.

### TypeScript / Code Quality

**[MED-TS1] IPC payloads parsed as untyped `any` throughout**
Riley Park. `JSON.parse()` in `src/ipc.ts` returns `any`. Every field access thereafter is unchecked. The MCP server already uses Zod for the same data. A discriminated union Zod schema applied at the parse boundary would make the switch exhaustive and field access type-safe.

**[MED-TS2] `processTaskIpc` parameter type uses `string` instead of a union for `type`**
Riley Park. Because `type` is typed as `string`, the switch has no exhaustiveness check. Adding a new IPC action requires manually updating the switch; the compiler will not catch omissions.

**[MED-TS3] DB rows cast directly to TypeScript interfaces with `as` (no runtime validation)**
Riley Park. `db.prepare(...).all() as NewMessage[]` is unchecked. If the schema drifts, the mismatch is silent at runtime. Row-mapping functions with explicit field name remapping (like `getAllRegisteredGroups` already partially does) are the correct pattern.

**[MED-TS4] Module-level singleton state in `index.ts` makes testing awkward**
Riley Park. `lastAgentTimestamp`, `registeredGroups`, `sessions`, `lastTimestamp` as module-level `let` bindings require the `_setRegisteredGroups` backdoor for tests. An `Orchestrator` class with an explicit `init()` method would make initialization order explicit and eliminate the backdoor.

**[MED-TS5] `requiresTrigger?: boolean` — undefined and true have identical behavior**
Riley Park. The three-valued semantics (`undefined | true | false`) add cognitive load everywhere the flag is checked. Coerce to `boolean` at the DB read boundary; use `if (group.requiresTrigger)` everywhere else.

### Testing

**[MED-T1] Cursor rollback path has zero test coverage**
Casey Nguyen. `processGroupMessages` cursor rollback logic — arguably the most critical correctness invariant in the system — has no test. It cannot be tested without significant refactoring because `processGroupMessages` closes over module-level state.

**[MED-T2] Startup recovery (`recoverPendingMessages`) has zero test coverage**
Casey Nguyen. The safety net for crash-dropped messages has never been tested.

**[MED-T3] Agent output streaming parser has no tests**
Casey Nguyen. The sentinel-delimited parser in `bare-metal-runner.ts` handles partial chunks, multiple back-to-back markers, and malformed JSON. None of these behaviors are tested. The logic is fully extractable into a pure function (`parseOutputChunks(buffer, chunk)`) with deterministic behavior.

**[MED-T4] `substituteVariables` in `template.ts` has no tests**
Casey Nguyen. A 15-line pure function that substitutes `{{VARNAME}}` tokens in agent instruction files before they reach Claude. A bug here silently corrupts agent instructions. Zero tests exist for it.

### Operations

**[MED-OPS1] `messages` and `task_run_logs` tables grow without bound**
Jordan Kim, Alex Chen, Drew Martinez. No retention policy exists. At 50 messages/day/group, the `messages` table grows 3-9 MB/year/group; `task_run_logs` grows 525,600 rows/year for a minutely task.
Fix: a startup retention sweep deleting rows older than 90 days (messages) and 30 days (task_run_logs).

**[MED-OPS2] Two-build process not unified**
Drew Martinez. `npm run build` only builds the orchestrator. The agent runner (`agent-runner-src/`) must be built separately. A stale agent binary will be deployed silently if someone runs only `npm run build`.
Fix: `"build": "npm run build:runner && tsc"` in `package.json`.

**[MED-OPS3] No resource limits on agent subprocesses**
Drew Martinez. Agent processes spawn with no V8 heap cap, no cgroup constraints. With `MAX_CONCURRENT_PROCESSES=5`, a pathological agent can allocate 7.5 GB before the OOM killer fires — likely killing the orchestrator first.
Fix: `--max-old-space-size=512` in the `spawn()` call; `MemoryMax=2G` and `LimitNOFILE=65536` in the systemd unit.

**[MED-OPS4] No health check mechanism**
Drew Martinez. The service has no `/healthz`, no watchdog file, no way to distinguish "process alive but event loop stalled" from "healthy." Systemd's `Restart=on-failure` only catches crashes, not hung states.

### Channel Integration

**[MED-CH1] Message splitter cuts mid-word**
Avery Johnson. The Telegram message chunker slices at exactly 4,096 characters: `text.slice(i, i + MAX_LENGTH)`. A word straddling the boundary is split across two messages. The identical bug exists in both `TelegramChannel.sendMessage` and `sendPoolMessage`.

**[MED-CH2] Typing indicator left stuck on error paths**
Avery Johnson. `setTyping(jid, false)` silently no-ops in the current implementation (the method only does anything when `isTyping === true`). Long-running agents show no typing indicator after the first 5-second Telegram expiry. The fix is a repeating `sendChatAction` interval that stops on agent completion.

**[MED-CH3] `senderBotMap` resets on every service restart**
Avery Johnson. Pool bot assignments are in-memory only. Every restart triggers re-assignment and re-naming of bots, causing the 2-second propagation delay for all known senders again.

**[MED-CH4] Email MIME parser is hand-rolled and fails on common real-world emails**
Avery Johnson, Casey Nguyen. The 70-line custom parser in `email.ts` does not handle folded headers, nested multipart, base64/quoted-printable encoding, or most real-world Gmail and Outlook message formats. The `mailparser` npm package handles all of this and is a near-drop-in replacement.

---

## Top Ideas and Proposals

These are the highest-impact forward-looking proposals from across all reviews, ranked roughly by value-to-effort.

**1. Push-triggered agent dispatch instead of 2-second poll (Alex Chen, Sam Torres)**
The Telegram `onMessage` callback already receives messages in near-real-time. Wire it to call `queue.enqueueMessageCheck(chatJid)` directly. The polling loop becomes a safety net running at 30-second intervals. Reduces worst-case message-to-agent latency from 2 seconds to near-zero with minimal code change.

**2. The Dream Cycle: nightly memory consolidation (Dr. Sage Winters)**
A nightly heartbeat task that reads all recent daily logs and the current `memory.md`, identifies patterns worth promoting, identifies stale facts worth removing, and rewrites `memory.md` as a compressed current state. The heartbeat infrastructure exists. This is primarily prompt engineering. It addresses the CRITICAL memory growth problem and the amnesia-after-context-compaction problem simultaneously.

**3. Relevance-gated memory loading via QMD (Dr. Sage Winters, Dr. Eli Stone)**
Instead of loading all of `memory.md` into every system prompt, query QMD with the current user message and inject only the most relevant excerpts. QMD is already initialized, indexed, and the MCP tools are mounted — the only missing piece is the retrieval call at conversation start and instructions to use it. This reduces system prompt token consumption and makes QMD's existence justified.

**4. Structured IPC Zod schema (Riley Park)**
A single `src/ipc-protocol.ts` file exporting Zod schemas for each IPC action type, used on both the write side (`ipc-mcp-stdio.ts`) and read side (`ipc.ts`). The Zod dependency is already present. This makes adding new IPC actions compile-safe, makes field access type-safe, and gives precise error messages on malformed payloads.

**5. Persistent `senderBotMap` via SQLite (Avery Johnson)**
A `bot_pool_assignments(group_folder, sender, pool_index)` table loaded at startup into `senderBotMap`. Bot identities survive service restarts. The global rename race is mitigated. One table, loaded once, written on assignment.

**6. `fs.watch` on IPC directories with poll fallback (Sam Torres, Taylor Reyes, Chris Wu)**
Three reviewers independently proposed replacing the 1-second IPC poll with `fs.watch` (inotify on Linux, ~1ms latency). The poll remains as a reliability fallback. This cuts IPC latency by ~99% at idle and eliminates ~11 synchronous syscalls per second.

**7. `refresh_groups` MCP tool (Taylor Reyes)**
The handler already exists in `ipc.ts`. The MCP tool is missing from `ipc-mcp-stdio.ts`. The agent currently cannot request an updated groups list from inside a session — it must rely on the pre-written snapshot.

**8. `sd_notify` watchdog integration (Drew Martinez)**
`WatchdogSec=60s` in the systemd unit + a `sd_notify(WATCHDOG=1)` call on each successful message loop iteration. If the event loop stalls for 60 seconds, systemd automatically restarts the service — even if the process is alive. This is the correct production-grade health check for a Linux service.

**9. Structured memory schema with typed sections (Dr. Eli Stone)**
Replace the freeform `memory.md` with a semi-structured format that has typed sections: `facts`, `preferences`, `patterns`, `open_questions`, `commitments`. Low engineering cost. Improves consolidation quality and makes the memory system legible to both the agent and the user.

**10. Open threads file for persistent reasoning chains (Dr. Eli Stone)**
A `threads.md` template file where the agent records ongoing investigations with status, last action, and next intended action. The heartbeat advances one thread per cycle. No code changes required — purely a template and HEARTBEAT.md configuration change. Transforms the heartbeat from a periodic task runner into an investigation-continuity mechanism.

---

## Prioritized Action Plan

### Sprint 1: Immediate (Do Before Anything Else)

These are the highest-confidence, lowest-effort fixes. Most are one or two lines.

1. **`chmod 600 .env`** — Morgan Blake. Fix it right now. Add enforcement to `install-service.sh`.
2. **Enable WAL mode and FK enforcement** — Jordan Kim, Drew Martinez. Add two lines to `initDatabase()`: `db.pragma('journal_mode = WAL')` and `db.pragma('foreign_keys = ON')`.
3. **Add composite index on `messages(chat_jid, timestamp)`** — Jordan Kim, Sam Torres. One SQL statement in `createSchema()`. Fixes the hot-path query that runs 30 times per minute.
4. **Fix CI: add `nodemailer` and `imapflow` to devDependencies** — Casey Nguyen. `npm install --save-dev nodemailer imapflow`. CI has been broken since the email channel was added.
5. **Fix `pino-pretty` in production** — Drew Martinez. Condition the transport on `process.stdout.isTTY || NODE_ENV === 'development'`; move to devDependencies.
6. **Fix the message splitter** — Avery Johnson. Replace the hard-slice loop with a word-boundary-aware split. The same bug exists in both `sendMessage` and `sendPoolMessage` — extract to a shared helper.
7. **Discriminate migration errors** — Jordan Kim. Replace bare `catch { /* column already exists */ }` with a check that re-throws anything that isn't a `duplicate column name` error.
8. **Enable `NoNewPrivileges=true` and `PrivateTmp=true` in systemd template** — Morgan Blake. Both are safe to enable unconditionally.
9. **Create `.env.example`** — Drew Martinez. Documents all required variables. Eliminates the need to read `config.ts` on every new install.
10. **Add `GMAIL_ALLOWED_SENDERS` allowlist to email channel** — Morgan Blake. Prevents arbitrary internet senders from triggering the agent.

### Sprint 2: Core Reliability (Next 2-3 Weeks)

These address the data-integrity and operational reliability gaps.

1. **Two-phase cursor commit** — Chris Wu. Write `pendingCursor` to DB separately from `lastAgentTimestamp`. Promote only after confirmed output. Closes the crash-drop window that both Alex Chen and Chris Wu identified.
2. **Fix `_close` sentinel ordering** — Chris Wu. Agent runner should drain all non-sentinel input files before honoring `_close`. A one-line sort/filter change.
3. **Add startup retention sweep** — Jordan Kim, Drew Martinez. Delete messages older than 90 days, task_run_logs older than 30 days. Call from `initDatabase()`. Add `MESSAGE_RETENTION_DAYS` and `TASK_LOG_RETENTION_DAYS` env vars.
4. **Add IPC error directory cleanup** — Alex Chen, Morgan Blake, Drew Martinez. Log a warning when `errors/` exceeds 50 files. Delete files older than 7 days. Add to the existing scheduler loop or run at startup.
5. **Add mtime guard to `setupGroupSession`** — Sam Torres, Taylor Reyes. Skip `copyFileSync` when destination exists and its mtime is >= source. Reduces per-spawn syscalls from ~32 to ~2 at steady state.
6. **Cap `parseBuffer` size** — Morgan Blake, Sam Torres. Apply the same size cap to `parseBuffer` that already applies to `stdout`. Prevents unbounded heap growth on pathological agent output.
7. **Unify the two-build process** — Drew Martinez. `"build": "npm run build:runner && tsc"`. Prevents stale agent binary deploys.
8. **Replace `waitingGroups: string[]` with Set-backed FIFO** — Chris Wu, Sam Torres. O(1) membership check, eliminates the theoretical duplicate-push race between `enqueueMessageCheck` and `enqueueTask`.
9. **Implement `shutdown()` grace period** — Alex Chen, Chris Wu. Use the existing `_gracePeriodMs` parameter. Track active Promises in a Set; await them (up to the grace period) before `process.exit`. Prevents cursor rollbacks and state saves from being skipped.
10. **Add `--max-old-space-size=512` to agent spawn and resource limits to systemd unit** — Drew Martinez.

### Sprint 3: Quality and Future-Proofing (Following Month)

1. **Migrate `lastAgentTimestamp` to `agent_cursors` table** — Alex Chen, Jordan Kim. Atomic per-group cursor updates, no all-or-nothing corruption risk.
2. **Type IPC payloads with Zod discriminated union** — Riley Park. Apply the same Zod validation pattern that already exists in `ipc-mcp-stdio.ts` to the orchestrator-side parser in `ipc.ts`.
3. **Wire `onMessage` callback to directly trigger queue dispatch** — Alex Chen, Sam Torres. Eliminate up to 2 seconds of polling latency for interactive conversations.
4. **Add task `in-progress` status** — Chris Wu. Prevents long-running tasks from being double-queued across scheduler ticks.
5. **Add message retention** — Jordan Kim, Alex Chen. `DELETE FROM messages WHERE timestamp < datetime('now', '-90 days')` on startup.
6. **Implement the Dream Cycle heartbeat task** — Dr. Sage Winters. Configure a nightly scheduled task for memory consolidation. Primarily HEARTBEAT.md and prompt configuration; no code changes required for a basic version.
7. **Add `threads.md` to the template system** — Dr. Eli Stone. No code changes. Template + HEARTBEAT.md configuration. Enables persistent reasoning chains across sessions.
8. **Write tests for: cursor rollback, startup recovery, output parser, `substituteVariables`** — Casey Nguyen. These are the highest-priority untested paths. The output parser test requires extracting `parseOutputChunks` into a pure function first.
9. **Add coverage configuration to vitest** — Casey Nguyen. Wire `@vitest/coverage-v8` (already installed) into `vitest.config.ts` with a baseline threshold.
10. **Fix `getAvailableGroups` JID filter** — Avery Johnson. Remove the `@g.us` whitelist (a WhatsApp leftover) that silently hides email groups from the main agent.

---

## Overall Verdict

**Codebase Health: B-**

AgentForge is well above average for a personal project that grew organically. The architectural decisions are mostly right: process isolation, atomic IPC, directory-based authorization, dependency injection, dual-cursor crash recovery. These are non-obvious, production-quality choices. The codebase shows clear evidence of an engineer thinking carefully about failure modes.

The C and D grades are in operations and testing. The service will run well for a few weeks and then quietly accumulate problems — disk fills with log files, the IPC error directory bloats, the database grows without bound, the test suite has been broken since the email channel was added. None of these require anything to go catastrophically wrong; they are the normal entropy of a service running unattended.

The data-integrity bugs (silent message drops via the cursor/crash interaction, the `_close` sentinel race) are the most serious correctness issues and deserve Sprint 1 attention alongside the security and database fixes.

The cognitive architecture is the most interesting long-term challenge. The infrastructure is thoughtful — QMD, heartbeat scheduler, conversation archiving, template-based identity — but the pieces are not connected. The memory system is an append-only log that will degrade with age. The QMD semantic search system runs at startup and then sits idle. The conversation archives are written but never read. Connecting these pieces — especially the Dream Cycle consolidation and QMD retrieval — would transform the system from "sophisticated task automation" to something qualitatively different.

The Sprint 1 fixes are all small. Many are single lines. Do them before anything else — several of them (the `.env` permissions, the CI breakage, the WAL mode, the composite index) should have been done months ago and cost almost nothing to fix now.

---

*Synthesis compiled from: 01-alex-chen-architecture.md, 02-morgan-blake-security.md, 03-sam-torres-performance.md, 04-jordan-kim-database.md, 05-chris-wu-concurrency.md, 06-taylor-reyes-runtime.md, 07-riley-park-typescript.md, 08-casey-nguyen-testing.md, 09-drew-martinez-devops.md, 10-avery-johnson-channels.md, 11-sage-winters-cognition.md, 12-eli-stone-research.md*
