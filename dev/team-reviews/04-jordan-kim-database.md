# Database Review — Jordan Kim, Database Engineer

**Date:** 2026-02-19
**Scope:** SQLite schema, query patterns, indexing, migrations, data integrity
**File reviewed:** `src/db.ts` (690 lines), schema embedded in `createSchema()`, queries throughout

---

## Executive Summary

AgentForge uses SQLite via `better-sqlite3` for all persistent state. The schema is well-organized for a personal assistant — six clearly-scoped tables, FK relationships defined, and a good in-memory test path. The synchronous driver is the right call for a single-process Node.js application. The code is clean, the JSDoc is excellent, and the query parameterization is consistent throughout.

That said, there are several issues that will hurt as the system runs for months unattended. The hot-path query (`getNewMessages`, running every 2 seconds) is missing a composite index that covers its actual filter shape. Text timestamps make range queries work by accident rather than by design. Foreign keys are declared but not enforced at runtime. `task_run_logs` and `messages` grow without any retention policy. The try/catch migration pattern will silently hide real errors. WAL mode is not configured, which introduces unnecessary write contention.

None of these are catastrophic for a personal assistant with modest traffic, but they compound over time. The retention issue in particular is a slow data-loss-by-neglect problem: the database grows indefinitely, old messages consume space, and if you ever want to query "messages from last 30 days" that scan will get slower every week.

**Priority fixes:** composite index on `messages`, WAL mode pragma, FK enforcement, and a retention sweep for `task_run_logs`.

---

## Strengths

**Synchronous driver is correct here.** `better-sqlite3` is the right choice for a single-threaded Node.js orchestrator. Async SQLite drivers (like `better-sqlite3-session`) add complexity with no benefit in a single-process model. All DB calls are fast point lookups or small range scans, so blocking is never an issue.

**Query parameterization is clean throughout.** Every query uses `?` placeholders. No string interpolation of user data into SQL — the one dynamic piece (`IN (${placeholders})`) generates only `?` markers from an array of safe `jids.map(() => '?')`, which is correct.

**The upsert patterns are well-designed.** The `MAX(last_message_time, excluded.last_message_time)` trick in `storeChatMetadata` is an elegant, race-safe way to avoid regressing a timestamp when out-of-order events arrive. `INSERT OR REPLACE` semantics are used consistently.

**In-memory test database.** `_initTestDatabase()` with `:memory:` is the right pattern. Tests in `src/db.test.ts` cover the core read/write paths, bot-message filtering (both flag and backstop prefix), cursor semantics, and upsert behavior. The test coverage is solid for a project this size.

**The JSON-to-SQLite migration is thoughtful.** The `migrateJsonState()` function does a one-shot migration of legacy JSON files, renames them to `*.migrated` to prevent re-runs, and handles parse errors silently. The cursor-state, sessions, and group registrations are all migrated correctly.

**`SELECT *` is isolated.** The two places that use `SELECT *` (`getAllTasks`, `getAllRegisteredGroups`) both immediately deserialize into typed structs, limiting blast radius if the schema changes. Not ideal, but it's contained.

---

## Issues Found

### [HIGH] Missing composite index on `messages` — hot path does a partial-index scan every 2 seconds

The `getNewMessages` query runs on every poll tick (default: every 2 seconds):

```sql
SELECT id, chat_jid, sender, sender_name, content, timestamp
FROM messages
WHERE timestamp > ? AND chat_jid IN (?, ?, ...)
  AND is_bot_message = 0 AND content NOT LIKE ?
ORDER BY timestamp
```

The current index is:

```sql
CREATE INDEX idx_timestamp ON messages(timestamp);
```

SQLite will use `idx_timestamp` to satisfy `timestamp > ?`, but it then has to filter the matching rows for `chat_jid IN (...)` and `is_bot_message = 0` by scanning every row past the timestamp cursor. As the messages table grows, the post-cursor scan grows with it.

The right index for this query is a composite covering `(chat_jid, timestamp)`:

```sql
CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);
```

With this index, SQLite can satisfy `chat_jid IN (...)` with index range scans, one per JID, and `timestamp > ?` narrows each range. The planner will typically choose this over `idx_timestamp` for the multi-JID case.

`EXPLAIN QUERY PLAN` on the current schema:

```
SCAN messages USING INDEX idx_timestamp (timestamp>?)
-- then filters: chat_jid IN (...), is_bot_message = 0, content NOT LIKE ?
```

With `idx_messages_jid_ts`:

```
SEARCH messages USING INDEX idx_messages_jid_ts (chat_jid=? AND timestamp>?)
-- repeated for each JID in the IN list
```

The `getMessagesSince` query (per-agent invocation) has the same shape:

```sql
WHERE chat_jid = ? AND timestamp > ? AND is_bot_message = 0 AND content NOT LIKE ?
```

Same fix applies — `(chat_jid, timestamp)` covers both queries.

The existing `idx_timestamp` still has value for the `getAllChats ORDER BY last_message_time DESC` scan and can be retained, but the composite index should be added.

---

### [HIGH] `content NOT LIKE ?` predicate cannot use any index

Both `getNewMessages` and `getMessagesSince` include:

```sql
AND content NOT LIKE ?
```

with the pattern `${botPrefix}:%` (e.g. `Andy:%`).

SQLite cannot use an index to satisfy a `LIKE` predicate that starts with a wildcard or a `NOT LIKE` at all. Every row passing the timestamp/jid filter must be examined in full to apply this filter. The code comment acknowledges this is a "backstop for messages inserted before the migration ran."

The migration that added `is_bot_message` and backfilled it ran on startup. By now, every message in the database should have the correct `is_bot_message` flag. The `NOT LIKE` backstop is costing a full-content scan on every hot-path execution for a migration that has already completed.

The right fix is a two-phase removal: verify the backfill is complete, then remove the `NOT LIKE` clause. If you want a belt-and-suspenders check without the query cost, a startup assertion would achieve the same safety:

```sql
-- Run once at startup to verify migration completeness (not on hot path)
SELECT COUNT(*) FROM messages WHERE content LIKE 'Andy:%' AND is_bot_message = 0;
```

If the count is 0, the backstop can be dropped from the hot-path queries. Once removed, `is_bot_message = 0` alone is index-friendly if you add it to a covering index:

```sql
CREATE INDEX IF NOT EXISTS idx_messages_jid_ts_bot
  ON messages(chat_jid, timestamp)
  WHERE is_bot_message = 0;
```

This partial index is smaller and the planner can use it to exclude bot messages structurally.

---

### [HIGH] Foreign key enforcement is disabled (SQLite default)

The schema declares two foreign keys:

```sql
-- messages
FOREIGN KEY (chat_jid) REFERENCES chats(jid)

-- task_run_logs
FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
```

SQLite does **not** enforce foreign keys by default. The `PRAGMA foreign_keys = ON` must be set on each connection after it opens. Without it, the constraints are documentation only.

In practice, `deleteTask()` manually deletes `task_run_logs` rows before the parent:

```typescript
db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
```

This works, but only because the developer remembered to do it manually. If FK enforcement were on, cascades or restricted deletes would enforce this automatically, and forgetting to delete children would be caught at the DB layer rather than silently producing orphaned rows.

Add to `initDatabase()` immediately after opening the connection:

```typescript
db = new Database(dbPath);
db.pragma('foreign_keys = ON');
createSchema(db);
```

The `_initTestDatabase()` path should get the same pragma so test behavior matches production.

---

### [HIGH] No WAL mode — default journal mode blocks concurrent reads during writes

`better-sqlite3` opens databases in the default SQLite journal mode: DELETE (rollback journal). In this mode, any write operation acquires an exclusive lock that blocks all readers.

AgentForge's access pattern is:
- `getNewMessages` polling every 2 seconds (read)
- `storeMessage` firing on every incoming Telegram message (write)
- `getDueTasks` polling every 60 seconds (read)
- `updateTaskAfterRun` after each scheduled task (write)
- `logTaskRun` after each scheduled task (write)
- `setRouterState` after each cursor advance (write)

With DELETE journal mode, a burst of incoming messages that triggers multiple `storeMessage` calls will cause the 2-second polling reads to wait. In WAL mode, readers and writers do not block each other.

```typescript
db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
createSchema(db);
```

WAL mode also provides better durability on crash (WAL frames are atomic) and better performance for write-heavy workloads. The only trade-off is the presence of `-wal` and `-shm` sidecar files, which is fine for a server-side deployment.

Note: WAL mode persists in the database file — it only needs to be set once, but including the pragma in `initDatabase` is correct practice because it's idempotent and ensures the setting if the DB is ever moved or recreated.

---

### [MEDIUM] try/catch migration pattern silently swallows real errors

The inline migration pattern:

```typescript
try {
  database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
} catch {
  /* column already exists */
}
```

This catches the `SqliteError: duplicate column name` that fires when the column exists — which is the intended behavior. But it also silently swallows any other error: a disk full condition, a corrupt database, a permissions failure, a syntax error in the ALTER statement if it were ever modified. There is no way to distinguish "column already exists" from "something went wrong."

SQLite 3.37.0+ supports `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, but `better-sqlite3` is likely on an older embedded version. A safer discriminated catch looks like:

```typescript
try {
  database.exec(
    `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`
  );
} catch (err) {
  // Only suppress "duplicate column" errors; re-throw everything else
  if (
    !(err instanceof Error) ||
    !err.message.includes('duplicate column name')
  ) {
    throw err;
  }
}
```

This is more verbose but correctly propagates unexpected errors rather than hiding them at startup.

---

### [MEDIUM] `messages` table has no retention policy — unbounded growth

Messages are stored and never deleted. For a personal assistant with active groups, this will accumulate indefinitely. After a year of daily use:

- At ~50 messages/day per group, a single group produces ~18,000 messages per year.
- Each message row is roughly 200–500 bytes on average (id, jid, sender, name, content, timestamp).
- That's 3–9 MB per group per year — modest individually, but the query cost on the timestamp scan grows linearly with the table size.

More practically: the agent context window passed to Claude is bounded by `getMessagesSince(chatJid, sinceTimestamp, ...)`, which only fetches messages since the last agent cursor. Old messages in the DB are never queried for agent context (the cursor always moves forward). They exist solely for the `getAllChats` list and the occasional "what was said" lookup — uses that don't need years of history.

A simple retention policy: delete messages older than 90 days. This could run as a startup vacuum or a scheduled task:

```sql
DELETE FROM messages WHERE timestamp < datetime('now', '-90 days');
```

The ISO 8601 string comparison works correctly here because ISO 8601 strings sort lexicographically in chronological order. But see the timestamp type discussion below for a cleaner alternative.

---

### [MEDIUM] `task_run_logs` table grows without bound

Every task execution appends a row to `task_run_logs`. There is no deletion or pruning path anywhere in the codebase. A task running every minute generates 1,440 rows per day, 525,600 rows per year. The index `idx_task_run_logs ON task_run_logs(task_id, run_at)` prevents the per-task lookup from becoming expensive, but the table itself bloats.

Retention options:
1. Keep last N runs per task (e.g., 100), delete older ones on each `logTaskRun` call.
2. Delete all logs older than X days (e.g., 30 days) at startup.
3. Delete logs for completed/deleted tasks when the task is deleted (currently done) and add a time-based sweep for active tasks.

A startup pruning sweep is the simplest approach:

```sql
DELETE FROM task_run_logs WHERE run_at < datetime('now', '-30 days');
```

---

### [MEDIUM] TEXT timestamps — ISO 8601 strings instead of INTEGER (Unix ms)

All timestamps are stored as ISO 8601 strings (`TEXT`), e.g., `2024-01-01T00:00:01.000Z`. This is the most commented-on field in the schema, so it warrants a clear analysis.

**Why it works:** ISO 8601 strings with consistent UTC formatting (`Z` suffix, zero-padded fields) sort lexicographically in the same order as chronologically. SQLite's `TEXT` affinity handles this correctly for `<`, `>`, and `=` comparisons. The existing index on `timestamp` is usable because text collation on ISO 8601 is monotone. The `MAX(last_message_time, excluded.last_message_time)` upsert is also correct because string MAX on ISO 8601 equals timestamp MAX.

**Why it's suboptimal:**
- String comparison is slower than integer comparison (marginal at this scale).
- Storage is larger: `2024-01-01T00:00:01.000Z` is 24 bytes as TEXT vs. 8 bytes as INTEGER.
- SQLite's `datetime()`, `strftime()`, and `julianday()` functions work on TEXT timestamps but require parsing on each call.
- `ORDER BY timestamp` on TEXT is correct only when all timestamps use the same UTC offset and zero-padding. Any deviation (e.g., a timestamp without the millisecond component) breaks sort order. The codebase generates timestamps via `new Date().toISOString()` which is always consistent, but this is an implicit contract, not a structural guarantee.

**Verdict:** For this scale and use case, TEXT timestamps are acceptable and changing them would require a data migration of every timestamp column in every table. The risk/reward does not justify migration. The constraint to document and enforce: all code paths must generate timestamps via `new Date().toISOString()` — never `Date.now()`, never locale-formatted strings.

---

### [MEDIUM] `last_agent_timestamp` stored as a JSON blob in `router_state`

```typescript
// Write
setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));

// Read
const agentTs = getRouterState('last_agent_timestamp');
lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
```

`lastAgentTimestamp` is a `Record<string, string>` mapping chat JIDs to ISO timestamp strings. Storing a map as a JSON blob in a key-value row means:
- Partial updates require a read-modify-write cycle (which is what happens: `lastAgentTimestamp[chatJid] = ...; saveState()`).
- The entire blob is replaced on every cursor advance, even for a single group.
- There is no per-key query or index; the only access pattern is load-all / save-all.

This is a schema design smell rather than a bug. The data would be better represented as a proper table:

```sql
CREATE TABLE agent_cursors (
  chat_jid TEXT PRIMARY KEY,
  last_timestamp TEXT NOT NULL
);
```

This enables per-group updates without rewriting all cursors, survives partial writes cleanly (each row is atomic), and is queryable if needed for diagnostics. At the current scale, the JSON blob approach works fine, but if the number of registered groups grows, the read-modify-write on every message becomes increasingly wasteful.

---

### [LOW] `deleteTask()` manual FK cascade should be a DB-level cascade

```typescript
export function deleteTask(id: string): void {
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}
```

With FK enforcement enabled (see above), this could be replaced by:

```sql
FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
```

Then `deleteTask` becomes a single statement:

```sql
DELETE FROM scheduled_tasks WHERE id = ?
```

...and SQLite automatically deletes the child `task_run_logs` rows. This requires FK enforcement to be on, which it currently is not.

---

### [LOW] `getDueTasks` + `getTaskById` double-fetch in scheduler loop

In `src/task-scheduler.ts`:

```typescript
const dueTasks = getDueTasks();   // fetches all due tasks
for (const task of dueTasks) {
  const currentTask = getTaskById(task.id);  // re-fetches each one individually
  if (!currentTask || currentTask.status !== 'active') continue;
  // ...
}
```

`getTaskById` is called to guard against a task being paused between the `getDueTasks` query and the processing loop. This is a valid race-condition concern. However, the check could be folded into the original query with a `WHERE id IN (...)` re-query or simply trusted (since the scheduler is the only writer of `status` during a loop tick). At minimum, the current pattern does N+1 queries for N due tasks. For a personal assistant with a handful of tasks this is irrelevant, but it's an easy clean-up.

---

### [LOW] Missing index on `messages(is_bot_message)`

The filter `is_bot_message = 0` appears in both hot-path queries. Without an index, every row fetched via the timestamp/jid index must be evaluated against this column. Since ~100% of stored messages are non-bot messages (the system stores bot messages with `is_bot_message = 1` only as a minority), the filter has very high selectivity in the wrong direction — nearly all rows pass. Adding `is_bot_message` to the composite index doesn't help much here, but a partial index (see earlier recommendation) would allow the planner to structurally skip bot messages.

---

### [LOW] `getAllChats` has no `last_message_time` index

```sql
SELECT jid, name, last_message_time FROM chats ORDER BY last_message_time DESC
```

`chats` is a small table (one row per known chat), so this full-scan sort is negligible. But for completeness, an index on `chats(last_message_time)` would make this a covered index scan. Not worth doing at this scale.

---

### [LOW] `INSERT OR REPLACE` on `sessions` and `router_state` is correct but subtle

`INSERT OR REPLACE` deletes the old row and inserts a new one, resetting the `rowid`. For tables with integer primary keys or autoincrement, this can cause surprising behavior (gaps in IDs, triggers firing on DELETE+INSERT rather than UPDATE). For `sessions` and `router_state`, which use TEXT primary keys with no autoincrement, this is safe. A future developer may not realize the semantics differ from `INSERT OR UPDATE`, so `INSERT INTO ... ON CONFLICT(key) DO UPDATE SET value = excluded.value` would be more explicit:

```sql
INSERT INTO router_state (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

---

## Recommendations

### R1 — Add composite index on `messages(chat_jid, timestamp)` [HIGH]

```sql
CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);
```

Add to `createSchema()`. The existing `idx_timestamp` can remain for other scans. This is the single highest-impact change — it directly improves the query that runs 30 times per minute.

---

### R2 — Enable WAL mode and FK enforcement at startup [HIGH]

In `initDatabase()`, immediately after opening the connection:

```typescript
db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
createSchema(db);
```

And in `_initTestDatabase()`:

```typescript
db = new Database(':memory:');
db.pragma('foreign_keys = ON');
createSchema(db);
```

WAL mode doesn't apply to `:memory:` databases, but FK enforcement should match production.

---

### R3 — Discriminate migration errors by message type [MEDIUM]

Replace bare `catch { /* column already exists */ }` with:

```typescript
} catch (err) {
  if (!(err instanceof Error) || !err.message.includes('duplicate column name')) {
    throw err;
  }
}
```

This preserves the intent (skip if already applied) while surfacing real failures.

---

### R4 — Add startup retention sweep for `task_run_logs` and old `messages` [MEDIUM]

Add to `initDatabase()` after `createSchema()`:

```typescript
function runRetentionSweep(database: Database.Database): void {
  // Keep 90 days of messages (ISO 8601 string comparison is valid)
  database.exec(`
    DELETE FROM messages WHERE timestamp < datetime('now', '-90 days')
  `);
  // Keep 30 days of task run logs
  database.exec(`
    DELETE FROM task_run_logs WHERE run_at < datetime('now', '-30 days')
  `);
}
```

Call `runRetentionSweep(db)` after `createSchema(db)` in `initDatabase()`. Consider making the retention window configurable via environment variables (`MESSAGE_RETENTION_DAYS`, `TASK_LOG_RETENTION_DAYS`).

---

### R5 — Remove or gate the `content NOT LIKE` backstop filter [MEDIUM]

Add a startup check to confirm the backfill is complete:

```typescript
const unmigratedCount = db
  .prepare(`SELECT COUNT(*) as n FROM messages WHERE content LIKE ? AND is_bot_message = 0`)
  .get(`${ASSISTANT_NAME}:%`) as { n: number };

if (unmigratedCount.n > 0) {
  logger.warn({ count: unmigratedCount.n }, 'Pre-migration bot messages detected, backstop filter active');
  // Keep NOT LIKE in queries
} else {
  // Safe to remove NOT LIKE from hot-path queries
}
```

In practice, for any database that has run the current `createSchema`, the count will be 0. The longer-term fix is to remove the `NOT LIKE` clause from `getNewMessages` and `getMessagesSince` and drop the `botPrefix` parameter from both functions.

---

### R6 — Consider replacing `last_agent_timestamp` JSON blob with a proper table [MEDIUM]

```sql
CREATE TABLE IF NOT EXISTS agent_cursors (
  chat_jid TEXT PRIMARY KEY,
  last_timestamp TEXT NOT NULL
);
```

Replace the `saveState()` / `loadState()` pattern for agent timestamps with per-group updates:

```typescript
export function setAgentCursor(chatJid: string, timestamp: string): void {
  db.prepare(
    `INSERT INTO agent_cursors (chat_jid, last_timestamp) VALUES (?, ?)
     ON CONFLICT(chat_jid) DO UPDATE SET last_timestamp = excluded.last_timestamp`
  ).run(chatJid, timestamp);
}

export function getAllAgentCursors(): Record<string, string> {
  const rows = db.prepare('SELECT chat_jid, last_timestamp FROM agent_cursors').all() as
    Array<{ chat_jid: string; last_timestamp: string }>;
  return Object.fromEntries(rows.map(r => [r.chat_jid, r.last_timestamp]));
}
```

This eliminates the read-modify-write-the-whole-blob pattern and makes each cursor update atomic at the row level.

---

## Ideas and Proposals

### [IDEA] Scheduled VACUUM to reclaim space after retention sweeps

After the retention sweep deletes rows, SQLite doesn't automatically reclaim the freed pages. Add a periodic `VACUUM` (or enable auto-vacuum at database creation):

```sql
PRAGMA auto_vacuum = INCREMENTAL;
```

Or run an `INCREMENTAL_VACUUM` periodically:

```typescript
// Run incremental vacuum at startup (reclaims up to 100 pages at a time)
db.pragma('incremental_vacuum(100)');
```

`PRAGMA auto_vacuum = INCREMENTAL` must be set before the first write to a database (or via `VACUUM INTO`), so it belongs in `createSchema`. For an existing database, `PRAGMA auto_vacuum = INCREMENTAL` followed by `VACUUM` enables it.

---

### [IDEA] A `db_stats` view for operational visibility

A simple read-only view that agents or the main group can query for database health:

```sql
CREATE VIEW IF NOT EXISTS db_stats AS
SELECT
  (SELECT COUNT(*) FROM messages) AS message_count,
  (SELECT COUNT(*) FROM messages WHERE timestamp > datetime('now', '-7 days')) AS messages_last_7d,
  (SELECT COUNT(*) FROM scheduled_tasks WHERE status = 'active') AS active_tasks,
  (SELECT COUNT(*) FROM task_run_logs) AS total_run_logs,
  (SELECT COUNT(*) FROM registered_groups) AS registered_groups;
```

This costs nothing at write time and gives a quick snapshot without needing `SELECT COUNT(*)` queries scattered through diagnostic code.

---

### [IDEA] Typed task IDs via a more structured format

Current task IDs are generated as `task-${Date.now()}-${random}` (inferred from the schema comment and usage). These are opaque strings. A structured format like `{groupFolder}/{yyyymmdd}/{shortRand}` would make IDs human-readable in logs and the IPC directory. This is an aesthetic preference, not a correctness issue.

---

### [IDEA] Per-query prepared statement caching for the dynamic `IN` clause

`getNewMessages` constructs the SQL string on every call because the number of JIDs varies:

```typescript
const placeholders = jids.map(() => '?').join(',');
const sql = `SELECT ... WHERE ... AND chat_jid IN (${placeholders}) ...`;
const rows = db.prepare(sql).all(...);
```

`better-sqlite3` prepares and caches statements internally, but the cache key is the SQL string. A different number of JIDs means a different SQL string and a new prepared statement entry in the cache. For a stable set of registered groups (which is the common case — groups are registered infrequently), this is effectively constant. But if groups are registered and deregistered frequently, the statement cache could thrash.

A simple optimization: maintain a prepared statement map keyed by JID count:

```typescript
const stmtCache = new Map<number, Statement>();

function getStmtForJids(count: number): Statement {
  if (!stmtCache.has(count)) {
    const placeholders = Array(count).fill('?').join(',');
    stmtCache.set(count, db.prepare(`SELECT ... WHERE chat_jid IN (${placeholders}) ...`));
  }
  return stmtCache.get(count)!;
}
```

This reduces repeated preparation for the common-case stable JID count. At AgentForge's scale it's pure polish.

---

## Summary Table

| Issue | Severity | Effort | Impact |
|-------|----------|--------|--------|
| Missing composite index `(chat_jid, timestamp)` | HIGH | Low — one SQL statement in `createSchema` | High — hot-path query every 2 seconds |
| WAL mode not configured | HIGH | Low — one pragma at init | Medium — prevents read/write contention |
| FK enforcement disabled | HIGH | Low — one pragma at init | Medium — prevents orphaned rows |
| `content NOT LIKE` can't use index | HIGH | Medium — verify backfill, remove clause | Medium — eliminates full content scan |
| try/catch swallows real migration errors | MEDIUM | Low — discriminate error message | Medium — prevents silent startup failures |
| `messages` grows indefinitely | MEDIUM | Low — add retention sweep | High — prevents unbounded disk growth |
| `task_run_logs` grows indefinitely | MEDIUM | Low — add retention sweep | Medium — prevents table bloat |
| `last_agent_timestamp` as JSON blob | MEDIUM | Medium — new table + migration | Low — correctness, not performance |
| `deleteTask` manual cascade | LOW | Low — enable FK cascade | Low — correctness improvement |
| getDueTasks N+1 re-fetch | LOW | Low — restructure loop | Low — negligible at this scale |
| TEXT timestamps | LOW | High — requires full data migration | Low — works correctly as-is |
